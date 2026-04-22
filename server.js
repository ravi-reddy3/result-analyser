import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';
import { PDFParse } from 'pdf-parse';

const app = express();
const upload = multer({
    dest: 'uploads/',
    limits: {
        files: 11,
        fileSize: 25 * 1024 * 1024
    }
});

const SUPPORTED_EXTENSIONS = new Set([
    '.txt',
    '.md',
    '.markdown',
    '.csv',
    '.json',
    '.jsonl',
    '.html',
    '.htm',
    '.xml',
    '.yml',
    '.yaml',
    '.log',
    '.pdf'
]);

const SPREADSHEET_EXTENSIONS = new Set([
    '.xlsx',
    '.xls',
    '.csv'
]);

const MAX_SHEET_ROWS = 100;

app.use(express.static('public'));

function createHttpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function extractMessageText(messageContent) {
    if (!messageContent) return '';

    if (Array.isArray(messageContent)) {
        return messageContent
            .map(part => {
                if (typeof part === 'string') return part;
                if (typeof part?.text === 'string') return part.text;
                return JSON.stringify(part);
            })
            .join('\n');
    }

    if (typeof messageContent === 'string') {
        return messageContent;
    }

    if (typeof messageContent?.text === 'string') {
        return messageContent.text;
    }

    return JSON.stringify(messageContent);
}

function decodeEscapedString(value) {
    let result = '';

    for (let i = 0; i < value.length; i += 1) {
        const current = value[i];
        const next = value[i + 1];

        if (current !== '\\' || next === undefined) {
            result += current;
            continue;
        }

        if (next === 'n') {
            result += '\n';
            i += 1;
            continue;
        }

        if (next === 'r') {
            result += '\r';
            i += 1;
            continue;
        }

        if (next === 't') {
            result += '\t';
            i += 1;
            continue;
        }

        if (next === "'" || next === '"' || next === '\\') {
            result += next;
            i += 1;
            continue;
        }

        result += current;
    }

    return result;
}

function extractAnalysisPayload(responseData) {
    if (typeof responseData === 'string') {
        return responseData;
    }

    if (responseData?.choices?.[0]?.message?.content) {
        return extractMessageText(responseData.choices[0].message.content);
    }

    if (responseData?.message?.content) {
        return extractMessageText(responseData.message.content);
    }

    return JSON.stringify(responseData);
}

