
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
            
            let de_text = data.delta_e_final ? 
                `<p><strong>ΔE Improved:</strong> ${data.delta_e_initial.toFixed(2)} → ${data.delta_e_final.toFixed(2)}</p>` : 
                `<p><strong>Color Check:</strong> Not found (Values in Pixels)</p>`;

            resultDiv.innerHTML = `
                <p><strong>R²:</strong> ${data.r2_score.toFixed(4)}</p>
                <p><strong>Width:</strong> ${data.width_val.toFixed(1)} mm</p>
                <p><strong>Height:</strong> ${data.height_val.toFixed(1)} mm</p>
                <p><strong>Perimeter:</strong> ${data.perimeter_val.toFixed(1)} mm</p>
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
    
    // Store data to build histograms at the end
    let batchData = {
        'R² Score': [],
        'Width (mm)': [],
        'Height (mm)':[],
        'Perimeter (mm)': [],
        'Initial ΔE': [],
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
                // Collect for histograms
                if(data.r2_score) batchData['R² Score'].push(data.r2_score);
                if(data.width_val) batchData['Width (mm)'].push(data.width_val);
                if(data.height_val) batchData['Height (mm)'].push(data.height_val);
                if(data.perimeter_val) batchData['Perimeter (mm)'].push(data.perimeter_val);
                if(data.delta_e_initial) batchData['Initial ΔE'].push(data.delta_e_initial);
                if(data.delta_e_final) batchData['Final ΔE'].push(data.delta_e_final);

                let dE_i = data.delta_e_initial ? data.delta_e_initial.toFixed(2) : "N/A";
                let dE_f = data.delta_e_final ? data.delta_e_final.toFixed(2) : "N/A";

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
    
    // Draw Histograms!
    drawHistograms(batchData, chartsContainer);
});

function drawHistograms(batchData, container) {
    for (const[title, values] of Object.entries(batchData)) {
        if (values.length === 0) continue; // Skip if feature wasn't collected

        const min = Math.min(...values);
        const max = Math.max(...values);
        
        // Dynamic binning
        const numBins = Math.max(5, Math.min(15, Math.ceil(values.length / 3)));
        const binWidth = (max - min) / numBins || 1;
        
        const counts = new Array(numBins).fill(0);
        const labels =[];
        
        for (let i = 0; i < numBins; i++) {
            labels.push(`${(min + i * binWidth).toFixed(2)} - ${(min + (i + 1) * binWidth).toFixed(2)}`);
        }
        
        values.forEach(val => {
            let idx = Math.floor((val - min) / binWidth);
            if (idx >= numBins) idx = numBins - 1; 
            counts[idx]++;
        });

        // Create canvas element
        const wrapper = document.createElement('div');
        wrapper.className = 'chart-box';
        const canvas = document.createElement('canvas');
        wrapper.appendChild(canvas);
        container.appendChild(wrapper);

        // Render Chart
        new Chart(canvas, {
            type: 'bar',
            data: {
                labels: labels,
                datasets:[{
                    label: title,
                    data: counts,
                    backgroundColor: 'rgba(54, 162, 235, 0.6)',
                    borderColor: 'rgba(54, 162, 235, 1)',
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false }, title: { display: true, text: title } },
                scales: { y: { beginAtZero: true, title: { display: true, text: 'Frequency' } } }
            }
        });
    }
}
