# RAG Batch QA Certifier

This app reviews multiple AI agent responses against uploaded RAG documents and returns both a batch summary and question-level QA analysis.

## What it does

- Upload one or more PDF or text-based RAG reference documents
- Upload one Excel or CSV file with headers named `query` and `response`
- Evaluate each valid spreadsheet row against the same reference documents
- Get:
  - average overall score across the sheet
  - average groundedness score
  - certification counts and rate
  - hallucination flags
  - per-question scorecards with:
    - certification status
    - correctness score
    - groundedness score
    - hallucination flag and risk
    - supported points
    - unsupported or incorrect points
    - missing points
    - document coverage notes
    - a recommended corrected response

## Spreadsheet format

The uploaded spreadsheet must contain these headers in the first row:

- `query`
- `response`

Notes:

- Only the first sheet is used
- Blank rows are ignored
- Rows missing either `query` or `response` are skipped and shown in the UI
- The app currently evaluates up to 100 valid rows per upload

## Supported document types

Supported RAG files:

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

Supported evaluation sheet types:

- `.xlsx`
- `.xls`
- `.csv`

## Run

1. Add `OCI_ENDPOINT` and `BEARER_TOKEN` to `.env`
2. Install dependencies with `npm install`
3. Start the app with `npm start`
4. Open `http://localhost:3000`

## Notes on PDFs

- Text-based PDFs are supported directly
- Scanned or image-only PDFs may produce little or no extractable text
- Password-protected PDFs may be skipped
- Upload limit is 25 MB per file
