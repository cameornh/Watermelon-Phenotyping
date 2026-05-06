const uploadForm = document.getElementById("upload-form");
const fileInput = document.getElementById("file-input");
const statusEl = document.getElementById("status");
const resultsSection = document.getElementById("results-section");
const slideshowBar = document.getElementById("slideshow-bar");
const btnPrev = document.getElementById("btn-prev");
const btnNext = document.getElementById("btn-next");
const resultSelect = document.getElementById("result-select");
const resultView = document.getElementById("result-view");
const exportFooter = document.getElementById("export-footer");
const exportCsvButton = document.getElementById("export-csv");
const exportStatus = document.getElementById("export-status");

const FEATURE_KEYS = [
  "px_to_mm",
  "mm_to_px",
  "perimeter_mm",
  "width_mm",
  "height_mm",
  "proximal_angle_deg",
  "total_area_mm2",
  "flesh_area_mm2",
  "rind_area_mm2",
  "flesh_area_ratio",
  "flesh_thickness_mm",
  "rind_thickness_mm",
];

const state = {
  results: [],
  index: 0,
};

function setFileLabelText() {
  const n = fileInput.files?.length || 0;
  const label = document.querySelector(".file-input-label");
  if (!label) return;
  if (n === 0) label.textContent = "Choose files";
  else if (n === 1) label.textContent = fileInput.files[0].name;
  else label.textContent = `${n} files selected`;
}

fileInput.addEventListener("change", setFileLabelText);

function showExportFooter(anySuccess) {
  if (anySuccess) {
    exportFooter.classList.remove("hidden");
  } else {
    exportFooter.classList.add("hidden");
    exportStatus.textContent = "";
  }
}

function fillSelect() {
  resultSelect.innerHTML = "";
  state.results.forEach((item, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = item.filename || `Image ${i + 1}`;
    resultSelect.appendChild(opt);
  });
  resultSelect.value = String(state.index);
}

function updateSlideshowChrome() {
  const n = state.results.length;
  if (n <= 1) {
    slideshowBar.classList.add("hidden");
    return;
  }
  slideshowBar.classList.remove("hidden");
  fillSelect();
  btnPrev.disabled = state.index <= 0;
  btnNext.disabled = state.index >= n - 1;
}

function renderMeta(item) {
  const meta = document.createElement("div");
  meta.className = "result-meta";

  const title = document.createElement("h2");
  title.textContent = item.filename || "Unknown";
  meta.appendChild(title);

  const msg = document.createElement("p");
  msg.className = "message";
  msg.textContent = item.message || "";
  meta.appendChild(msg);

  if (item.success && typeof item.r2 === "number") {
    const score = document.createElement("p");
    score.className = "score";
    score.textContent = `R² fit: ${item.r2.toFixed(4)}`;
    meta.appendChild(score);
  }

  if (item.success && item.features) {
    const list = document.createElement("ul");
    list.className = "feature-list";
    FEATURE_KEYS.forEach((key) => {
      if (typeof item.features[key] === "undefined") return;
      const li = document.createElement("li");
      li.textContent = `${key}: ${item.features[key]}`;
      list.appendChild(li);
    });
    meta.appendChild(list);
  }

  return meta;
}

function renderFigure(item) {
  const fig = document.createElement("figure");
  fig.className = "result-figure";
  if (item.success && item.result_url) {
    const img = document.createElement("img");
    img.src = item.result_url;
    img.alt = `Result: ${item.filename || ""}`;
    fig.appendChild(img);
  } else {
    const ph = document.createElement("div");
    ph.className = "placeholder";
    ph.textContent = "No preview (processing failed or no output image).";
    fig.appendChild(ph);
  }
  return fig;
}

function renderCurrent() {
  resultView.innerHTML = "";
  if (!state.results.length) return;

  const item = state.results[state.index];
  const layout = document.createElement("div");
  layout.className = "result-layout";
  layout.appendChild(renderMeta(item));
  layout.appendChild(renderFigure(item));
  resultView.appendChild(layout);
}

function setIndex(i) {
  const n = state.results.length;
  if (!n) return;
  state.index = Math.max(0, Math.min(i, n - 1));
  if (resultSelect.options.length) {
    resultSelect.value = String(state.index);
  }
  updateSlideshowChrome();
  renderCurrent();
}

btnPrev.addEventListener("click", () => setIndex(state.index - 1));
btnNext.addEventListener("click", () => setIndex(state.index + 1));
resultSelect.addEventListener("change", () => {
  const i = parseInt(resultSelect.value, 10);
  if (!Number.isNaN(i)) setIndex(i);
});

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!fileInput.files?.length) {
    statusEl.textContent = "Select at least one image.";
    return;
  }

  statusEl.textContent = "Processing…";
  resultsSection.classList.add("hidden");
  showExportFooter(false);
  state.results = [];
  state.index = 0;

  const data = new FormData();
  for (const file of fileInput.files) {
    data.append("files", file);
  }

  try {
    const response = await fetch("/api/process-bulk", {
      method: "POST",
      body: data,
    });
    const payload = await response.json();

    if (!response.ok) {
      statusEl.textContent = payload.error || "Request failed.";
      return;
    }

    const results = payload.results || [];
    state.results = results;
    state.index = 0;

    const anySuccess = results.some((r) => r.success);
    const okCount = results.filter((r) => r.success).length;
    statusEl.textContent =
      results.length === 0
        ? "No files processed."
        : `Done: ${okCount} of ${results.length} succeeded.`;

    if (results.length === 0) {
      return;
    }

    resultsSection.classList.remove("hidden");
    updateSlideshowChrome();
    renderCurrent();
    showExportFooter(anySuccess);
  } catch (err) {
    statusEl.textContent = `Request failed: ${err.message}`;
  }
});

exportCsvButton.addEventListener("click", async () => {
  exportStatus.textContent = "Preparing…";
  try {
    const response = await fetch("/api/export-csv");
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      exportStatus.textContent = payload.error || "Could not export.";
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "watermelon_features.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    exportStatus.textContent = "Download started.";
  } catch (err) {
    exportStatus.textContent = `Export failed: ${err.message}`;
  }
});

setFileLabelText();
