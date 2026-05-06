import os
import cv2
import numpy as np
import base64
from dataclasses import dataclass
from typing import Optional
from scipy.ndimage import median_filter
from scipy.optimize import curve_fit
from ultralytics import YOLO
from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

# Import your helpers (assuming cv_helpers.py is in the same folder)
from cv_helpers import blend_mask_overlays, stem_tip_tangent_deg

# --- CONFIGURATION ---
MODEL_PATH = "best.pt"
# Change this scale factor later to convert pixels to cm (e.g., 0.026)
PIXELS_TO_CM = 1.0  

@dataclass
class ProcessResult:
    success: bool
    message: str
    r2_score: Optional[float] = None
    width_val: Optional[float] = None
    height_val: Optional[float] = None
    perimeter_val: Optional[float] = None
    image_base64: Optional[str] = None
    filename: Optional[str] = None

class WatermelonProcessor:
    def __init__(self, model_path: str):
        self.model = YOLO(model_path)

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
        if not cnts: return None
        best_cnt = None
        max_overlap = -1
        for cnt in cnts:
            temp_mask = np.zeros_like(rind_mask)
            cv2.drawContours(temp_mask, [cnt], -1, 255, -1)
            overlap_area = cv2.countNonZero(cv2.bitwise_and(temp_mask, flesh_mask))
            if overlap_area > max_overlap:
                max_overlap = overlap_area
                best_cnt = cnt
        if best_cnt is None: best_cnt = max(cnts, key=cv2.contourArea)
        moments = cv2.moments(best_cnt)
        if moments["m00"] == 0: return None

        cx, cy = moments["m10"] / moments["m00"], moments["m01"] / moments["m00"]
        pts = best_cnt.reshape(-1, 2)
        dx, dy = pts[:, 0] - cx, cy - pts[:, 1]
        r_vals, t_vals = np.sqrt(dx**2 + dy**2), np.arctan2(dy, dx)
        num_bins = 360
        bins = np.linspace(-np.pi, np.pi, num_bins + 1)
        raw_r = np.full(num_bins, np.nan)
        for i in range(num_bins):
            mask = (t_vals >= bins[i]) & (t_vals < bins[i + 1])
            if np.any(mask): raw_r[i] = np.max(r_vals[mask])

        valid_idx = np.where(~np.isnan(raw_r))[0]
        if len(valid_idx) == 0: return None
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
        else: rot_angle = 0

        m_rot = cv2.getRotationMatrix2D((cx, cy), rot_angle, 1.0)
        m_inv = cv2.getRotationMatrix2D((cx, cy), -rot_angle, 1.0)
        f_rot = cv2.warpAffine(flesh_mask, m_rot, (w, h))

        gap_points =[]
        y_indices, _ = np.where(f_rot > 0)
        if len(y_indices) > 0:
            for y in range(np.min(y_indices), np.max(y_indices)):
                row = f_rot[y, :]
                white_px = np.where(row > 0)[0]
                if len(white_px) >= 2:
                    blanks = np.where(row[white_px[0]:white_px[-1]] == 0)[0] + white_px[0]
                    if len(blanks) > 0: gap_points.append([y, np.median(blanks)])

        gap_points = np.array(gap_points)
        if len(gap_points) > 10:
            y_min, y_max = np.min(gap_points[:, 0]), np.max(gap_points[:, 0])
            y_span, y_mean = max(y_max - y_min, 1), (y_max + y_min) / 2.0
            y_norm = (gap_points[:, 0] - y_mean) / y_span
            x_data = gap_points[:, 1]

            def parabola(y_n, a, b, c): return a * (y_n**2) + b * y_n + c
            try:
                popt_mid, _ = curve_fit(parabola, y_norm, x_data, bounds=([-w*0.08, -np.inf, -np.inf], [w*0.08, np.inf, np.inf]))
            except: popt_mid = [0.0, 0.0, cx]

            ys_extrap = np.linspace(0, h, 500)
            xs_extrap = parabola((ys_extrap - y_mean) / y_span, *popt_mid)
            pts_rot = np.vstack([xs_extrap, ys_extrap, np.ones_like(xs_extrap)])
        else:
            ys_extrap = np.linspace(0, h, 500)
            pts_rot = np.vstack([np.full_like(ys_extrap, cx), ys_extrap, np.ones_like(ys_extrap)])

        pts_orig = (m_inv @ pts_rot).T
        pred_cnt_cv = predicted_cnt.reshape(-1, 1, 2).astype(np.int32)
        return np.array([pt for pt in pts_orig if cv2.pointPolygonTest(pred_cnt_cv, (float(pt[0]), float(pt[1])), False) >= 0])

    def process_image(self, image: np.ndarray, source_name: str) -> ProcessResult:
        if image is None: return ProcessResult(success=False, message="Could not decode image.")
        h, w = image.shape[:2]
        
        results = self.model(image, conf=0.25, verbose=False)
        rind_mask, flesh_mask = np.zeros((h, w), dtype=np.uint8), np.zeros((h, w), dtype=np.uint8)

        if results[0].masks is None:
            return ProcessResult(success=False, message="No masks detected.")

        for mask_data, cls in zip(results[0].masks.xy, results[0].boxes.cls):
            contour = np.array(mask_data, dtype=np.int32)
            if int(cls) == 0: cv2.drawContours(rind_mask, [contour], -1, 255, -1)
            elif int(cls) == 1: cv2.drawContours(flesh_mask, [contour], -1, 255, -1)

        perimeter_data = self.get_stable_perimeter_data(rind_mask, flesh_mask)
        if perimeter_data is None: return ProcessResult(success=False, message="No stable perimeter.")

        t_data, r_raw, (cx, cy), rind_cnt = perimeter_data
        scale = np.mean(r_raw)
        
        try:
            popt, _ = curve_fit(
                self.watermelon_model, t_data, r_raw / scale,
                p0=[1.0, 1.1, 0.0, 0.05, 3.0, 0.05, 3.0, 0.0, 0.0, 0.0],
                bounds=([0.5, 0.5, -0.4, 0.0, 0.1, 0.0, 0.1, -1.5, -0.2, -0.2],[2.0, 2.0, 0.4, 0.5, 50.0, 0.5, 50.0, 1.5, 0.2, 0.2]),
            )
        except Exception as exc: return ProcessResult(success=False, message=f"Fit failed: {exc}")

        r2 = 1 - (np.sum((r_raw / scale - self.watermelon_model(t_data, *popt)) ** 2) / np.sum((r_raw / scale - 1) ** 2))
        
        t_fit = np.linspace(-np.pi, np.pi, 500)
        r_fit = self.watermelon_model(t_fit, *popt) * scale
        fit_pts = np.array([[r * np.cos(t) + cx, cy - r * np.sin(t)] for t, r in zip(t_fit, r_fit)])
        
        # --- FEATURE EXTRACTION ---
        width_px = float(np.max(fit_pts[:, 0]) - np.min(fit_pts[:, 0]))
        height_px = float(np.max(fit_pts[:, 1]) - np.min(fit_pts[:, 1]))
        
        # Perimeter = sum of distances between consecutive points + closing the loop
        diffs = np.diff(fit_pts, axis=0)
        perimeter_px = float(np.sum(np.linalg.norm(diffs, axis=1)) + np.linalg.norm(fit_pts[-1] - fit_pts[0]))

        # Apply Scale Factor
        width_val = width_px * PIXELS_TO_CM
        height_val = height_px * PIXELS_TO_CM
        perimeter_val = perimeter_px * PIXELS_TO_CM

        # --- DRAWING ---
        midline = self.get_ray_scan_midline(flesh_mask, rind_cnt, fit_pts, cx, cy)
        output = blend_mask_overlays(image, rind_mask, flesh_mask)
        if len(midline) > 1: cv2.polylines(output,[midline.astype(np.int32)], False, (0, 255, 255), 3)
        cv2.polylines(output, [fit_pts.astype(np.int32)], True, (0, 255, 0), 3)

        stem = stem_tip_tangent_deg(rind_cnt, (cx, cy))
        if stem is not None:
            tx, ty, tdeg = stem
            L = min(w, h) * 0.08
            p1 = (int(round(tx)), int(round(ty)))
            p2 = (int(round(tx + L * np.cos(np.deg2rad(tdeg))), int(round(ty + L * np.sin(np.deg2rad(tdeg))))))
            cv2.circle(output, p1, 6, (255, 0, 255), -1)
            cv2.line(output, p1, p2, (255, 0, 255), 2)

        # Convert image to Base64 so frontend can display it directly
        _, buffer = cv2.imencode('.jpg', output)
        img_base64 = base64.b64encode(buffer).decode('utf-8')

        return ProcessResult(
            success=True, message="Success", r2_score=float(r2),
            width_val=width_val, height_val=height_val, perimeter_val=perimeter_val,
            image_base64=img_base64, filename=source_name
        )


# --- FASTAPI APP ---
app = FastAPI()

# Allow GitHub pages frontend to talk to this API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

processor = WatermelonProcessor(MODEL_PATH)

@app.post("/process_single")
async def process_single(file: UploadFile = File(...)):
    contents = await file.read()
    nparr = np.frombuffer(contents, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    
    res = processor.process_image(img, file.filename)
    return res.__dict__

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
