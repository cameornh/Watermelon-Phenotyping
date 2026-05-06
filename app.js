
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
            resultDiv.innerHTML = `
                <p><strong>R²:</strong> ${data.r2_score.toFixed(4)}</p>
                <p><strong>Width:</strong> ${data.width_val.toFixed(2)}</p>
                <p><strong>Height:</strong> ${data.height_val.toFixed(2)}</p>
                <p><strong>Perimeter:</strong> ${data.perimeter_val.toFixed(2)}</p>
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
    
    tbody.innerHTML = "";
    table.style.display = "table";
    let completed = 0;

    for (let i = 0; i < files.length; i++) {
        status.innerText = `Processing image ${i + 1} of ${files.length}...`;
        const formData = new FormData();
        formData.append("file", files[i]);

        try {
            const response = await fetch(API_URL, { method: "POST", body: formData });
            const data = await response.json();
            
            const tr = document.createElement('tr');
            if (data.success) {
                tr.innerHTML = `
                    <td>${data.filename}</td>
                    <td>${data.r2_score.toFixed(4)}</td>
                    <td>${data.width_val.toFixed(2)}</td>
                    <td>${data.height_val.toFixed(2)}</td>
                    <td>${data.perimeter_val.toFixed(2)}</td>
                    <td><img src="data:image/jpeg;base64,${data.image_base64}" class="thumb" onclick="window.open(this.src)"></td>
                `;
            } else {
                tr.innerHTML = `<td>${files[i].name}</td><td colspan="5" style="color:red;">Error: ${data.message}</td>`;
            }
            tbody.appendChild(tr);
        } catch (err) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${files[i].name}</td><td colspan="5" style="color:red;">API Connection Failed</td>`;
            tbody.appendChild(tr);
        }
        completed++;
    }
    status.innerText = `Batch complete! Processed ${completed} images.`;
});
