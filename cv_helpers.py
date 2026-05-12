"""Shared CV helpers: mask visualization and stem-tip heuristic."""

import numpy as np


def blend_mask_overlays(bgr, rind_mask, flesh_mask, alpha=0.42):
    """
    Semi-transparent rind (green tint) and flesh (orange tint) on top of the BGR image.
    Flesh is drawn after rind so overlap reads clearly.
    """
    out = bgr.astype(np.float32)
    rind_m = (rind_mask > 0).astype(np.float32)
    flesh_m = (flesh_mask > 0).astype(np.float32)
    rind_color = np.array([0.0, 170.0, 0.0], dtype=np.float32)
    flesh_color = np.array([60.0, 120.0, 255.0], dtype=np.float32)
    for c in range(3):
        ch = out[..., c]
        ch[:] = ch * (1.0 - alpha * rind_m) + rind_color[c] * (alpha * rind_m)
    for c in range(3):
        ch = out[..., c]
        ch[:] = ch * (1.0 - alpha * flesh_m) + flesh_color[c] * (alpha * flesh_m)
    return np.clip(out, 0, 255).astype(np.uint8)


def stem_tip_tangent_deg(contour, centroid_xy):
    """
    Heuristic "stem / neck" pole on the rind contour: take PCA major-axis extremes,
    then pick the end with sharper local turning (inward-curving neck). Tie-break:
    smaller image y (overhead shots often have stem toward top of frame).

    Returns (tip_x, tip_y, tangent_deg) where tangent_deg is atan2(dy, dx) in degrees,
    or None if not enough contour points.
    """
    cnt = contour.reshape(-1, 2).astype(np.float64)
    n = len(cnt)
    if n < 9:
        return None

    cx, cy = float(centroid_xy[0]), float(centroid_xy[1])
    X = cnt - np.array([cx, cy])
    cov = np.cov(X.T)
    eigvals, eigvecs = np.linalg.eigh(cov)
    u = eigvecs[:, int(np.argmax(eigvals))]
    un = np.linalg.norm(u)
    if un < 1e-9:
        return None
    u /= un

    s = X @ u
    idx_a = int(np.argmax(s))
    idx_b = int(np.argmin(s))
    span = max(3, min(25, n // 30))

    def curvature_score(i):
        p = cnt[i % n]
        prev = cnt[(i - span) % n]
        nxt = cnt[(i + span) % n]
        v1 = p - prev
        v2 = nxt - p
        nv1 = np.linalg.norm(v1)
        nv2 = np.linalg.norm(v2)
        if nv1 < 1e-6 or nv2 < 1e-6:
            return 0.0
        v1u = v1 / nv1
        v2u = v2 / nv2
        return abs(v1u[0] * v2u[1] - v1u[1] * v2u[0])

    ka, kb = curvature_score(idx_a), curvature_score(idx_b)
    if abs(ka - kb) < 0.05:
        stem_idx = idx_a if cnt[idx_a, 1] < cnt[idx_b, 1] else idx_b
    else:
        stem_idx = idx_a if ka > kb else idx_b

    span_t = max(2, span // 2)
    d = cnt[(stem_idx + span_t) % n] - cnt[(stem_idx - span_t) % n]
    tang_deg = float(np.degrees(np.arctan2(d[1], d[0])))
    tip = cnt[stem_idx]
    return float(tip[0]), float(tip[1]), tang_deg