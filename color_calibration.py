"""
Color calibration via X-Rite ColorChecker Classic (24 patches).

Detects the checker in both a reference and target image, computes a
white-balance + CCM + luminance correction pipeline, and applies it to
the full target image.
"""

import cv2 as cv
import numpy as np


# ── linear / sRGB helpers ──────────────────────────────────────────

def to_linear_srgb(u8_bgr):
    rgb = cv.cvtColor(u8_bgr, cv.COLOR_BGR2RGB).astype(np.float32) / 255.0
    a = 0.055
    lin = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + a) / (1 + a)) ** 2.4)
    return lin


def to_srgb_u8(lin_rgb):
    a = 0.055
    srgb = np.where(lin_rgb <= 0.0031308, 12.92 * lin_rgb, (1 + a) * np.power(lin_rgb, 1/2.4) - a)
    srgb = np.clip(srgb, 0, 1)
    return cv.cvtColor((srgb * 255.0).astype(np.uint8), cv.COLOR_RGB2BGR)


# ── checker geometry ───────────────────────────────────────────────

def warp_checker(img, corners, out_w=600, out_h=400):
    dst = np.float32([[0, 0], [out_w-1, 0], [out_w-1, out_h-1], [0, out_h-1]])
    H = cv.getPerspectiveTransform(np.float32(corners), dst)
    warped = cv.warpPerspective(img, H, (out_w, out_h), flags=cv.INTER_CUBIC)
    return warped


def detect_checker_corners(img_bgr):
    det = cv.mcc.CCheckerDetector_create()
    ok = det.process(img_bgr, cv.mcc.MCC24)
    if not ok:
        raise RuntimeError("ColorChecker not found")
    lst = det.getListColorChecker()
    cc = lst[0]
    if hasattr(cc, "getBox"):
        corners = np.array(cc.getBox(), dtype=np.float32)
    else:
        corners = np.array(cc.getCorners(), dtype=np.float32)
    return corners


def sample_24_patches(warped, margin=12):
    H, W = warped.shape[:2]
    cell_w, cell_h = W / 6.0, H / 4.0
    lin = to_linear_srgb(warped)
    means = []
    for r in range(4):
        for c in range(6):
            x0 = int(c * cell_w + margin); x1 = int((c+1) * cell_w - margin)
            y0 = int(r * cell_h + margin); y1 = int((r+1) * cell_h - margin)
            roi = lin[y0:y1, x0:x1]
            means.append(np.median(roi.reshape(-1, 3), axis=0))
    return np.stack(means, 0)


# ── calibration math ──────────────────────────────────────────────

def white_balance_neutrals(src24, ref24):
    idx = np.arange(18, 24)
    src_g = src24[idx].mean(0)
    ref_g = ref24[idx].mean(0)
    gains = ref_g / np.maximum(src_g, 1e-6)
    return gains


def solve_ccm_no_bias(src24, ref24, use_indices):
    A = src24[use_indices]
    B = ref24[use_indices]
    X, *_ = np.linalg.lstsq(A, B, rcond=None)
    M = X.T
    return M


def fit_monotone_luma_curve_midgrays(src24_lin, ref24_lin):
    mid_idx = np.array([19, 20, 21, 22])
    w = np.array([0.2126, 0.7152, 0.0722], np.float32)

    Ls = (src24_lin[mid_idx] @ w).astype(np.float32)
    Lt = (ref24_lin[mid_idx] @ w).astype(np.float32)

    eps_lo, eps_hi = 0.01, 0.98
    Ls = np.concatenate([[eps_lo], np.sort(Ls), [eps_hi]])
    Lt = np.concatenate([[eps_lo], np.sort(Lt), [eps_hi]])

    def map_luma(L):
        L = np.clip(L, 0, 1)
        j = np.searchsorted(Ls, L, side='right') - 1
        j = np.clip(j, 0, len(Ls)-2)
        t = (L - Ls[j]) / np.maximum(Ls[j+1] - Ls[j], 1e-6)
        return (1 - t) * Lt[j] + t * Lt[j+1]
    return map_luma


def soft_highlight_rolloff(L, knee=0.90, strength=0.6):
    below = L < knee
    out = np.empty_like(L, dtype=np.float32)
    out[below] = L[below]
    x = (L[~below] - knee) / max(1e-6, (1.0 - knee))
    out[~below] = knee + (1.0 - knee) * (1.0 - np.exp(-strength * x))
    return out


# ── full correction pipeline ─────────────────────────────────────

def apply_pipeline(target_bgr_u8, ref24, tgt24):
    gains = white_balance_neutrals(tgt24, ref24)

    lin = to_linear_srgb(target_bgr_u8)
    lin_wb = lin * gains.reshape(1, 1, 3)

    tgt24_wb = tgt24 * gains

    chroma_idx = np.arange(0, 18)
    M = solve_ccm_no_bias(tgt24_wb, ref24, chroma_idx)

    H, W = lin_wb.shape[:2]
    corrected = lin_wb.reshape(-1, 3) @ M.T
    corrected = corrected.reshape(H, W, 3)

    map_luma = fit_monotone_luma_curve_midgrays(tgt24_wb, ref24)
    w = np.array([0.2126, 0.7152, 0.0722], np.float32)
    L = np.clip(np.tensordot(corrected, w, axes=([2], [0])), 0, 1)
    Lt = map_luma(L)
    Lt = soft_highlight_rolloff(Lt, knee=0.90, strength=0.6)
    eps = 1e-6
    scale = (Lt + eps) / (L + eps)
    corrected = corrected * scale[..., None]

    corrected = np.clip(corrected, 0, 1)
    return to_srgb_u8(corrected)
