"""
Module 3 — Contour Analysis

Find the largest contour on the total (flesh | rind) mask, fit an ellipse
and a minimum-area rotated rectangle.

The proximal (stem) tip is **not** taken from the ellipse major axis: for a
watermelon half the major axis often runs left–right (width), while the stem
pinch sits at the **top** of the fruit along the vertical midline.  We locate
the stem by scanning the upper portion of the contour near the ellipse centre.
"""

import cv2 as cv
import numpy as np


def largest_contour(mask):
    """
    Extract the largest contour by area from a binary mask.

    Parameters
    ----------
    mask : ndarray, uint8 (0/255)

    Returns
    -------
    contour : ndarray, shape (N, 1, 2)
    """
    contours, _ = cv.findContours(mask, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE)
    if not contours:
        raise RuntimeError("No contours found on total_mask")
    return max(contours, key=cv.contourArea)


def fit_geometry(contour):
    """
    Fit an ellipse and a minimum-area rectangle to the contour.

    Returns
    -------
    ellipse : tuple  ((cx, cy), (minor_axis, major_axis), angle)
        OpenCV convention: axes are full lengths (not semi-), angle in degrees.
    min_rect : tuple  ((cx, cy), (w, h), angle)
        From cv.minAreaRect.
    """
    if len(contour) < 5:
        raise RuntimeError("Contour has <5 points; cannot fit ellipse")

    ellipse = cv.fitEllipse(contour)
    min_rect = cv.minAreaRect(contour)
    return ellipse, min_rect


def find_stem_tip_on_contour(contour, ellipse_center):
    """
    Locate the stem (proximal) end on the contour.

    Convention: photos are taken with the stem end toward the **top** of the
    image.  The stem pinch lies in the upper part of the fruit and on the
    vertical midline — *not* at the ellipse major-axis endpoints (those are
    often the left/right extremities when the fruit is wider than tall).

    Algorithm:
      1. Take contour points in the top ~18% of the fruit's vertical span.
      2. Restrict to points within ~22% of fruit width from the ellipse centre
         (horizontal midline).
      3. Among those, use the crest of minimum y (mean x for tie-break).

    Parameters
    ----------
    contour : ndarray, shape (N, 1, 2)
    ellipse_center : (cx, cy)  from cv.fitEllipse

    Returns
    -------
    tip : ndarray, shape (2,)  float [x, y]
    """
    pts = contour.reshape(-1, 2).astype(np.float64)
    cx = float(ellipse_center[0])
    ys = pts[:, 1]
    xs = pts[:, 0]
    y_min, y_max = ys.min(), ys.max()
    x_min, x_max = xs.min(), xs.max()
    vert_span = max(y_max - y_min, 1.0)
    horiz_span = max(x_max - x_min, 1.0)

    y_band = y_min + 0.18 * vert_span
    half_w = max(0.22 * horiz_span, 25.0)

    sel = (pts[:, 1] <= y_band) & (np.abs(pts[:, 0] - cx) <= half_w)
    candidates = pts[sel]

    if len(candidates) < 4:
        sel = (pts[:, 1] <= y_min + 0.28 * vert_span) & (
            np.abs(pts[:, 0] - cx) <= max(0.35 * horiz_span, 35.0)
        )
        candidates = pts[sel]

    if len(candidates) < 4:
        candidates = pts[pts[:, 1] <= y_min + 0.15 * vert_span]

    if len(candidates) == 0:
        candidates = pts

    cy = float(ellipse_center[1])
    # Actual contour vertex: minimum y (closest to top of image), then
    # prefer farthest from (cx, cy) to break ties in favour of the **outer**
    # rind shell (stem apex) rather than an inner corner of the flesh, then
    # closest to the vertical midline.
    d2 = (candidates[:, 0] - cx) ** 2 + (candidates[:, 1] - cy) ** 2
    order = np.lexsort(
        (np.abs(candidates[:, 0] - cx), -d2, candidates[:, 1])
    )
    return candidates[order[0]].copy()


