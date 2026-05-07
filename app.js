// For local testing, change to http://localhost:8000/process_single
const API_URL = "https://crabbly-watermelonphenotyping.hf.space/process_single";

function processUrl(includeImage) {
    return `${API_URL}?include_image=${includeImage ? "true" : "false"}`;
}

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#039;"
    }[ch]));
}

function isNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

function fmt(value, digits = 1) {
    return isNumber(value) ? value.toFixed(digits) : "N/A";
}

function measurementUnit(data) {
    if (data.measurement_unit) return data.measurement_unit;
    return data.delta_e_final !== null && data.delta_e_final !== undefined ? "cm" : "px";
}

function rowNotes(data) {
    const notes = [];
    if (Array.isArray(data.warnings)) notes.push(...data.warnings);
    if (data.rind_source && data.rind_source !== "whole_mask_overlap") {
        notes.push(`rind: ${data.rind_source}`);
    }
    return notes.join(" | ");
}

async function postImage(file, includeImage) {
    const formData = new FormData();
    formData.append("file", file);

    const response = await fetch(processUrl(includeImage), { method: "POST", body: formData });
    const text = await response.text();
    let data;

    try {
        data = text ? JSON.parse(text) : {};
    } catch (err) {
        const snippet = text ? text.slice(0, 180) : "empty response";
        throw new Error(`HTTP ${response.status}: non-JSON response (${snippet})`);
    }

    if (!response.ok) {
        throw new Error(data.message || `HTTP ${response.status}`);
    }

    return data;
}

function previewCell(data) {
    if (data.image_base64) {
        return `<img src="data:image/jpeg;base64,${data.image_base64}" class="thumb" onclick="window.open(this.src)">`;
    }
    return `<span class="muted">Disabled</span>`;
}

document.getElementById("single-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = document.getElementById("single-file").files[0];
    const status = document.getElementById("single-status");
    const resultDiv = document.getElementById("single-result");

    status.innerText = "Processing...";
    resultDiv.innerHTML = "";

    try {
        const data = await postImage(file, true);

        if (data.success) {
            const unit = measurementUnit(data);
            const digits = unit === "cm" ? 2 : 0;
            const notes = rowNotes(data);
            status.innerText = "Success!";

            let scaleText = `<p><strong>Scale:</strong> Measurements are in ${escapeHtml(unit)}.</p>`;
            if (data.delta_e_initial !== null && data.delta_e_final !== null) {
                scaleText = `<p><strong>Delta E:</strong> ${fmt(data.delta_e_initial, 2)} to ${fmt(data.delta_e_final, 2)}</p>`;
            } else if (!data.color_checker_found) {
                scaleText = `<p><strong>Scale:</strong> ColorChecker not found; dimensions are original-image pixels.</p>`;
            }

            resultDiv.innerHTML = `
                <p><strong>R²:</strong> ${fmt(data.r2_score, 4)}</p>
                <p><strong>Width:</strong> ${fmt(data.width_val, digits)} ${escapeHtml(unit)}</p>
                <p><strong>Height:</strong> ${fmt(data.height_val, digits)} ${escapeHtml(unit)}</p>
                <p><strong>Perimeter:</strong> ${fmt(data.perimeter_val, digits)} ${escapeHtml(unit)}</p>
                ${scaleText}
                ${notes ? `<p><strong>Notes:</strong> ${escapeHtml(notes)}</p>` : ""}
                ${isNumber(data.processing_ms) ? `<p><strong>Time:</strong> ${data.processing_ms} ms</p>` : ""}
                ${data.image_base64 ? `<img src="data:image/jpeg;base64,${data.image_base64}" style="max-width: 100%; border-radius: 8px;">` : ""}
            `;
        } else {
            const notes = rowNotes(data);
            status.innerText = `Error: ${data.message}`;
            resultDiv.innerHTML = notes ? `<p><strong>Notes:</strong> ${escapeHtml(notes)}</p>` : "";
        }
    } catch (err) {
        status.innerText = `API request failed: ${err.message}`;
    }
});

