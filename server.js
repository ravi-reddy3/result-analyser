import 'dotenv/config';
import express from 'express';
import { OpenAI } from 'openai';

const app = express();
app.use(express.text()); // Critical for reading the 'logText'
app.use(express.static('public')); // Serves your app.js and index.html

// The Server uses the token, the Browser never sees it
const openai = new OpenAI({
    apiKey: process.env.BEARER_TOKEN, 
});

app.post('/analyze', async (req, res) => {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: "You are a Selenium expert. Answer the queries." },
                { role: "user", content: req.body }
            ],
        });

        res.json({ analysis: response.choices[0].message.content });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "AI Analysis failed" });
    }
});

app.listen(3000, () => console.log('Server running on http://localhost:3000'));