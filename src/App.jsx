import { useEffect, useMemo, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import katex from 'katex'
import 'katex/dist/katex.min.css'

const DEFAULT_MODEL_ID = 'stealth/ox-alpha'

const FREE_MODELS = [
  { id: 'google/gemini-2.0-flash-exp:free', name: 'Gemini 2.0 Flash', badge: 'Free' },
  { id: 'meta-llama/llama-3.2-11b-vision-instruct:free', name: 'Llama 3.2 Vision 11B', badge: 'Free' },
  { id: 'qwen/qwen-2.5-vl-72b-instruct:free', name: 'Qwen 2.5 VL 72B', badge: 'Free' },
  { id: 'mistralai/mistral-small-3.1-24b-instruct:free', name: 'Mistral Small 3.1', badge: 'Free' },
  { id: 'deepseek/deepseek-chat-v3-0324:free', name: 'DeepSeek V3 Chat', badge: 'Free' },
]

const SYSTEM_PROMPT =
  'You are a document/image analysis assistant. Respond in clean Markdown with these sections when relevant: ## Summary, ## Key Points (bullet list), ## Details, ## Answer. Be concise and factual.'

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result)
      resolve(result.split(',')[1] ?? '')
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function buildContent(text, files) {
  const parts = []
  if (text.trim()) parts.push({ type: 'text', text })
  for (const file of files) {
    if (file.type === 'application/pdf') {
      parts.push({ type: 'file', file: { filename: file.name, file_data: `data:${file.type};base64,${file.base64}` } })
    } else if (file.type.startsWith('image/')) {
      parts.push({ type: 'image_url', image_url: { url: `data:${file.type};base64,${file.base64}` } })
    }
  }
  return parts
}

const URL_PATTERN = /@url:`([^`]+)`|(https?:\/\/[^\s)`]+)/g

// Extract every URL referenced in the prompt (@url:`...` syntax or bare links).
function extractUrls(text) {
  const urls = []
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = (match[1] ?? match[2]).replace(/[.,;]+$/, '')
    if (!urls.includes(url)) urls.push(url)
  }
  return urls
}

// Fetch a page as clean markdown via r.jina.ai (CORS-enabled reader proxy).
async function fetchPageMarkdown(url, signal) {
  const response = await fetch(`https://r.jina.ai/${url}`, { signal })
  if (!response.ok) throw new Error(`Failed to fetch ${url} (${response.status})`)
  return response.text()
}

function renderMathInText(text) {
  if (!text || !text.includes('$')) return text
  const parts = []
  let rest = text
  let key = 0
  while (rest) {
    const display = rest.indexOf('$$')
    const inline = rest.indexOf('$')
    if (display === -1 && inline === -1) { parts.push(rest); break }
    const useDisplay = display !== -1 && (inline === -1 || display <= inline)
    if (useDisplay && display === 0) {
      const end = rest.indexOf('$$', 2)
      if (end === -1) { parts.push(rest); break }
      parts.push(renderKatex(rest.slice(2, end), true, key++))
      rest = rest.slice(end + 2)
    } else if (!useDisplay && inline === 0) {
      const end = rest.indexOf('$', 1)
      if (end === -1) { parts.push(rest); break }
      parts.push(renderKatex(rest.slice(1, end), false, key++))
      rest = rest.slice(end + 1)
    } else {
      const next = useDisplay ? display : inline
      parts.push(rest.slice(0, next))
      rest = rest.slice(next)
    }
  }
  return parts
}

function renderKatex(tex, displayMode, key) {
  let html
  try {
    html = katex.renderToString(tex.trim(), { displayMode, throwOnError: false })
  } catch {
    html = null
  }
  if (!html) return <code key={key}>{tex}</code>
  return <span key={key} dangerouslySetInnerHTML={{ __html: html }} />
}

function ResponseBlock({ markdown }) {
  const html = useMemo(() => {
    if (!markdown) return ''
    const raw = marked.parse(markdown, { breaks: true, async: false })
    return DOMPurify.sanitize(raw, { ADD_ATTR: ['target'] })
  }, [markdown])

  return (
    <div
      className="response"
      dangerouslySetInnerHTML={{ __html: renderMathPostHtml(html) }}
    />
  )
}

