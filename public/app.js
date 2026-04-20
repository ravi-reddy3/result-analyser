const form = document.getElementById('evaluationForm');
const fileInput = document.getElementById('ragDocuments');
const fileList = document.getElementById('fileList');
const dropzone = document.getElementById('dropzone');
const resultDiv = document.getElementById('result');
const evaluateBtn = document.getElementById('evaluateBtn');

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderFileList() {
    const files = Array.from(fileInput.files || []);

    if (!files.length) {
        fileList.innerHTML = '<p class="helper-text">No reference documents selected yet.</p>';
        return;
    }

    fileList.innerHTML = files
        .map(file => `<span class="file-pill">${escapeHtml(file.name)}</span>`)
        .join('');
}

function normaliseList(items, fallbackText) {
    if (!Array.isArray(items) || items.length === 0) {
        return `<li>${escapeHtml(fallbackText)}</li>`;
    }

    return items
        .map(item => `<li>${escapeHtml(item)}</li>`)
        .join('');
}

function renderResult(data) {
    const analysis = data.analysis;

    if (!analysis || analysis.raw) {
        resultDiv.classList.add('visible');
        resultDiv.innerHTML = `
            <p class="error">Could not parse the QA response.</p>
            <pre class="raw-output">${escapeHtml(analysis?.raw || 'No response')}</pre>
        `;
        return;
    }

    const score = Number.isFinite(Number(analysis.correctness_score))
        ? Number(analysis.correctness_score)
        : 'N/A';
    const groundednessScore = Number.isFinite(Number(analysis.groundedness_score))
        ? Number(analysis.groundedness_score)
        : score;

    const status = analysis.certification_status || 'Needs Review';
    const hallucination = Boolean(analysis.hallucination);
    const risk = analysis.hallucination_risk || 'Medium';
    const verdictClass = status === 'Certified'
        ? 'pass'
        : status === 'Needs Review'
            ? 'warn'
            : 'fail';

    const warningsHtml = (data.skippedFiles || []).length
        ? `
            <div class="inline-banner warn">
              Some files were skipped:
              ${data.skippedFiles.map(file => `${escapeHtml(file.name)} (${escapeHtml(file.reason)})`).join(', ')}
            </div>
          `
        : '';

    resultDiv.classList.add('visible');
    resultDiv.innerHTML = `
        ${warningsHtml}
        <div class="summary-grid">
          <article class="hero-result ${verdictClass}">
            <div>
              <div class="result-kicker">QA Certification</div>
              <h3>${escapeHtml(status)}</h3>
              <p>${escapeHtml(analysis.summary || 'No summary provided.')}</p>
            </div>
            <div class="score-ring ${verdictClass}">
              <span>${score}</span>
              <small>/100</small>
            </div>
          </article>

          <article class="stat-card">
            <span class="stat-label">Groundedness</span>
            <strong>${escapeHtml(groundednessScore)}</strong>
            <p>How strongly the response is supported by the uploaded RAG documents.</p>
          </article>

          <article class="stat-card">
            <span class="stat-label">Hallucination</span>
            <strong class="${hallucination ? 'text-fail' : 'text-pass'}">
              ${hallucination ? 'Detected' : 'Not Detected'}
            </strong>
            <p>${escapeHtml(risk)} risk</p>
          </article>

          <article class="stat-card">
            <span class="stat-label">Documents Used</span>
            <strong>${escapeHtml(data.documentCount || 0)}</strong>
            <p>${escapeHtml((data.documentNames || []).join(', ') || 'No documents listed')}</p>
          </article>
        </div>

        <div class="analysis-grid">
          <article class="analysis-card focus">
            <div class="card-label">Verdict Reason</div>
            <p class="lead">${escapeHtml(analysis.verdict_reason || 'No verdict reason provided.')}</p>
          </article>

          <article class="analysis-card">
            <div class="card-label">Supported Points</div>
            <ul class="analysis-list">
              ${normaliseList(analysis.supported_points, 'No supported points were listed.')}
            </ul>
          </article>

          <article class="analysis-card">
            <div class="card-label">Unsupported Or Incorrect</div>
            <ul class="analysis-list">
              ${normaliseList(analysis.unsupported_or_incorrect_points, 'No unsupported points were listed.')}
            </ul>
          </article>

          <article class="analysis-card">
            <div class="card-label">Missing Points</div>
            <ul class="analysis-list">
              ${normaliseList(analysis.missing_points, 'No missing points were listed.')}
            </ul>
          </article>

          <article class="analysis-card">
            <div class="card-label">Document Coverage</div>
            <ul class="analysis-list">
              ${normaliseList(analysis.document_coverage, 'No document coverage notes were listed.')}
            </ul>
          </article>

          <article class="analysis-card recommendation">
            <div class="card-label">Recommended Corrected Response</div>
            <pre>${escapeHtml(analysis.recommended_response || 'No recommended response was provided.')}</pre>
          </article>
        </div>
    `;
}

function showError(message) {
    resultDiv.classList.add('visible');
    resultDiv.innerHTML = `<p class="error">${escapeHtml(message)}</p>`;
}

async function parseJsonSafely(response) {
    const rawText = await response.text();
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
        try {
            return JSON.parse(rawText);
        } catch {
            throw new Error('The server returned invalid JSON.');
        }
    }

    try {
        return JSON.parse(rawText);
    } catch {
        const compactText = rawText
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 180);

        throw new Error(
            compactText.startsWith('<!DOCTYPE') || compactText.startsWith('<html')
                ? 'The server returned an HTML error page instead of JSON. Please restart the server and check the terminal for the real backend error.'
                : `Unexpected server response: ${compactText || 'empty response'}`
        );
    }
}

fileInput.addEventListener('change', renderFileList);

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        fileInput.click();
    }
});

form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const files = Array.from(fileInput.files || []);
    const query = document.getElementById('agentQuery').value.trim();
    const responseText = document.getElementById('agentResponse').value.trim();

    if (!files.length) {
        showError('Upload at least one RAG document.');
        return;
    }

    if (!query) {
        showError('Enter the user query.');
        return;
    }

    if (!responseText) {
        showError('Enter the agent response.');
        return;
    }

    evaluateBtn.disabled = true;
    resultDiv.classList.add('visible');
    resultDiv.innerHTML = '<p class="loading">Reviewing the response against the RAG documents...</p>';

    try {
        const formData = new FormData();
        files.forEach(file => formData.append('ragDocuments', file));
        formData.append('agentQuery', query);
        formData.append('agentResponse', responseText);

        const response = await fetch('/evaluate', {
            method: 'POST',
            body: formData
        });

        const data = await parseJsonSafely(response);

        if (!response.ok) {
            throw new Error(data.error || `Server responded with ${response.status}`);
        }

        renderResult(data);
    } catch (error) {
        console.error('Evaluation Error:', error);
        showError(error.message);
    } finally {
        evaluateBtn.disabled = false;
    }
});

renderFileList();
