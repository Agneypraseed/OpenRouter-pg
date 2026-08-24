import { useEffect, useMemo, useRef, useState } from 'react'
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
    if (file.type.startsWith('image/')) {
      parts.push({ type: 'image_url', image_url: { url: `data:${file.type};base64,${file.base64}` } })
    } else if (file.type.startsWith('audio/')) {
      parts.push({ type: 'input_audio', input_audio: { data: file.base64, format: file.type.split('/')[1] } })
    } else if (file.type.startsWith('video/')) {
      parts.push({ type: 'video_url', video_url: { url: `data:${file.type};base64,${file.base64}` } })
    } else {
      // PDFs and any other documents go through the generic file part.
      parts.push({ type: 'file', file: { filename: file.name, file_data: `data:${file.type};base64,${file.base64}` } })
    }
  }
  return parts
}

const URL_PATTERN = /@url:`([^`]+)`|(https?:\/\/[^\s)`]+)/g

// Pull the most specific human-readable message out of an OpenRouter error
// response. The interesting text often hides in error.metadata.raw.
function parseProviderError(status, bodyText) {
  let data = null
  try { data = JSON.parse(bodyText) } catch {}
  const err = data?.error ?? {}
  const raw = err.metadata?.raw
  const hint = err.metadata?.remedy_hint
  let message = err.message || `Request failed (${status})`
  if (raw && raw !== message) message += ` — ${raw}`
  // Surface the HTTP code for transient classes so users know it's server-side.
  if (status === 429) message = `Rate limited (429). ${message}`
  else if (status >= 500) message = `Provider outage (${status}). ${message}`
  if (hint && status !== 402) message += ` (${hint})`
  return message
}

// Transient server-side failures worth an automatic retry.
const isTransient = (status) => status === 408 || status === 409 || status === 429 || status >= 500

// Map a browser MIME type to the OpenRouter modality name it belongs to.
function fileModality(file) {
  const t = file.type || ''
  if (t.startsWith('image/')) return 'image'
  if (t.startsWith('video/')) return 'video'
  if (t.startsWith('audio/')) return 'audio'
  if (t === 'application/pdf') return 'file'
  if (t.startsWith('text/') || t === 'application/json' || t === 'application/xml') return 'file'
  return null
}