def find_distal_tip_on_contour(contour, ellipse_center):
    """
    Blossom / distal end: bottom region of the fruit, near the vertical midline.
    """
    pts = contour.reshape(-1, 2).astype(np.float64)
    cx = float(ellipse_center[0])
    ys = pts[:, 1]
    xs = pts[:, 0]
    y_min, y_max = ys.min(), ys.max()
    x_min, x_max = xs.min(), xs.max()
    vert_span = max(y_max - y_min, 1.0)
    horiz_span = max(x_max - x_min, 1.0)

    y_band = y_max - 0.18 * vert_span
    half_w = max(0.22 * horiz_span, 25.0)

    sel = (pts[:, 1] >= y_band) & (np.abs(pts[:, 0] - cx) <= half_w)
    candidates = pts[sel]

    if len(candidates) < 4:
        sel = (pts[:, 1] >= y_max - 0.28 * vert_span) & (
            np.abs(pts[:, 0] - cx) <= max(0.35 * horiz_span, 35.0)
        )
        candidates = pts[sel]

    if len(candidates) < 4:
        candidates = pts[pts[:, 1] >= y_max - 0.15 * vert_span]

    if len(candidates) == 0:
        candidates = pts

    order = np.lexsort((np.abs(candidates[:, 0] - cx), -candidates[:, 1]))
    return candidates[order[0]].copy()


def _short_arc_indices(i_a, i_b, n, pts=None):
    """
    Indices along the shorter of the two closed-contour arcs from i_a to i_b
    (both endpoints inclusive), in traversal order. If both arcs tie in length,
    prefer the arc with smaller mean y (upper side of the fruit) when *pts*
    is given.
    """
    d_fwd = (i_b - i_a) % n
    d_bwd = n - d_fwd
    arc_fwd = [(i_a + k) % n for k in range(d_fwd + 1)]
    arc_bwd = [(i_a - k) % n for k in range(d_bwd + 1)]
    if d_fwd < d_bwd:
        return arc_fwd
    if d_bwd < d_fwd:
        return arc_bwd
    if pts is None:
        return arc_fwd
    y1 = float(pts[arc_fwd][:, 1].mean())
    y2 = float(pts[arc_bwd][:, 1].mean())
    return arc_fwd if y1 < y2 else arc_bwd


def _nearest_contour_index(pts, point):
    d = np.linalg.norm(pts - np.asarray(point, dtype=np.float64), axis=1)
    return int(np.argmin(d))


