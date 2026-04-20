import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { PDFParse } from 'pdf-parse';

const app = express();
const upload = multer({
    dest: 'uploads/',
    limits: {
        files: 10,
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

app.use(express.static('public'));

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

function cleanupUploadedFiles(files) {
    files.forEach(file => {
        try {
            fs.unlinkSync(file.path);
        } catch {
            // Ignore cleanup failures for temp uploads.
        }
    });
}

function isSupportedDocument(file) {
    const extension = path.extname(file.originalname || '').toLowerCase();
    return extension === '.pdf'
        || SUPPORTED_EXTENSIONS.has(extension)
        || (file.mimetype || '').startsWith('text/');
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

async function buildDocumentBundle(files, searchTerms) {
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

    if (supportedFiles.length === 0) {
        return { bundledText: '', supportedFiles, skippedFiles };
    }

    const maxCharsPerDocument = 7000;
    const maxTotalChars = 24000;
    let totalChars = 0;

    const bundledText = supportedFiles
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

    return { bundledText, supportedFiles, skippedFiles };
}

function buildEvaluationPrompt({ query, agentResponse, ragDocuments }) {
    return `You are a senior QA analyst certifying whether an AI agent answer is accurate and grounded in the provided RAG documents.

Evaluate the AGENT RESPONSE only against the REFERENCE DOCUMENTS.
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

app.post('/evaluate', upload.array('ragDocuments', 10), async (req, res) => {
    const uploadedFiles = Array.isArray(req.files) ? req.files : [];

    try {
        const query = (req.body?.agentQuery || '').trim();
        const agentResponse = (req.body?.agentResponse || '').trim();

        if (!uploadedFiles.length) {
            return res.status(400).json({ error: 'Upload at least one RAG document.' });
        }

        if (!query) {
            return res.status(400).json({ error: 'Enter the agent query.' });
        }

        if (!agentResponse) {
            return res.status(400).json({ error: 'Enter the agent response.' });
        }

        if (!process.env.OCI_ENDPOINT || !process.env.BEARER_TOKEN) {
            return res.status(500).json({
                error: 'Missing OCI configuration. Add OCI_ENDPOINT and BEARER_TOKEN to your .env file.'
            });
        }

        const searchTerms = buildSearchTerms(query, agentResponse);
        const { bundledText, supportedFiles, skippedFiles } = await buildDocumentBundle(uploadedFiles, searchTerms);

        if (!supportedFiles.length || !bundledText) {
            return res.status(400).json({
                error: 'No supported readable RAG documents were found.',
                skippedFiles
            });
        }

        const response = await fetch(process.env.OCI_ENDPOINT, {
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
                            agentResponse,
                            ragDocuments: bundledText
                        })
                    }
                ]
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('API Error:', response.status, errorText);
            return res.status(response.status).json({ error: `API Error: ${response.status}` });
        }

        const responseText = await response.text();
        let responseData;

        try {
            responseData = JSON.parse(responseText);
        } catch {
            responseData = responseText;
        }

        const fullText = extractAnalysisPayload(responseData);

        if (!fullText) {
            throw new Error('AI response did not include parsable content.');
        }

        let analysis;
        try {
            analysis = parseAnalysisResponse(fullText);
        } catch {
            analysis = { raw: fullText };
        }

        res.json({
            analysis,
            documentCount: supportedFiles.length,
            documentNames: supportedFiles.map(file => file.name),
            skippedFiles
        });
    } catch (error) {
        console.error('Full error:', error);
        res.status(500).json({ error: error.message });
    } finally {
        cleanupUploadedFiles(uploadedFiles);
    }
});

app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);

    if (res.headersSent) {
        return next(error);
    }

    if (error instanceof multer.MulterError) {
        const message = error.code === 'LIMIT_FILE_SIZE'
            ? 'One of the uploaded files is too large. The current limit is 25 MB per file.'
            : error.code === 'LIMIT_FILE_COUNT'
                ? 'Too many files were uploaded. The current limit is 10 files per request.'
                : `Upload error: ${error.message}`;

        return res.status(400).json({ error: message });
    }

    return res.status(500).json({
        error: error?.message || 'Unexpected server error.'
    });
});

app.listen(3000, () => console.log('Server running on http://localhost:3000'));
