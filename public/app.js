const fileInput = document.getElementById('notebookFile');
const fileNameEl = document.getElementById('fileName');
const validateBtn = document.getElementById('validateBtn');
const resultDiv = document.getElementById('result');

fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        fileNameEl.textContent = file.name;
        fileNameEl.classList.add('selected');
    } else {
        fileNameEl.textContent = 'No file selected';
        fileNameEl.classList.remove('selected');
    }
});

validateBtn.addEventListener('click', async () => {
    if (!fileInput.files.length) {
        resultDiv.classList.add('visible');
        resultDiv.innerHTML = '<p class="error">Please upload a .ipynb file.</p>';
        return;
    }

    resultDiv.classList.add('visible');
    resultDiv.innerHTML = '<p class="loading">Validating your notebook...</p>';
    validateBtn.disabled = true;

    try {
        const formData = new FormData();
        formData.append('notebookFile', fileInput.files[0]);

        const response = await fetch('/validate', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) throw new Error(`Server responded with ${response.status}`);

        const data = await response.json();
        const a = data.analysis;

        if (!a || a.raw) {
            resultDiv.innerHTML = `<p class="error">Could not parse AI response. Raw output:<br><pre style="color:#9090b0;font-size:0.8rem;margin-top:0.5rem;white-space:pre-wrap">${a?.raw || 'No response'}</pre></p>`;
            return;
        }

        const isExecutable = Boolean(a.executable);
        const verdictClass = isExecutable ? 'pass' : 'fail';
        const verdictIcon = isExecutable ? '✓ Executable' : '✗ Not Executable';
        const reasonText = typeof a.reason === 'string' && a.reason.trim()
            ? a.reason.trim()
            : 'No blocking issue was reported.';
        const reasonPoints = reasonText
            .split(/\n+|;\s+|(?<=\.)\s+(?=[A-Z])/)
            .map(point => point.trim())
            .filter(Boolean);
        const score = Number.isFinite(Number(a.score)) ? Number(a.score) : 'N/A';

        let html = '';

        // Runtime error banner
        if (data.hasErrors && data.errorList.length > 0) {
            html += `<div class="error-banner">
                ⚠ Runtime errors detected in ${data.errorList.length} cell(s): 
                ${data.errorList.map(e => `Cell ${e.cell} — ${e.ename}`).join(', ')}
            </div>`;
        }

        // Verdict
        html += `<div class="verdict ${verdictClass}">
            <div>
                <div class="verdict-label">${verdictIcon}</div>
                <div style="color:#6b6b8a;font-size:0.8rem;margin-top:4px">Execution Check</div>
            </div>
            <div class="verdict-score">${score}/100</div>
        </div>`;

        html += `<div class="section-card ${verdictClass}">
            <div class="section-title">Why</div>
            <div class="section-status">${isExecutable ? 'Ready to run' : 'Blocking issue found'}</div>
            <ul class="section-points">
                ${reasonPoints.map(point => `<li>${point}</li>`).join('')}
            </ul>
        </div>`;

        resultDiv.innerHTML = html;

    } catch (error) {
        console.error('Validation Error:', error);
        resultDiv.innerHTML = `<p class="error">Error: ${error.message}</p>`;
    } finally {
        validateBtn.disabled = false;
    }
});
