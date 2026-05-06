import os
import uuid
import csv
import io

import cv2
import numpy as np
from flask import Flask, Response, jsonify, render_template, request, send_from_directory
from werkzeug.utils import secure_filename

from web_pipeline import WatermelonProcessor

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
RESULTS_DIR = os.path.join(BASE_DIR, "web_results")
OUTPUT_DIR = os.path.join(RESULTS_DIR, "processed")
MODEL_PATH = os.path.join(BASE_DIR, "best.pt")
ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png"}

os.makedirs(OUTPUT_DIR, exist_ok=True)
app = Flask(__name__)

_DEFAULT_REFERENCE = os.path.join(BASE_DIR, "IMG_7000_standard.JPG")
REFERENCE_IMAGE_PATH = os.environ.get("REFERENCE_CHECKER_IMAGE", _DEFAULT_REFERENCE)
if not os.path.isfile(REFERENCE_IMAGE_PATH):
    raise SystemExit(
        f"Reference checker image required but not found: {REFERENCE_IMAGE_PATH}. "
        f"Set REFERENCE_CHECKER_IMAGE or add {_DEFAULT_REFERENCE}."
    )
try:
    processor = WatermelonProcessor(
        model_path=MODEL_PATH,
        output_dir=OUTPUT_DIR,
        reference_image_path=REFERENCE_IMAGE_PATH,
    )
except ValueError as exc:
    raise SystemExit(str(exc)) from exc

processed_feature_rows = []


def _features_for_json(features):
    """Drop _debug (holds ndarrays); Flask jsonify cannot serialize numpy arrays."""
    if not features:
        return None
    return {k: v for k, v in features.items() if k != "_debug"}


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


def _append_row(filename: str, result):
    public = _features_for_json(result.features)
    if not public:
        return
    row = {"filename": filename, "r2": result.r2_score}
    row.update(public)
    if result.calibration:
        ruler = result.calibration.get("ruler_px_per_mm")
        if ruler is not None:
            row["ruler_px_per_mm"] = ruler
    processed_feature_rows.append(row)


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
    _append_row(safe_name, result)

    return jsonify(
        {
            "success": True,
            "filename": safe_name,
            "message": result.message,
            "r2": result.r2_score,
            "result_url": f"/results/{result.output_filename}",
            "features": _features_for_json(result.features),
            "calibration": result.calibration,
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
                "features": _features_for_json(result.features),
                "calibration": result.calibration,
            }
        )
        _append_row(original_name, result)

    return jsonify({"results": output})


@app.get("/api/export-csv")
def export_csv():
    if not processed_feature_rows:
        return jsonify({"error": "No processed results available for CSV export yet."}), 400

    headers = []
    for row in processed_feature_rows:
        for key in row.keys():
            if key not in headers:
                headers.append(key)

    stream = io.StringIO()
    writer = csv.DictWriter(stream, fieldnames=headers, extrasaction="ignore")
    writer.writeheader()
    for row in processed_feature_rows:
        writer.writerow(row)

    csv_data = stream.getvalue()
    stream.close()
    return Response(
        csv_data,
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=watermelon_features.csv"},
    )


if __name__ == "__main__":
    # macOS often binds port 5000 to AirPlay Receiver; default to 5050 instead.
    port = int(os.environ.get("PORT", "5050"))
    app.run(host="0.0.0.0", port=port, debug=True)
