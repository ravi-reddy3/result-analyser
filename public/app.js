document.getElementById('analyseBtn').addEventListener('click', async () => {
    const logText = document.getElementById('logInput').value;
    const resultDiv = document.getElementById('result');

    if (!logText.trim()) {
        resultDiv.innerHTML = '<p class="error">Please paste a log first.</p>';
        return;
    }

    resultDiv.innerHTML = '<p class="loading">Analysing... ⏳</p>';

    try {
        const response = await fetch('/analyze', { // Check spelling (z vs s)
            method: 'POST',
            headers: { 'Content-Type': 'text/plain'
             },
            body: logText,
        });

        if (!response.ok) {
            throw new Error(`Server responded with ${response.status}`);
        }

        const data = await response.json();
        
        // Use textContent instead of innerHTML for the AI response 
        // to prevent XSS if the AI returns HTML-like tags.
        resultDiv.innerHTML = '<h3>Analysis Result:</h3>';
        const pre = document.createElement('pre');
        pre.textContent = data.analysis || "No analysis returned.";
        resultDiv.appendChild(pre);

    } catch (error) {
        console.error("Analysis Error:", error);
        resultDiv.innerHTML = `<p class="error">Error: ${error.message}</p>`;
    }
});