document.getElementById("bulk-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const files = document.getElementById("bulk-files").files;
    const includeImages = document.getElementById("bulk-previews").checked;
    const status = document.getElementById("bulk-status");
    const table = document.getElementById("bulk-table");
    const tbody = table.querySelector("tbody");
    const chartsContainer = document.getElementById("histograms-container");

    tbody.innerHTML = "";
    chartsContainer.innerHTML = "";
    table.style.display = "table";

    let completed = 0;
    let successCount = 0;
    let failureCount = 0;
    let pixelScaleCount = 0;

    const batchData = {
        "R² Score": [],
        "Width (cm)": [],
        "Height (cm)": [],
        "Perimeter (cm)": [],
        "Initial ΔE": [],
        "Final ΔE": []
    };

    for (let i = 0; i < files.length; i++) {
        status.innerText = `Processing image ${i + 1} of ${files.length}...`;

        try {
            const data = await postImage(files[i], includeImages);
            const tr = document.createElement("tr");

            if (data.success) {
                successCount++;
                const unit = measurementUnit(data);
                const digits = unit === "cm" ? 1 : 0;
                const notes = rowNotes(data);

                if (isNumber(data.r2_score)) batchData["R² Score"].push(data.r2_score);
                if (unit === "cm") {
                    if (isNumber(data.width_val)) batchData["Width (cm)"].push(data.width_val);
                    if (isNumber(data.height_val)) batchData["Height (cm)"].push(data.height_val);
                    if (isNumber(data.perimeter_val)) batchData["Perimeter (cm)"].push(data.perimeter_val);
                } else {
                    pixelScaleCount++;
                }
                if (isNumber(data.delta_e_initial)) batchData["Initial ΔE"].push(data.delta_e_initial);
                if (isNumber(data.delta_e_final)) batchData["Final ΔE"].push(data.delta_e_final);

                tr.innerHTML = `
                    <td>${escapeHtml(data.filename || files[i].name)}</td>
                    <td>${fmt(data.r2_score, 4)}</td>
                    <td>${fmt(data.width_val, digits)}</td>
                    <td>${fmt(data.height_val, digits)}</td>
                    <td>${fmt(data.perimeter_val, digits)}</td>
                    <td>${escapeHtml(unit)}</td>
                    <td>${fmt(data.delta_e_initial, 2)}</td>
                    <td>${fmt(data.delta_e_final, 2)}</td>
                    <td>${isNumber(data.processing_ms) ? `${data.processing_ms} ms` : "N/A"}</td>
                    <td>${notes ? escapeHtml(notes) : ""}</td>
                    <td>${previewCell(data)}</td>
                `;
            } else {
                failureCount++;
                tr.innerHTML = `<td>${escapeHtml(files[i].name)}</td><td colspan="10" style="color:red;">Error: ${escapeHtml(data.message)}</td>`;
            }
            tbody.appendChild(tr);
        } catch (err) {
            failureCount++;
            const tr = document.createElement("tr");
            tr.innerHTML = `<td>${escapeHtml(files[i].name)}</td><td colspan="10" style="color:red;">API request failed: ${escapeHtml(err.message)}</td>`;
            tbody.appendChild(tr);
        }

        completed++;
    }

    const excludedText = pixelScaleCount > 0 ? ` ${pixelScaleCount} pixel-scale row(s) excluded from cm histograms.` : "";
    status.innerText = `Batch complete: ${successCount} succeeded, ${failureCount} failed, ${completed} attempted.${excludedText}`;
    drawHistograms(batchData, chartsContainer);
});

