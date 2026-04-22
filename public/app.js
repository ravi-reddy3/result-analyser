const form = document.getElementById('evaluationForm');
const fileInput = document.getElementById('ragDocuments');
const sheetInput = document.getElementById('evaluationSheet');
const fileList = document.getElementById('fileList');
const sheetSelection = document.getElementById('sheetSelection');
const dropzone = document.getElementById('dropzone');
const sheetDropzone = document.getElementById('sheetDropzone');
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

function getVerdictClass(status) {
    return status === 'Certified'
        ? 'pass'
        : status === 'Needs Review'
            ? 'warn'
            : 'fail';
}

function formatScore(value, fallback = 'N/A') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed.toFixed(1).replace(/\.0$/, '') : fallback;
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

function renderSheetSelection() {
    const file = sheetInput.files?.[0];

    sheetSelection.innerHTML = file
        ? `<span class="file-pill file-pill-sheet">${escapeHtml(file.name)}</span>`
        : 'No evaluation sheet selected yet.';
}

function normaliseList(items, fallbackText) {
    if (!Array.isArray(items) || items.length === 0) {
        return `<li>${escapeHtml(fallbackText)}</li>`;
    }

    return items
        .map(item => `<li>${escapeHtml(item)}</li>`)
        .join('');
}

function renderWarnings(data) {
    const warnings = [];

    if (Array.isArray(data.skippedFiles) && data.skippedFiles.length) {
        warnings.push(`
            <div class="inline-banner warn">
              Some reference documents were skipped:
              ${data.skippedFiles.map(file => `${escapeHtml(file.name)} (${escapeHtml(file.reason)})`).join(', ')}
            </div>
        `);
    }

    if (Array.isArray(data.sheet?.skippedRows) && data.sheet.skippedRows.length) {
        warnings.push(`
            <div class="inline-banner warn">
              Some spreadsheet rows were skipped:
              ${data.sheet.skippedRows.map(row => `Row ${escapeHtml(row.rowNumber)} (${escapeHtml(row.reason)})`).join(', ')}
            </div>
        `);
    }

    return warnings.join('');
}

