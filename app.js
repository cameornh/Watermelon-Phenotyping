
// For local testing, change to http://localhost:8000
const API_URL = "https://crabbly-watermelonphenotyping.hf.space/process_single"; 

document.getElementById('single-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = document.getElementById('single-file').files[0];
    const status = document.getElementById('single-status');
    const resultDiv = document.getElementById('single-result');
    
    status.innerText = "Processing...";
    resultDiv.innerHTML = "";

    const formData = new FormData();
    formData.append("file", file);

    try {
        const response = await fetch(API_URL, { method: "POST", body: formData });
        const data = await response.json();

        if (data.success) {
            status.innerText = "Success!";
            
            let de_text = data.delta_e_final !== null ? 
                `<p><strong>ΔE Improved:</strong> ${data.delta_e_initial.toFixed(2)} → ${data.delta_e_final.toFixed(2)}</p>` : 
                `<p><strong>Color Check:</strong> Not found (Dimensions are in Pixels!)</p>`;

            resultDiv.innerHTML = `
                <p><strong>R²:</strong> ${data.r2_score.toFixed(4)}</p>
                <p><strong>Width:</strong> ${data.width_val.toFixed(2)} cm</p>
                <p><strong>Height:</strong> ${data.height_val.toFixed(2)} cm</p>
                <p><strong>Perimeter:</strong> ${data.perimeter_val.toFixed(2)} cm</p>
                ${de_text}
                <img src="data:image/jpeg;base64,${data.image_base64}" style="max-width: 100%; border-radius: 8px;">
            `;
        } else {
            status.innerText = `Error: ${data.message}`;
        }
    } catch (err) {
        status.innerText = "Failed to connect to API.";
    }
});