function drawHistograms(batchData, container) {
    const deKeys = ["Initial ΔE", "Final ΔE"];
    let allDE = [];
    deKeys.forEach(k => {
        if (batchData[k]) allDE.push(...batchData[k].filter(isNumber));
    });

    let deMin = 0, deMax = 1, deNumBins = 10, deBinWidth = 0.1, deMaxY = null;
    if (allDE.length > 0) {
        allDE.sort((a, b) => a - b);
        deMin = allDE[0];
        deMax = allDE[allDE.length - 1];
        if (deMin === deMax) { deMin *= 0.9; deMax *= 1.1; }
        if (deMin === deMax && deMin === 0) { deMax = 1; }
        const pad = (deMax - deMin) * 0.02;
        deMin -= pad; deMax += pad;

        deNumBins = Math.max(8, Math.min(20, Math.ceil(Math.sqrt(batchData["Initial ΔE"].length || 1))));
        deBinWidth = (deMax - deMin) / deNumBins || 1;

        let maxCount = 0;
        deKeys.forEach(k => {
            const vals = batchData[k] ? batchData[k].filter(isNumber) : [];
            const counts = new Array(deNumBins).fill(0);
            vals.forEach(val => {
                let idx = Math.floor((val - deMin) / deBinWidth);
                if (idx >= deNumBins) idx = deNumBins - 1;
                if (idx < 0) idx = 0;
                counts[idx]++;
            });
            maxCount = Math.max(maxCount, Math.max(...counts));
        });
        deMaxY = maxCount + Math.ceil(maxCount * 0.1);
    }

    let chartCount = 0;
    for (const [title, rawValues] of Object.entries(batchData)) {
        const values = rawValues.filter(isNumber);
        if (values.length === 0) continue;

        let min, max, numBins, binWidth, maxY;
        const isDE = title.includes("ΔE");

        if (isDE && allDE.length > 0) {
            min = deMin; max = deMax; numBins = deNumBins; binWidth = deBinWidth; maxY = deMaxY;
        } else {
            values.sort((a, b) => a - b);
            min = values[0];
            max = values[values.length - 1];
            if (max === min) { min *= 0.9; max *= 1.1; }
            if (max === min && min === 0) { max = 1; }
            const padding = (max - min) * 0.02;
            min -= padding; max += padding;
            numBins = Math.max(8, Math.min(20, Math.ceil(Math.sqrt(values.length))));
            binWidth = (max - min) / numBins || 1;
            maxY = null;
        }

        const counts = new Array(numBins).fill(0);
        const labels = [];

        let precision = 1;
        if (binWidth < 0.005) precision = 4;
        else if (binWidth < 0.05) precision = 3;
        else if (binWidth < 0.5) precision = 2;

        for (let i = 0; i < numBins; i++) {
            labels.push(`${(min + i * binWidth).toFixed(precision)} - ${(min + (i + 1) * binWidth).toFixed(precision)}`);
        }

        values.forEach(val => {
            let idx = Math.floor((val - min) / binWidth);
            if (idx >= numBins) idx = numBins - 1;
            if (idx < 0) idx = 0;
            counts[idx]++;
        });

        const wrapper = document.createElement("div");
        wrapper.className = "chart-box";
        const canvas = document.createElement("canvas");
        wrapper.appendChild(canvas);
        container.appendChild(wrapper);

        const chartOptions = {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false }, title: { display: true, text: title, font: { size: 16 } } },
            scales: {
                x: { ticks: { maxRotation: 45, minRotation: 0 } },
                y: { beginAtZero: true, title: { display: true, text: "Frequency" }, ticks: { stepSize: 1 } }
            }
        };

        if (maxY !== null) chartOptions.scales.y.max = maxY;

        new Chart(canvas, {
            type: "bar",
            data: {
                labels: labels,
                datasets: [{ label: title, data: counts, backgroundColor: "rgba(54, 162, 235, 0.6)", borderColor: "rgba(54, 162, 235, 1)", borderWidth: 1 }]
            },
            options: chartOptions
        });
        chartCount++;
    }

    if (chartCount === 0) {
        container.innerHTML = `<p class="muted">No numeric values available for histograms.</p>`;
    }
}