def proximal_angle(contour, tip_point, arc_window_px=55):
    """
    Measure the included angle at the proximal (stem) tip.

    Strategy:
    1. Find the contour point closest to *tip_point*.
    2. Walk ±arc_window_px along the contour from that point.
    3. Fit a line through each side's sub-contour (the two tangent rays).
    4. Return the angle between the rays (degrees).

    Parameters
    ----------
    contour : ndarray, shape (N, 1, 2)
    tip_point : array-like, shape (2,)
    arc_window_px : int
        Number of contour points to sample on each side of the tip.

    Returns
    -------
    angle_deg : float
        The included angle at the tip, in degrees [0, 180].
    ray1_dir, ray2_dir : ndarray
        Unit direction vectors for the two tangent rays (for debug drawing).
    """
    pts = contour.reshape(-1, 2).astype(np.float64)
    n = len(pts)

    dists = np.linalg.norm(pts - np.array(tip_point, dtype=np.float64), axis=1)
    idx = int(np.argmin(dists))

    w = min(arc_window_px, n // 4)

    side1_indices = [(idx - i) % n for i in range(1, w + 1)]
    side2_indices = [(idx + i) % n for i in range(1, w + 1)]

    side1_pts = pts[side1_indices]
    side2_pts = pts[side2_indices]

    def fit_direction(points, origin):
        vecs = points - origin
        _, _, vt = np.linalg.svd(vecs, full_matrices=False)
        d = vt[0]
        if np.dot(d, vecs.mean(axis=0)) < 0:
            d = -d
        return d / (np.linalg.norm(d) + 1e-12)

    origin = pts[idx].astype(np.float64)
    ray1 = fit_direction(side1_pts, origin)
    ray2 = fit_direction(side2_pts, origin)

    cos_a = np.clip(np.dot(ray1, ray2), -1.0, 1.0)
    angle_deg = float(np.degrees(np.arccos(cos_a)))

    return angle_deg, ray1, ray2


def proximal_angle_peaks_valley(rind_contour, ellipse_center, upper_frac=0.28):
    """
    Proximal “apple dip” angle from the **rind** outline: two shoulder peaks
    in the upper fruit and the lowest rind point between them on the short
    contour arc (stem valley). The angle is the interior angle at the valley
    between the segments valley→left peak and valley→right peak (smaller =
    sharper inward pinch).

    Parameters
    ----------
    rind_contour : ndarray, shape (N, 1, 2)
    ellipse_center : (cx, cy)
    upper_frac : float
        Fraction of vertical span (from top) used to search for shoulder peaks.

    Returns
    -------
    angle_deg : float
    ray1, ray2 : ndarray
        Unit vectors from valley toward left and right peaks (for debug arrows).
    peak_left, peak_right, valley : ndarray, shape (2,)
        Peak and valley points (float xy).
    ok : bool
        False if geometry could not be resolved (caller may fall back).
    """
    pts = rind_contour.reshape(-1, 2).astype(np.float64)
    n = len(pts)
    if n < 8:
        return 0.0, np.zeros(2), np.zeros(2), np.zeros(2), np.zeros(2), np.zeros(2), False

    cx = float(ellipse_center[0])
    ys = pts[:, 1]
    xs = pts[:, 0]
    y_min, y_max = float(ys.min()), float(ys.max())
    x_min, x_max = float(xs.min()), float(xs.max())
    vert_span = max(y_max - y_min, 1.0)
    horiz_span = max(x_max - x_min, 1.0)
    y_cut = y_min + upper_frac * vert_span
    margin = max(0.02 * horiz_span, 3.0)

    upper = pts[ys <= y_cut]
    if len(upper) < 6:
        y_cut = y_min + 0.4 * vert_span
        upper = pts[ys <= y_cut]
    if len(upper) < 4:
        return 0.0, np.zeros(2), np.zeros(2), np.zeros(2), np.zeros(2), np.zeros(2), False

    # Prefer a strict left / right split at cx so the two peaks are distinct shoulders.
    left_cand = upper[upper[:, 0] < cx]
    right_cand = upper[upper[:, 0] >= cx]
    if len(left_cand) < 2:
        left_cand = upper[upper[:, 0] <= cx + margin]
    if len(right_cand) < 2:
        right_cand = upper[upper[:, 0] >= cx - margin]
    if len(left_cand) < 2:
        left_cand = upper[upper[:, 0] <= cx + 0.12 * horiz_span]
    if len(right_cand) < 2:
        right_cand = upper[upper[:, 0] >= cx - 0.12 * horiz_span]
    if len(left_cand) == 0 or len(right_cand) == 0:
        return 0.0, np.zeros(2), np.zeros(2), np.zeros(2), np.zeros(2), np.zeros(2), False

    # Shoulder peaks: highest points (minimum y) on each side of the midline.
    li = int(np.argmin(left_cand[:, 1]))
    ri = int(np.argmin(right_cand[:, 1]))
    peak_left = left_cand[li].copy()
    peak_right = right_cand[ri].copy()

    iL = _nearest_contour_index(pts, peak_left)
    iR = _nearest_contour_index(pts, peak_right)
    if iL == iR:
        return 0.0, np.zeros(2), np.zeros(2), peak_left, peak_right, pts[iL].copy(), False

    arc_idx = _short_arc_indices(iL, iR, n, pts)
    if len(arc_idx) < 3:
        return 0.0, np.zeros(2), np.zeros(2), peak_left, peak_right, pts[iL].copy(), False

    arc_pts = pts[arc_idx]
    # Deepest point on the top cap (maximum y = stem valley).
    local = int(np.argmax(arc_pts[:, 1]))
    valley = arc_pts[local].copy()

    v_l = peak_left - valley
    v_r = peak_right - valley
    nl = np.linalg.norm(v_l)
    nr = np.linalg.norm(v_r)
    if nl < 1e-6 or nr < 1e-6:
        return 0.0, np.zeros(2), np.zeros(2), peak_left, peak_right, valley, False

    ray1 = v_l / nl
    ray2 = v_r / nr
    cos_a = float(np.clip(np.dot(ray1, ray2), -1.0, 1.0))
    angle_deg = float(np.degrees(np.arccos(cos_a)))
    return angle_deg, ray1, ray2, peak_left, peak_right, valley, True


def analyze(total_mask, image_shape=None):
    """
    Full contour analysis pipeline.

    Returns
    -------
    result : dict
        contour, ellipse, min_rect, proximal_tip, distal_tip
    """
    contour = largest_contour(total_mask)
    ellipse, min_rect = fit_geometry(contour)
    (cx, cy), _, _ = ellipse
    proximal_tip = find_stem_tip_on_contour(contour, (cx, cy))
    distal_tip = find_distal_tip_on_contour(contour, (cx, cy))

    return {
        "contour": contour,
        "ellipse": ellipse,
        "min_rect": min_rect,
        "proximal_tip": proximal_tip,
        "distal_tip": distal_tip,
    }
