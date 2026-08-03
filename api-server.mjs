import http from 'node:http'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const port = Number(process.env.LUMEN_API_PORT || 8787)
const host = process.env.LUMEN_API_HOST || '127.0.0.1'
const searxngUrl = process.env.SEARXNG_URL || 'http://127.0.0.1:8080'
const cache = new Map()
const appRoot = path.dirname(fileURLToPath(import.meta.url))
const distRoot = path.join(appRoot, 'dist')

const providerCommands = {
  openai: process.env.OPENAI_CODEX_COMMAND || 'codex',
  minimax: process.env.MINIMAX_CLI_COMMAND || 'mmx',
  grok: process.env.GROK_BUILD_COMMAND || 'grok',
}
const providerCliModels = { openai: process.env.OPENAI_CODEX_MODEL || '' }
const agentCommands = { openclaw: process.env.OPENCLAW_COMMAND || 'openclaw', hermes: process.env.HERMES_COMMAND || 'hermes' }

const modelRuntimes = {
  lmstudio: { endpoint: process.env.LM_STUDIO_URL || 'http://127.0.0.1:1234/v1', model: process.env.LM_STUDIO_MODEL || 'local-model', key: process.env.LM_API_TOKEN || '' },
  openai: { endpoint: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', model: process.env.OPENAI_MODEL || 'gpt-5', key: process.env.OPENAI_API_KEY || '' },
  minimax: { endpoint: process.env.MINIMAX_BASE_URL || 'https://api.minimax.io/v1', model: process.env.MINIMAX_MODEL || 'MiniMax-M2.7', key: process.env.MINIMAX_API_KEY || '' },
  grok: { endpoint: process.env.XAI_BASE_URL || 'https://api.x.ai/v1', model: process.env.XAI_MODEL || 'grok-4.5', key: process.env.XAI_API_KEY || '' },
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization' })
  res.end(JSON.stringify(body))
}

const readBody = (req) => new Promise((resolve, reject) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk; if (body.length > 1_000_000) reject(new Error('Request too large')) })
  req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}) } catch { reject(new Error('Invalid JSON')) } })
  req.on('error', reject)
})

function safeUrl(raw) {
  const parsed = new URL(raw)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP(S) URLs are supported')
  return parsed
}

function queriesFor(query, depth) {
  if (depth !== 'deep') return [query]
  return [query, `${query} technical report`, `${query} latest developments`]
}

