document.getElementById('analyseBtn').addEventListener('click', async () => {
    const logText = document.getElementById('logInput').value;
    const resultDiv = document.getElementById('result'); // single declaration

    if (!logText.trim()) {
        resultDiv.innerHTML = '<p class="error">Please paste a log first.</p>';
        return;
    }

    resultDiv.innerHTML = '<p class="loading">Analysing... ⏳</p>';

    try {
        const response = await fetch('/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: logText,
        });

        if (!response.ok) {
            throw new Error(`Server responded with ${response.status}`);
        }

        const data = await response.json();

        // Add debug log to confirm data structure
        console.log("Response data:", data);
        console.log("Is array?", Array.isArray(data.analysis));

        resultDiv.innerHTML = ''; // clear loading message

        if (Array.isArray(data.analysis) && data.analysis.length > 0) {
            const ul = document.createElement('ul');
            ul.style.textAlign = 'left';
            ul.style.lineHeight = '1.8';
            ul.style.padding = '10px 20px';

            data.analysis.forEach(point => {
                const li = document.createElement('li');
                li.textContent = point;
                ul.appendChild(li);
            });

            resultDiv.appendChild(ul);
        } else {
            resultDiv.innerText = data.analysis || 'No response received.';
        }

    } catch (error) {
        console.error("Analysis Error:", error);
        resultDiv.innerHTML = `<p class="error">Error: ${error.message}</p>`;
    }
});