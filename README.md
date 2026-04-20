# RAG QA Certifier

This app reviews an AI agent response against uploaded RAG documents and returns a QA-style certification report.

## What it does

- Upload one or more PDF or text-based RAG reference documents
- Paste the original user query
- Paste the AI agent response
- Get:
  - certification status
  - correctness score
  - groundedness score
  - hallucination flag and risk
  - supported points
  - unsupported or incorrect points
  - missing points
  - document coverage notes
  - a recommended corrected response

## Supported document types

Supported files:

- `.pdf`
- `.txt`
- `.md`
- `.markdown`
- `.csv`
- `.json`
- `.jsonl`
- `.html`
- `.htm`
- `.xml`
- `.yml`
- `.yaml`
- `.log`

## Run

1. Add `OCI_ENDPOINT` and `BEARER_TOKEN` to `.env`
2. Install dependencies with `npm install`
3. Start the app with `npm start`
4. Open `http://localhost:3000`

## Notes on PDFs

- Text-based PDFs are supported directly.
- Scanned or image-only PDFs may produce little or no extractable text.
- Password-protected PDFs may be skipped.
- Upload limit is 25 MB per file.