function parseAnalysisResponse(rawText) {
    const cleanText = rawText
        .replace(/```json/g, '')
        .replace(/```/g, '')
        .trim();

    const tryParse = (text) => {
        const parsed = JSON.parse(text);

        if (parsed?.choices?.[0]?.message?.content) {
            return parseAnalysisResponse(extractMessageText(parsed.choices[0].message.content));
        }

        return parsed;
    };

    try {
        return tryParse(cleanText);
    } catch {
        // Continue to wrapper extraction fallbacks.
    }

    const singleQuotedTextMatch = cleanText.match(/['"]text['"]\s*:\s*'((?:\\.|[^'])*)'/);
    if (singleQuotedTextMatch?.[1]) {
        return parseAnalysisResponse(decodeEscapedString(singleQuotedTextMatch[1]));
    }

    const doubleQuotedTextMatch = cleanText.match(/['"]text['"]\s*:\s*"((?:\\.|[^"])*)"/);
    if (doubleQuotedTextMatch?.[1]) {
        return parseAnalysisResponse(decodeEscapedString(doubleQuotedTextMatch[1]));
    }

    const firstBrace = cleanText.indexOf('{');
    const lastBrace = cleanText.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        return tryParse(cleanText.slice(firstBrace, lastBrace + 1));
    }

    throw new Error('No JSON object found in AI response.');
}

function collectUploadedFiles(filesByField) {
    if (Array.isArray(filesByField)) {
        return filesByField;
    }

    if (!filesByField || typeof filesByField !== 'object') {
        return [];
    }

    return Object.values(filesByField).flat();
}

function cleanupUploadedFiles(files) {
    files.forEach(file => {
        try {
            fs.unlinkSync(file.path);
        } catch {
            // Ignore cleanup failures for temp uploads.
        }
    });
}

function getUploadedFiles(filesByField, fieldName) {
    if (!filesByField || typeof filesByField !== 'object') {
        return [];
    }

    return Array.isArray(filesByField[fieldName]) ? filesByField[fieldName] : [];
}

function isSupportedDocument(file) {
    const extension = path.extname(file.originalname || '').toLowerCase();
    return extension === '.pdf'
        || SUPPORTED_EXTENSIONS.has(extension)
        || (file.mimetype || '').startsWith('text/');
}

function isSupportedSpreadsheet(file) {
    const extension = path.extname(file.originalname || '').toLowerCase();
    return SPREADSHEET_EXTENSIONS.has(extension);
}

function normaliseDocumentText(text) {
    return text
        .replace(/\r\n/g, '\n')
        .replace(/\u0000/g, '')
        .trim();
}

function tokenizeForSearch(text) {
    return Array.from(new Set(
        (text.toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) || [])
            .filter(token => token.length >= 3)
    ));
}

function extractQuotedPhrases(text) {
    return Array.from(new Set(
        [...text.matchAll(/"([^"]{4,120})"/g)]
            .map(match => match[1].trim())
            .filter(Boolean)
    ));
}

function buildSearchTerms(query, agentResponse) {
    const exactPhrases = Array.from(new Set([
        query.trim(),
        ...extractQuotedPhrases(query),
        ...extractQuotedPhrases(agentResponse)
    ].filter(Boolean)));

    const keywords = tokenizeForSearch(`${query} ${agentResponse}`);
    return { exactPhrases, keywords };
}

function chunkDocument(content, chunkSize = 1400, overlap = 200) {
    if (content.length <= chunkSize) {
        return [content];
    }

    const chunks = [];
    let start = 0;

    while (start < content.length) {
        const end = Math.min(start + chunkSize, content.length);
        chunks.push(content.slice(start, end));

        if (end >= content.length) {
            break;
        }

        start = Math.max(end - overlap, start + 1);
    }

    return chunks;
}

function scoreChunk(chunk, searchTerms) {
    const lowerChunk = chunk.toLowerCase();
    let score = 0;

    searchTerms.exactPhrases.forEach(phrase => {
        const lowerPhrase = phrase.toLowerCase();

        if (lowerPhrase && lowerChunk.includes(lowerPhrase)) {
            score += Math.max(20, lowerPhrase.length);
        }
    });

    searchTerms.keywords.forEach(keyword => {
        if (lowerChunk.includes(keyword)) {
            score += keyword.length > 8 ? 4 : 2;
        }
    });

    return score;
}

function selectRelevantExcerpt(doc, searchTerms, charBudget) {
    if (doc.content.length <= charBudget) {
        return doc.content;
    }

    const chunks = chunkDocument(doc.content).map((chunk, index) => ({
        chunk,
        index,
        score: scoreChunk(chunk, searchTerms)
    }));

    const rankedChunks = chunks
        .slice()
        .sort((a, b) => b.score - a.score || a.index - b.index);

    const selectedChunks = rankedChunks
        .slice(0, 3)
        .sort((a, b) => a.index - b.index)
        .map(item => item.chunk);

    const combined = selectedChunks.join('\n\n[...]\n\n');

    if (combined.trim()) {
        return combined.length > charBudget
            ? `${combined.slice(0, charBudget)}\n[Relevant excerpt truncated for analysis.]`
            : combined;
    }

    return `${doc.content.slice(0, charBudget)}\n[Document excerpt truncated for analysis.]`;
}

async function readDocumentContent(file) {
    const extension = path.extname(file.originalname || '').toLowerCase();

    if (extension === '.pdf' || file.mimetype === 'application/pdf') {
        const data = fs.readFileSync(file.path);
        const parser = new PDFParse({ data });

        try {
            const result = await parser.getText();
            return normaliseDocumentText(result?.text || '');
        } finally {
            await parser.destroy();
        }
    }

    const rawText = fs.readFileSync(file.path, 'utf8');
    return normaliseDocumentText(rawText);
}

async function prepareSupportedDocuments(files) {
    const supportedFiles = [];
    const skippedFiles = [];

    for (const file of files) {
        if (!isSupportedDocument(file)) {
            skippedFiles.push({
                name: file.originalname,
                reason: 'Unsupported file type. Upload PDFs or text-based RAG documents such as TXT, MD, CSV, JSON, HTML, XML, YAML, or LOG.'
            });
            continue;
        }

        let content = '';

        try {
            content = await readDocumentContent(file);
        } catch {
            skippedFiles.push({
                name: file.originalname,
                reason: 'The document could not be parsed. Make sure the PDF is not scanned-only or password-protected, and that text files are UTF-8 readable.'
            });
            continue;
        }

        if (!content) {
            skippedFiles.push({
                name: file.originalname,
                reason: 'No readable text was extracted from this document.'
            });
            continue;
        }

        supportedFiles.push({
            name: file.originalname,
            content
        });
    }

    return { supportedFiles, skippedFiles };
}

function buildDocumentBundle(documents, searchTerms) {
    if (!documents.length) {
        return '';
    }

    const maxCharsPerDocument = 7000;
    const maxTotalChars = 24000;
    let totalChars = 0;

    return documents
        .map((doc, index) => {
            const remaining = maxTotalChars - totalChars;
            if (remaining <= 0) {
                return `Document ${index + 1}: ${doc.name}\n[Document excluded because the total reference size limit was reached.]`;
            }

            const allowedChars = Math.min(maxCharsPerDocument, remaining);
            const excerpt = selectRelevantExcerpt(doc, searchTerms, allowedChars);

            totalChars += excerpt.length;
            return `Document ${index + 1}: ${doc.name}\n${excerpt}`;
        })
        .join('\n\n---\n\n');
}

function normaliseHeaderName(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_');
}

function parseSpreadsheetRows(file) {
    if (!isSupportedSpreadsheet(file)) {
        throw createHttpError(400, 'Upload an Excel or CSV file for the evaluation sheet.');
    }

    const workbook = XLSX.readFile(file.path, { cellDates: false });
    const firstSheetName = workbook.SheetNames[0];

    if (!firstSheetName) {
        throw createHttpError(400, 'The uploaded spreadsheet does not contain any sheets.');
    }

    const worksheet = workbook.Sheets[firstSheetName];
    const rows = XLSX.utils.sheet_to_json(worksheet, {
        header: 1,
        defval: '',
        raw: false,
        blankrows: false
    });

    if (!rows.length) {
        throw createHttpError(400, 'The uploaded spreadsheet is empty.');
    }

    const headerRow = Array.isArray(rows[0]) ? rows[0] : [];
    const normalisedHeaders = headerRow.map(normaliseHeaderName);
    const queryIndex = normalisedHeaders.indexOf('query');
    const responseIndex = normalisedHeaders.indexOf('response');

    if (queryIndex === -1 || responseIndex === -1) {
        throw createHttpError(400, 'The spreadsheet must contain `query` and `response` columns in the header row.');
    }

    const records = [];
    const skippedRows = [];

    for (let index = 1; index < rows.length; index += 1) {
        const sheetRow = Array.isArray(rows[index]) ? rows[index] : [];
        const rowNumber = index + 1;
        const query = String(sheetRow[queryIndex] || '').trim();
        const response = String(sheetRow[responseIndex] || '').trim();

        if (!query && !response) {
            continue;
        }

        if (!query || !response) {
            skippedRows.push({
                rowNumber,
                reason: !query
                    ? 'Missing query value.'
                    : 'Missing response value.'
            });
            continue;
        }

        records.push({
            rowNumber,
            query,
            response
        });
    }

    if (!records.length) {
        throw createHttpError(400, 'No valid rows were found. Each row must include both `query` and `response`.');
    }

    if (records.length > MAX_SHEET_ROWS) {
        throw createHttpError(400, `The sheet contains ${records.length} valid rows. Please upload ${MAX_SHEET_ROWS} or fewer rows per run.`);
    }

    return {
        sheetName: firstSheetName,
        records,
        skippedRows
    };
}

function buildEvaluationPrompt({ query, agentResponse, ragDocuments }) {
    return `You are a senior QA analyst certifying whether an AI agent answer is accurate and grounded in the provided RAG documents.

Evaluate the AGENT RESPONSE only against the REFERENCE DOCUMENTS and the USER QUERY.
Do not use outside knowledge.
If the response contains claims that are unsupported, contradicted, overconfident, or materially incomplete relative to the query, count that against correctness.

Return ONLY a JSON object in this exact schema:
{
  "certification_status": "Certified" | "Needs Review" | "Not Certified",
  "correctness_score": 0,
  "groundedness_score": 0,
  "hallucination": false,
  "hallucination_risk": "Low" | "Medium" | "High",
  "summary": "short overall assessment",
  "verdict_reason": "why this certification decision was made",
  "supported_points": ["point"],
  "unsupported_or_incorrect_points": ["point"],
  "missing_points": ["point"],
  "document_coverage": ["point"],
  "recommended_response": "best corrected answer using only the provided documents"
}

Scoring rules:
- 90-100: Fully grounded, accurate, and complete for the user query
- 75-89: Mostly correct with minor gaps or cautious overreach
- 50-74: Mixed quality, noticeable omissions, ambiguity, or partly unsupported claims
- 0-49: Major hallucination, contradiction, or clearly incorrect answer

Groundedness scoring rules:
- 90-100: Nearly every material claim is directly supported by the reference documents
- 75-89: Mostly grounded, with only minor unsupported phrasing or weakly evidenced claims
- 50-74: Mixed grounding, with some claims supported and some only partially supported
- 0-49: Major unsupported or contradicted claims, or strong evidence of hallucination

Certification rules:
- "Certified" only when the answer is well-grounded, materially correct, and has no meaningful hallucination
- "Needs Review" when there are minor issues, uncertainty, or partial support
- "Not Certified" when the answer is materially wrong, contradicted, or hallucinated

Hallucination rules:
- hallucination = true if any material claim is not supported by the RAG documents or is contradicted by them
- hallucination_risk reflects the severity of unsupported content overall

Keep list items concise and evidence-focused.

USER QUERY:
${query}

AGENT RESPONSE:
${agentResponse}

REFERENCE DOCUMENTS:
${ragDocuments}`;
}

function toNumberOrNull(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function buildFallbackAnalysis(fullText) {
    return {
        certification_status: 'Needs Review',
        correctness_score: null,
        groundedness_score: null,
        hallucination: null,
        hallucination_risk: 'Medium',
        summary: 'The QA model returned output that could not be parsed into the expected JSON format.',
        verdict_reason: 'This row needs manual review because the evaluator response was malformed.',
        supported_points: [],
        unsupported_or_incorrect_points: [],
        missing_points: [],
        document_coverage: [],
        recommended_response: '',
        raw: fullText
    };
}

async function analyseRow({ query, response, rowNumber }, documents) {
    const searchTerms = buildSearchTerms(query, response);
    const bundledText = buildDocumentBundle(documents, searchTerms);

    const apiResponse = await fetch(process.env.OCI_ENDPOINT, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${process.env.BEARER_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'genai.openai.gpt-5.2',
            stream: false,
            messages: [
                {
                    role: 'system',
                    content: 'You are a rigorous QA certification assistant for RAG agents. Return only strict JSON.'
                },
                {
                    role: 'user',
                    content: buildEvaluationPrompt({
                        query,
                        agentResponse: response,
                        ragDocuments: bundledText
                    })
                }
            ]
        })
    });

    if (!apiResponse.ok) {
        const errorText = await apiResponse.text();
        console.error('API Error:', apiResponse.status, errorText);
        throw createHttpError(apiResponse.status, `API Error: ${apiResponse.status}`);
    }

    const responseText = await apiResponse.text();
    let responseData;

    try {
        responseData = JSON.parse(responseText);
    } catch {
        responseData = responseText;
    }

    const fullText = extractAnalysisPayload(responseData);

    if (!fullText) {
        throw new Error(`No parsable analysis content returned for row ${rowNumber}.`);
    }

    let analysis;
    try {
        analysis = parseAnalysisResponse(fullText);
    } catch {
        analysis = buildFallbackAnalysis(fullText);
    }

    return {
        rowNumber,
        query,
        response,
        analysis
    };
}

function average(values) {
    if (!values.length) {
        return null;
    }

    const total = values.reduce((sum, value) => sum + value, 0);
    return Number((total / values.length).toFixed(1));
}

function buildBatchSummary(evaluations) {
    const correctnessScores = evaluations
        .map(item => toNumberOrNull(item.analysis?.correctness_score))
        .filter(value => value !== null);

    const groundednessScores = evaluations
        .map(item => toNumberOrNull(item.analysis?.groundedness_score))
        .filter(value => value !== null);

    const certifiedCount = evaluations.filter(item => item.analysis?.certification_status === 'Certified').length;
    const needsReviewCount = evaluations.filter(item => item.analysis?.certification_status === 'Needs Review').length;
    const notCertifiedCount = evaluations.filter(item => item.analysis?.certification_status === 'Not Certified').length;
    const hallucinationCount = evaluations.filter(item => item.analysis?.hallucination === true).length;
    const parseFailureCount = evaluations.filter(item => item.analysis?.raw).length;

    return {
        totalQuestions: evaluations.length,
        averageOverallScore: average(correctnessScores),
        averageGroundednessScore: average(groundednessScores),
        certifiedCount,
        needsReviewCount,
        notCertifiedCount,
        hallucinationCount,
        parseFailureCount,
        certificationRate: evaluations.length
            ? Number(((certifiedCount / evaluations.length) * 100).toFixed(1))
            : null
    };
}

app.post(
    '/evaluate',
    upload.fields([
        { name: 'ragDocuments', maxCount: 10 },
        { name: 'evaluationSheet', maxCount: 1 }
    ]),
    async (req, res) => {
        const allUploadedFiles = collectUploadedFiles(req.files);

        try {
            const ragFiles = getUploadedFiles(req.files, 'ragDocuments');
            const sheetFile = getUploadedFiles(req.files, 'evaluationSheet')[0];

            if (!ragFiles.length) {
                return res.status(400).json({ error: 'Upload at least one RAG document.' });
            }

            if (!sheetFile) {
                return res.status(400).json({ error: 'Upload an Excel or CSV file that contains `query` and `response` columns.' });
            }

            if (!process.env.OCI_ENDPOINT || !process.env.BEARER_TOKEN) {
                return res.status(500).json({
                    error: 'Missing OCI configuration. Add OCI_ENDPOINT and BEARER_TOKEN to your .env file.'
                });
            }

            const { sheetName, records, skippedRows } = parseSpreadsheetRows(sheetFile);
            const { supportedFiles, skippedFiles } = await prepareSupportedDocuments(ragFiles);

            if (!supportedFiles.length) {
                return res.status(400).json({
                    error: 'No supported readable RAG documents were found.',
                    skippedFiles
                });
            }

            const evaluations = [];

            for (const record of records) {
                const evaluation = await analyseRow(record, supportedFiles);
                evaluations.push(evaluation);
            }

            res.json({
                summary: buildBatchSummary(evaluations),
                evaluations,
                sheet: {
                    fileName: sheetFile.originalname,
                    sheetName,
                    skippedRows
                },
                documentCount: supportedFiles.length,
                documentNames: supportedFiles.map(file => file.name),
                skippedFiles
            });
        } catch (error) {
            console.error('Full error:', error);
            res.status(error.status || 500).json({ error: error.message });
        } finally {
            cleanupUploadedFiles(allUploadedFiles);
        }
    }
);

app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);

    if (res.headersSent) {
        return next(error);
    }

    if (error instanceof multer.MulterError) {
        const message = error.code === 'LIMIT_FILE_SIZE'
            ? 'One of the uploaded files is too large. The current limit is 25 MB per file.'
            : error.code === 'LIMIT_FILE_COUNT'
                ? 'Too many files were uploaded. The current limit is 10 RAG files plus 1 spreadsheet per request.'
                : `Upload error: ${error.message}`;

        return res.status(400).json({ error: message });
    }

    return res.status(500).json({
        error: error?.message || 'Unexpected server error.'
    });
});

app.listen(3000, () => console.log('Server running on http://localhost:3000'));
