"""
Module 1 — Scale Calibration

Primary method: derive px_per_mm from the detected ColorChecker quad corners
and the known physical dimensions of an X-Rite ColorChecker Classic
(279 mm wide × 216 mm tall).

Secondary method: detect 5 cm ruler tick marks from the warped checker strip
as an independent cross-check.
"""

import cv2 as cv
import numpy as np

CC_WIDTH_MM = 279.0
CC_HEIGHT_MM = 216.0


def _edge_length(p1, p2):
    return float(np.linalg.norm(np.array(p1, dtype=np.float64) - np.array(p2, dtype=np.float64)))


def px_per_mm_from_corners(corners):
    """
    Given the 4 ColorChecker corners (TL, TR, BR, BL) in pixel coordinates,
    compute a robust px/mm ratio by averaging the scale derived from all 4 edges.

    Parameters
    ----------
    corners : array-like, shape (4, 2)
        Ordered [top-left, top-right, bottom-right, bottom-left].

    Returns
    -------
    px_per_mm : float
    mm_per_px : float
    """
    tl, tr, br, bl = corners[:4]

    top_px = _edge_length(tl, tr)
    bottom_px = _edge_length(bl, br)
    left_px = _edge_length(tl, bl)
    right_px = _edge_length(tr, br)

    horiz_px_per_mm = np.mean([top_px, bottom_px]) / CC_WIDTH_MM
    vert_px_per_mm = np.mean([left_px, right_px]) / CC_HEIGHT_MM

    px_per_mm = float(np.mean([horiz_px_per_mm, vert_px_per_mm]))
    mm_per_px = 1.0 / px_per_mm
    return px_per_mm, mm_per_px


def px_per_mm_from_ruler(warped_checker, expected_tick_spacing_mm=50.0):
    """
    Secondary/validation: crop the bottom ruler strip from the already-warped
    600×400 checker image.  Detect vertical edges (5 cm tick marks) via a
    column-wise Canny edge profile and return an independent px/mm estimate.

    Parameters
    ----------
    warped_checker : ndarray, shape (400, 600, 3)
        The perspective-corrected ColorChecker image.
    expected_tick_spacing_mm : float
        Physical spacing between ruler ticks (default 50 mm = 5 cm).

    Returns
    -------
    px_per_mm : float or None
        None if fewer than 2 ticks are detected.
    tick_positions : list[int]
        Column positions of detected ticks (for debug plotting).
    """
    h, w = warped_checker.shape[:2]
    strip = warped_checker[int(h * 0.90):, :]

    gray = cv.cvtColor(strip, cv.COLOR_BGR2GRAY)
    edges = cv.Canny(gray, 50, 150)

    profile = np.sum(edges, axis=0).astype(np.float64)

    profile = cv.GaussianBlur(profile.reshape(1, -1), (1, 15), 0).flatten()

    threshold = profile.max() * 0.3
    peaks = []
    in_peak = False
    start = 0
    for i, v in enumerate(profile):
        if v >= threshold and not in_peak:
            in_peak = True
            start = i
        elif v < threshold and in_peak:
            peaks.append((start + i) // 2)
            in_peak = False
    if in_peak:
        peaks.append((start + len(profile) - 1) // 2)

    MIN_TICK_GAP_PX = 20
    filtered = [peaks[0]] if peaks else []
    for p in peaks[1:]:
        if p - filtered[-1] >= MIN_TICK_GAP_PX:
            filtered.append(p)
    peaks = filtered

    if len(peaks) < 2:
        return None, peaks

    spacings = np.diff(peaks).astype(np.float64)
    median_spacing_px = float(np.median(spacings))
    px_per_mm = median_spacing_px / expected_tick_spacing_mm

    return px_per_mm, peaks


def calibrate(corners, warped_checker=None):
    """
    Convenience wrapper: compute primary CC-based calibration and optionally
    cross-check against the ruler.

    Returns
    -------
    dict with keys: px_per_mm, mm_per_px, ruler_px_per_mm (or None)
    """
    px_pm, mm_pp = px_per_mm_from_corners(corners)
    result = {"px_per_mm": px_pm, "mm_per_px": mm_pp, "ruler_px_per_mm": None}

    if warped_checker is not None:
        ruler_px_pm, _ = px_per_mm_from_ruler(warped_checker)
        result["ruler_px_per_mm"] = ruler_px_pm

    return result