async function searchSearxng(query, depth = 'quick', maxResults = 10, configuredUrl = searxngUrl, category = 'general', page = 1) {
  const safePage = Math.max(1, Math.floor(Number(page) || 1))
  const key = `${configuredUrl}:${query}:${depth}:${maxResults}:${category}:${safePage}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.createdAt < 300_000) return { ...hit.value, cached: true }
  const results = []
  const errors = []
  for (const focusedQuery of queriesFor(query, depth).slice(0, depth === 'deep' ? 3 : 1)) {
    try {
      const url = new URL('/search', safeUrl(configuredUrl))
      url.searchParams.set('q', focusedQuery)
      url.searchParams.set('format', 'json')
      url.searchParams.set('safesearch', '1')
      url.searchParams.set('pageno', String(safePage))
      if (category !== 'general') url.searchParams.set('categories', category)
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`SearXNG returned ${response.status}`)
      const payload = await response.json()
      for (const result of Array.isArray(payload.results) ? payload.results : []) {
        if (!result.url || results.some((item) => item.url === result.url)) continue
        results.push({ title: result.title || 'Untitled result', url: result.url, content: result.content || '', engine: result.engine || 'SearXNG', publishedDate: result.publishedDate || null })
        if (results.length >= maxResults) break
      }
    } catch (error) { errors.push({ query: focusedQuery, message: error.message }) }
    if (results.length >= maxResults) break
  }
  const value = { provider: 'searxng', query, depth, page: safePage, pageSize: maxResults, hasMore: results.length >= maxResults, results: results.slice(0, maxResults), errors, queries: queriesFor(query, depth), budget: { requested: depth === 'deep' ? 3 : 1, used: queriesFor(query, depth).length } }
  cache.set(key, { createdAt: Date.now(), value })
  return value
}

function decodeHtml(value) {
  return value.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
}

async function readSourcePage(item) {
  try {
    const response = await fetch(item.url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'LumenResearch/0.1 (+local search)' } })
    if (!response.ok) throw new Error(`page returned ${response.status}`)
    const type = response.headers.get('content-type') || ''
    if (!type.includes('text/html') && !type.includes('application/xhtml')) throw new Error('page is not HTML')
    const html = (await response.text()).slice(0, 300_000)
    const title = decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim()
    const text = decodeHtml(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 6_000)
    if (!text) throw new Error('page contained no readable text')
    return { ...item, pageTitle: title || item.title, pageText: text }
  } catch (error) {
    return { ...item, pageReadError: error.message }
  }
}

async function readTopSourcePages(results, limit = 4) {
  const selected = results.slice(0, limit)
  const pages = await Promise.all(selected.map(readSourcePage))
  return { results: results.map((item) => pages.find((page) => page.url === item.url) || item), errors: pages.filter((item) => item.pageReadError).map((item) => ({ url: item.url, message: `Could not read source page: ${item.pageReadError}` })) }
}

function commandProbe(command, args = ['--version']) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'ignore'] })
    child.once('error', (error) => resolve({ installed: false, message: error.code === 'ENOENT' ? `${command} is not installed` : error.message }))
    child.once('close', (code) => resolve({ installed: true, message: code === 0 ? 'Available' : 'Installed but returned a non-zero status' }))
  })
}

function runAgent(agent, prompt) {
  return new Promise((resolve) => {
    const command = agentCommands[agent]
    const args = agent === 'openclaw' ? ['agent', '--json', '--message', prompt] : ['-z', prompt]
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1_000_000 })
    let output = ''
    let errorOutput = ''
    child.stdout.on('data', (chunk) => { output += chunk.toString(); if (output.length > 1_000_000) child.kill('SIGTERM') })
    child.stderr.on('data', (chunk) => { errorOutput += chunk.toString().slice(0, 8_000) })
    child.once('error', (error) => resolve({ ok: false, error: error.code === 'ENOENT' ? `${command} is not installed` : error.message }))
    child.once('close', (code) => resolve({ ok: code === 0, output: output.slice(0, 1_000_000), error: code === 0 ? undefined : errorOutput || `Exited with code ${code}` }))
  })
}

function runCommand(command, args, { input = '', timeout = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    let output = ''
    let errorOutput = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      resolve({ ok: false, output, error: 'Provider CLI timed out.' })
    }, timeout)
    child.stdout.on('data', (chunk) => { output += chunk.toString(); if (output.length > 1_000_000) child.kill('SIGTERM') })
    child.stderr.on('data', (chunk) => { errorOutput += chunk.toString().slice(0, 12_000) })
    child.once('error', (error) => { clearTimeout(timer); resolve({ ok: false, output, error: error.code === 'ENOENT' ? `${command} is not installed` : error.message }) })
    child.once('close', (code) => {
      clearTimeout(timer)
      const compactError = errorOutput.trim().split('\n').filter(Boolean).slice(-8).join('\n').slice(0, 4_000)
      resolve({ ok: code === 0, output: output.slice(0, 1_000_000), error: code === 0 ? undefined : compactError || `Provider CLI exited with code ${code}` })
    })
    if (input) { child.stdin.write(input); child.stdin.end() }
  })
}

function extractCliText(provider, output) {
  const normalize = (value) => Array.isArray(value) ? value.map((part) => typeof part === 'string' ? part : part?.text || '').join('') : typeof value === 'string' ? value : ''
  if (!output.trim()) return ''
  if (provider === 'minimax') {
    try {
      const payload = JSON.parse(output)
      return normalize(payload.choices?.[0]?.message?.content || payload.reply || payload.content || payload.text)
    } catch {
      return output.trim()
    }
  }
  if (provider === 'grok') {
    try {
      const payload = JSON.parse(output)
      return normalize(payload.result?.finalText || payload.result?.content || payload.finalText || payload.content || payload.text)
    } catch {
      const lines = output.trim().split('\n').reverse()
      for (const line of lines) {
        try {
          const event = JSON.parse(line)
          const text = normalize(event.result?.finalText || event.result?.content || event.finalText || event.content || event.text)
          if (text) return text
        } catch {}
      }
      return output.trim()
    }
  }
  const messages = output.trim().split('\n').reverse()
  for (const line of messages) {
    try {
      const event = JSON.parse(line)
      const text = normalize(event.item?.text || event.item?.content || event.message?.content || event.result?.content || event.text)
      if (text.trim()) return text.trim()
    } catch {}
  }
  return output.trim()
}

async function chatCompletion(provider, system, prompt, override = {}) {
  const runtime = { ...(modelRuntimes[provider] || modelRuntimes.lmstudio), endpoint: override.endpoint || undefined, model: override.model || undefined }
  runtime.endpoint ||= modelRuntimes[provider]?.endpoint || modelRuntimes.lmstudio.endpoint
  runtime.model ||= modelRuntimes[provider]?.model || modelRuntimes.lmstudio.model
  const endpoint = new URL('/chat/completions', safeUrl(runtime.endpoint))
  const response = await fetch(endpoint, {
    method: 'POST', signal: AbortSignal.timeout(45_000), headers: { 'content-type': 'application/json', ...(runtime.key ? { authorization: `Bearer ${runtime.key}` } : {}) },
    body: JSON.stringify({ model: runtime.model, temperature: 0.1, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
  })
  if (!response.ok) throw new Error(`${provider} returned ${response.status}`)
  const payload = await response.json()
  return payload.choices?.[0]?.message?.content || ''
}

async function synthesize(provider, query, results, override = {}) {
  const context = results.slice(0, 8).map((item, index) => `[${index + 1}] ${item.pageTitle || item.title}\n${item.url}\n${item.pageText || item.content}`).join('\n\n')
  return chatCompletion(provider, 'You are Lumen, a careful research agent. Synthesize only from the supplied sources, cite claims as [1], [2], and say when evidence is insufficient. Keep the answer to three concise paragraphs.', `Question: ${query}\n\nSources:\n${context}`, override)
}

function heuristicRank(query, results) {
  const terms = query.toLowerCase().match(/[a-z0-9]{3,}/g) || []
  return results.map((item, index) => {
    const title = item.title.toLowerCase()
    const content = item.content.toLowerCase()
    const score = terms.reduce((total, term) => total + (title.includes(term) ? 18 : 0) + (content.includes(term) ? 4 : 0), 0) + Math.max(0, 10 - index)
    return { ...item, aiScore: score, aiReason: terms.length ? `Matches ${terms.filter((term) => title.includes(term) || content.includes(term)).slice(0, 2).join(' and ') || 'the requested topic'}.` : 'Relevant to the requested topic.' }
  }).sort((a, b) => b.aiScore - a.aiScore)
}

function parseCuratedRanking(output, query, results) {
  const match = output.replace(/```json|```/gi, '').match(/\[[\s\S]*\]/)
  if (!match) throw new Error('Model did not return a ranking list')
  const ranked = JSON.parse(match[0])
  if (!Array.isArray(ranked)) throw new Error('Model ranking was not an array')
  const byId = new Map(results.map((item, index) => [index + 1, item]))
  const used = new Set()
  const curated = ranked.flatMap((entry) => {
    const id = Number(entry.id)
    const item = byId.get(id)
    if (!item || used.has(id)) return []
    used.add(id)
    return [{ ...item, aiScore: Math.max(0, Math.min(100, Number(entry.score) || 0)), aiReason: String(entry.reason || `Relevant to “${query}”.`).slice(0, 180) }]
  })
  return [...curated, ...heuristicRank(query, results.filter((_, index) => !used.has(index + 1)))]
}

async function curateResults(provider, query, results, override = {}) {
  if (!results.length) return { results, mode: 'none', error: null }
  const sourceList = results.map((item, index) => `${index + 1}. ${item.title}\n${item.url}\n${item.content.slice(0, 420)}`).join('\n\n')
  const prompt = `Query: ${query}\n\nRank these website results for the user's intent. Prefer direct, trustworthy, useful sources. Do not invent facts. Return ONLY a JSON array containing every id once, each as {"id": number, "score": 0-100, "reason": "short tailored reason"}.\n\nCandidates:\n${sourceList}`
  try {
    if (provider !== 'lmstudio' && (await commandStatus(provider)).authenticated) {
      const output = await curateViaCli(provider, prompt)
      return { results: parseCuratedRanking(output, query, results), mode: 'ai', error: null }
    }
    const output = await chatCompletion(provider, 'You are a web search ranking model. Your only job is to rank the supplied search results for the user query.', prompt, override)
    return { results: parseCuratedRanking(output, query, results), mode: 'ai', error: null }
  } catch (error) {
    return { results: heuristicRank(query, results), mode: 'heuristic', error: error.message }
  }
}