// Render $...$ / $$...$$ that survived inside the sanitized HTML (text nodes only).
function renderMathPostHtml(html) {
  const container = document.createElement('div')
  container.innerHTML = html
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const textNodes = []
  while (walker.nextNode()) {
    if (walker.currentNode.nodeValue.includes('$')) textNodes.push(walker.currentNode)
  }
  for (const node of textNodes) {
    const parts = renderMathInText(node.nodeValue)
    if (typeof parts === 'string') continue
    const frag = document.createDocumentFragment()
    for (const part of parts) {
      if (typeof part === 'string') {
        frag.appendChild(document.createTextNode(part))
      } else {
        const span = document.createElement('span')
        span.innerHTML = part.props.dangerouslySetInnerHTML.__html
        frag.appendChild(span)
      }
    }
    node.parentNode.replaceChild(frag, node)
  }
  return container.innerHTML
}

export default function App() {
  const [apiKey, setApiKey] = useState(import.meta.env.VITE_OPENROUTER_API_KEY ?? '')
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [reasoningEffort, setReasoningEffort] = useState('medium')
  const [allModels, setAllModels] = useState([])
  const [model, setModel] = useState('stealth/ox-alpha')
  const [prompt, setPrompt] = useState('')
  const [files, setFiles] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const [meta, setMeta] = useState(null)
  const [devMode, setDevMode] = useState(false)
  const [rawRequest, setRawRequest] = useState('')
  const [rawResponse, setRawResponse] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [streaming, setStreaming] = useState(false)
  const [phase, setPhase] = useState('')

  // Elapsed-time counter while a request is in flight.
  useEffect(() => {
    if (!loading) { setElapsed(0); return }
    const started = Date.now()
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(id)
  }, [loading])

  useEffect(() => {
    fetch('https://openrouter.ai/api/v1/models')
      .then((res) => res.json())
      .then((data) => {
        if (!Array.isArray(data?.data)) return
        const models = data.data
          .map((m) => ({ id: m.id, name: m.name ?? m.id }))
          .sort((a, b) => a.name.localeCompare(b.name))
        if (models.length > 0) setAllModels(models)
      })
      .catch(() => {})
  }, [])


  async function handleSubmit(event) {
    event.preventDefault()
    setError('')
    setResult('')
    setMeta(null)

    if (!apiKey.trim()) return setError('Please enter your OpenRouter API key.')
    if (!prompt.trim() && files.length === 0) return setError('Add a prompt or at least one file.')

    setLoading(true)
    setStreaming(false)
    try {
      const contentParts = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          type: file.type,
          size: file.size,
          base64: await fileToBase64(file),
        })),
      )

      // Browse any links in the prompt and pull their content in as context.
      const urls = extractUrls(prompt)
      const pageContexts = []
      if (urls.length > 0) {
        setPhase(`Reading ${urls.length === 1 ? 'link' : `${urls.length} links`}…`)
        const fetchController = new AbortController()
        const fetchTimeout = setTimeout(() => fetchController.abort(), 30000)
        try {
          const results = await Promise.allSettled(urls.map((url) => fetchPageMarkdown(url, fetchController.signal)))
          for (const [index, result] of results.entries()) {
            if (result.status === 'fulfilled') {
              // Cap each page so one huge site can't blow the context window.
              pageContexts.push({ url: urls[index], markdown: result.value.slice(0, 60000) })
            } else {
              const reason = result.reason?.name === 'AbortError' ? 'timed out' : result.reason?.message
              pageContexts.push({ url: urls[index], markdown: `Failed to fetch: ${reason}` })
            }
          }
        } finally {
          clearTimeout(fetchTimeout)
        }
        setPhase('')
      }

      const userText = pageContexts.length > 0
        ? `${prompt}\n\n---\nReferenced page content:\n\n${pageContexts
            .map(({ url, markdown }) => `### ${url}\n\n${markdown}`)
            .join('\n\n---\n\n')}`
        : prompt

      const requestBody = {
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildContent(userText, contentParts) },
        ],
        ...(reasoningEffort !== 'none' && { reasoning_effort: reasoningEffort }),
      }
      setRawRequest(JSON.stringify(requestBody, null, 2))

      const controller = new AbortController()
      // Two-tier timeout: 60s to receive the FIRST byte, 300s total for the
      // whole response. Streaming keeps tokens flowing so long generations
      // don't hit the wall as long as the model is actively producing.
      const firstByteTimeoutMs = 60000
      const totalTimeoutMs = 300000
      let timeoutId = setTimeout(() => controller.abort(), firstByteTimeoutMs)
      const extendDeadline = () => {
        clearTimeout(timeoutId)
        timeoutId = setTimeout(() => controller.abort(), totalTimeoutMs)
      }

      let content = ''
      let usage = null
      let responseModel = null
      try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey.trim()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ...requestBody, stream: true }),
          signal: controller.signal,
        })

        if (!response.ok) {
          let message = `Request failed (${response.status})`
          try {
            const errData = await response.json()
            if (errData?.error?.message) message = errData.error.message
          } catch {}
          throw new Error(message)
        }

        extendDeadline()
        setStreaming(true)
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          extendDeadline()
          buffer += decoder.decode(value, { stream: true })
          let newlineIndex
          while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIndex).trim()
            buffer = buffer.slice(newlineIndex + 1)
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (payload === '[DONE]') continue
            try {
              const chunk = JSON.parse(payload)
              if (chunk.model) responseModel = chunk.model
              if (chunk.usage) usage = chunk.usage
              const delta = chunk.choices?.[0]?.delta?.content
              if (delta) {
                content += delta
                setResult(content)
              }
            } catch {}
          }
        }

        // Fallback: some providers return a non-streamed body despite stream:true
        if (!content && !responseModel) {
          const text = buffer.trim()
          if (text) {
            try {
              const data = JSON.parse(text)
              content = data.choices?.[0]?.message?.content ?? ''
              usage = data.usage ?? null
              responseModel = data.model ?? null
            } catch {}
          }
        }
      } catch (fetchErr) {
        clearTimeout(timeoutId)
        if (fetchErr.name === 'AbortError') {
          throw new Error(content
            ? 'The stream was cut off before completion. The partial response above is kept.'
            : 'No response received in time (60s). The model may be overloaded — try again or pick another model.')
        }
        throw fetchErr
      } finally {
        clearTimeout(timeoutId)
      }

      setRawResponse(JSON.stringify({ model: responseModel, usage, content }, null, 2))

      if (!content) {
        setError('The model returned an empty response. Try again or pick another model.')
      } else {
        setResult(content)
      }
      setMeta({ model: responseModel ?? model, usage })
    } catch (err) {
      setError(
        /modality|image|pdf|file|unsupported|not support/i.test(err.message)
          ? `${err.message} — this model may not accept PDFs/images. Try a vision-capable model.`
          : err.message,
      )
    } finally {
      setLoading(false)
    }
  }

  function removeFile(index) {
    setFiles((prev) => prev.filter((_, i) => i !== index))
  }

  return (
    <main className="page">
      <header className="page-header">
        <h1>OpenRouter Analyzer</h1>
        <p>Ask about PDFs and images, get structured answers.</p>
      </header>

      <form className="card" onSubmit={handleSubmit} noValidate>
        <label className="field">
          <span id="apikey-label">OpenRouter API key</span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={import.meta.env.VITE_OPENROUTER_API_KEY ? 'Loaded from .env.local' : 'sk-or-v1-...'}
            autoComplete="off"
            aria-labelledby="apikey-label"
            aria-required="true"
          />
        </label>

        <div className="row">
          <div className="field model-field">
            <span id="model-label">Model</span>
            <div
              className="model-dropdown"
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget)) setDropdownOpen(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setDropdownOpen(false); e.currentTarget.querySelector('.model-trigger')?.focus() }
              }}
            >
              <button
                type="button"
                className="model-trigger"
                onClick={() => setDropdownOpen((v) => !v)}
                aria-haspopup="listbox"
                aria-expanded={dropdownOpen}
                aria-labelledby="model-label"
              >
                <span>{allModels.find((m) => m.id === model)?.name ?? FREE_MODELS.find((m) => m.id === model)?.name ?? model}</span>
                <svg aria-hidden="true" width="12" height="8" viewBox="0 0 12 8"><path d="M1 1l5 5 5-5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round"/></svg>
              </button>

              {dropdownOpen && (
                <div className="model-menu" role="listbox" aria-label="Models">
                  <div
                    role="option"
                    aria-selected={model === DEFAULT_MODEL_ID}
                    tabIndex={0}
                    className={`model-option ${model === DEFAULT_MODEL_ID ? 'selected' : ''}`}
                    onClick={() => { setModel(DEFAULT_MODEL_ID); setDropdownOpen(false) }}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setModel(DEFAULT_MODEL_ID); setDropdownOpen(false) } }}
                  >
                    <span>Ox Alpha</span><em className="badge">Default</em>
                  </div>
                  {FREE_MODELS.map((m) => (
                    <div
                      key={m.id}
                      role="option"
                      aria-selected={model === m.id}
                      tabIndex={0}
                      className={`model-option ${model === m.id ? 'selected' : ''}`}
                      onClick={() => { setModel(m.id); setDropdownOpen(false) }}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setModel(m.id); setDropdownOpen(false) } }}
                    >
                      <span>{m.name}</span><em className="badge free">{m.badge}</em>
                    </div>
                  ))}

                  <div className="see-more-wrap">
                    <div className="see-more-label">See more ({allModels.length})</div>
                    <div className="see-more-panel">
                      {allModels.map((m) => (
                        <div
                          key={m.id}
                          role="option"
                          aria-selected={model === m.id}
                          tabIndex={0}
                          className={`model-option ${model === m.id ? 'selected' : ''}`}
                          onClick={() => { setModel(m.id); setDropdownOpen(false) }}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setModel(m.id); setDropdownOpen(false) } }}
                        >
                          <span>{m.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="row">
          <label className="field">
            <span>Upload (PDF or images)</span>
            <input
              type="file"
              accept=".pdf,image/*"
              multiple
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
          </label>
        </div>

        {files.length > 0 && (
          <ul className="file-list">
            {files.map((file, index) => (
              <li key={`${file.name}-${index}`}>
                <span>{file.name} · {(file.size / 1024).toFixed(0)} KB</span>
                <button type="button" aria-label={`Remove ${file.name}`} onClick={() => removeFile(index)}>✕</button>
              </li>
            ))}
          </ul>
        )}

        <label className="field">
          <span id="prompt-label">Your prompt</span>
          <textarea
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Summarize this document and list the key points."
            aria-labelledby="prompt-label"
          />
        </label>

        <div className="row">
          <label className="field">
            <span>Reasoning level</span>
            <select
              className="model-select"
              value={reasoningEffort}
              onChange={(e) => setReasoningEffort(e.target.value)}
            >
              <option value="none">None</option>
              <option value="minimal">Minimal</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="xhigh">Extra high</option>
              <option value="max">Max</option>
            </select>
          </label>
        </div>

        <button type="submit" disabled={loading} aria-busy={loading}>
          {loading ? 'Analyzing…' : 'Analyze'}
        </button>

        <button
          type="button"
          className={`dev-toggle ${devMode ? 'active' : ''}`}
          onClick={() => setDevMode((v) => !v)}
          aria-pressed={devMode}
        >
          {devMode ? '✓ Developer mode on' : 'Developer mode'}
        </button>
      </form>

      {error && (
        <div className="card error-card" role="alert" aria-live="assertive">
          {error}
        </div>
      )}
      {loading && (
        <div className="card muted" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          {phase
            ? <>{phase} <strong className="timer">{elapsed}s</strong></>
            : streaming
              ? <>Receiving response… <strong className="timer">{elapsed}s</strong></>
              : <>Waiting for the model… <strong className="timer">{elapsed}s</strong>{elapsed >= 30 && ' (still working — high reasoning can take a while)'}</>}
        </div>
      )}

      {(result || meta) && (
        <section className="card result-card" aria-live="polite">
          {meta && (
            <p className="meta">
              <strong>{meta.model}</strong>
              {meta.usage && ` · ${meta.usage.total_tokens ?? '?'} tokens`}
            </p>
          )}
          {result && <ResponseBlock markdown={result} />}
        </section>
      )}

      {devMode && (
        <section className="card dev-card" aria-label="Developer details">
          <h3 className="dev-title">Request</h3>
          <pre className="dev-json" tabIndex={0}>{rawRequest || '— press Analyze to capture a request —'}</pre>
          <h3 className="dev-title">Response</h3>
          <pre className="dev-json" tabIndex={0}>{rawResponse || '— no response yet —'}</pre>
        </section>
      )}

      <footer className="footer">
        Your API key stays in this browser tab and is sent only to OpenRouter.
      </footer>
    </main>
  )
}