document.getElementById('bulk-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const files = document.getElementById('bulk-files').files;
    const status = document.getElementById('bulk-status');
    const table = document.getElementById('bulk-table');
    const tbody = table.querySelector('tbody');
    const chartsContainer = document.getElementById('histograms-container');
    
    tbody.innerHTML = "";
    chartsContainer.innerHTML = "";
    table.style.display = "table";
    
    let completed = 0;
    
    let batchData = {
        'R² Score': [],
        'Width (cm)':[],
        'Height (cm)':[],
        'Perimeter (cm)': [],
        'Initial ΔE':[],
        'Final ΔE':[]
    };

    for (let i = 0; i < files.length; i++) {
        status.innerText = `Processing image ${i + 1} of ${files.length}...`;
        const formData = new FormData();
        formData.append("file", files[i]);

        try {
            const response = await fetch(API_URL, { method: "POST", body: formData });
            const data = await response.json();
            
            const tr = document.createElement('tr');
            if (data.success) {
                if(data.r2_score !== null) batchData['R² Score'].push(data.r2_score);
                if(data.width_val !== null) batchData['Width (cm)'].push(data.width_val);
                if(data.height_val !== null) batchData['Height (cm)'].push(data.height_val);
                if(data.perimeter_val !== null) batchData['Perimeter (cm)'].push(data.perimeter_val);
                if(data.delta_e_initial !== null) batchData['Initial ΔE'].push(data.delta_e_initial);
                if(data.delta_e_final !== null) batchData['Final ΔE'].push(data.delta_e_final);

                let dE_i = data.delta_e_initial !== null ? data.delta_e_initial.toFixed(2) : "N/A";
                let dE_f = data.delta_e_final !== null ? data.delta_e_final.toFixed(2) : "N/A";

                tr.innerHTML = `
                    <td>${data.filename}</td>
                    <td>${data.r2_score.toFixed(4)}</td>
                    <td>${data.width_val.toFixed(1)}</td>
                    <td>${data.height_val.toFixed(1)}</td>
                    <td>${data.perimeter_val.toFixed(1)}</td>
                    <td>${dE_i}</td>
                    <td>${dE_f}</td>
                    <td><img src="data:image/jpeg;base64,${data.image_base64}" class="thumb" onclick="window.open(this.src)"></td>
                `;
            } else {
                tr.innerHTML = `<td>${files[i].name}</td><td colspan="7" style="color:red;">Error: ${data.message}</td>`;
            }
            tbody.appendChild(tr);
        } catch (err) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${files[i].name}</td><td colspan="7" style="color:red;">API Connection Failed</td>`;
            tbody.appendChild(tr);
        }
        completed++;
    }
    status.innerText = `Batch complete! Processed ${completed} images.`;
    
    drawHistograms(batchData, chartsContainer);
});


// --- SHARED AXES HISTOGRAM LOGIC ---
function drawHistograms(batchData, container) {
    
    // 1. Pre-calculate global shared bounds for the Delta E graphs
    const deKeys = ['Initial ΔE', 'Final ΔE'];
    let allDE =[];
    deKeys.forEach(k => {
        if(batchData[k]) allDE.push(...batchData[k].filter(v => typeof v === 'number' && !isNaN(v)));
    });
    
    let deMin = 0, deMax = 1, deNumBins = 10, deBinWidth = 0.1, deMaxY = null;
    if (allDE.length > 0) {
        allDE.sort((a,b) => a-b);
        deMin = allDE[0];
        deMax = allDE[allDE.length - 1];
        if (deMin === deMax) { deMin *= 0.9; deMax *= 1.1; }
        let pad = (deMax - deMin) * 0.02;
        deMin -= pad; deMax += pad;
        
        deNumBins = Math.max(8, Math.min(20, Math.ceil(Math.sqrt(batchData['Initial ΔE'].length))));
        deBinWidth = (deMax - deMin) / deNumBins || 1;
        
        // Find the absolute highest bar across BOTH charts to lock the Y-axis
        let maxCount = 0;
        deKeys.forEach(k => {
            let vals = batchData[k].filter(v => typeof v === 'number' && !isNaN(v));
            let counts = new Array(deNumBins).fill(0);
            vals.forEach(val => {
                let idx = Math.floor((val - deMin) / deBinWidth);
                if(idx >= deNumBins) idx = deNumBins-1;
                if(idx < 0) idx = 0;
                counts[idx]++;
            });
            if(Math.max(...counts) > maxCount) maxCount = Math.max(...counts);
        });
        deMaxY = maxCount + Math.ceil(maxCount * 0.1); // Add 10% headroom
    }

    // 2. Draw all histograms
    for (const [title, rawValues] of Object.entries(batchData)) {
        const values = rawValues.filter(v => typeof v === 'number' && !isNaN(v));
        if (values.length === 0) continue; 

        let min, max, numBins, binWidth, maxY;
        let isDE = title.includes('ΔE');

        // Apply shared rules if it's a Delta E chart
        if (isDE && allDE.length > 0) {
            min = deMin; max = deMax; numBins = deNumBins; binWidth = deBinWidth; maxY = deMaxY;
        } else {
            // Otherwise, calculate bounds dynamically for Width, Height, Perimeter, R2
            values.sort((a,b) => a-b);
            min = values[0];
            max = values[values.length - 1];
            if (max === min) { min *= 0.9; max *= 1.1; }
            let padding = (max - min) * 0.02;
            min -= padding; max += padding;
            numBins = Math.max(8, Math.min(20, Math.ceil(Math.sqrt(values.length))));
            binWidth = (max - min) / numBins || 1;
            maxY = null; 
        }

        const counts = new Array(numBins).fill(0);
        const labels =[];
        for (let i = 0; i < numBins; i++) {
            labels.push(`${(min + i * binWidth).toFixed(1)} - ${(min + (i + 1) * binWidth).toFixed(1)}`);
        }

        values.forEach(val => {
            let idx = Math.floor((val - min) / binWidth);
            if (idx >= numBins) idx = numBins - 1; 
            if (idx < 0) idx = 0;
            counts[idx]++;
        });

        const wrapper = document.createElement('div');
        wrapper.className = 'chart-box';
        const canvas = document.createElement('canvas');
        wrapper.appendChild(canvas);
        container.appendChild(wrapper);

        let chartOptions = { 
            responsive: true, 
            maintainAspectRatio: false, 
            plugins: { legend: { display: false }, title: { display: true, text: title, font: {size: 16} } }, 
            scales: { 
                x: { ticks: { maxRotation: 45, minRotation: 0 } },
                y: { beginAtZero: true, title: { display: true, text: 'Frequency' }, ticks: { stepSize: 1 } } 
            } 
        };
        
        // Lock the Y-axis height for Delta E
        if (maxY !== null) chartOptions.scales.y.max = maxY;

        new Chart(canvas, {
            type: 'bar',
            data: {
                labels: labels,
                datasets:[{ label: title, data: counts, backgroundColor: 'rgba(54, 162, 235, 0.6)', borderColor: 'rgba(54, 162, 235, 1)', borderWidth: 1 }]
            },
            options: chartOptions
        });
    }
}
