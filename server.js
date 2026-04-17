import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'fs';

const app = express();
const upload = multer({ dest: 'uploads/' });

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
    return value
        .replace(/\\\\/g, '\\')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\'/g, "'");
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
        // Continue with fallback extraction below.
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

app.post('/validate', upload.single('notebookFile'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded.' });
        }

        const rawContent = fs.readFileSync(req.file.path, 'utf8');
        fs.unlinkSync(req.file.path);

        // Parse the .ipynb JSON file
        let notebook;
        try {
            notebook = JSON.parse(rawContent);
        } catch (e) {
            return res.status(400).json({ error: 'Invalid .ipynb file. Please upload a valid Jupyter notebook.' });
        }

        // Extract all code cells and their outputs
        const cells = notebook.cells || [];
        let codeContent = '';
        let hasErrors = false;
        const errorList = [];

        cells.forEach((cell, index) => {
            if (cell.cell_type === 'code') {
                const source = Array.isArray(cell.source)
                    ? cell.source.join('')
                    : cell.source;

                codeContent += `\n# --- Cell ${index + 1} ---\n${source}\n`;

                // Check outputs for errors
                const outputs = cell.outputs || [];
                outputs.forEach(output => {
                    if (output.output_type === 'error') {
                        hasErrors = true;
                        errorList.push({
                            cell: index + 1,
                            ename: output.ename,
                            evalue: output.evalue
                        });
                    }
                });
            }
        });

        // Build error context for the prompt
        const errorContext = errorList.length > 0
            ? `\nThe following runtime errors were found:\n${errorList.map(e => `Cell ${e.cell}: ${e.ename} - ${e.evalue}`).join('\n')}`
            : '\nNo runtime errors detected in cell outputs.';

        // Limit code size to avoid token overflow
        const trimmedCode = codeContent.length > 8000
            ? codeContent.substring(0, 8000) + '\n# Notebook content truncated for analysis'
            : codeContent;

        const response = await fetch(process.env.OCI_ENDPOINT, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.BEARER_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: "genai.openai.gpt-5.2",
                stream: false,
                messages: [
                    {
                        role: "system",
                        content: `You are a Python code reviewer and Jupyter notebook validator.
Determine only whether the notebook code is executable in a typical validation environment.
Return results strictly in this JSON format:

{
  "executable": true,
  "reason": null,
  "score": 85
}

Rules:
- "executable" must be true only if the code is likely to run successfully end-to-end without syntax, runtime, file-path, dependency, or obvious environment errors
- If "executable" is false, "reason" must be a short sentence or two explaining the main blocking issue(s)
- If "executable" is true, "reason" must be null
- "score" must be a number from 0 to 100
- Return ONLY the JSON object, no markdown, no explanations outside the JSON`
                    },
                    {
                        role: "user",
                        content: `Check whether this Jupyter notebook code is executable.\n${trimmedCode}\n${errorContext}`
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

        // Parse the JSON response from LLM
        let analysis;
        try {
            analysis = parseAnalysisResponse(fullText);
        } catch (e) {
            // Fallback if LLM doesn't return valid JSON
            analysis = { raw: fullText };
        }

        res.json({ analysis, hasErrors, errorList });

    } catch (error) {
        console.error("Full error:", error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(3000, () => console.log('Server running on http://localhost:3000'));
