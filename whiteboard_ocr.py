"""
Whiteboard ID: HSV white mask → largest contour → axis-aligned crop → EasyOCR (handwriting).
No perspective warp; one OCR inference on the crop.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List, Optional, Tuple

import cv2
import numpy as np

# Top-right search window (fractions of full image)
ROI_X0_FRAC = 0.50
ROI_X1_FRAC = 0.995
ROI_Y0_FRAC = 0.02
ROI_Y1_FRAC = 0.48

# White in HSV: high V, low S (tweak if lighting changes)
HSV_V_MIN = 190
HSV_S_MAX = 50

# Contour must be a plausible board, not the entire ROI or specks
MIN_AREA_FRAC = 0.012
MAX_AREA_FRAC = 0.48

# Expand bounding box slightly before crop (fraction of w/h)
BBOX_PAD_FRAC = 0.02

# If the crop is tiny, upscale so EasyOCR has enough pixels (one resize only)
OCR_MIN_LONG_SIDE = 320


@dataclass
class WhiteboardRead:
    found_board: bool
    text: Optional[str]
    confidence: Optional[float]


_ocr_reader = None


def _get_reader():
    global _ocr_reader
    if _ocr_reader is None:
        import easyocr

        _ocr_reader = easyocr.Reader(["en"], gpu=False, verbose=False)
    return _ocr_reader


def _largest_board_contour(mask: np.ndarray, roi_area: float):
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    min_a = MIN_AREA_FRAC * roi_area
    max_a = MAX_AREA_FRAC * roi_area
    best = None
    best_area = 0.0
    for c in contours:
        a = cv2.contourArea(c)
        if a < min_a or a > max_a:
            continue
        if a > best_area:
            best_area = a
            best = c
    return best


def _normalize_dashes(s: str) -> str:
    for ch in "\u2010\u2011\u2012\u2013\u2014\u2212":
        s = s.replace(ch, "-")
    return s


def _id_chars_only(segment: str) -> str:
    """Keep digits and hyphen only (e.g. 743-1)."""
    return re.sub(r"[^\d\-]", "", _normalize_dashes(segment))


def _finalize_id(merged: str) -> Optional[str]:
    s = re.sub(r"-+", "-", merged).strip("-")
    if not s or not any(c.isdigit() for c in s):
        return None
    return s


def _run_easyocr_once(bgr: np.ndarray) -> Tuple[Optional[str], Optional[float]]:
    if bgr.size == 0:
        return None, None
    reader = _get_reader()
    kw = {"detail": 1, "paragraph": False}

    def from_results(results) -> Tuple[Optional[str], Optional[float]]:
        if not results:
            return None, None
        scored: List[Tuple[float, str, float]] = []
        for bbox, text, conf in results:
            seg = _id_chars_only(str(text))
            if not seg:
                continue
            x = float(min(p[0] for p in bbox))
            scored.append((x, seg, float(conf)))
        if not scored:
            return None, None
        scored.sort(key=lambda t: t[0])
        merged = _finalize_id("".join(t[1] for t in scored))
        if not merged:
            return None, None
        return merged, float(np.mean([t[2] for t in scored]))

    out = from_results(reader.readtext(bgr, allowlist="0123456789-", **kw))
    if out[0]:
        return out
    return from_results(reader.readtext(bgr, **kw))


def read_whiteboard_handwriting(image_bgr: np.ndarray) -> WhiteboardRead:
    if image_bgr is None or image_bgr.size == 0:
        return WhiteboardRead(False, None, None)

    H, W = image_bgr.shape[:2]
    rx0 = int(W * ROI_X0_FRAC)
    rx1 = int(W * ROI_X1_FRAC)
    ry0 = int(H * ROI_Y0_FRAC)
    ry1 = int(H * ROI_Y1_FRAC)
    if rx1 <= rx0 or ry1 <= ry0:
        return WhiteboardRead(False, None, None)

    roi = image_bgr[ry0:ry1, rx0:rx1]
    roi_area = float(roi.shape[0] * roi.shape[1])

    try:
        hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
        _, S, V = cv2.split(hsv)
        mask = ((V >= HSV_V_MIN) & (S <= HSV_S_MAX)).astype(np.uint8) * 255
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))

        cnt = _largest_board_contour(mask, roi_area)
        if cnt is None:
            return WhiteboardRead(False, None, None)

        x, y, bw, bh = cv2.boundingRect(cnt)
        pad_x = int(bw * BBOX_PAD_FRAC) + 2
        pad_y = int(bh * BBOX_PAD_FRAC) + 2
        gx0 = max(0, rx0 + x - pad_x)
        gy0 = max(0, ry0 + y - pad_y)
        gx1 = min(W, rx0 + x + bw + pad_x)
        gy1 = min(H, ry0 + y + bh + pad_y)
        if gx1 <= gx0 or gy1 <= gy0:
            return WhiteboardRead(False, None, None)

        crop = image_bgr[gy0:gy1, gx0:gx1].copy()
        ch, cw = crop.shape[:2]
        long_side = max(ch, cw)
        if long_side < OCR_MIN_LONG_SIDE and long_side > 0:
            s = OCR_MIN_LONG_SIDE / float(long_side)
            crop = cv2.resize(crop, (int(cw * s), int(ch * s)), interpolation=cv2.INTER_CUBIC)

        label, conf = _run_easyocr_once(crop)
        if label is None:
            return WhiteboardRead(True, None, None)
        return WhiteboardRead(True, label, conf)
    except Exception:
        return WhiteboardRead(False, None, None)
