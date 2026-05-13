// For local testing, change to http://localhost:8000/process_single
const API_URL = "https://crabbly-watermelonphenotyping.hf.space/process_single";
const SINGLE_REQUEST_TIMEOUT_MS = 120000; // 2 minutes
const BULK_REQUEST_TIMEOUT_MS = 30000;    // Increased to 30 seconds to prevent premature drops
const BULK_TIMEOUT_MESSAGE = "Taking longer than 30 seconds. Moving on.";
const TARGET_HASH = "9139eb3676d5dfafced7613f044d86d9e7c84f40a04c83ddce062878621315d0";

let currentPassword = ""; // Stores the password in memory after a successful login
let currentUsername = ""; // Stores user identity

async function sha256(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// --- NEW LOGIN LISTENER ---
document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pwd = document.getElementById("login-password").value;
    const uname = document.getElementById("login-name").value.trim();
    const errorDiv = document.getElementById("login-error");
    
    if (await sha256(pwd) === TARGET_HASH) {
        currentPassword = pwd;
        currentUsername = uname;
        document.getElementById("login-view").style.display = "none";
        document.getElementById("app-view").style.display = "block";

        // Track unique login name
        if (typeof gtag === 'function') {
            gtag('event', 'user_login', {
                'event_category': 'Authentication',
                'username': currentUsername
            });
        }
        
        startQueuePolling(); // Boot up the live dashboard
    } else {
        errorDiv.innerText = "Incorrect password.";
    }
});

