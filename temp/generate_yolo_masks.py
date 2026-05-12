import os
import cv2
import numpy as np
from ultralytics import YOLO

# --- CONFIGURATION ---
MODEL_PATH = "best.pt"
INPUT_DIR = "UGAvision/corrected_images"
OUTPUT_BASE = "UGAvision/segmented_images_yolo"

def generate_masks():
    model = YOLO(MODEL_PATH)
    os.makedirs(OUTPUT_BASE, exist_ok=True)
    
    # Support multiple extensions
    images = [f for f in os.listdir(INPUT_DIR) if f.lower().endswith(('.jpg', '.jpeg', '.png'))]
    
    print(f"Found {len(images)} images. Processing...")

    for img_name in images:
        img_path = os.path.join(INPUT_DIR, img_name)
        img = cv2.imread(img_path)
        h, w = img.shape[:2]
        
        # Create output folder for this image (e.g., IMG_1)
        folder_name = os.path.splitext(img_name)[0]
        save_path = os.path.join(OUTPUT_BASE, folder_name)
        os.makedirs(save_path, exist_ok=True)

        # Run YOLO inference
        results = model(img, conf=0.25, verbose=False)
        result = results[0]

        # Initialize empty masks
        rind_mask = np.zeros((h, w), dtype=np.uint8)
        flesh_mask = np.zeros((h, w), dtype=np.uint8)

        if result.masks is not None:
            for mask_data, cls in zip(result.masks.xy, result.boxes.cls):
                # Convert normalized/pixel coords to integer contour
                contour = np.array(mask_data, dtype=np.int32)
                
                if int(cls) == 0: # watermelon_whole
                    cv2.drawContours(rind_mask, [contour], -1, 255, -1)
                elif int(cls) == 1: # flesh_half
                    cv2.drawContours(flesh_mask, [contour], -1, 255, -1)

        # Save masks to match your expected naming convention
        cv2.imwrite(os.path.join(save_path, "rind.jpg"), rind_mask)
        cv2.imwrite(os.path.join(save_path, "flesh.jpg"), flesh_mask)
        print(f"Done: {folder_name}")

if __name__ == "__main__":
    generate_masks()
