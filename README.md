# OpenRouter Analyzer

A lightweight, privacy-first web app for asking questions about PDFs and images using any model on [OpenRouter](https://openrouter.ai). Upload a document, type a prompt, and get structured, well-formatted answers — rendered with full Markdown and LaTeX math support.

![Stack](https://img.shields.io/badge/React-18-blue) ![Bundler](https://img.shields.io/badge/Vite-5-purple) ![License](https://img.shields.io/badge/license-private-lightgrey)

## Features

- **Any OpenRouter model** — pick from a curated list of free models or browse the full catalog (fetched live from the OpenRouter API)
- **PDF & image input** — files are base64-encoded in the browser and sent as multimodal content parts
- **Live streaming responses** — tokens render as they arrive, with a two-tier timeout (60s first token, 300s overall, extended on every chunk) so long generations don't get cut off
- **Elapsed-time indicator** — "Waiting for the model… 12s" / "Receiving response… 15s" so you always know what's happening
- **Markdown + LaTeX rendering** — headings, lists, tables, code blocks, and `$inline$` / `$$display$$` math via `marked` + KaTeX, sanitized with DOMPurify
- **Developer mode** — toggle to inspect the raw request/response JSON
- **Reasoning levels** — choose none → max reasoning effort per request
- **Accessible UI** — ARIA-labelled controls, keyboard-navigable model dropdown (listbox pattern), visible focus rings, screen-reader live regions, and `prefers-reduced-motion` support
- **Key stays local** — the API key lives only in your browser tab and is sent directly to OpenRouter; nothing touches any intermediate server

## Getting started

### Prerequisites

- Node.js 18+

### Install & run

```bash
npm install
npm run dev
```

The app opens at `http://localhost:5173`.

### API key

Get a key at [openrouter.ai/keys](https://openrouter.ai/keys), then either:

- Paste it into the **API key** field in the UI (it stays in the tab for the session), or
- Create a `.env.local` file in the project root:

  ```bash
  VITE_OPENROUTER_API_KEY=sk-or-v1-...
  ```

  See `.env.example` for the template.

## Usage

1. Enter your OpenRouter API key
2. Pick a model (Ox Alpha by default, or any free/catalog model)
3. Optionally attach one or more PDFs or images
4. Type your prompt and hit **Analyze**
5. Read the structured response — use **Developer mode** to inspect the raw JSON

> Tip: for PDF/image questions, use a vision-capable model. The app warns you if the selected model rejects multimodal input.

## Tech stack

| Layer      | Choice                                        |
| ---------- | --------------------------------------------- |
| Framework  | React 18                                      |
| Bundler    | Vite 5                                        |
| Markdown   | [marked](https://marked.js.org/)              |
| Sanitizer  | [DOMPurify](https://github.com/cure53/DOMPurify) |
| Math       | [KaTeX](https://katex.org/)                   |
| API        | [OpenRouter](https://openrouter.ai/docs) chat completions (SSE streaming) |

## Project structure

```
src/
  App.jsx     # All app logic: request handling, SSE parsing, markdown/math rendering
  index.css   # Design tokens, component styles, responsive + a11y rules
  main.jsx    # Entry point
```

## Scripts

| Command         | Description              |
| --------------- | ------------------------ |
| `npm run dev`   | Start the dev server     |
| `npm run build` | Production build to `dist/` |
| `npm run preview` | Preview the production build |

## Privacy

Your API key and uploaded files are processed entirely in your browser and sent only to `openrouter.ai` over HTTPS. No analytics, no server-side storage.