function processUrl(includeImage) {
    return `${API_URL}?include_image=${includeImage ? "true" : "false"}`;
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

async function postImage(file, includeImage, timeoutMs = SINGLE_REQUEST_TIMEOUT_MS, maxRetries = 1) {
    const formData = new FormData();
    formData.append("password", currentPassword);
    formData.append("username", currentUsername); 
    formData.append("file", file);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            // Strict timeout wrapper
            const fetchPromise = fetch(processUrl(includeImage), {
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

async function postBulkImage(file, includeImage) {
    // 30 second timeout, 1 automatic retry if the server drops the connection
    return postImage(file, includeImage, BULK_REQUEST_TIMEOUT_MS, 1);
}

function previewCell(data) {
    if (data.image_base64) {
        return `<img src="data:image/jpeg;base64,${data.image_base64}" class="thumb preview-img">`;
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
        const data = await postImage(file, true, SINGLE_REQUEST_TIMEOUT_MS, 0);  // No retries for single images
        
        if (data.success) {
            const unit = measurementUnit(data);
            const aUnit = areaUnit(data);
            const digits = unit === "cm" ? 2 : 0;
            const notes = rowNotes(data);
            status.innerText = "Success";

            // Send event to Google Analytics
            if (typeof gtag === 'function') {
                gtag('event', 'processed_single_image', {
                    'event_category': 'Phenotyping',
                    'success': true,
                    'username': currentUsername
                });
            }

            let scaleText = `<p><strong>Scale:</strong> Measurements are in ${escapeHtml(unit)}.</p>`;
            if (data.delta_e_initial !== null && data.delta_e_final !== null) {
                scaleText = `<p><strong>Delta E:</strong> ${fmt(data.delta_e_initial, 2)} to ${fmt(data.delta_e_final, 2)}</p>`;
            } else if (!data.color_checker_found) {
                scaleText = `<p><strong>Scale:</strong> ColorChecker not found; dimensions are original-image pixels.</p>`;
            }

            resultDiv.innerHTML = `
                <div style="display:flex; gap: 20px; text-align: left; flex-wrap: wrap;">
                    <div style="flex: 1; min-width: 200px;">
                        <h3>Raw Features</h3>
                        <p><strong>Width:</strong> ${fmt(data.raw_width, digits)} ${escapeHtml(unit)}</p>
                        <p><strong>Height:</strong> ${fmt(data.raw_height, digits)} ${escapeHtml(unit)}</p>
                        <p><strong>Perimeter:</strong> ${fmt(data.raw_perimeter, digits)} ${escapeHtml(unit)}</p>
                        <p><strong>F.Width:</strong> ${fmt(data.raw_flesh_width, digits)} ${escapeHtml(unit)}</p>
                        <p><strong>F.Height:</strong> ${fmt(data.raw_flesh_height, digits)} ${escapeHtml(unit)}</p>
                        <p><strong>F.Perim:</strong> ${fmt(data.raw_flesh_perimeter, digits)} ${escapeHtml(unit)}</p>
                        <p><strong>Rind Thick.:</strong> ${fmt(data.raw_rind_thick, digits)} ${escapeHtml(unit)}</p>
                        <p><strong>Rind Ratio:</strong> ${fmt(data.raw_rind_ratio, 3)}</p>
                        <p><strong>Total Area:</strong> ${fmt(data.raw_total_area, digits)} ${escapeHtml(aUnit)}</p>
                        <p><strong>Flesh Area:</strong> ${fmt(data.raw_flesh_area, digits)} ${escapeHtml(aUnit)}</p>
                        <p><strong>Flesh/Total:</strong> ${fmt(data.raw_flesh_ratio, 3)}</p>
                        <p><strong>Elongation:</strong> ${fmt(data.raw_elongation, 3)}</p>
                        <p><strong>Asymmetry:</strong> ${fmt(data.raw_asym, 3)}</p>
                        <p><strong>Flesh Asym:</strong> ${fmt(data.raw_flesh_asym, 3)}</p>
                        <p><strong>Circularity:</strong> ${fmt(data.raw_circ, 3)}</p>
                        <br>
                        ${data.image_raw_base64 ? `<img src="data:image/jpeg;base64,${data.image_raw_base64}" class="preview-img" style="width:100%; border-radius:8px; cursor:pointer;">` : ""}
                    </div>
                    <div style="flex: 1; min-width: 200px;">
                        <h3>Smoothed Features</h3>
                        <p><strong>R² Rind:</strong> ${fmt(data.r2_rind, 4)}</p>
                        <p><strong>R² Flesh:</strong> ${fmt(data.r2_flesh, 4)}</p>
                        <p><strong>Width:</strong> ${fmt(data.sm_width, digits)} ${escapeHtml(unit)}</p>
                        <p><strong>Height:</strong> ${fmt(data.sm_height, digits)} ${escapeHtml(unit)}</p>
                        <p><strong>Perimeter:</strong> ${fmt(data.sm_perimeter, digits)} ${escapeHtml(unit)}</p>
                        <p><strong>F.Width:</strong> ${fmt(data.sm_flesh_width, digits)} ${escapeHtml(unit)}</p>
                        <p><strong>F.Height:</strong> ${fmt(data.sm_flesh_height, digits)} ${escapeHtml(unit)}</p>
                        <p><strong>F.Perim:</strong> ${fmt(data.sm_flesh_perimeter, digits)} ${escapeHtml(unit)}</p>
                        <p><strong>Rind Thick.:</strong> ${fmt(data.sm_rind_thick, digits)} ${escapeHtml(unit)}</p>
                        <p><strong>Rind Ratio:</strong> ${fmt(data.sm_rind_ratio, 3)}</p>
                        <p><strong>Total Area:</strong> ${fmt(data.sm_total_area, digits)} ${escapeHtml(aUnit)}</p>
                        <p><strong>Flesh Area:</strong> ${fmt(data.sm_flesh_area, digits)} ${escapeHtml(aUnit)}</p>
                        <p><strong>Flesh/Total:</strong> ${fmt(data.sm_flesh_ratio, 3)}</p>
                        <p><strong>Elongation:</strong> ${fmt(data.sm_elongation, 3)}</p>
                        <p><strong>Asymmetry:</strong> ${fmt(data.sm_asym, 3)}</p>
                        <p><strong>Flesh Asym:</strong> ${fmt(data.sm_flesh_asym, 3)}</p>
                        <p><strong>Circularity:</strong> ${fmt(data.sm_circ, 3)}</p>
                        <br>
                        ${data.image_sm_base64 ? `<img src="data:image/jpeg;base64,${data.image_sm_base64}" class="preview-img" style="width:100%; border-radius:8px; cursor:pointer;">` : ""}
                    </div>
                </div>
                <div style="margin-top: 15px;">
                    <p><strong>Midline Curve:</strong> ${fmt(data.midline_curvature, 4)}</p>
                    ${scaleText}
                    ${notes ? `<p><strong>Notes:</strong> ${escapeHtml(notes)}</p>` : ""}
                    ${isNumber(data.processing_ms) ? `<p><strong>Time:</strong> ${data.processing_ms} ms</p>` : ""}
                </div>
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
    const status = document.getElementById("bulk-status");
    const table = document.getElementById("bulk-table");
    const tbody = table.querySelector("tbody");
    const chartsContainer = document.getElementById("histograms-container");

    tbody.innerHTML = "";
    chartsContainer.innerHTML = "";
    table.style.display = "table";
    document.getElementById("bulk-section").classList.add("bulk-card");
    const downloadBtn = document.getElementById("download-csv-btn");
    downloadBtn.style.display = "none";

    // Initialize CSV with Headers
    globalCsvData = [[
        "Filename", "R² Rind", "R² Flesh", "Width Raw (cm)", "Width Sm (cm)", 
        "Height Raw (cm)", "Height Sm (cm)", "Perim Raw (cm)", "Perim Sm (cm)", 
        "F.Width Raw (cm)", "F.Width Sm (cm)", "F.Height Raw (cm)", "F.Height Sm (cm)", 
        "F.Perim Raw (cm)", "F.Perim Sm (cm)", "RindThk Raw (cm)", "RindThk Sm (cm)", 
        "RindRatio Raw", "RindRatio Sm", "Area Raw (cm²)", "Area Sm (cm²)", 
        "F.Area Raw (cm²)", "F.Area Sm (cm²)", "F.Ratio Raw", "F.Ratio Sm", 
        "Elong Raw", "Elong Sm", "Asym Raw", "Asym Sm", "F.Asym Raw", "F.Asym Sm", 
        "Circ Raw", "Circ Sm", "Midline Curve", "Init ΔE", "Final ΔE", "Time (ms)"
    ].join(",")];

    let completed = 0;
    let successCount = 0;
    let failureCount = 0;
    let pixelScaleCount = 0;

    // --- Timer Initialization ---
    const timerDiv = document.getElementById("batch-timer");
    timerDiv.style.display = "block";
    timerDiv.innerText = "Elapsed: 00:00 | ETA: Calculating...";
    const batchStartTime = Date.now();
    let timerInterval = setInterval(() => {
        const elapsedSec = Math.floor((Date.now() - batchStartTime) / 1000);
        const m = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
        const s = String(elapsedSec % 60).padStart(2, '0');
        
        let etaStr = "Calculating...";
        if (completed > 0 && completed < files.length) {
            const timePerImg = elapsedSec / completed;
            const remainingSec = Math.floor(timePerImg * (files.length - completed));
            const rm = String(Math.floor(remainingSec / 60)).padStart(2, '0');
            const rs = String(remainingSec % 60).padStart(2, '0');
            etaStr = `${rm}:${rs}`;
        }
        
        timerDiv.innerText = `Elapsed: ${m}:${s} | ETA: ${etaStr}`;
    }, 1000);
    // ---------------------------------
    
    const batchData = {
        "Width - Raw (cm)":[], "Width - Sm (cm)": [],
        "Height - Raw (cm)":[], "Height - Sm (cm)": [],
        "Perim - Raw (cm)":[], "Perim - Sm (cm)": [],
        "F.Width - Raw (cm)":[], "F.Width - Sm (cm)": [],
        "F.Height - Raw (cm)":[], "F.Height - Sm (cm)": [],
        "F.Perim - Raw (cm)":[], "F.Perim - Sm (cm)": [],
        "Rind Thick - Raw (cm)":[], "Rind Thick - Sm (cm)": [],
        "Rind Ratio - Raw": [], "Rind Ratio - Sm":[],
        "Total Area - Raw (cm²)": [], "Total Area - Sm (cm²)":[],
        "Flesh Area - Raw (cm²)": [], "Flesh Area - Sm (cm²)":[],
        "Flesh Ratio - Raw": [], "Flesh Ratio - Sm": [],
        "Elongation - Raw":[], "Elongation - Sm": [],
        "Asymmetry - Raw": [], "Asymmetry - Sm":[],
        "Flesh Asym - Raw": [], "Flesh Asym - Sm":[],
        "Circularity - Raw": [], "Circularity - Sm": [],
        "Midline Curve": [], "R² Rind":[], "R² Flesh": [],
        "Initial ΔE": [], "Final ΔE":[]
    };

    for (let i = 0; i < files.length; i++) {
        status.innerText = `Processing image ${i + 1} of ${files.length}...`;

        try {
            const data = await postBulkImage(files[i], includeImages);
            const tr = document.createElement("tr");

            if (data.success) {
                successCount++;
                const isCm = measurementUnit(data) === "cm";
                const digits = isCm ? 2 : 0;
                const notes = rowNotes(data);

                // Enforce N/A for physical dimensions if ColorChecker failed
                let rw=isCm?data.raw_width:null, sw=isCm?data.sm_width:null;
                let rh=isCm?data.raw_height:null, sh=isCm?data.sm_height:null;
                let rp=isCm?data.raw_perimeter:null, sp=isCm?data.sm_perimeter:null;
                let rfw=isCm?data.raw_flesh_width:null, sfw=isCm?data.sm_flesh_width:null;
                let rfh=isCm?data.raw_flesh_height:null, sfh=isCm?data.sm_flesh_height:null;
                let rfp=isCm?data.raw_flesh_perimeter:null, sfp=isCm?data.sm_flesh_perimeter:null;
                let rrt=isCm?data.raw_rind_thick:null, srt=isCm?data.sm_rind_thick:null;
                let ra=isCm?data.raw_total_area:null, sa=isCm?data.sm_total_area:null;
                let rfa=isCm?data.raw_flesh_area:null, sfa=isCm?data.sm_flesh_area:null;
                if (!isCm) pixelScaleCount++;

                // Collect Histograms
                if(isNumber(rw)) batchData["Width - Raw (cm)"].push(rw);
                if(isNumber(sw)) batchData["Width - Sm (cm)"].push(sw);
                if(isNumber(rh)) batchData["Height - Raw (cm)"].push(rh);
                if(isNumber(sh)) batchData["Height - Sm (cm)"].push(sh);
                if(isNumber(rp)) batchData["Perim - Raw (cm)"].push(rp);
                if(isNumber(sp)) batchData["Perim - Sm (cm)"].push(sp);
                if(isNumber(rfw)) batchData["F.Width - Raw (cm)"].push(rfw);
                if(isNumber(sfw)) batchData["F.Width - Sm (cm)"].push(sfw);
                if(isNumber(rfh)) batchData["F.Height - Raw (cm)"].push(rfh);
                if(isNumber(sfh)) batchData["F.Height - Sm (cm)"].push(sfh);
                if(isNumber(rfp)) batchData["F.Perim - Raw (cm)"].push(rfp);
                if(isNumber(sfp)) batchData["F.Perim - Sm (cm)"].push(sfp);
                if(isNumber(rrt)) batchData["Rind Thick - Raw (cm)"].push(rrt);
                if(isNumber(srt)) batchData["Rind Thick - Sm (cm)"].push(srt);
                if(isNumber(data.raw_rind_ratio)) batchData["Rind Ratio - Raw"].push(data.raw_rind_ratio);
                if(isNumber(data.sm_rind_ratio)) batchData["Rind Ratio - Sm"].push(data.sm_rind_ratio);
                if(isNumber(ra)) batchData["Total Area - Raw (cm²)"].push(ra);
                if(isNumber(sa)) batchData["Total Area - Sm (cm²)"].push(sa);
                if(isNumber(rfa)) batchData["Flesh Area - Raw (cm²)"].push(rfa);
                if(isNumber(sfa)) batchData["Flesh Area - Sm (cm²)"].push(sfa);
                if(isNumber(data.raw_flesh_ratio)) batchData["Flesh Ratio - Raw"].push(data.raw_flesh_ratio);
                if(isNumber(data.sm_flesh_ratio)) batchData["Flesh Ratio - Sm"].push(data.sm_flesh_ratio);
                if(isNumber(data.raw_elongation)) batchData["Elongation - Raw"].push(data.raw_elongation);
                if(isNumber(data.sm_elongation)) batchData["Elongation - Sm"].push(data.sm_elongation);
                if(isNumber(data.raw_asym)) batchData["Asymmetry - Raw"].push(data.raw_asym);
                if(isNumber(data.sm_asym)) batchData["Asymmetry - Sm"].push(data.sm_asym);
                if(isNumber(data.raw_flesh_asym)) batchData["Flesh Asym - Raw"].push(data.raw_flesh_asym);
                if(isNumber(data.sm_flesh_asym)) batchData["Flesh Asym - Sm"].push(data.sm_flesh_asym);
                if(isNumber(data.raw_circ)) batchData["Circularity - Raw"].push(data.raw_circ);
                if(isNumber(data.sm_circ)) batchData["Circularity - Sm"].push(data.sm_circ);
                if(isNumber(data.midline_curvature)) batchData["Midline Curve"].push(data.midline_curvature);
                if(isNumber(data.r2_rind)) batchData["R² Rind"].push(data.r2_rind);
                if(isNumber(data.r2_flesh)) batchData["R² Flesh"].push(data.r2_flesh);
                if(isNumber(data.delta_e_initial)) batchData["Initial ΔE"].push(data.delta_e_initial);
                if(isNumber(data.delta_e_final)) batchData["Final ΔE"].push(data.delta_e_final);

                // HTML Row
                tr.innerHTML = `
                    <td>${escapeHtml(data.filename || files[i].name)}
                        ${notes ? `<span title="${escapeHtml(notes)}" style="display:inline-block; width:18px; height:18px; background:#ffc107; color:#000; border-radius:50%; text-align:center; line-height:18px; font-weight:bold; cursor:help; margin-left:5px; font-size:12px;">!</span>` : ""}
                    </td>
                    <td>${fmt(data.r2_rind, 4)}</td>
                    <td>${fmt(data.r2_flesh, 4)}</td>
                    <td>${fmt(rw, digits)}</td>
                    <td>${fmt(sw, digits)}</td>
                    <td>${fmt(rh, digits)}</td>
                    <td>${fmt(sh, digits)}</td>
                    <td>${fmt(rp, digits)}</td>
                    <td>${fmt(sp, digits)}</td>
                    <td>${fmt(rfw, digits)}</td>
                    <td>${fmt(sfw, digits)}</td>
                    <td>${fmt(rfh, digits)}</td>
                    <td>${fmt(sfh, digits)}</td>
                    <td>${fmt(rfp, digits)}</td>
                    <td>${fmt(sfp, digits)}</td>
                    <td>${fmt(rrt, digits)}</td>
                    <td>${fmt(srt, digits)}</td>
                    <td>${fmt(data.raw_rind_ratio, 3)}</td>
                    <td>${fmt(data.sm_rind_ratio, 3)}</td>
                    <td>${fmt(ra, digits)}</td>
                    <td>${fmt(sa, digits)}</td>
                    <td>${fmt(rfa, digits)}</td>
                    <td>${fmt(sfa, digits)}</td>
                    <td>${fmt(data.raw_flesh_ratio, 3)}</td>
                    <td>${fmt(data.sm_flesh_ratio, 3)}</td>
                    <td>${fmt(data.raw_elongation, 3)}</td>
                    <td>${fmt(data.sm_elongation, 3)}</td>
                    <td>${fmt(data.raw_asym, 3)}</td>
                    <td>${fmt(data.sm_asym, 3)}</td>
                    <td>${fmt(data.raw_flesh_asym, 3)}</td>
                    <td>${fmt(data.sm_flesh_asym, 3)}</td>
                    <td>${fmt(data.raw_circ, 3)}</td>
                    <td>${fmt(data.sm_circ, 3)}</td>
                    <td>${fmt(data.midline_curvature, 4)}</td>
                    <td>${fmt(data.delta_e_initial, 2)}</td>
                    <td>${fmt(data.delta_e_final, 2)}</td>
                    <td>${isNumber(data.processing_ms) ? data.processing_ms : "N/A"}</td>
                    <td>${data.image_raw_base64 ? `<img src="data:image/jpeg;base64,${data.image_raw_base64}" class="thumb preview-img">` : `<span class="muted">-</span>`}</td>
                    <td>${data.image_sm_base64 ? `<img src="data:image/jpeg;base64,${data.image_sm_base64}" class="thumb preview-img">` : `<span class="muted">-</span>`}</td>
                `;

                // CSV
                const csvRow = [
                    `"${data.filename || files[i].name}"`,
                    fmt(data.r2_rind, 4), fmt(data.r2_flesh, 4),
                    fmt(rw, digits), fmt(sw, digits),
                    fmt(rh, digits), fmt(sh, digits),
                    fmt(rp, digits), fmt(sp, digits),
                    fmt(rfw, digits), fmt(sfw, digits),
                    fmt(rfh, digits), fmt(sfh, digits),
                    fmt(rfp, digits), fmt(sfp, digits),
                    fmt(rrt, digits), fmt(srt, digits),
                    fmt(data.raw_rind_ratio, 3), fmt(data.sm_rind_ratio, 3),
                    fmt(ra, digits), fmt(sa, digits),
                    fmt(rfa, digits), fmt(sfa, digits),
                    fmt(data.raw_flesh_ratio, 3), fmt(data.sm_flesh_ratio, 3),
                    fmt(data.raw_elongation, 3), fmt(data.sm_elongation, 3),
                    fmt(data.raw_asym, 3), fmt(data.sm_asym, 3),
                    fmt(data.raw_flesh_asym, 3), fmt(data.sm_flesh_asym, 3),
                    fmt(data.raw_circ, 3), fmt(data.sm_circ, 3),
                    fmt(data.midline_curvature, 4),
                    fmt(data.delta_e_initial, 2), fmt(data.delta_e_final, 2),
                    isNumber(data.processing_ms) ? data.processing_ms : "N/A"
                ];
                globalCsvData.push(csvRow.join(","));
                // --- Track each individual image from the batch in Google Analytics ---
                if (typeof gtag === 'function') {
                    gtag('event', 'processed_single_image', {
                        'event_category': 'Phenotyping',
                        'success': true,
                        'is_bulk': true,
                        'username': currentUsername
                    });
                }
            } else {
                failureCount++;
                tr.innerHTML = `<td>${escapeHtml(files[i].name)}</td><td colspan="38" style="color:red;">Error: ${escapeHtml(data.message)}</td>`;
            }
            tbody.appendChild(tr);
        } catch (err) {
            failureCount++;
            const tr = document.createElement("tr");
            const message = err.message === BULK_TIMEOUT_MESSAGE ? BULK_TIMEOUT_MESSAGE : `Network/API Error: ${err.message}`;
            tr.innerHTML = `<td>${escapeHtml(files[i].name)}</td><td colspan="38" style="color:red;">${escapeHtml(message)}</td>`;
            tbody.appendChild(tr);
        }

        completed++;
        
        // THE FIX: Cool-down period between requests to prevent overwhelming the proxy
        if (i < files.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    // --- Stop the Timer ---
    clearInterval(timerInterval);
    const finalElapsed = Math.floor((Date.now() - batchStartTime) / 1000);
    const fm = String(Math.floor(finalElapsed / 60)).padStart(2, '0');
    const fs = String(finalElapsed % 60).padStart(2, '0');
    timerDiv.innerText = `Total Time: ${fm}:${fs}`;
    // ---------------------------
    
    const excludedText = pixelScaleCount > 0 ? ` ${pixelScaleCount} pixel-scale row(s) ignored for spatial metrics.` : "";
    status.innerText = `Batch complete: ${successCount} succeeded, ${failureCount} failed, ${completed} attempted.${excludedText}`;

    // Send event to Google Analytics
    if (typeof gtag === 'function') {
        gtag('event', 'processed_bulk_batch', {
            'event_category': 'Phenotyping',
            'images_attempted': completed,
            'images_succeeded': successCount
        });
    }
    
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

// --- LIGHTBOX HANDLER ---
const lightbox = document.getElementById("lightbox");
const lightboxImg = document.getElementById("lightbox-img");
const lightboxClose = document.getElementById("lightbox-close");

// Listen for clicks on ANY image with the 'preview-img' class
document.body.addEventListener("click", (e) => {
    if (e.target && e.target.classList.contains("preview-img")) {
        lightbox.style.display = "flex";
        lightboxImg.src = e.target.src;
    }
});

// Close when clicking the X
lightboxClose.addEventListener("click", () => {
    lightbox.style.display = "none";
    lightboxImg.src = "";
});

// Close when clicking the dark background outside the image
lightbox.addEventListener("click", (e) => {
    if (e.target === lightbox) {
        lightbox.style.display = "none";
        lightboxImg.src = "";
    }
});

// --- LIVE QUEUE POLLING ---
function startQueuePolling() {
    const statusEndpoint = API_URL.replace("/process_single", "/queue_status");
    
    setInterval(async () => {
        try {
            const res = await fetch(statusEndpoint);
            const data = await res.json();
            
            const statusDiv = document.getElementById("server-status");
            const isDev = currentUsername.toLowerCase() === 'devtest';
            
            // Route to correct queue
            let myQueue = isDev ? data.dev_queue : data.gen_queue;
            let coreName = isDev ? "Reserved 'devtest' Core" : "General Core";
            
            if (myQueue === 0) {
                statusDiv.innerHTML = `Server Ready | <strong>${coreName}</strong>.`;
                statusDiv.style.color = "#155724";
                statusDiv.style.backgroundColor = "#d4edda";
            } else {
                statusDiv.innerHTML = `Processing | <strong>${myQueue}</strong> request(s) in <strong>${coreName}</strong> queue.`;
                statusDiv.style.color = "#856404";
                statusDiv.style.backgroundColor = "#fff3cd";
            }
        } catch (err) {
            // Silently ignore network blips during polling
        }
    }, 2000); // Check every 2 seconds
}
