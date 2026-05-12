// For local testing, change to http://localhost:8000/process_single
const API_URL = "https://crabbly-watermelonphenotyping.hf.space/process_single";
const SINGLE_REQUEST_TIMEOUT_MS = 120000; // 2 minutes
const BULK_REQUEST_TIMEOUT_MS = 30000;    // Increased to 30 seconds to prevent premature drops
const BULK_TIMEOUT_MESSAGE = "Taking longer than 30 seconds. Moving on.";

function processUrl(includeImage, applySmoothing) {
    return `${API_URL}?include_image=${includeImage ? "true" : "false"}&apply_smoothing=${applySmoothing ? "true" : "false"}`;
}

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
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

function areaUnit(data) {
    if (data.area_unit === "cm2") return "cm²";
    if (data.area_unit === "px2") return "px²";
    return measurementUnit(data) === "cm" ? "cm²" : "px²";
}

function rowNotes(data) {
    const notes =[];
    if (Array.isArray(data.warnings)) notes.push(...data.warnings);
    if (data.rind_source && data.rind_source !== "whole_mask_overlap") {
        notes.push(`rind: ${data.rind_source}`);
    }
    return notes.join(" | ");
}

async function postImage(file, includeImage, applySmoothing, timeoutMs = SINGLE_REQUEST_TIMEOUT_MS, maxRetries = 1) {
    const formData = new FormData();
    formData.append("file", file);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            // Strict timeout wrapper
            // --- CHANGE IS HERE: Passed applySmoothing into processUrl ---
            const fetchPromise = fetch(processUrl(includeImage, applySmoothing), {
                method: "POST",
                body: formData,
                signal: controller.signal
            });

            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error("Timeout")), timeoutMs)
            );

            const response = await Promise.race([fetchPromise, timeoutPromise]);
            clearTimeout(timeoutId);

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

        } catch (err) {
            clearTimeout(timeoutId);
            
            const isTimeout = err.name === "AbortError" || err.message === "Timeout";
            
            // If we are out of retries, throw the error
            if (attempt === maxRetries) {
                if (isTimeout) {
                    throw new Error(timeoutMs === BULK_REQUEST_TIMEOUT_MS ? BULK_TIMEOUT_MESSAGE : `Timed out after ${Math.round(timeoutMs / 1000)}s`);
                }
                throw err;
            }
            
            // Otherwise, wait 2 seconds and retry
            console.warn(`Attempt ${attempt + 1} failed for ${file.name}. Retrying...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

async function postBulkImage(file, includeImage, applySmoothing) {
    // 30 second timeout, 1 automatic retry if the server drops the connection
    return postImage(file, includeImage, applySmoothing, BULK_REQUEST_TIMEOUT_MS, 1);
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
    const applySmoothing = document.getElementById("single-smoothing").checked;
    const status = document.getElementById("single-status");
    const resultDiv = document.getElementById("single-result");

    status.innerText = "Processing...";
    resultDiv.innerHTML = "";

    try {
        const data = await postImage(file, true, applySmoothing, SINGLE_REQUEST_TIMEOUT_MS, 0); // No retries for single images

        if (data.success) {
            const unit = measurementUnit(data);
            const aUnit = areaUnit(data);
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
                <p><strong>R²:</strong> ${data.r2_score !== null ? fmt(data.r2_score, 4) : "N/A (Smoothing Off)"}</p>
                <p><strong>Width:</strong> ${fmt(data.width_val, digits)} ${escapeHtml(unit)}</p>
                <p><strong>Height:</strong> ${fmt(data.height_val, digits)} ${escapeHtml(unit)}</p>
                <p><strong>Perimeter:</strong> ${fmt(data.perimeter_val, digits)} ${escapeHtml(unit)}</p>
                <p><strong>Total Area:</strong> ${fmt(data.total_area, digits)} ${escapeHtml(aUnit)}</p>
                <p><strong>Flesh Area:</strong> ${fmt(data.flesh_area, digits)} ${escapeHtml(aUnit)}</p>
                <p><strong>Flesh / Total:</strong> ${fmt(data.flesh_area_ratio, 3)}</p>
                <p><strong>Elongation:</strong> ${fmt(data.elongation_factor, 3)}</p>
                <p><strong>Asymmetry:</strong> ${fmt(data.asymmetry_score, 3)}</p>
                <p><strong>Flesh Asymmetry:</strong> ${fmt(data.flesh_asymmetry_score, 3)}</p>
                <p><strong>Midline Curvature:</strong> ${fmt(data.midline_curvature, 4)}</p>
                <p><strong>Circularity:</strong> ${fmt(data.circularity, 3)}</p>
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

let globalCsvData =[];

document.getElementById("bulk-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const files = document.getElementById("bulk-files").files;
    const includeImages = document.getElementById("bulk-previews") ? document.getElementById("bulk-previews").checked : true;
    const applySmoothing = document.getElementById("bulk-smoothing").checked;
    const status = document.getElementById("bulk-status");
    const table = document.getElementById("bulk-table");
    const tbody = table.querySelector("tbody");
    const chartsContainer = document.getElementById("histograms-container");

    tbody.innerHTML = "";
    chartsContainer.innerHTML = "";
    table.style.display = "table";
    const downloadBtn = document.getElementById("download-csv-btn");
    downloadBtn.style.display = "none";

    // Initialize CSV with Headers
    globalCsvData = [[
        "Filename", "R²", "Width (cm)", "Height (cm)", "Perimeter (cm)", 
        "Total Area (cm²)", "Flesh Area (cm²)", "Flesh Ratio", "Elongation", 
        "Asymmetry", "Flesh Asymmetry", "Midline Curvature", "Circularity", 
        "Init ΔE", "Final ΔE", "Time (ms)"
    ].join(",")];

    let completed = 0;
    let successCount = 0;
    let failureCount = 0;
    let pixelScaleCount = 0;

    const batchData = {
        "R² Score": [],
        "Width (cm)":[],
        "Height (cm)": [],
        "Perimeter (cm)":[],
        "Total Area (cm²)": [],
        "Flesh Area (cm²)":[],
        "Flesh / Total Ratio": [],
        "Elongation Factor": [],
        "Circularity":[],
        "Asymmetry": [],
        "Flesh Asymmetry": [],
        "Midline Curvature":[],
        "Initial ΔE": [],
        "Final ΔE":[]
    };

    for (let i = 0; i < files.length; i++) {
        status.innerText = `Processing image ${i + 1} of ${files.length}...`;

        try {
            const data = await postBulkImage(files[i], includeImages, applySmoothing);
            const tr = document.createElement("tr");

            if (data.success) {
                successCount++;
                const isCm = measurementUnit(data) === "cm";
                const notes = rowNotes(data);

                // Enforce N/A for physical dimensions if ColorChecker failed
                let w = isCm ? data.width_val : null;
                let h = isCm ? data.height_val : null;
                let p = isCm ? data.perimeter_val : null;
                let ta = isCm ? data.total_area : null;
                let fa = isCm ? data.flesh_area : null;

                if (!isCm) pixelScaleCount++;

                // Histogram data collection
                if (isNumber(data.r2_score)) batchData["R² Score"].push(data.r2_score);
                if (isNumber(w)) batchData["Width (cm)"].push(w);
                if (isNumber(h)) batchData["Height (cm)"].push(h);
                if (isNumber(p)) batchData["Perimeter (cm)"].push(p);
                if (isNumber(ta)) batchData["Total Area (cm²)"].push(ta);
                if (isNumber(fa)) batchData["Flesh Area (cm²)"].push(fa);
                if (isNumber(data.flesh_area_ratio)) batchData["Flesh / Total Ratio"].push(data.flesh_area_ratio);
                if (isNumber(data.elongation_factor)) batchData["Elongation Factor"].push(data.elongation_factor);
                if (isNumber(data.circularity)) batchData["Circularity"].push(data.circularity);
                if (isNumber(data.asymmetry_score)) batchData["Asymmetry"].push(data.asymmetry_score);
                if (isNumber(data.flesh_asymmetry_score)) batchData["Flesh Asymmetry"].push(data.flesh_asymmetry_score);
                if (isNumber(data.midline_curvature)) batchData["Midline Curvature"].push(data.midline_curvature);
                if (isNumber(data.delta_e_initial)) batchData["Initial ΔE"].push(data.delta_e_initial);
                if (isNumber(data.delta_e_final)) batchData["Final ΔE"].push(data.delta_e_final);

                // Update Table (No units in columns)
                tr.innerHTML = `
                    <td>${escapeHtml(data.filename || files[i].name)}</td>
                    <td>${data.r2_score !== null ? fmt(data.r2_score, 4) : "N/A"}</td>
                    <td>${fmt(w, 1)}</td>
                    <td>${fmt(h, 1)}</td>
                    <td>${fmt(p, 1)}</td>
                    <td>${fmt(ta, 1)}</td>
                    <td>${fmt(fa, 1)}</td>
                    <td>${fmt(data.flesh_area_ratio, 3)}</td>
                    <td>${fmt(data.elongation_factor, 3)}</td>
                    <td>${fmt(data.asymmetry_score, 3)}</td>
                    <td>${fmt(data.flesh_asymmetry_score, 3)}</td>
                    <td>${fmt(data.midline_curvature, 4)}</td>
                    <td>${fmt(data.circularity, 3)}</td>
                    <td>${fmt(data.delta_e_initial, 2)}</td>
                    <td>${fmt(data.delta_e_final, 2)}</td>
                    <td>${isNumber(data.processing_ms) ? data.processing_ms : "N/A"}</td>
                    <td class="notes-cell">${notes ? escapeHtml(notes) : ""}</td>
                    <td>${previewCell(data)}</td>
                `;

                // Update CSV
                const csvRow = [
                    `"${data.filename || files[i].name}"`,
                    data.r2_score !== null ? fmt(data.r2_score, 4) : "N/A",
                    fmt(w, 1), fmt(h, 1), fmt(p, 1), fmt(ta, 1), fmt(fa, 1),
                    fmt(data.flesh_area_ratio, 3), fmt(data.elongation_factor, 3),
                    fmt(data.asymmetry_score, 3), fmt(data.flesh_asymmetry_score, 3),
                    fmt(data.midline_curvature, 4), fmt(data.circularity, 3),
                    fmt(data.delta_e_initial, 2), fmt(data.delta_e_final, 2),
                    isNumber(data.processing_ms) ? data.processing_ms : "N/A"
                ];
                globalCsvData.push(csvRow.join(","));
            } else {
                failureCount++;
                tr.innerHTML = `<td>${escapeHtml(files[i].name)}</td><td colspan="18" style="color:red;">Error: ${escapeHtml(data.message)}</td>`;
            }
            tbody.appendChild(tr);
        } catch (err) {
            failureCount++;
            const tr = document.createElement("tr");
            const message = err.message === BULK_TIMEOUT_MESSAGE ? BULK_TIMEOUT_MESSAGE : `Network/API Error: ${err.message}`;
            tr.innerHTML = `<td>${escapeHtml(files[i].name)}</td><td colspan="18" style="color:red;">${escapeHtml(message)}</td>`;
            tbody.appendChild(tr);
        }

        completed++;
        
        // THE FIX: Cool-down period between requests to prevent overwhelming the proxy
        if (i < files.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    const excludedText = pixelScaleCount > 0 ? ` ${pixelScaleCount} pixel-scale row(s) excluded from cm histograms.` : "";
    status.innerText = `Batch complete: ${successCount} succeeded, ${failureCount} failed, ${completed} attempted.${excludedText}`;
    if (successCount > 0) downloadBtn.style.display = "inline-block";
    drawHistograms(batchData, chartsContainer);
});

function drawHistograms(batchData, container) {
    const deKeys = ["Initial ΔE", "Final ΔE"];
    let allDE =[];
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
            const vals = batchData[k] ? batchData[k].filter(isNumber) :[];
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
        const labels =[];

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

// --- CSV DOWNLOAD HANDLER ---
document.getElementById("download-csv-btn").addEventListener("click", () => {
    const csvString = globalCsvData.join("\n");
    const blob = new Blob([csvString], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.setAttribute('hidden', '');
    a.setAttribute('href', url);
    
    const now = new Date();
    const dateStr = now.toISOString().replace(/T/, '_').replace(/:/g, '-').slice(0, 19);
    
    a.setAttribute('download', `phenotype_data_${dateStr}.csv`);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
});
