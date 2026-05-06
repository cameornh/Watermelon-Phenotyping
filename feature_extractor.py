"""
Module 4 — Feature Extraction

Compute all 11 phenotypic features from masks, contour geometry, and
calibration data:

  1. photo_id
  2. perimeter_mm
  3. width_mm
  4. height_mm
  5. proximal_angle_deg
  6. total_area_mm2
  7. flesh_area_mm2
  8. rind_area_mm2
  9. flesh_area_ratio
 10. flesh_thickness_mm
 11. rind_thickness_mm
"""

import cv2 as cv
import numpy as np

import contour_utils


def _pixel_area(mask):
    return int(np.count_nonzero(mask))


def _midline_thickness(mask, bbox_y_mid, x_start, x_end):
    """
    Scan a single row (y_mid) of *mask* between x_start..x_end and return the
    total span of nonzero pixels in that row (in px).
    """
    row = mask[bbox_y_mid, x_start:x_end]
    nz = np.nonzero(row)[0]
    if len(nz) == 0:
        return 0
    return int(nz[-1] - nz[0] + 1)


def _rind_thickness_at_midline(total_mask, flesh_mask, bbox_y_mid, x_start, x_end):
    """
    Measure rind thickness on each side of the midline row:
      left_rind  = left-edge-of-total -> left-edge-of-flesh
      right_rind = right-edge-of-flesh -> right-edge-of-total
    Returns the average of both sides (px).
    """
    row_total = total_mask[bbox_y_mid, x_start:x_end]
    row_flesh = flesh_mask[bbox_y_mid, x_start:x_end]

    nz_total = np.nonzero(row_total)[0]
    nz_flesh = np.nonzero(row_flesh)[0]

    if len(nz_total) == 0 or len(nz_flesh) == 0:
        return 0.0

    left_rind = max(0, int(nz_flesh[0] - nz_total[0]))
    right_rind = max(0, int(nz_total[-1] - nz_flesh[-1]))

    return (left_rind + right_rind) / 2.0


def extract_features(
    photo_id,
    masks,
    total_mask,
    contour_info,
    mm_per_px,
):
    """
    Parameters
    ----------
    photo_id : str
        Typically the image filename stem.
    masks : dict
        Must include 'flesh' and 'rind' (uint8 0/255).
    total_mask : ndarray
        Combined flesh|rind mask.
    contour_info : dict
        Output of contour_utils.analyze().
    mm_per_px : float
        Millimetres per pixel (from scale_calibration).

    Returns
    -------
    features : dict   with the 11 fields.
    """
    contour = contour_info["contour"]
    min_rect = contour_info["min_rect"]
    ellipse = contour_info["ellipse"]
    proximal_tip = contour_info["proximal_tip"]
    (cx, cy), _, _ = ellipse

    perimeter_px = cv.arcLength(contour, closed=True)
    perimeter_mm = perimeter_px * mm_per_px

    (_, _), (rect_w, rect_h), _ = min_rect
    dim1, dim2 = sorted([rect_w, rect_h])
    width_mm = dim1 * mm_per_px
    height_mm = dim2 * mm_per_px

    rind_mask = masks.get("rind")
    peak_left = peak_right = valley_pt = None
    if rind_mask is not None and np.any(rind_mask > 0):
        rind_contours, _ = cv.findContours(
            (rind_mask > 0).astype(np.uint8), cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE
        )
        if rind_contours:
            rind_contour = max(rind_contours, key=cv.contourArea)
            (
                angle_deg,
                ray1,
                ray2,
                peak_left,
                peak_right,
                valley_pt,
                peaks_ok,
            ) = contour_utils.proximal_angle_peaks_valley(rind_contour, (cx, cy))
            if not peaks_ok:
                angle_deg, ray1, ray2 = contour_utils.proximal_angle(
                    contour, proximal_tip, arc_window_px=55
                )
                valley_pt = proximal_tip
                peak_left = peak_right = None
        else:
            angle_deg, ray1, ray2 = contour_utils.proximal_angle(
                contour, proximal_tip, arc_window_px=55
            )
            valley_pt = proximal_tip
    else:
        angle_deg, ray1, ray2 = contour_utils.proximal_angle(
            contour, proximal_tip, arc_window_px=55
        )
        valley_pt = proximal_tip

    mm2_per_px2 = mm_per_px ** 2
    total_area_mm2 = _pixel_area(total_mask) * mm2_per_px2
    flesh_area_mm2 = _pixel_area(masks["flesh"]) * mm2_per_px2
    rind_area_mm2 = _pixel_area(masks["rind"]) * mm2_per_px2

    flesh_area_ratio = flesh_area_mm2 / total_area_mm2 if total_area_mm2 > 0 else 0.0

    coords = cv.findNonZero(total_mask)
    if coords is not None:
        x, y, w, h = cv.boundingRect(coords)
        y_mid = y + h // 2
        x_end = x + w

        flesh_thick_px = _midline_thickness(masks["flesh"], y_mid, x, x_end)
        rind_thick_px = _rind_thickness_at_midline(total_mask, masks["flesh"], y_mid, x, x_end)
    else:
        flesh_thick_px = 0
        rind_thick_px = 0.0

    flesh_thickness_mm = flesh_thick_px * mm_per_px
    rind_thickness_mm = rind_thick_px * mm_per_px

    return {
        "photo_id": photo_id,
        "perimeter_mm": round(perimeter_mm, 2),
        "width_mm": round(width_mm, 2),
        "height_mm": round(height_mm, 2),
        "proximal_angle_deg": round(angle_deg, 2),
        "total_area_mm2": round(total_area_mm2, 2),
        "flesh_area_mm2": round(flesh_area_mm2, 2),
        "rind_area_mm2": round(rind_area_mm2, 2),
        "flesh_area_ratio": round(flesh_area_ratio, 4),
        "flesh_thickness_mm": round(flesh_thickness_mm, 2),
        "rind_thickness_mm": round(rind_thickness_mm, 2),
        "_debug": {
            "ray1": ray1,
            "ray2": ray2,
            "proximal_tip": valley_pt,
            "proximal_peaks": (peak_left, peak_right)
            if peak_left is not None and peak_right is not None
            else None,
            "y_mid": y_mid if coords is not None else None,
        },
    }
