import 'dotenv/config';
import express from 'express';

const app = express();
app.use(express.text());
app.use(express.static('public'));

app.post('/analyze', async (req, res) => {
    try {
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
                    { role: "system", content: "You are a Selenium log analyser. Answer the queries. Respond in clean bullet points only. No markdown, no bold, no headers. Each point on a new line starting with a dash (-)" },
                    { role: "user", content: req.body }
                ]
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('API Error:', response.status, errorText);
            return res.status(response.status).json({ error: `API Error: ${response.status}` });
        }

        const data = await response.json();

        // Step 1: Get the outer content string (Python-style dict)
        const outerContent = data.choices[0].message.content;

        // Step 2: Convert Python-style dict string to valid JSON
        const fixedContent = outerContent
            .replace(/'/g, '"')                             // single → double quotes
            .replace(/\bNone\b/g, 'null')                   // Python None → null
            .replace(/\bTrue\b/g, 'true')                   // Python True → true
            .replace(/\bFalse\b/g, 'false')                 // Python False → false
            .replace(/"s\s/g, "'s ")                        // fix "it"s " → "it's "
            .replace(/(\w)"t\b/g, "$1't")                   // fix "don"t" → "don't"
            .replace(/(\w)"re\b/g, "$1're")                 // fix "you"re" → "you're"
            .replace(/(\w)"ve\b/g, "$1've")                 // fix "I"ve" → "I've"
            .replace(/(\w)"ll\b/g, "$1'll")                 // fix "it"ll" → "it'll"
            .replace(/(\w)"d\b/g, "$1'd");                  // fix "I"d" → "I'd"

        // Step 3: Parse the inner JSON
        const innerData = JSON.parse(fixedContent);

        // Step 4: Extract the actual text
        const fullText = innerData.choices[0].message.content[0].text;

        // Step 5: Extract bullet points and clean markdown
        const points = fullText
            .split('\n')
            .filter(line => line.trim().startsWith('-'))
            .map(line => line
                .replace(/^-\s*/, '')
                .replace(/\*\*(.*?)\*\*/g, '$1')
                .replace(/\*(.*?)\*/g, '$1')
                .replace(/#+ /g, '')
                .trim()
            )
            .filter(line => line.length > 0);

        res.json({ analysis: points });

    } catch (error) {
        console.error("Full error:", error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(3000, () => console.log('Server running on http://localhost:3000'));