function renderQuestionCard(item, index) {
    const analysis = item.analysis || {};
    const status = analysis.certification_status || 'Needs Review';
    const verdictClass = getVerdictClass(status);
    const overallScore = formatScore(analysis.correctness_score);
    const groundednessScore = formatScore(analysis.groundedness_score);
    const hallucinationText = analysis.hallucination === true
        ? 'Detected'
        : analysis.hallucination === false
            ? 'Not Detected'
            : 'Needs Review';

    const detailContent = analysis.raw
        ? `
            <div class="question-grid">
              <article class="analysis-card">
                <div class="card-label">Parsing Note</div>
                <p class="lead">${escapeHtml(analysis.summary || 'The model output could not be parsed for this question.')}</p>
              </article>
              <article class="analysis-card recommendation">
                <div class="card-label">Raw Evaluator Output</div>
                <pre>${escapeHtml(analysis.raw)}</pre>
              </article>
            </div>
        `
        : `
            <div class="question-grid">
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

    return `
        <article class="question-card ${verdictClass}">
          <div class="question-head">
            <div>
              <div class="result-kicker">Question ${index + 1} • Sheet Row ${escapeHtml(item.rowNumber)}</div>
              <h3>${escapeHtml(status)}</h3>
              <p class="question-summary">${escapeHtml(analysis.summary || 'No summary provided.')}</p>
            </div>
            <div class="score-cluster">
              <div class="mini-score ${verdictClass}">
                <span>${escapeHtml(overallScore)}</span>
                <small>Overall</small>
              </div>
              <div class="mini-stat">
                <strong>${escapeHtml(groundednessScore)}</strong>
                <small>Groundedness</small>
              </div>
            </div>
          </div>

          <div class="chip-row">
            <span class="metric-chip">${escapeHtml(status)}</span>
            <span class="metric-chip">Hallucination: ${escapeHtml(hallucinationText)}</span>
            <span class="metric-chip">Risk: ${escapeHtml(analysis.hallucination_risk || 'Medium')}</span>
          </div>

          <div class="qa-grid">
            <article class="qa-card">
              <div class="card-label">Query</div>
              <p>${escapeHtml(item.query)}</p>
            </article>
            <article class="qa-card">
              <div class="card-label">Agent Response</div>
              <p>${escapeHtml(item.response)}</p>
            </article>
          </div>

          <details class="question-details">
            <summary>View detailed analysis</summary>
            ${detailContent}
          </details>
        </article>
    `;
}

function renderResult(data) {
    const summary = data.summary || {};
    const overallScore = formatScore(summary.averageOverallScore);
    const groundednessScore = formatScore(summary.averageGroundednessScore);
    const certificationRate = formatScore(summary.certificationRate, '0');
    const warningsHtml = renderWarnings(data);
    const evaluations = Array.isArray(data.evaluations) ? data.evaluations : [];

    resultDiv.classList.add('visible');
    resultDiv.innerHTML = `
        ${warningsHtml}

        <div class="summary-grid">
          <article class="hero-result ${getVerdictClass(summary.averageOverallScore >= 75 ? 'Certified' : summary.averageOverallScore >= 50 ? 'Needs Review' : 'Not Certified')}">
            <div>
              <div class="result-kicker">Batch QA Summary</div>
              <h3>${escapeHtml(data.sheet?.fileName || 'Uploaded Sheet')}</h3>
              <p>
                Evaluated ${escapeHtml(summary.totalQuestions || 0)} question${summary.totalQuestions === 1 ? '' : 's'}
                using ${escapeHtml(data.documentCount || 0)} reference document${data.documentCount === 1 ? '' : 's'}.
              </p>
            </div>
            <div class="score-ring ${getVerdictClass(summary.averageOverallScore >= 75 ? 'Certified' : summary.averageOverallScore >= 50 ? 'Needs Review' : 'Not Certified')}">
              <span>${escapeHtml(overallScore)}</span>
              <small>Avg /100</small>
            </div>
          </article>

          <article class="stat-card">
            <span class="stat-label">Average Groundedness</span>
            <strong>${escapeHtml(groundednessScore)}</strong>
            <p>Mean grounding strength across all valid spreadsheet rows.</p>
          </article>

          <article class="stat-card">
            <span class="stat-label">Certified Rate</span>
            <strong>${escapeHtml(certificationRate)}%</strong>
            <p>${escapeHtml(summary.certifiedCount || 0)} certified, ${escapeHtml(summary.needsReviewCount || 0)} needs review, ${escapeHtml(summary.notCertifiedCount || 0)} not certified.</p>
          </article>

          <article class="stat-card">
            <span class="stat-label">Hallucination Flags</span>
            <strong>${escapeHtml(summary.hallucinationCount || 0)}</strong>
            <p>${escapeHtml(summary.parseFailureCount || 0)} evaluation${summary.parseFailureCount === 1 ? '' : 's'} needed parsing fallback.</p>
          </article>

          <article class="stat-card">
            <span class="stat-label">Documents Used</span>
            <strong>${escapeHtml(data.documentCount || 0)}</strong>
            <p>${escapeHtml((data.documentNames || []).join(', ') || 'No documents listed')}</p>
          </article>
        </div>

        <section class="question-results">
          <div class="section-head result-head">
            <div>
              <div class="section-kicker">Question-Level Results</div>
              <h2>Per-Question Scores And Metrics</h2>
            </div>
            <p class="section-note">Each card below maps to one valid row from the uploaded sheet and includes its overall score, grounding metrics, and detailed QA evidence.</p>
          </div>

          <div class="question-list">
            ${evaluations.map(renderQuestionCard).join('')}
          </div>
        </section>
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

function wireDropzone(dropzoneElement, inputElement) {
    dropzoneElement.addEventListener('click', () => inputElement.click());
    dropzoneElement.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            inputElement.click();
        }
    });
}

fileInput.addEventListener('change', renderFileList);
sheetInput.addEventListener('change', renderSheetSelection);

wireDropzone(dropzone, fileInput);
wireDropzone(sheetDropzone, sheetInput);

form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const files = Array.from(fileInput.files || []);
    const sheetFile = sheetInput.files?.[0];

    if (!files.length) {
        showError('Upload at least one RAG document.');
        return;
    }

    if (!sheetFile) {
        showError('Upload an Excel or CSV file with `query` and `response` columns.');
        return;
    }

    evaluateBtn.disabled = true;
    resultDiv.classList.add('visible');
    resultDiv.innerHTML = '<p class="loading">Reviewing each spreadsheet row against the uploaded RAG documents. Larger batches can take a little longer.</p>';

    try {
        const formData = new FormData();
        files.forEach(file => formData.append('ragDocuments', file));
        formData.append('evaluationSheet', sheetFile);

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
renderSheetSelection();
