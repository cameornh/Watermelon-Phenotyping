import os
import cv2
import numpy as np
import matplotlib.pyplot as plt
from ultralytics import YOLO
from scipy.optimize import curve_fit
from scipy.ndimage import median_filter

# --- 1. CONFIGURATION ---
INPUT_DIR = "full_data"
MASK_DIR = "full_data_segmented_yolo"
OUTPUT_DIR = "full_data_fitted_results"
MODEL_PATH = "best.pt"

os.makedirs(MASK_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

# --- 2. PERIMETER MODEL ---
def watermelon_model(theta, Rx, Ry, c_a, d_top, w_top, d_bot, w_bot, phi, c_skew, c_bend):
    t = theta - phi 
    ellipse = (Rx * Ry) / np.sqrt((Ry * np.cos(t))**2 + (Rx * np.sin(t))**2)
    asymmetry = 1 + c_a * np.cos(t)**3
    divot_top = d_top * np.exp(w_top * (np.sin(t) - 1))
    divot_bot = d_bot * np.exp(w_bot * (-np.sin(t) - 1))
    return (ellipse * asymmetry) - divot_top - divot_bot + c_skew * np.sin(t) + c_bend * np.cos(t) * (np.sin(t)**2)

# --- 3. EXTRACTION FUNCTIONS ---

def get_stable_perimeter_data(g_mask, f_mask):
    """Extracts stable perimeter, actively picking the rind closest to the flesh."""
    cnts, _ = cv2.findContours(g_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not cnts: return None
    
    # RIND SELECTION: Pick the rind that overlaps most with the flesh mask
    best_cnt = None
    max_overlap = -1
    for cnt in cnts:
        temp_mask = np.zeros_like(g_mask)
        cv2.drawContours(temp_mask, [cnt], -1, 255, -1)
        overlap_area = cv2.countNonZero(cv2.bitwise_and(temp_mask, f_mask))
        if overlap_area > max_overlap:
            max_overlap = overlap_area
            best_cnt = cnt
            
    if best_cnt is None:
        best_cnt = max(cnts, key=cv2.contourArea) # Fallback to largest
        
    M = cv2.moments(best_cnt)
    if M['m00'] == 0: return None
    cx, cy = M['m10']/M['m00'], M['m01']/M['m00']

    pts = best_cnt.reshape(-1, 2)
    dx, dy = pts[:, 0] - cx, cy - pts[:, 1] 
    r_vals, t_vals = np.sqrt(dx**2 + dy**2), np.arctan2(dy, dx)

    num_bins = 360
    bins = np.linspace(-np.pi, np.pi, num_bins + 1)
    raw_r = np.full(num_bins, np.nan)
    for i in range(num_bins):
        mask = (t_vals >= bins[i]) & (t_vals < bins[i+1])
        if np.any(mask): raw_r[i] = np.max(r_vals[mask])
    
    v_idx = np.where(~np.isnan(raw_r))[0]
    raw_r[np.isnan(raw_r)] = np.interp(np.where(np.isnan(raw_r))[0], v_idx, raw_r[v_idx], period=360)
    final_r = median_filter(raw_r, size=7, mode='wrap')
    final_theta = (bins[:-1] + bins[1:]) / 2.0
    return final_theta, final_r, (cx, cy), best_cnt

def get_ray_scan_midline(f_mask, g_cnt, pred_cnt, cx, cy):
    """Midline logic with Regularization (Anti-overfitting) and Predicted-Perimeter bounds."""
    h, w = f_mask.shape
    
    # 1. Align fruit vertically
    if len(g_cnt) > 5:
        _, (ma, Ma), angle = cv2.fitEllipse(g_cnt)
        rot_angle = angle if ma < Ma else angle + 90
    else:
        rot_angle = 0
        
    M_rot = cv2.getRotationMatrix2D((cx, cy), rot_angle, 1.0)
    M_inv = cv2.getRotationMatrix2D((cx, cy), -rot_angle, 1.0)
    f_rot = cv2.warpAffine(f_mask, M_rot, (w, h))

    # 2. Ray-Scan Logic
    gap_points =[]
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

    # 3. Fitting and Extrapolation
    gap_points = np.array(gap_points)
    
    if len(gap_points) > 10:
        # Normalization helps the regression stay mathematically stable
        y_min, y_max = np.min(gap_points[:, 0]), np.max(gap_points[:, 0])
        y_span = max(y_max - y_min, 1)
        y_mean = (y_max + y_min) / 2.0
        
        y_norm = (gap_points[:, 0] - y_mean) / y_span
        x_data = gap_points[:, 1]
        
        def parabola(y_n, a, b, c): return a * (y_n**2) + b * y_n + c
        
        # REGULARIZATION: Force spline to prefer being straight
        # Max bend is bounded to 8% of the image width to prevent wild hairpin turns
        max_bend = w * 0.08 
        try:
            popt_mid, _ = curve_fit(parabola, y_norm, x_data, bounds=([-max_bend, -np.inf, -np.inf],[max_bend, np.inf, np.inf]))
        except:
            popt_mid = [0.0, 0.0, cx]
        
        # Evaluate across full height to ensure it hits the perimeter
        ys_extrap = np.linspace(0, h, 500)
        ys_extrap_norm = (ys_extrap - y_mean) / y_span
        xs_extrap = parabola(ys_extrap_norm, *popt_mid)
        pts_rot = np.vstack([xs_extrap, ys_extrap, np.ones_like(xs_extrap)])
        
    else:
        # Fallback: Straight line down the major axis
        ys_extrap = np.linspace(0, h, 500)
        xs_extrap = np.full_like(ys_extrap, cx)
        pts_rot = np.vstack([xs_extrap, ys_extrap, np.ones_like(xs_extrap)])

    # Transform back to original image orientation
    pts_orig = (M_inv @ pts_rot).T
    
    # 4. CLIP TO PREDICTED PERIMETER
    # Convert the predicted float coordinates into an integer OpenCV contour
    pred_cnt_cv = pred_cnt.reshape(-1, 1, 2).astype(np.int32)
    
    final_line =[]
    for pt in pts_orig:
        if cv2.pointPolygonTest(pred_cnt_cv, (float(pt[0]), float(pt[1])), False) >= 0:
            final_line.append(pt)
            
    return np.array(final_line)

# --- 4. MAIN PIPELINE ---
def main():
    model = YOLO(MODEL_PATH)
    image_files = sorted([f for f in os.listdir(INPUT_DIR) if f.lower().endswith(('.jpg', '.jpeg', '.png'))])
    r2_scores =[]

    for img_name in image_files:
        img_id = os.path.splitext(img_name)[0]
        img = cv2.imread(os.path.join(INPUT_DIR, img_name))
        if img is None: continue
        h, w = img.shape[:2]

        # YOLO Inference
        results = model(img, conf=0.25, verbose=False)
        rind_m, flesh_m = np.zeros((h, w), dtype=np.uint8), np.zeros((h, w), dtype=np.uint8)
        if results[0].masks is not None:
            for mask_data, cls in zip(results[0].masks.xy, results[0].boxes.cls):
                contour = np.array(mask_data, dtype=np.int32)
                if int(cls) == 0: cv2.drawContours(rind_m, [contour], -1, 255, -1)
                elif int(cls) == 1: cv2.drawContours(flesh_m, [contour], -1, 255, -1)
        
        mask_sub = os.path.join(MASK_DIR, img_id)
        os.makedirs(mask_sub, exist_ok=True)
        cv2.imwrite(os.path.join(mask_sub, "rind.jpg"), rind_m)
        cv2.imwrite(os.path.join(mask_sub, "flesh.jpg"), flesh_m)

        try:
            # 1. Independent Perimeter Fit (Now correctly selects the best rind mask)
            perim = get_stable_perimeter_data(rind_m, flesh_m)
            if perim is None: continue
            t_data, r_raw, (cx, cy), g_cnt = perim
            
            scale = np.mean(r_raw)
            popt, _ = curve_fit(watermelon_model, t_data, r_raw/scale, 
                                p0=[1.0, 1.1, 0.0, 0.05, 3.0, 0.05, 3.0, 0.0, 0.0, 0.0],
                                bounds=([0.5, 0.5, -0.4, 0, 0.1, 0, 0.1, -1.5, -0.2, -0.2],[2.0, 2.0,  0.4, 0.5, 50,  0.5, 50,   1.5,  0.2,  0.2]))
            
            r_sq = 1 - (np.sum((r_raw/scale - watermelon_model(t_data, *popt))**2) / np.sum((r_raw/scale - 1)**2))
            r2_scores.append(r_sq)

            # 2. Calculate the PREDICTED perimeter points
            t_fit = np.linspace(-np.pi, np.pi, 500)
            r_fit = watermelon_model(t_fit, *popt) * scale
            fit_pts = np.array([[r*np.cos(t)+cx, cy-r*np.sin(t)] for t, r in zip(t_fit, r_fit)])

            # 3. Independent Midline (Clipped to the PREDICTED perimeter)
            midline = get_ray_scan_midline(flesh_m, g_cnt, fit_pts, cx, cy)

            # 4. Draw and Save
            if len(midline) > 1:
                cv2.polylines(img, [midline.astype(np.int32)], False, (0, 255, 255), 3)
            
            cv2.polylines(img, [fit_pts.astype(np.int32)], True, (0, 255, 0), 3)

            cv2.imwrite(os.path.join(OUTPUT_DIR, f"fitted_{img_id}.jpg"), img)
            print(f"Processed {img_id}: R² = {r_sq:.4f}")

        except Exception as e:
            print(f"   Error {img_id}: {e}")

    if r2_scores:
        plt.figure(figsize=(8, 6))
        plt.hist(r2_scores, bins=15, color='skyblue', edgecolor='black')
        plt.title('Dataset Fit Quality Distribution')
        plt.xlabel('R² Value')
        plt.ylabel('Count')
        
        # Prominent Summary Text
        mean_r2 = np.mean(r2_scores)
        summary_text = f"Total Processed: {len(r2_scores)} | Mean R²: {mean_r2:.4f}"
        plt.figtext(0.5, 0.01, summary_text, ha="center", fontsize=12, fontweight='bold', 
                    bbox={"facecolor":"white", "alpha":0.9, "pad":6, "edgecolor":"black"})
        
        plt.savefig("dataset_performance_summary.png", bbox_inches='tight')

if __name__ == "__main__":
    main()
