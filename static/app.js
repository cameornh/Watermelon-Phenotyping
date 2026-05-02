const singleForm = document.getElementById("single-form");
const singleFileInput = document.getElementById("single-file");
const singleStatus = document.getElementById("single-status");
const singleResult = document.getElementById("single-result");

const bulkForm = document.getElementById("bulk-form");
const bulkFilesInput = document.getElementById("bulk-files");
const bulkStatus = document.getElementById("bulk-status");
const bulkResults = document.getElementById("bulk-results");

function renderCard(container, item) {
  const card = document.createElement("article");
  card.className = "result-card";

  const title = document.createElement("h3");
  title.textContent = item.filename || "Unknown";
  card.appendChild(title);

  const message = document.createElement("p");
  message.textContent = item.message || "No message";
  card.appendChild(message);

  if (item.success && typeof item.r2 === "number") {
    const score = document.createElement("p");
    score.className = "score";
    score.textContent = `R2 score: ${item.r2.toFixed(4)}`;
    card.appendChild(score);
  }

  if (item.success && item.result_url) {
    const image = document.createElement("img");
    image.src = item.result_url;
    image.alt = `Processed result for ${item.filename}`;
    card.appendChild(image);
  }

  container.appendChild(card);
}

singleForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!singleFileInput.files.length) return;

  singleStatus.textContent = "Processing...";
  singleResult.innerHTML = "";

  const data = new FormData();
  data.append("file", singleFileInput.files[0]);

  try {
    const response = await fetch("/api/process-single", {
      method: "POST",
      body: data,
    });
    const payload = await response.json();

    if (!response.ok) {
      singleStatus.textContent = payload.error || "Failed to process image.";
      return;
    }

    singleStatus.textContent = payload.success
      ? "Completed."
      : "Finished with no result.";
    renderCard(singleResult, payload);
  } catch (error) {
    singleStatus.textContent = `Request failed: ${error.message}`;
  }
});

bulkForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!bulkFilesInput.files.length) return;

  bulkStatus.textContent = "Processing...";
  bulkResults.innerHTML = "";

  const data = new FormData();
  for (const file of bulkFilesInput.files) {
    data.append("files", file);
  }

  try {
    const response = await fetch("/api/process-bulk", {
      method: "POST",
      body: data,
    });
    const payload = await response.json();

    if (!response.ok) {
      bulkStatus.textContent = payload.error || "Failed to process files.";
      return;
    }

    const results = payload.results || [];
    bulkStatus.textContent = `Completed ${results.length} file(s).`;
    results.forEach((item) => renderCard(bulkResults, item));
  } catch (error) {
    bulkStatus.textContent = `Request failed: ${error.message}`;
  }
});
