# OpenChat

A clean, fast web client to use with models from [OpenRouter](https://openrouter.ai).


API key
Get a key at openrouter.ai/keys, then either:

Paste it into the API key field in the UI (it stays in the tab for the session), or

Create a .env.local file in the project root:

VITE_OPENROUTER_API_KEY=sk-or-v1-...
See .env.example for the template.



## Quick Start

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) and enter your [OpenRouter API key](https://openrouter.ai/keys) (or configure `VITE_OPENROUTER_API_KEY` in `.env.local`).