// True if the file's type is among the model's accepted input modalities.
function fileMatchesModalities(file, inputMods) {
  const mod = fileModality(file)
  if (!mod) return false
  if (inputMods.includes(mod)) return true
  // Documents/PDFs ride on the image pathway at most providers, so allow them
  // for any model that takes images even when 'file' isn't declared.
  if (mod === 'file') {
    return inputMods.includes('file') || inputMods.includes('pdf') || inputMods.includes('image')
  }
  return false
}

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
  const [chatMode, setChatMode] = useState(false)
  const [rawRequest, setRawRequest] = useState('')
  const [rawResponse, setRawResponse] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [streaming, setStreaming] = useState(false)
  const [phase, setPhase] = useState('')
  const [preview, setPreview] = useState(null) // { name, type, url }
  const [chat, setChat] = useState([]) // [{ role: 'user'|'assistant', text, model?, usage? }]
  const [dragActive, setDragActive] = useState(false)
  const [thumbs, setThumbs] = useState({})
  const fileInputRef = useRef(null)
  const currentCleanupRef = useRef(null) // clears the in-flight request's timers on unmount
  const threadEndRef = useRef(null)

  // Keep the latest message in view as the conversation grows/streams.
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [chat, loading, phase])

  // Shared add pipeline: merge, dedupe, modality filter, 10-file cap.
  const MAX_FILES = 10
  function addFiles(incoming) {
    setFiles((prev) => {
      const merged = [...prev]
      for (const f of incoming) {
        if (merged.length >= MAX_FILES) break
        if (!fileMatchesModalities(f, inputModsRef.current)) continue
        if (!merged.some((x) => x.name === f.name && x.size === f.size)) merged.push(f)
      }
      return merged
    })
  }

  // Thumbnail object-URLs for image files; revoked when the list changes.
  useEffect(() => {
    const created = {}
    for (const [index, file] of files.entries()) {
      if (file.type?.startsWith('image/')) created[index] = URL.createObjectURL(file)
    }
    setThumbs(created)
    return () => { for (const url of Object.values(created)) URL.revokeObjectURL(url) }
  }, [files])

  // Small icon for non-image files in the list.
  function fileIconFor(file) {
    const t = file.type || ''
    if (t.startsWith('video/')) return '▶'
    if (t.startsWith('audio/')) return '♪'
    if (t === 'application/pdf') return 'PDF'
    return 'DOC'
  }

  // Clipboard paste: attach image files copied anywhere (Ctrl+V).
  useEffect(() => {
    const onPaste = (e) => {
      const items = Array.from(e.clipboardData?.files ?? [])
      if (items.length === 0) return
      e.preventDefault()
      addFiles(items)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Open a file in the in-app preview (images inline, PDFs in an iframe).
  function openPreview(file) {
    setPreview({ name: file.name, type: file.type, url: URL.createObjectURL(file) })
  }

  // Revoke blob URLs when the preview closes so memory is freed.
  function closePreview() {
    if (preview) URL.revokeObjectURL(preview.url)
    setPreview(null)
  }

  // Trigger a client-side download of a text blob.
  function downloadBlob(content, mime, extension) {
    const blob = new Blob([content], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `response-${new Date().toISOString().slice(0, 10)}.${extension}`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  // Open a print-friendly window with the rendered response; the user saves as PDF.
  function downloadPdf() {
    const source = document.querySelector('.result-card .response')
    if (!source) return
    const win = window.open('', '_blank', 'width=820,height=900')
    if (!win) {
      setError('Popup blocked — allow popups to export as PDF.')
      return
    }
    const styles = [...document.querySelectorAll('style, link[rel="stylesheet"]')]
      .map((node) => node.outerHTML)
      .join('\n')
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Response</title>${styles}
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 720px; margin: 32px auto; padding: 0 16px; color: #1d1d1f; background: #fff; }
        .print-header { font-size: 12px; color: #6e6e73; border-bottom: 1px solid #e5e5ea; padding-bottom: 10px; margin-bottom: 20px; }
        @media print { .print-note { display: none; } }
        .print-note { margin-top: 28px; font-size: 12px; color: #6e6e73; }
      </style></head><body>
      <div class="print-header">OpenRouter Analyzer${meta ? ` · ${meta.model}${meta.usage ? ` · ${meta.usage.total_tokens ?? '?'} tokens` : ''}` : ''} · ${new Date().toLocaleString()}</div>
      ${source.innerHTML}
      <div class="print-note">Press Ctrl/Cmd+P and choose “Save as PDF”.</div>
      </body></html>`)
    win.document.close()
  }

  useEffect(() => {
    if (!preview) return
    const onKey = (e) => { if (e.key === 'Escape') closePreview() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview])

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
          .map((m) => ({
            id: m.id,
            name: m.name ?? m.id,
            inputModalities: m.architecture?.input_modalities ?? ['text'],
            outputModalities: m.architecture?.output_modalities ?? ['text'],
          }))
          .sort((a, b) => a.name.localeCompare(b.name))
        if (models.length > 0) setAllModels(models)
      })
      .catch(() => {})
  }, [])

  // Modality info for the selected model (falls back to Ox Alpha's known profile).
  const selectedModelInfo = allModels.find((m) => m.id === model)
  const inputMods = selectedModelInfo?.inputModalities ?? ['text', 'image', 'video']
  const outputMods = selectedModelInfo?.outputModalities ?? ['text']
  const acceptsImage = inputMods.includes('image')
  const acceptsPdf = inputMods.includes('file') || inputMods.includes('pdf')

  // Keep a ref of current modalities for use inside addFiles (defined above).
  const inputModsRef = useRef(inputMods)
  useEffect(() => { inputModsRef.current = inputMods }, [inputMods])

  const MODALITY_ICONS = {
    text: (
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3 3.5h10M8 3.5v9M5.5 12.5h5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round"/></svg>
    ),
    image: (
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" fill="none"/><circle cx="6" cy="6.5" r="1.3" fill="currentColor"/><path d="M3 11.5l3.2-3 2.3 2 2-1.8 2.5 2.3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinejoin="round"/></svg>
    ),
    video: (
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="1.5" y="4" width="9" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.4" fill="none"/><path d="M10.5 8l4-2.5v5z" fill="currentColor"/></svg>
    ),
    audio: (
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2 8h2l2-3.5v7L4 8H2zm7-2.5a3 3 0 010 5m2-7a5.5 5.5 0 010 9" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
    ),
    file: (
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M4 2h5l3 3v9H4z" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinejoin="round"/><path d="M9 2v3h3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinejoin="round"/></svg>
    ),
    pdf: null, // rendered as 'file'
  }
  const modalityIcon = (mod) => MODALITY_ICONS[mod] ?? MODALITY_ICONS.file

  // Which file types the picker accepts, derived from the model's input modalities.
  const MODALITY_ACCEPT = {
    text: null, // not a file type
    image: 'image/*',
    video: 'video/*',
    audio: 'audio/*',
    file: '.pdf,.doc,.docx,.txt,.csv,.json,.xml,.md',
    pdf: '.pdf',
  }
  // Documents ride on the image pathway, so include them when images are accepted.
  const effectiveMods = acceptsImage && !inputMods.includes('file') && !inputMods.includes('pdf')
    ? [...inputMods, 'file']
    : inputMods
  const finalAccept = effectiveMods
    .map((mod) => MODALITY_ACCEPT[mod])
    .filter(Boolean)
    .join(',')
  const uploadLabel = effectiveMods
    .filter((mod) => MODALITY_ACCEPT[mod])
    .map((mod) => ({ image: 'images', video: 'videos', audio: 'audio', file: 'documents', pdf: 'PDFs' }[mod] ?? mod))
    .join(', ')


  async function handleSubmit(event) {
    event.preventDefault()
    setError('')
    setResult('')

    if (!apiKey.trim()) return setError('Please enter your OpenRouter API key.')
    if (!prompt.trim() && files.length === 0) return setError('Add a prompt or at least one file.')

    const userText = prompt
    const turnFiles = files

    // Show the user's message immediately and clear the composer.
    setChat((prev) => [...prev, { role: 'user', text: userText, files: turnFiles.map((f) => f.name) }])
    setPrompt('')
    setFiles([])

    setLoading(true)
    setStreaming(false)
    try {
      // Build the conversation for the API. Chat mode sends the full history;
      // single mode sends only this turn (fresh context every time).
      const historyForApi = chatMode
        ? chat.map((m) => ({ role: m.role, content: m.text }))
        : []
      const contentParts = await Promise.all(
        turnFiles.map(async (file) => ({
          name: file.name,
          type: file.type,
          size: file.size,
          base64: await fileToBase64(file),
        })),
      )

      // Browse any links in this turn's prompt and pull their content in as context.
      const urls = extractUrls(userText)
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

      const turnText = pageContexts.length > 0
        ? `${userText}\n\n---\nReferenced page content:\n\n${pageContexts
            .map(({ url, markdown }) => `### ${url}\n\n${markdown}`)
            .join('\n\n---\n\n')}`
        : userText

      const requestBody = {
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...historyForApi,
          { role: 'user', content: buildContent(turnText, contentParts) },
        ],
        ...(reasoningEffort !== 'none' && { reasoning_effort: reasoningEffort }),
      }
      setRawRequest(JSON.stringify(requestBody, null, 2))

      const firstByteTimeoutMs = 60000
      const totalTimeoutMs = 300000

      let content = ''
      let usage = null
      let responseModel = null
      try {
        const MAX_ATTEMPTS = 3
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          if (attempt > 1) {
            setPhase(`Provider busy — retrying (attempt ${attempt}/${MAX_ATTEMPTS})…`)
            await new Promise((resolve) => setTimeout(resolve, attempt === 2 ? 3000 : 9000))
          }

          const controller = new AbortController()
          // Two-tier timeout: 60s to receive the FIRST byte, 300s total for the
          // whole response. Streaming keeps tokens flowing so long generations
          // don't hit the wall as long as the model is actively producing.
          let timeoutId = setTimeout(() => controller.abort(), firstByteTimeoutMs)
          const extendDeadline = () => {
            clearTimeout(timeoutId)
            timeoutId = setTimeout(() => controller.abort(), totalTimeoutMs)
          }
          currentCleanupRef.current = () => clearTimeout(timeoutId)

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
              const bodyText = await response.text()
              const message = parseProviderError(response.status, bodyText)
              // Transient server-side failures: retry automatically.
              if (isTransient(response.status) && attempt < MAX_ATTEMPTS) continue
              throw Object.assign(new Error(message), { noRetry: true })
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
                  // Mid-stream provider errors arrive as SSE events too.
                  if (chunk.error) {
                    const msg = parseProviderError(chunk.error.code ?? 500, JSON.stringify({ error: chunk.error }))
                    throw Object.assign(new Error(msg), { noRetry: true })
                  }
                } catch (e) {
                  if (e?.noRetry) throw e
                }
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
            break // success — leave the retry loop
          } catch (fetchErr) {
            if (fetchErr.noRetry || fetchErr.name !== 'AbortError') throw fetchErr
            if (fetchErr.name === 'AbortError') {
              throw new Error(content
                ? 'The stream was cut off before completion. The partial response above is kept.'
                : 'No response received in time (60s). The model may be overloaded — try again or pick another model.')
            }
          } finally {
            clearTimeout(timeoutId)
            currentCleanupRef.current = null
          }
        }
      } catch (fetchErr) {
        if (fetchErr.name === 'AbortError' && content && !fetchErr.noRetry) {
          // keep partial result; fall through to render below
        } else {
          throw fetchErr
        }
      }

      setRawResponse(JSON.stringify({ model: responseModel, usage, content }, null, 2))

      if (!content) {
        setError('The model returned an empty response. Try again or pick another model.')
      } else {
        setChat((prev) => [...prev, { role: 'assistant', text: content, model: responseModel ?? model, usage }])
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

  function clearChat() {
    setChat([])
    setResult('')
    setMeta(null)
    setRawRequest('')
    setRawResponse('')
    setError('')
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
          <div className="field">
            <span>Modalities</span>
            <div className="modality-panel" aria-label="Model input and output modalities">
              <div className="modality-group" title={`Accepted inputs: ${inputMods.join(', ')}`}>
                {inputMods.map((mod) => (
                  <span key={mod} className={`modality-badge ${mod}`} title={mod}>
                    {modalityIcon(mod)}
                  </span>
                ))}
              </div>
              <svg className="modality-arrow" viewBox="0 0 20 10" width="20" height="10" aria-hidden="true"><path d="M1 5h16m0 0l-3.5-3.5M17 5l-3.5 3.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/></svg>
              <div className="modality-group" title={`Produces: ${outputMods.join(', ')}`}>
                {outputMods.map((mod) => (
                  <span key={mod} className={`modality-badge ${mod}`} title={mod}>
                    {modalityIcon(mod)}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="row">
          <div className="field">
            <span>Upload ({uploadLabel})</span>
            {files.length > 0 && (
              <button
                type="button"
                className="clear-btn"
                onClick={() => setFiles([])}
                title="Remove all files"
              >
                Clear all ({files.length})
              </button>
            )}
          </div>
        </div>

        <div className="row">
          <div className="field">
            <span>
              {finalAccept
                ? `Add files (${uploadLabel})`
                : 'Add files — selected model accepts text only'}
            </span>
            <div
              className={`dropzone ${dragActive ? 'drag-active' : ''}`}
              role="button"
              tabIndex={0}
              aria-label={`Add files by browsing, pasting, or dragging. Accepted: ${uploadLabel || 'none'}`}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click() } }}
              onDragOver={(e) => { e.preventDefault(); setDragActive(true) }}
              onDragLeave={() => setDragActive(false)}
              onDrop={(e) => { e.preventDefault(); setDragActive(false); addFiles(Array.from(e.dataTransfer.files ?? [])) }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept={finalAccept || undefined}
                multiple
                hidden
                onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = '' }}
              />
              <span className="dropzone-plus" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round"/></svg>
              </span>
              <span className="dropzone-text">
                <strong>Click to browse</strong>, drag &amp; drop or paste
              </span>
              <span className="dropzone-hint">{files.length}/10 files</span>
            </div>
          </div>
        </div>

        {files.length > 0 && (
          <ul className="file-list">
            {files.map((file, index) => (
              <li key={`${file.name}-${index}`} className="file-item">
                {file.type?.startsWith('image/') && thumbs[index]
                  ? <img className="file-thumb" src={thumbs[index]} alt="" aria-hidden="true" />
                  : <span className="file-thumb file-thumb-generic" aria-hidden="true">{fileIconFor(file)}</span>}
                <button
                  type="button"
                  className="file-open"
                  onClick={() => openPreview(file)}
                  title={`Preview ${file.name}`}
                >
                  {file.name} · {(file.size / 1024).toFixed(0)} KB
                </button>
                <button type="button" aria-label={`Remove ${file.name}`} onClick={() => removeFile(index)}>✕</button>
              </li>
            ))}
          </ul>
        )}

        <label className="field">
          <span className="prompt-label-row">
            <span id="prompt-label">Your prompt</span>
            {prompt && (
              <button
                type="button"
                className="clear-btn"
                onClick={() => setPrompt('')}
                title="Clear the prompt"
              >
                Clear
              </button>
            )}
          </span>
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

        <div className="mode-row" role="group" aria-label="Modes">
          <button
            type="button"
            className={`mode-toggle ${chatMode ? 'active' : ''}`}
            onClick={() => setChatMode((v) => !v)}
            aria-pressed={chatMode}
            title="Keep the conversation going — each message sees the full history"
          >
            {chatMode ? '✓ Chat mode on' : 'Chat mode'}
          </button>
          <button
            type="button"
            className={`dev-toggle-inline ${devMode ? 'active' : ''}`}
            onClick={() => setDevMode((v) => !v)}
            aria-pressed={devMode}
            title="Inspect the raw request/response JSON"
          >
            {devMode ? '✓ Dev mode on' : 'Dev mode'}
          </button>
        </div>
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

      {chatMode && (chat.length > 0 || loading) && (
        <section className="card result-card" aria-live="polite">
          <div className="result-toolbar">
            <p className="meta">Conversation · {chat.filter((m) => m.role === 'user').length} turn{chat.filter((m) => m.role === 'user').length === 1 ? '' : 's'}</p>
            <div className="download-group" role="group" aria-label="Chat actions">
              {result && (
                <button type="button" className="dl-btn" onClick={() => downloadBlob(result, 'text/markdown;charset=utf-8', 'md')} title="Download the latest response as Markdown">
                  Markdown
                </button>
              )}
              {chat.length > 0 && !loading && (
                <button type="button" className="dl-btn new-chat-btn" onClick={clearChat} title="Start a fresh conversation">
                  ✚ New chat
                </button>
              )}
            </div>
          </div>

          <div className="chat-thread">
            {chat.map((m, index) => (
              m.role === 'user' ? (
                <div key={index} className="bubble bubble-user">
                  <div className="bubble-text">{m.text}</div>
                  {m.files?.length > 0 && (
                    <div className="bubble-files">📎 {m.files.join(', ')}</div>
                  )}
                </div>
              ) : (
                <div key={index} className="bubble bubble-assistant">
                  <ResponseBlock markdown={m.text} />
                  {m.usage?.total_tokens != null && (
                    <div className="bubble-meta">{m.model} · {m.usage.total_tokens} tokens</div>
                  )}
                </div>
              )
            ))}
            {loading && (
              <div className="bubble bubble-assistant bubble-pending">
                <span className="spinner" aria-hidden="true" />
                <span className="bubble-text">{phase || 'Thinking…'}</span>
              </div>
            )}
          </div>
          <div ref={threadEndRef} />

          {/* Inline composer: sits right below the latest reply, like a real chat app */}
          <form
            className="chat-composer"
            onSubmit={(e) => { e.preventDefault(); handleSubmit(e) }}
          >
            <textarea
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Reply…"
              aria-label="Reply to the conversation"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(e) }
              }}
            />
            <button type="submit" className="chat-send" disabled={loading || (!prompt.trim() && files.length === 0)} aria-label="Send message">
              <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M2 10l16-7-5.5 15L9.5 12z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="M9.5 12L18 3" stroke="currentColor" strokeWidth="1.6"/></svg>
            </button>
          </form>
          <p className="composer-hint">Chat mode — the model sees the full conversation. Press Enter to send, Shift+Enter for a new line.</p>
        </section>
      )}

      {!chatMode && (result || meta) && (
        <section className="card result-card" aria-live="polite">
          <div className="result-toolbar">
            {meta && (
              <p className="meta">
                <strong>{meta.model}</strong>
                {meta.usage && ` · ${meta.usage.total_tokens ?? '?'} tokens`}
              </p>
            )}
            {result && (
              <div className="download-group" role="group" aria-label="Download response">
                <button type="button" className="dl-btn" onClick={() => downloadBlob(result, 'text/markdown;charset=utf-8', 'md')} title="Download as Markdown">Markdown</button>
                <button type="button" className="dl-btn" onClick={downloadPdf} title="Export as PDF (via print dialog)">PDF</button>
              </div>
            )}
          </div>
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

      {preview && (
        <div className="preview-overlay" onClick={closePreview} role="dialog" aria-modal="true" aria-label={`Preview of ${preview.name}`}>
          <div className="preview-panel" onClick={(e) => e.stopPropagation()}>
            <div className="preview-header">
              <span className="preview-name" title={preview.name}>{preview.name}</span>
              <div className="preview-actions">
                <a className="preview-newtab" href={preview.url} target="_blank" rel="noreferrer">Open in new tab</a>
                <button type="button" className="preview-close" aria-label="Close preview" onClick={closePreview}>✕</button>
              </div>
            </div>
            {preview.type.startsWith('image/') ? (
              <img className="preview-image" src={preview.url} alt={preview.name} />
            ) : (
              <iframe className="preview-frame" src={preview.url} title={preview.name} />
            )}
          </div>
        </div>
      )}

      <footer className="footer">
        Your API key stays in this browser tab and is sent only to OpenRouter.
      </footer>
    </main>
  )
}
