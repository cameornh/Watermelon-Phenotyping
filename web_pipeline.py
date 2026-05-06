import os
from dataclasses import dataclass
from typing import Any, Dict, Optional

import cv2
import numpy as np
from scipy.ndimage import median_filter
from scipy.optimize import curve_fit
from ultralytics import YOLO

import contour_utils
import feature_extractor
from color_calibration import (
    apply_pipeline,
    detect_checker_corners,
    sample_24_patches,
    warp_checker,
)
from cv_helpers import blend_mask_overlays, stem_tip_tangent_deg
from scale_calibration import calibrate


@dataclass
class ProcessResult:
    success: bool
    message: str
    r2_score: Optional[float] = None
    output_filename: Optional[str] = None
    features: Optional[Dict[str, Any]] = None
    calibration: Optional[Dict[str, Any]] = None


class WatermelonProcessor:
    def __init__(self, model_path: str, output_dir: str, reference_image_path: str) -> None:
        self.model = YOLO(model_path)
        self.output_dir = output_dir
        os.makedirs(self.output_dir, exist_ok=True)
        if not reference_image_path or not os.path.isfile(reference_image_path):
            raise ValueError(
                f"Reference checker image is required but not found: {reference_image_path!r}"
            )
        self.reference_image_path = os.path.abspath(reference_image_path)
        ref_img = cv2.imread(self.reference_image_path)
        if ref_img is None:
            raise ValueError(f"Could not read reference checker image: {self.reference_image_path}")
        try:
            ref_corners = detect_checker_corners(ref_img)
            ref_warp = warp_checker(ref_img, ref_corners)
            self.ref24 = sample_24_patches(ref_warp)
        except Exception as exc:
            raise ValueError(
                f"Failed to build reference ColorChecker patches from {self.reference_image_path}: {exc}"
            ) from exc

    @staticmethod
    def watermelon_model(theta, Rx, Ry, c_a, d_top, w_top, d_bot, w_bot, phi, c_skew, c_bend):
        t = theta - phi
        ellipse = (Rx * Ry) / np.sqrt((Ry * np.cos(t)) ** 2 + (Rx * np.sin(t)) ** 2)
        asymmetry = 1 + c_a * np.cos(t) ** 3
        divot_top = d_top * np.exp(w_top * (np.sin(t) - 1))
        divot_bot = d_bot * np.exp(w_bot * (-np.sin(t) - 1))
        return (ellipse * asymmetry) - divot_top - divot_bot + c_skew * np.sin(t) + c_bend * np.cos(t) * (np.sin(t) ** 2)

    @staticmethod
    def get_stable_perimeter_data(rind_mask, flesh_mask):
        cnts, _ = cv2.findContours(rind_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        if not cnts:
            return None

        best_cnt = None
        max_overlap = -1
        for cnt in cnts:
            temp_mask = np.zeros_like(rind_mask)
            cv2.drawContours(temp_mask, [cnt], -1, 255, -1)
            overlap_area = cv2.countNonZero(cv2.bitwise_and(temp_mask, flesh_mask))
            if overlap_area > max_overlap:
                max_overlap = overlap_area
                best_cnt = cnt

        if best_cnt is None:
            best_cnt = max(cnts, key=cv2.contourArea)

        moments = cv2.moments(best_cnt)
        if moments["m00"] == 0:
            return None

        cx, cy = moments["m10"] / moments["m00"], moments["m01"] / moments["m00"]
        pts = best_cnt.reshape(-1, 2)
        dx, dy = pts[:, 0] - cx, cy - pts[:, 1]
        r_vals, t_vals = np.sqrt(dx**2 + dy**2), np.arctan2(dy, dx)

        num_bins = 360
        bins = np.linspace(-np.pi, np.pi, num_bins + 1)
        raw_r = np.full(num_bins, np.nan)
        for i in range(num_bins):
            mask = (t_vals >= bins[i]) & (t_vals < bins[i + 1])
            if np.any(mask):
                raw_r[i] = np.max(r_vals[mask])

        valid_idx = np.where(~np.isnan(raw_r))[0]
        if len(valid_idx) == 0:
            return None
        raw_r[np.isnan(raw_r)] = np.interp(np.where(np.isnan(raw_r))[0], valid_idx, raw_r[valid_idx], period=360)
        final_r = median_filter(raw_r, size=7, mode="wrap")
        final_theta = (bins[:-1] + bins[1:]) / 2.0
        return final_theta, final_r, (cx, cy), best_cnt

    @staticmethod
    def get_ray_scan_midline(flesh_mask, rind_cnt, predicted_cnt, cx, cy):
        h, w = flesh_mask.shape
        if len(rind_cnt) > 5:
            _, (ma, Ma), angle = cv2.fitEllipse(rind_cnt)
            rot_angle = angle if ma < Ma else angle + 90
        else:
            rot_angle = 0

        m_rot = cv2.getRotationMatrix2D((cx, cy), rot_angle, 1.0)
        m_inv = cv2.getRotationMatrix2D((cx, cy), -rot_angle, 1.0)
        f_rot = cv2.warpAffine(flesh_mask, m_rot, (w, h))

        gap_points = []
        y_indices, _ = np.where(f_rot > 0)
        if len(y_indices) > 0:
            y_min, y_max = np.min(y_indices), np.max(y_indices)
            for y in range(y_min, y_max):
                row = f_rot[y, :]
                white_px = np.where(row > 0)[0]
                if len(white_px) >= 2:
                    first, last = white_px[0], white_px[-1]
                    blanks_in_between = np.where(row[first:last] == 0)[0] + first
                    if len(blanks_in_between) > 0:
                        gap_points.append([y, np.median(blanks_in_between)])

        gap_points = np.array(gap_points)
        if len(gap_points) > 10:
            y_min, y_max = np.min(gap_points[:, 0]), np.max(gap_points[:, 0])
            y_span = max(y_max - y_min, 1)
            y_mean = (y_max + y_min) / 2.0
            y_norm = (gap_points[:, 0] - y_mean) / y_span
            x_data = gap_points[:, 1]

            def parabola(y_n, a, b, c):
                return a * (y_n**2) + b * y_n + c

            max_bend = w * 0.08
            try:
                popt_mid, _ = curve_fit(
                    parabola,
                    y_norm,
                    x_data,
                    bounds=([-max_bend, -np.inf, -np.inf], [max_bend, np.inf, np.inf]),
                )
            except Exception:
                popt_mid = [0.0, 0.0, cx]

            ys_extrap = np.linspace(0, h, 500)
            ys_extrap_norm = (ys_extrap - y_mean) / y_span
            xs_extrap = parabola(ys_extrap_norm, *popt_mid)
            pts_rot = np.vstack([xs_extrap, ys_extrap, np.ones_like(xs_extrap)])
        else:
            ys_extrap = np.linspace(0, h, 500)
            xs_extrap = np.full_like(ys_extrap, cx)
            pts_rot = np.vstack([xs_extrap, ys_extrap, np.ones_like(xs_extrap)])

        pts_orig = (m_inv @ pts_rot).T
        pred_cnt_cv = predicted_cnt.reshape(-1, 1, 2).astype(np.int32)
        final_line = []
        for pt in pts_orig:
            if cv2.pointPolygonTest(pred_cnt_cv, (float(pt[0]), float(pt[1])), False) >= 0:
                final_line.append(pt)
        return np.array(final_line)

    def process_image(self, image: np.ndarray, source_name: str) -> ProcessResult:
        if image is None:
            return ProcessResult(success=False, message="Could not decode image.")

        try:
            checker_corners = detect_checker_corners(image)
        except Exception as exc:
            return ProcessResult(
                success=False,
                message=f"ColorChecker not found in image (required for calibration): {exc}",
            )

        try:
            checker_warp = warp_checker(image, checker_corners)
            tgt24 = sample_24_patches(checker_warp)
            image_for_inference = apply_pipeline(image, self.ref24, tgt24)
        except Exception as exc:
            return ProcessResult(success=False, message=f"Color calibration failed: {exc}")

        calibration_info: Dict[str, Any] = {
            "mm_per_px": None,
            "px_per_mm": None,
            "ruler_px_per_mm": None,
            "color_calibrated": True,
            "reference_image": self.reference_image_path,
        }
        try:
            cal = calibrate(checker_corners, warped_checker=checker_warp)
            calibration_info.update(cal)
        except Exception as exc:
            return ProcessResult(success=False, message=f"Scale calibration failed: {exc}")

        mm_per_px = calibration_info.get("mm_per_px")
        if mm_per_px is None or float(mm_per_px) <= 0:
            return ProcessResult(
                success=False,
                message="Scale calibration returned invalid mm_per_px.",
            )
        mm_per_px = float(mm_per_px)

        h, w = image_for_inference.shape[:2]
        results = self.model(image_for_inference, conf=0.25, verbose=False)
        rind_mask, flesh_mask = np.zeros((h, w), dtype=np.uint8), np.zeros((h, w), dtype=np.uint8)

        if results[0].masks is None:
            return ProcessResult(success=False, message="No masks detected.")

        for mask_data, cls in zip(results[0].masks.xy, results[0].boxes.cls):
            contour = np.array(mask_data, dtype=np.int32)
            if int(cls) == 0:
                cv2.drawContours(rind_mask, [contour], -1, 255, -1)
            elif int(cls) == 1:
                cv2.drawContours(flesh_mask, [contour], -1, 255, -1)

        perimeter_data = self.get_stable_perimeter_data(rind_mask, flesh_mask)
        if perimeter_data is None:
            return ProcessResult(success=False, message="Could not extract a stable perimeter.")

        t_data, r_raw, (cx, cy), rind_cnt = perimeter_data
        scale = np.mean(r_raw)
        if scale <= 0:
            return ProcessResult(success=False, message="Invalid perimeter scale.")

        try:
            popt, _ = curve_fit(
                self.watermelon_model,
                t_data,
                r_raw / scale,
                p0=[1.0, 1.1, 0.0, 0.05, 3.0, 0.05, 3.0, 0.0, 0.0, 0.0],
                bounds=(
                    [0.5, 0.5, -0.4, 0.0, 0.1, 0.0, 0.1, -1.5, -0.2, -0.2],
                    [2.0, 2.0, 0.4, 0.5, 50.0, 0.5, 50.0, 1.5, 0.2, 0.2],
                ),
            )
        except Exception as exc:
            return ProcessResult(success=False, message=f"Curve fit failed: {exc}")

        denom = np.sum((r_raw / scale - 1) ** 2)
        if denom == 0:
            return ProcessResult(success=False, message="R2 denominator became zero.")

        r2 = 1 - (np.sum((r_raw / scale - self.watermelon_model(t_data, *popt)) ** 2) / denom)
        t_fit = np.linspace(-np.pi, np.pi, 500)
        r_fit = self.watermelon_model(t_fit, *popt) * scale
        fit_pts = np.array([[r * np.cos(t) + cx, cy - r * np.sin(t)] for t, r in zip(t_fit, r_fit)])
        midline = self.get_ray_scan_midline(flesh_mask, rind_cnt, fit_pts, cx, cy)

        total_mask = cv2.bitwise_or(rind_mask, flesh_mask)
        try:
            contour = contour_utils.largest_contour(total_mask)
        except Exception as exc:
            return ProcessResult(success=False, message=f"No contour found for feature extraction: {exc}")
        if len(contour) < 5:
            return ProcessResult(success=False, message="Contour too small for feature extraction.")

        ellipse = cv2.fitEllipse(contour)
        min_rect = cv2.minAreaRect(contour)
        proximal_tip = contour.reshape(-1, 2)[np.argmin(contour.reshape(-1, 2)[:, 1])].astype(np.float64)
        contour_info = {
            "contour": contour,
            "min_rect": min_rect,
            "ellipse": ellipse,
            "proximal_tip": proximal_tip,
        }
        photo_id = os.path.splitext(os.path.basename(source_name))[0]
        features = feature_extractor.extract_features(
            photo_id=photo_id,
            masks={"flesh": flesh_mask, "rind": rind_mask},
            total_mask=total_mask,
            contour_info=contour_info,
            mm_per_px=mm_per_px,
        )
        px_per_mm = float(calibration_info.get("px_per_mm") or (1.0 / mm_per_px))
        features["px_to_mm"] = round(float(mm_per_px), 6)
        features["mm_to_px"] = round(px_per_mm, 6)

        output = blend_mask_overlays(image_for_inference, rind_mask, flesh_mask)
        if len(midline) > 1:
            cv2.polylines(output, [midline.astype(np.int32)], False, (0, 255, 255), 3)
        cv2.polylines(output, [fit_pts.astype(np.int32)], True, (0, 255, 0), 3)

        stem = stem_tip_tangent_deg(rind_cnt, (cx, cy))
        if stem is not None:
            tx, ty, tdeg = stem
            rad = np.deg2rad(tdeg)
            L = min(w, h) * 0.08
            p1 = (int(round(tx)), int(round(ty)))
            p2 = (int(round(tx + L * np.cos(rad))), int(round(ty + L * np.sin(rad))))
            cv2.circle(output, p1, 6, (255, 0, 255), -1)
            cv2.line(output, p1, p2, (255, 0, 255), 2)

        safe_name = os.path.splitext(os.path.basename(source_name))[0]
        output_filename = f"fitted_{safe_name}.jpg"
        output_path = os.path.join(self.output_dir, output_filename)
        cv2.imwrite(output_path, output)

        return ProcessResult(
            success=True,
            message="Processed successfully.",
            r2_score=float(r2),
            output_filename=output_filename,
            features=features,
            calibration=calibration_info,
        )
