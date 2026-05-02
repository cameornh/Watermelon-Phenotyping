import os
import uuid

import cv2
import numpy as np
from flask import Flask, jsonify, render_template, request, send_from_directory
from werkzeug.utils import secure_filename

from web_pipeline import WatermelonProcessor

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
RESULTS_DIR = os.path.join(BASE_DIR, "web_results")
OUTPUT_DIR = os.path.join(RESULTS_DIR, "processed")
MODEL_PATH = os.path.join(BASE_DIR, "best.pt")
ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png"}

os.makedirs(OUTPUT_DIR, exist_ok=True)
app = Flask(__name__)
processor = WatermelonProcessor(model_path=MODEL_PATH, output_dir=OUTPUT_DIR)


def is_allowed_file(filename: str) -> bool:
    ext = os.path.splitext(filename.lower())[1]
    return ext in ALLOWED_EXTENSIONS


def decode_upload(file_storage):
    file_bytes = file_storage.read()
    np_arr = np.frombuffer(file_bytes, np.uint8)
    return cv2.imdecode(np_arr, cv2.IMREAD_COLOR)


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/results/<path:filename>")
def get_result_file(filename: str):
    return send_from_directory(OUTPUT_DIR, filename)


@app.post("/api/process-single")
def process_single():
    if "file" not in request.files:
        return jsonify({"error": "No file provided."}), 400

    uploaded = request.files["file"]
    if uploaded.filename == "":
        return jsonify({"error": "No file selected."}), 400
    if not is_allowed_file(uploaded.filename):
        return jsonify({"error": "Only .jpg, .jpeg, and .png are supported."}), 400

    safe_name = secure_filename(uploaded.filename)
    unique_name = f"{uuid.uuid4().hex}_{safe_name}"
    image = decode_upload(uploaded)
    result = processor.process_image(image, unique_name)
    if not result.success:
        return jsonify({"success": False, "filename": safe_name, "message": result.message}), 200

    return jsonify(
        {
            "success": True,
            "filename": safe_name,
            "message": result.message,
            "r2": result.r2_score,
            "result_url": f"/results/{result.output_filename}",
        }
    )


@app.post("/api/process-bulk")
def process_bulk():
    files = request.files.getlist("files")
    if not files:
        return jsonify({"error": "No files provided."}), 400

    output = []
    for uploaded in files:
        if uploaded.filename == "":
            continue

        original_name = secure_filename(uploaded.filename)
        if not is_allowed_file(original_name):
            output.append(
                {
                    "success": False,
                    "filename": original_name,
                    "message": "Unsupported extension. Use .jpg, .jpeg, or .png",
                }
            )
            continue

        unique_name = f"{uuid.uuid4().hex}_{original_name}"
        image = decode_upload(uploaded)
        result = processor.process_image(image, unique_name)
        if not result.success:
            output.append(
                {
                    "success": False,
                    "filename": original_name,
                    "message": result.message,
                }
            )
            continue

        output.append(
            {
                "success": True,
                "filename": original_name,
                "message": result.message,
                "r2": result.r2_score,
                "result_url": f"/results/{result.output_filename}",
            }
        )

    return jsonify({"results": output})


if __name__ == "__main__":
    # macOS often binds port 5000 to AirPlay Receiver; default to 5050 instead.
    port = int(os.environ.get("PORT", "5050"))
    app.run(host="0.0.0.0", port=port, debug=True)