async function synthesizeViaCli(provider, query, results) {
  const context = results.slice(0, 8).map((item, index) => `[${index + 1}] ${item.pageTitle || item.title}\n${item.url}\n${item.pageText || item.content}`).join('\n\n')
  const prompt = `You are Lumen, a careful web search answer engine. Answer the question using only the supplied website sources. Cite claims inline as [1], [2]. If sources disagree or evidence is missing, say so. Return three concise paragraphs followed by a short "Sources" line.\n\nQuestion: ${query}\n\nWebsite sources:\n${context}`
  let command
  let args
  if (provider === 'openai') {
    command = providerCommands.openai
    args = ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', prompt]
    if (providerCliModels.openai) args.splice(1, 0, '--model', providerCliModels.openai)
  } else if (provider === 'minimax') {
    command = providerCommands.minimax
    args = ['text', 'chat', '--output', 'json', '--non-interactive', '--message', prompt]
  } else if (provider === 'grok') {
    command = providerCommands.grok
    args = ['--output-format', 'json', '--max-turns', '1', '--no-plan', '--disable-web-search', '--single', prompt]
  } else return ''
  const result = await runCommand(command, args)
  if (!result.ok) throw new Error(result.error || `${provider} CLI synthesis failed`)
  return extractCliText(provider, result.output).replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

async function curateViaCli(provider, prompt) {
  let command
  let args
  if (provider === 'openai') {
    command = providerCommands.openai
    args = ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', prompt]
    if (providerCliModels.openai) args.splice(1, 0, '--model', providerCliModels.openai)
  } else if (provider === 'minimax') {
    command = providerCommands.minimax
    args = ['text', 'chat', '--output', 'json', '--non-interactive', '--message', prompt]
  } else if (provider === 'grok') {
    command = providerCommands.grok
    args = ['--output-format', 'json', '--max-turns', '1', '--no-plan', '--disable-web-search', '--single', prompt]
  } else return ''
  const result = await runCommand(command, args)
  if (!result.ok) throw new Error(result.error || `${provider} CLI ranking failed`)
  return extractCliText(provider, result.output).replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

function commandStatus(provider) {
  return new Promise((resolve) => {
    const command = providerCommands[provider]
    if (!command) return resolve({ installed: false, authenticated: false, message: 'Unsupported provider' })
    const args = provider === 'openai' ? ['login', 'status'] : provider === 'grok' ? ['models'] : ['auth', 'status']
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.on('error', (error) => resolve({ installed: false, authenticated: false, message: error.code === 'ENOENT' ? `${command} is not installed` : error.message }))
    child.on('close', (code) => resolve({ installed: true, authenticated: code === 0, message: code === 0 ? 'Authenticated local session' : 'Login required' }))
  })
}

function startLogin(provider) {
  return new Promise((resolve) => {
    const command = providerCommands[provider]
    const args = provider === 'openai' ? ['login'] : provider === 'grok' ? ['login', '--oauth'] : ['auth', 'login', '--browser']
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.once('error', (error) => resolve({ started: false, message: error.code === 'ENOENT' ? `${command} is not installed` : error.message }))
    child.once('spawn', () => { child.unref(); resolve({ started: true, message: 'Authentication flow started in the local CLI' }) })
  })
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') return json(res, 204, {})
  const url = new URL(req.url, `http://${host}:${port}`)
  if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res)
  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, service: 'lumen-api', searxng: searxngUrl })
  if (req.method === 'GET' && url.pathname === '/api/providers') return json(res, 200, { providers: Object.keys(providerCommands) })
  if (req.method === 'GET' && url.pathname === '/api/agents') {
    const statuses = await Promise.all(Object.entries(agentCommands).map(async ([id, command]) => ({ id, command, ...(await commandProbe(command)) })))
    return json(res, 200, { agents: statuses })
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/cli-auth/')) {
    const provider = url.pathname.split('/').pop()
    return json(res, 200, { provider, command: providerCommands[provider], ...(await commandStatus(provider)) })
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/cli-auth/') && url.pathname.endsWith('/login')) {
    const provider = url.pathname.split('/')[3]
    return json(res, 200, { provider, ...(await startLogin(provider)) })
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/agent/')) {
    const agent = url.pathname.split('/').pop()
    if (!agentCommands[agent]) return json(res, 404, { error: 'Unknown agent' })
    const body = await readBody(req)
    if (!body.prompt || typeof body.prompt !== 'string') return json(res, 400, { error: 'prompt is required' })
    return json(res, 200, { agent, ...(await runAgent(agent, body.prompt.slice(0, 20_000))) })
  }
  if (req.method === 'GET' && url.pathname === '/api/search/health') {
    try {
      const baseUrl = url.searchParams.get('baseUrl') || searxngUrl
      const probe = await searchSearxng('lumen search', 'quick', 1, baseUrl, 'general')
      return json(res, 200, { ok: probe.errors.length === 0, baseUrl, resultCount: probe.results.length, errors: probe.errors })
    } catch (error) { return json(res, 400, { ok: false, error: error.message }) }
  }
  if (req.method === 'POST' && url.pathname === '/api/search') {
    const body = await readBody(req)
    if (!body.query || typeof body.query !== 'string') return json(res, 400, { error: 'query is required' })
    const selectedProvider = modelRuntimes[body.provider] ? body.provider : 'lmstudio'
    const search = await searchSearxng(body.query.trim().slice(0, 500), body.depth === 'deep' ? 'deep' : 'quick', Math.min(Number(body.maxResults) || 10, 10), body.baseUrl || searxngUrl, body.category || 'general', body.page)
    const curation = body.curate === false ? { results: search.results, mode: 'disabled', error: null } : await curateResults(selectedProvider, body.query, search.results, body.providerConfig || {})
    return json(res, 200, { ...search, results: curation.results, curation: { mode: curation.mode, error: curation.error } })
  }
  if (req.method === 'POST' && url.pathname === '/api/research') {
    const body = await readBody(req)
    if (!body.query || typeof body.query !== 'string') return json(res, 400, { error: 'query is required' })
    const selectedProvider = modelRuntimes[body.provider] ? body.provider : 'lmstudio'
    const search = await searchSearxng(body.query.trim().slice(0, 500), body.depth === 'quick' ? 'quick' : 'deep', Math.min(Number(body.maxResults) || 10, 10), body.baseUrl || searxngUrl, body.category || 'general', body.page)
    const curation = await curateResults(selectedProvider, body.query, search.results, body.providerConfig || {})
    const curatedSearch = { ...search, results: curation.results, curation: { mode: curation.mode, error: curation.error } }
    const pagePass = body.depth === 'quick' || !curatedSearch.results.length ? { results: curatedSearch.results, errors: [] } : await readTopSourcePages(curatedSearch.results)
    const researchSearch = { ...curatedSearch, results: pagePass.results, errors: [...search.errors, ...pagePass.errors], pageReads: pagePass.results.filter((item) => item.pageText).length }
    let answer = ''
    let synthesisMode = 'api'
    const synthesisErrors = []
    if (researchSearch.results.length) {
      if (selectedProvider !== 'lmstudio' && (await commandStatus(selectedProvider)).authenticated) {
        try {
          answer = await synthesizeViaCli(selectedProvider, body.query, researchSearch.results)
          if (answer) synthesisMode = 'oauth-cli'
        } catch (error) { synthesisErrors.push({ provider: `${selectedProvider}:oauth-cli`, message: error.message }) }
      }
      if (!answer) {
        try { answer = await synthesize(selectedProvider, body.query, researchSearch.results, body.providerConfig || {}) }
        catch (error) { synthesisErrors.push({ provider: selectedProvider, message: error.message }) }
      }
    }
    const trace = [
      { step: 'Plan', status: 'complete', detail: `Generated ${search.queries.length} bounded search queries.` },
      { step: 'Query SearXNG', status: researchSearch.results.length ? 'complete' : 'error', detail: `Retrieved ${researchSearch.results.length} unique website results.` },
      { step: 'Read source pages', status: body.depth === 'quick' ? 'skipped' : researchSearch.pageReads ? 'complete' : 'skipped', detail: body.depth === 'quick' ? 'Quick search uses result snippets without page crawling.' : `Read ${researchSearch.pageReads} top source pages for deeper evidence.` },
      { step: 'Rank sources', status: researchSearch.results.length ? (curation.mode === 'ai' ? 'complete' : 'skipped') : 'skipped', detail: curation.mode === 'ai' ? `AI-ranked ${researchSearch.results.length} sources for the requested intent.` : `Model ranking unavailable; used transparent lexical fallback${curation.error ? '.' : ''}` },
      { step: 'Cross-check', status: researchSearch.results.length > 1 ? 'complete' : 'skipped', detail: 'Prepared multiple sources for contradiction-aware synthesis.' },
      { step: 'Synthesize', status: answer ? 'complete' : 'error', detail: answer ? `Synthesized with ${selectedProvider}${synthesisMode === 'oauth-cli' ? ' OAuth session' : ''}.` : 'No model synthesis was produced.' },
    ]
    return json(res, 200, { query: body.query, provider: selectedProvider, synthesisMode, search: { ...researchSearch, errors: [...researchSearch.errors, ...synthesisErrors] }, trace, answer: answer || (researchSearch.results.length ? `Research retrieved ${researchSearch.results.length} sources, but ${selectedProvider} could not synthesize them. Check the provider endpoint, model, or server-side credentials.` : 'SearXNG did not return sources. Check the SearXNG URL and JSON format configuration, then try again.') })
  }
  return json(res, 404, { error: 'Not found' })
}

async function serveStatic(requestPath, res) {
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }
  const relative = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '')
  const candidate = path.resolve(distRoot, relative)
  const safeCandidate = candidate.startsWith(`${distRoot}${path.sep}`) ? candidate : path.join(distRoot, 'index.html')
  try {
    const body = await readFile(safeCandidate)
    res.writeHead(200, { 'content-type': mime[path.extname(safeCandidate)] || 'application/octet-stream', 'cache-control': safeCandidate.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable' })
    res.end(body)
  } catch {
    try { res.writeHead(200, { 'content-type': mime['.html'] }); res.end(await readFile(path.join(distRoot, 'index.html'))) } catch { json(res, 404, { error: 'Build output not found. Run npm run build.' }) }
  }
}

const server = http.createServer((req, res) => handle(req, res).catch((error) => json(res, 500, { error: error.message })))
server.listen(port, host, () => console.log(`Lumen API listening on http://${host}:${port}`))
