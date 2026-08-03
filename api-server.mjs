import http from 'node:http'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const port = Number(process.env.LUMEN_API_PORT || 3001)
const host = process.env.LUMEN_API_HOST || '127.0.0.1'
const searxngUrl = process.env.SEARXNG_URL || 'http://127.0.0.1:8080'
const cache = new Map()
const rankedSearchCache = new Map()
const rankedSearchInflight = new Map()
const warmSearchJobs = new Map()
const localRuntimeProfiles = new Map()
const localStageCache = new Map()
const localQueue = []
let localQueueActive = 0
const rankedSearchWindowPages = 4
const appRoot = path.dirname(fileURLToPath(import.meta.url))
const distRoot = path.join(appRoot, 'dist')
// Local inference varies dramatically with model size, quantization, and
// hardware. Give it a generous default, while retaining a bounded override.
const lmStudioTimeoutMs = Math.min(Math.max(Number(process.env.LM_STUDIO_TIMEOUT_MS || 180_000), 30_000), 600_000)
const localStageCacheTtlMs = 300_000

function clamp(value, min, max, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.floor(parsed), min), max) : fallback
}

function localRuntimeKey(endpoint, model) { return `${safeUrl(endpoint)}::${String(model || '').trim()}` }

function localRuntimeDefaults() {
  return { autoAdapt: true, warmupEnabled: true, format: 'auto', timeoutMs: lmStudioTimeoutMs, retryCount: 1, concurrency: 1, contextBudget: 6_000, rankingBatchSize: 10 }
}

function normalizeLocalRuntime(value = {}) {
  const defaults = localRuntimeDefaults()
  const format = ['auto', 'json', 'fenced-json', 'markdown'].includes(value.format) ? value.format : defaults.format
  return {
    autoAdapt: value.autoAdapt !== false,
    warmupEnabled: value.warmupEnabled !== false,
    format,
    timeoutMs: clamp(value.timeoutMs, 30_000, 600_000, defaults.timeoutMs),
    retryCount: clamp(value.retryCount, 0, 2, defaults.retryCount),
    concurrency: clamp(value.concurrency, 1, 2, defaults.concurrency),
    contextBudget: clamp(value.contextBudget, 1_500, 16_000, defaults.contextBudget),
    rankingBatchSize: clamp(value.rankingBatchSize, 3, 10, defaults.rankingBatchSize),
  }
}

function ensureLocalProfile(endpoint, model, override = {}) {
  const key = localRuntimeKey(endpoint, model)
  const existing = localRuntimeProfiles.get(key)
  const profile = existing || { key, endpoint: safeUrl(endpoint), model: String(model || ''), createdAt: Date.now(), version: 1, warmup: 'not-run', formatDetected: 'unknown', lastResponseMs: null, averageResponseMs: null, lastError: null, stages: {}, overrides: localRuntimeDefaults(), cacheHits: 0 }
  if (override && Object.keys(override).length) {
    const nextOverrides = normalizeLocalRuntime({ ...profile.overrides, ...override })
    if (JSON.stringify(profile.overrides) !== JSON.stringify(nextOverrides)) {
      profile.overrides = nextOverrides
      profile.version += existing ? 1 : 0
    }
  }
  localRuntimeProfiles.set(key, profile)
  return profile
}

function publicLocalProfile(profile) {
  return {
    endpoint: profile.endpoint, model: profile.model, version: profile.version, warmup: profile.warmup,
    format: profile.formatDetected, lastResponseMs: profile.lastResponseMs, averageResponseMs: profile.averageResponseMs,
    lastError: profile.lastError, stages: profile.stages, cacheHits: profile.cacheHits,
    queue: { active: localQueueActive, waiting: localQueue.length }, overrides: profile.overrides,
  }
}

function recordLocalStage(profile, stage, status, durationMs = null, error = null, cached = false) {
  const current = profile.stages[stage] || { success: 0, failure: 0, cached: 0, lastStatus: 'idle', lastDurationMs: null }
  if (status === 'success') current.success += 1
  if (status === 'failure') current.failure += 1
  if (cached) current.cached += 1
  current.lastStatus = status
  current.lastDurationMs = durationMs
  profile.stages[stage] = current
  if (durationMs != null) {
    profile.lastResponseMs = durationMs
    profile.averageResponseMs = profile.averageResponseMs == null ? durationMs : Math.round(profile.averageResponseMs * 0.7 + durationMs * 0.3)
  }
  profile.lastError = error || null
  localRuntimeProfiles.set(profile.key, profile)
}

function enqueueLocal(task, concurrency = 1) {
  return new Promise((resolve, reject) => {
    localQueue.push({ task, concurrency, resolve, reject })
    const drain = () => {
      const limit = Math.max(1, ...localQueue.map((item) => item.concurrency))
      while (localQueueActive < limit && localQueue.length) {
        const next = localQueue.shift()
        localQueueActive += 1
        Promise.resolve().then(next.task).then(next.resolve, next.reject).finally(() => { localQueueActive -= 1; drain() })
      }
    }
    drain()
  })
}

function stageCacheKey(profile, stage, prompt, options = {}) {
  return createHash('sha256').update(`${profile.key}:${profile.version}:${stage}:${options.maxTokens || ''}:${prompt}`).digest('hex')
}

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
const providerFallbackModels = {
  openai: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6', 'gpt-5'],
  minimax: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.1', 'MiniMax-M2.1-highspeed', 'MiniMax-M2', 'M2-her'],
  grok: ['grok-4.5', 'grok-4.5-latest', 'grok-build-0.1', 'grok-build-latest', 'grok-4.3', 'grok-4.20-0309-reasoning', 'grok-4.20-reasoning-latest', 'grok-4.20-0309-non-reasoning', 'grok-4.20-non-reasoning-latest', 'grok-4.20-multi-agent-0309', 'grok-4.20-multi-agent-latest'],
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

function chatCompletionsUrl(raw) {
  const endpoint = safeUrl(raw)
  const path = endpoint.pathname.replace(/\/+$/, '')
  endpoint.pathname = `${path.endsWith('/v1') ? path : `${path}/v1`}/chat/completions`
  endpoint.search = ''
  return endpoint
}

async function discoverModels(provider, endpoint, key = '') {
  const configured = safeUrl(endpoint || modelRuntimes[provider]?.endpoint || modelRuntimes.lmstudio.endpoint)
  const providerKey = key || modelRuntimes[provider]?.key
  const headers = { accept: 'application/json', ...(providerKey ? { authorization: `Bearer ${providerKey}` } : {}) }
  const paths = provider === 'lmstudio' ? ['/api/v1/models', '/v1/models', '/models'] : ['/models']
  const errors = []
  for (const pathname of paths) {
    try {
      const url = new URL(pathname, configured)
      const response = await fetch(url, { signal: AbortSignal.timeout(8_000), headers })
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      const payload = await response.json()
      const candidates = Array.isArray(payload.models) ? payload.models : Array.isArray(payload.data) ? payload.data : []
      const models = candidates.filter((item) => !item.type || ['llm', 'language', 'text-generation'].includes(String(item.type).toLowerCase())).map((item) => ({ id: item.key || item.id || item.model_id || item.display_name, label: item.display_name || item.name || item.key || item.id, architecture: item.architecture || null, quantization: item.quantization?.name || item.quantization || null })).filter((item) => item.id)
      return { models, endpoint: url.toString(), source: pathname }
    } catch (error) { errors.push(error.message) }
  }
  const detail = errors.join(' · ')
  if (provider === 'lmstudio' && /401|403/.test(detail)) throw new Error('Could not load models: LM Studio requires a server token. Add it in Providers and refresh.')
  if (providerFallbackModels[provider]) {
    return {
      models: providerFallbackModels[provider].map((id) => ({ id, label: id, architecture: null, quantization: null })),
      endpoint: configured.toString(), source: 'built-in-fallback', warning: `Live model discovery was unavailable: ${detail}`,
    }
  }
  throw new Error(`Could not load models: ${detail}`)
}

function queriesFor(query, depth) {
  if (depth !== 'deep') return [query]
  return [query, `${query} technical report`, `${query} latest developments`]
}

async function searchGitHubRepositories(query, page = 1, maxResults = 10) {
  try {
    const url = new URL('https://api.github.com/search/repositories')
    const focusedQuery = query.replace(/\b(what|are|the|most|useful|right|now|how|does|can|could|should|with|for|and|that|this|these|best)\b/gi, ' ').replace(/[^\w\s.+#-]/g, ' ').replace(/\s+/g, ' ').trim() || query
    url.searchParams.set('q', focusedQuery)
    url.searchParams.set('sort', 'stars')
    url.searchParams.set('order', 'desc')
    url.searchParams.set('per_page', String(maxResults))
    url.searchParams.set('page', String(page))
    const response = await fetch(url, { signal: AbortSignal.timeout(12_000), headers: { accept: 'application/vnd.github+json', 'user-agent': 'LumenSearch/0.1' } })
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`)
    const payload = await response.json()
    return { results: (payload.items || []).map((item) => ({ title: item.full_name, url: item.html_url, content: item.description || 'GitHub repository', engine: 'github', publishedDate: item.updated_at || null })), hasMore: (payload.total_count || 0) > page * maxResults, error: null }
  } catch (error) { return { results: [], hasMore: false, error: error.message } }
}

async function searchSearxng(query, depth = 'quick', maxResults = 10, configuredUrl = searxngUrl, category = 'general', page = 1) {
  const safePage = Math.max(1, Math.floor(Number(page) || 1))
  const key = `${configuredUrl}:${query}:${depth}:${maxResults}:${category}:${safePage}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.createdAt < 300_000) return { ...hit.value, cached: true }
  if (category === 'github') {
    const github = await searchGitHubRepositories(query, safePage, maxResults)
    const value = { provider: 'github', query, depth, page: safePage, pageSize: maxResults, hasMore: github.hasMore, results: github.results, errors: github.error ? [{ query, message: `GitHub repository search: ${github.error}` }] : [], queries: [query], budget: { requested: 1, used: 1 } }
    cache.set(key, { createdAt: Date.now(), value })
    return value
  }
  const results = []
  const errors = []
  const searchCategory = category
  for (const focusedQuery of queriesFor(query, depth).slice(0, depth === 'deep' ? 3 : 1)) {
    try {
      const url = new URL('/search', safeUrl(configuredUrl))
      url.searchParams.set('q', focusedQuery)
      url.searchParams.set('format', 'json')
      url.searchParams.set('safesearch', '1')
      url.searchParams.set('pageno', String(safePage))
      if (searchCategory !== 'general') url.searchParams.set('categories', searchCategory)
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`SearXNG returned ${response.status}`)
      const payload = await response.json()
      const unavailableEngines = Array.isArray(payload.unresponsive_engines) ? payload.unresponsive_engines : []
      if (!Array.isArray(payload.results) || payload.results.length === 0) {
        for (const engine of unavailableEngines) {
          const [name, reason] = Array.isArray(engine) ? engine : [String(engine), 'unavailable']
          errors.push({ query: focusedQuery, message: `SearXNG engine ${name}: ${reason}` })
        }
      }
      for (const result of Array.isArray(payload.results) ? payload.results : []) {
        if (!result.url || results.some((item) => item.url === result.url)) continue
        results.push({
          title: result.title || 'Untitled result', url: result.url, content: result.content || '', engine: result.engine || 'SearXNG', publishedDate: result.publishedDate || result.pubdate || null,
          category: result.category || category, template: result.template || '', thumbnail: result.thumbnail || result.thumbnail_src || '', imgSrc: result.img_src || '', iframeSrc: result.iframe_src || '',
          source: result.source || '', resolution: result.resolution || '', length: result.length || '', author: result.author || '', metadata: result.metadata || '',
        })
        if (results.length >= maxResults) break
      }
    } catch (error) { errors.push({ query: focusedQuery, message: error.message }) }
    if (results.length >= maxResults) break
  }
  const value = { provider: 'searxng', query, depth, page: safePage, pageSize: maxResults, hasMore: results.length >= maxResults, results: results.slice(0, maxResults), errors, queries: queriesFor(query, depth), budget: { requested: depth === 'deep' ? 3 : 1, used: queriesFor(query, depth).length } }
  if (value.results.length) cache.set(key, { createdAt: Date.now(), value })
  return value
}

async function searchRankedWindow(query, maxResults = 10, configuredUrl = searxngUrl, category = 'general', requestedPage = 1, provider = 'lmstudio', override = {}, curate = true, includeOverview = true) {
  const page = Math.max(1, Math.floor(Number(requestedPage) || 1))
  const pageSize = Math.min(Math.max(1, Number(maxResults) || 10), 10)
  const stageOutcomes = []
  const effectiveOverride = { ...override, stageOutcomes }
  const localProfile = provider === 'lmstudio' ? ensureLocalProfile(override.endpoint || modelRuntimes.lmstudio.endpoint, override.model || modelRuntimes.lmstudio.model, override.localRuntime || {}) : null
  const cacheKey = JSON.stringify({ query, page, pageSize, configuredUrl, category, provider, endpoint: override.endpoint || '', model: override.model || '', profileVersion: localProfile?.version || 0, curate })
  const hit = rankedSearchCache.get(cacheKey)
  let ranked

  if (hit && Date.now() - hit.createdAt < 300_000) {
    ranked = { ...hit.value, cached: true }
  } else {
    let pending = rankedSearchInflight.get(cacheKey)
    if (!pending) {
      pending = (async () => {
        // Query only the requested page. Pulling a four-page window for every
        // first search exhausts public SearXNG engines and also reranks later,
        // lower-ranked pages as though they were page one.
        const pages = [await searchSearxng(query, 'quick', pageSize, configuredUrl, category, page)]
        const seenUrls = new Set()
        const candidates = pages.flatMap((result) => result.results).filter((item) => {
          if (seenUrls.has(item.url)) return false
          seenUrls.add(item.url)
          return true
        })
        let curation
        try {
          curation = curate ? await curateResults(provider, query, candidates, effectiveOverride, null, includeOverview) : { results: candidates, mode: 'disabled', error: null, overview: '', plan: null, diagnostics: [] }
        } catch (error) {
          curation = { results: heuristicRank(query, candidates), mode: 'heuristic', error: error.message, overview: '', plan: null, diagnostics: [{ provider, stage: 'curation', message: error.message, severity: 'error' }] }
        }
        // An empty retrieval set is not an AI ranking failure. Preserve the
        // SearXNG/GitHub error so the client can explain what actually needs
        // attention, rather than blaming the selected model.
        if (candidates.length && (!Array.isArray(curation.results) || !curation.results.length)) {
          curation = { ...curation, results: heuristicRank(query, candidates), mode: 'heuristic', error: curation.error || 'AI response did not include usable rankings.' }
        }
        const answer = curation.overview || ''
        const overviewError = includeOverview && !answer ? curation.error : null
        const plan = curation.plan || { mode: 'fallback', focus: 'Match the user intent with direct, trustworthy websites.', criteria: [], error: curation.error || null }
        const value = {
          provider: pages[0]?.provider || 'searxng', query, depth: 'quick', pageSize,
          hasMore: pages.some((result) => result.hasMore),
          results: curation.results,
          errors: pages.flatMap((result) => result.errors),
          queries: [query],
          budget: { requested: 1, used: 1 },
          curation: { mode: curation.mode, error: curation.error, warning: curation.warning || null },
          plan: { mode: plan.mode, focus: plan.focus, criteria: plan.criteria, error: plan.error },
          answer,
          overviewError,
          runtime: localProfile ? publicLocalProfile(localProfile) : null,
          stages: stageOutcomes,
          diagnostics: curation.diagnostics || [],
        }
        if (value.results.length) rankedSearchCache.set(cacheKey, { createdAt: Date.now(), value })
        return value
      })().finally(() => rankedSearchInflight.delete(cacheKey))
      rankedSearchInflight.set(cacheKey, pending)
    }
    ranked = { ...(await pending), cached: false }
  }

  return { ...ranked, page, hasMore: Boolean(ranked.hasMore) }
}

function warmSearchCategories(query, maxResults, configuredUrl, provider, override) {
  const categories = ['news', 'github', 'science', 'images', 'videos']
  const jobKey = JSON.stringify({ query, maxResults, configuredUrl, provider, endpoint: override.endpoint || '', model: override.model || '' })
  if (warmSearchJobs.has(jobKey)) return false
  const job = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 4_000))
    for (const category of categories) await searchRankedWindow(query, maxResults, configuredUrl, category, 1, provider, override, true, false)
  })().catch(() => {}).finally(() => warmSearchJobs.delete(jobKey))
  warmSearchJobs.set(jobKey, job)
  return true
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

async function chatCompletion(provider, system, prompt, override = {}, options = {}) {
  const runtime = { ...(modelRuntimes[provider] || modelRuntimes.lmstudio), endpoint: override.endpoint || undefined, model: override.model || undefined, key: override.key || undefined }
  runtime.endpoint ||= modelRuntimes[provider]?.endpoint || modelRuntimes.lmstudio.endpoint
  runtime.model ||= modelRuntimes[provider]?.model || modelRuntimes.lmstudio.model
  runtime.key ||= modelRuntimes[provider]?.key || modelRuntimes.lmstudio.key
  const endpoint = chatCompletionsUrl(runtime.endpoint)
  const requestedTimeout = options.timeoutMs || 30_000
  if (provider !== 'lmstudio') {
    const response = await fetch(endpoint, { method: 'POST', signal: AbortSignal.timeout(requestedTimeout), headers: { 'content-type': 'application/json', ...(runtime.key ? { authorization: `Bearer ${runtime.key}` } : {}) }, body: JSON.stringify({ model: runtime.model, temperature: 0.1, max_tokens: options.maxTokens || 700, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }) })
    if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(`${provider} model request failed: ${payload?.error?.message || payload?.message || `${response.status} ${response.statusText}`}`) }
    const payload = await response.json()
    return payload.choices?.[0]?.message?.content || ''
  }

  const profile = ensureLocalProfile(runtime.endpoint, runtime.model, override.localRuntime || {})
  const stage = options.stage || 'completion'
  const cacheKey = options.cacheable ? stageCacheKey(profile, stage, prompt, options) : ''
  const cached = cacheKey && localStageCache.get(cacheKey)
  if (cached && Date.now() - cached.createdAt < localStageCacheTtlMs) {
    profile.cacheHits += 1
    recordLocalStage(profile, stage, 'success', 0, null, true)
    options.stageOutcomes?.push({ stage, status: 'cached', durationMs: 0, attempts: 0, cached: true })
    return cached.output
  }
  if (cached) localStageCache.delete(cacheKey)

  const maxAttempts = 1 + profile.overrides.retryCount
  const selectedFormat = profile.overrides.format === 'auto' ? profile.formatDetected : profile.overrides.format
  const formatInstruction = selectedFormat === 'json' ? ' Respond with valid JSON only; do not wrap it in prose or Markdown.' : selectedFormat === 'fenced-json' ? ' Put the requested JSON in one ```json fenced block only.' : selectedFormat === 'markdown' ? ' Use concise Markdown when JSON is not possible; do not explain formatting.' : ''
  let lastError
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = Date.now()
    const maxTokens = Math.max(80, Math.min(options.maxTokens || 700, attempt === 1 ? profile.overrides.contextBudget : Math.floor(profile.overrides.contextBudget * 0.65), attempt === 1 ? options.maxTokens || 700 : Math.floor((options.maxTokens || 700) * 0.65)))
    const attemptPrompt = attempt === 1 ? prompt : `${prompt.slice(0, Math.max(1_200, Math.floor(profile.overrides.contextBudget * 0.65)))}\n\nReturn the smallest valid answer only.`
    try {
      const payload = await enqueueLocal(async () => {
        const response = await fetch(endpoint, { method: 'POST', signal: AbortSignal.timeout(Math.max(requestedTimeout, profile.overrides.timeoutMs)), headers: { 'content-type': 'application/json', ...(runtime.key ? { authorization: `Bearer ${runtime.key}` } : {}) }, body: JSON.stringify({ model: runtime.model, temperature: 0.1, max_tokens: maxTokens, messages: [{ role: 'system', content: `${system}${formatInstruction}` }, { role: 'user', content: attemptPrompt }] }) })
        if (!response.ok) { const value = await response.json().catch(() => ({})); const message = value?.error?.message || value?.message || `${response.status} ${response.statusText}`; const error = new Error(`lmstudio model request failed: ${message}`); error.retryable = response.status === 408 || response.status === 429 || response.status >= 500; throw error }
        return response.json()
      }, profile.overrides.concurrency)
      const output = payload.choices?.[0]?.message?.content || ''
      if (!output.trim()) throw new Error('lmstudio model returned an empty response')
      const durationMs = Date.now() - startedAt
      recordLocalStage(profile, stage, 'success', durationMs)
      options.stageOutcomes?.push({ stage, status: 'success', durationMs, attempts: attempt, cached: false })
      if (cacheKey) localStageCache.set(cacheKey, { createdAt: Date.now(), profileKey: profile.key, output })
      return output
    } catch (error) {
      lastError = error
      const durationMs = Date.now() - startedAt
      const retryable = error?.retryable || error?.name === 'TimeoutError' || error?.name === 'AbortError' || /timeout|overload|busy|empty response/i.test(error?.message || '')
      if (attempt === maxAttempts || !retryable) {
        recordLocalStage(profile, stage, 'failure', durationMs, error.message)
        options.stageOutcomes?.push({ stage, status: 'failed', durationMs, attempts: attempt, cached: false, reason: error.message })
        throw error
      }
    }
  }
  throw lastError || new Error('lmstudio model request failed')
}

function parseJsonObject(output, label) {
  const match = output.replace(/```json|```/gi, '').match(/\{[\s\S]*\}/)
  if (!match) throw new Error(`Model did not return ${label} JSON`)
  return JSON.parse(match[0])
}

async function planSearch(provider, query, category, depth, override = {}) {
  const prompt = `User query: ${query}\nCategory: ${category}\nDepth: ${depth}\n\nReturn ONLY JSON: {"searchQuery":"a precise website search query", "focus":"what evidence matters", "criteria":["criterion"]}. Keep searchQuery close to the user's wording; do not add facts or change the requested place, date, product, or person.`
  try {
    const plan = parseJsonObject(await chatCompletion(provider, 'You are Lumen\'s search planner. Convert the user intent into a precise web-search plan without answering the question.', prompt, override, { timeoutMs: 8_000, maxTokens: 120, stage: 'plan', cacheable: true, stageOutcomes: override.stageOutcomes }), 'a search plan')
    const searchQuery = String(plan.searchQuery || '').trim().slice(0, 500)
    return { searchQuery: searchQuery || query, focus: String(plan.focus || '').slice(0, 280), criteria: Array.isArray(plan.criteria) ? plan.criteria.slice(0, 5).map((item) => String(item).slice(0, 120)) : [], mode: 'ai', error: null }
  } catch (error) {
    return { searchQuery: query, focus: 'Match the user intent with direct, trustworthy websites.', criteria: [], mode: 'fallback', error: error.message }
  }
}

async function probeLocalRuntime(override = {}) {
  const runtime = { ...modelRuntimes.lmstudio, endpoint: override.endpoint || modelRuntimes.lmstudio.endpoint, model: override.model || modelRuntimes.lmstudio.model }
  const profile = ensureLocalProfile(runtime.endpoint, runtime.model, override.localRuntime || {})
  if (!profile.overrides.warmupEnabled) return { profile: publicLocalProfile(profile), skipped: true }
  profile.warmup = 'running'
  localRuntimeProfiles.set(profile.key, profile)
  try {
    const output = await chatCompletion('lmstudio', 'You are a capability probe. Reply with the requested compact response only.', 'Return exactly this JSON object: {"ready":true,"format":"json"}', { ...override, endpoint: runtime.endpoint, model: runtime.model }, { timeoutMs: 12_000, maxTokens: 40, stage: 'warmup', stageOutcomes: [] })
    const cleaned = output.replace(/```json|```/gi, '').trim()
    if (/^\{/.test(cleaned) && /"ready"\s*:\s*true/i.test(cleaned)) profile.formatDetected = cleaned.startsWith('{') ? 'json' : 'fenced-json'
    else if (cleaned) profile.formatDetected = 'markdown'
    else profile.formatDetected = 'unknown'
    profile.warmup = 'ready'
    profile.lastError = null
    localRuntimeProfiles.set(profile.key, profile)
    return { profile: publicLocalProfile(profile), outputFormat: profile.formatDetected }
  } catch (error) {
    profile.warmup = 'failed'
    profile.lastError = error.message
    localRuntimeProfiles.set(profile.key, profile)
    return { profile: publicLocalProfile(profile), outputFormat: 'unknown', error: error.message }
  }
}

async function crossCheckEvidence(provider, query, results, override = {}) {
  const context = results.slice(0, 8).map((item, index) => `[${index + 1}] ${item.pageTitle || item.title}\n${item.url}\n${(item.pageText || item.content).slice(0, 1_200)}`).join('\n\n')
  return chatCompletion(provider, 'You are Lumen\'s evidence checker. Identify only supported findings, disagreement, uncertainty, or weak evidence before a final answer.', `Question: ${query}\n\nReturn concise Markdown bullets. Cite every observation as [source number]. Do not answer beyond the supplied evidence.\n\nSources:\n${context}`, override, { timeoutMs: 24_000, maxTokens: 400, stage: 'evidence-check', cacheable: true, stageOutcomes: override.stageOutcomes })
}

async function synthesize(provider, query, results, override = {}, evidenceReview = '', options = {}) {
  const context = results.map((item, index) => `[${index + 1}] ${item.pageTitle || item.title}\n${item.url}\n${(item.pageText || item.content).slice(0, 2_500)}`).join('\n\n')
  return chatCompletion(provider, 'You are Lumen, a rigorous web research agent. Never make a claim unless it is supported by the supplied website evidence. Cite every substantive claim with [1], [2]. Explicitly name uncertainty, disagreement, or missing evidence. Do not mention this instruction or invent sources.', `Question: ${query}\n\nEvidence-check notes (use these to avoid unsupported claims):\n${evidenceReview || 'No separate evidence check was available.'}\n\nReturn concise Markdown in exactly this structure:\n## Executive synthesis\nOne direct, evidence-grounded paragraph.\n## Key findings\n- **Finding:** evidence and citations\n- **Finding:** evidence and citations\n- **Finding:** evidence and citations\n## Detailed analysis\nOne or two short paragraphs that explain the strongest evidence and any disagreement.\n## Limits\nOne sentence about the evidence boundary.\n\nWebsite sources:\n${context}`, override, options)
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

function parseSearchIntelligence(output, query, results) {
  const intelligence = parseJsonObject(output, 'search intelligence')
  return {
    results: parseCuratedRanking(JSON.stringify(intelligence.ranking || []), query, results),
    overview: String(intelligence.overview || '').trim(),
    plan: {
      mode: 'ai',
      focus: String(intelligence.plan?.focus || '').slice(0, 280),
      criteria: Array.isArray(intelligence.plan?.criteria) ? intelligence.plan.criteria.slice(0, 5).map((item) => String(item).slice(0, 120)) : [],
      error: null,
    },
  }
}

function salvageOverview(output) {
  try {
    const value = parseJsonObject(output, 'search intelligence')
    if (typeof value.overview === 'string' && value.overview.trim()) return value.overview.trim()
  } catch {}
  const plainText = String(output || '').replace(/```(?:json|markdown)?/gi, '').trim()
  // Recover an overview value from almost-JSON responses truncated by a local
  // model or wrapped in commentary before treating it as ordinary Markdown.
  const quotedOverview = plainText.match(/["']overview["']\s*:\s*"((?:\\.|[^"\\])*)/i)
  if (quotedOverview) {
    try { return JSON.parse(`"${quotedOverview[1]}"`).trim().slice(0, 8_000) } catch { return quotedOverview[1].replace(/\\n/g, '\n').trim().slice(0, 8_000) }
  }
  if (plainText.startsWith('[') || plainText.startsWith('{')) return ''
  return plainText.length >= 24 ? plainText.slice(0, 8_000) : ''
}

function sourceOverview(query, results) {
  const findings = results.slice(0, 4).map((item, index) => `- **${item.title}** — ${(item.content || 'Relevant website result.').replace(/\s+/g, ' ').slice(0, 220)} [${index + 1}]`)
  return `## Source overview\nHere are the strongest retrieved website results for “${query}”.\n\n${findings.join('\n')}`
}

function parseRankingEntries(output) {
  const cleaned = String(output || '').replace(/```(?:json|markdown)?/gi, '').trim()
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/)
  if (arrayMatch) {
    try {
      const entries = JSON.parse(arrayMatch[0])
      if (Array.isArray(entries)) return entries
    } catch {}
  }
  const objectMatch = cleaned.match(/\{[\s\S]*\}/)
  if (objectMatch) {
    try {
      const value = JSON.parse(objectMatch[0])
      if (Array.isArray(value.ranking)) return value.ranking
    } catch {}
  }

  // Some local chat templates prepend a Markdown list despite the JSON
  // instruction. Only accept an unambiguous "id. score - reason" line.
  const markdownEntries = []
  for (const line of cleaned.split('\n')) {
    const match = line.match(/^\s*(?:[-*]\s*)?(\d+)\s*[.)]\s*(?:score\s*[:=-]?\s*)?(\d{1,3})(?:\s*(?:[-|:—–])\s*(.*))?\s*$/i)
    if (!match) continue
    markdownEntries.push({ id: Number(match[1]), score: Number(match[2]), reason: String(match[3] || 'Relevant to the query.').trim() })
  }
  if (markdownEntries.length) return markdownEntries
  throw new Error('Model did not return a usable ranking list')
}

async function rankEveryResultWithAI(provider, query, results, override = {}) {
  const entries = []
  const failures = []
  const runtimeProfile = provider === 'lmstudio' ? ensureLocalProfile(override.endpoint || modelRuntimes.lmstudio.endpoint, override.model || modelRuntimes.lmstudio.model, override.localRuntime || {}) : null
  const batchSize = runtimeProfile?.overrides.rankingBatchSize || 10
  for (let offset = 0; offset < results.length; offset += batchSize) {
    const batch = results.slice(offset, offset + batchSize)
    const candidates = batch.map((item, index) => `${offset + index + 1}. ${item.title.slice(0, 110)} | ${new URL(item.url).hostname} | ${item.content.replace(/\s+/g, ' ').slice(0, 85)}`).join('\n')
    try {
      const output = await chatCompletion(provider, 'You are Lumen\'s search reranker. Score each supplied website for the exact user query. Return only the requested JSON.', `Query: ${query}\n\nReturn ONLY JSON array with every id exactly once: [{"id":number,"score":0-100,"reason":"max 8 words"}].\n\nCandidates:\n${candidates}`, override, { timeoutMs: 16_000, maxTokens: 240, stage: 'rank', cacheable: true, stageOutcomes: override.stageOutcomes })
      const rankedBatch = parseRankingEntries(output)
      const validBatchIds = new Set(rankedBatch.map((item) => Number(item.id)))
      if (validBatchIds.size !== batch.length || [...validBatchIds].some((id) => id < offset + 1 || id > offset + batch.length)) throw new Error(`AI returned an incomplete ranking batch (${validBatchIds.size}/${batch.length})`)
      entries.push(...rankedBatch)
    } catch (error) { failures.push(error.message) }
  }
  const uniqueIds = new Set(entries.map((item) => Number(item.id)).filter((id) => id >= 1 && id <= results.length))
  return {
    results: parseCuratedRanking(JSON.stringify(entries), query, results),
    rankedCount: uniqueIds.size,
    complete: uniqueIds.size === results.length,
    error: failures[0] || null,
  }
}

async function curateResults(provider, query, results, override = {}, plan = null, includeOverview = false) {
  if (!results.length) return { results, mode: 'none', error: null }
  const sourceList = results.map((item, index) => `${index + 1}. ${item.title.slice(0, 120)} | ${new URL(item.url).hostname} | ${item.content.replace(/\s+/g, ' ').slice(0, 100)}`).join('\n')
  if (includeOverview && provider === 'lmstudio') {
    const prompt = `Query: ${query}\n\nReturn ONLY JSON: {"plan":{"focus":"short"},"ranking":[{"id":number,"score":0-100,"reason":"max 8 words"}],"overview":"2-4 concise Markdown paragraphs/bullets with [id] citations"}. Select and rank only the 6 strongest candidates. The overview must directly answer the query using only the candidates.\n\nCandidates:\n${sourceList}`
    let overview = sourceOverview(query, results)
    let planResult = null
    let overviewError = null
    let modelResponded = false
    try {
      const output = await chatCompletion(provider, 'You are Lumen\'s compact search intelligence engine. Prioritize a useful, cited overview and select only the strongest sources.', prompt, override, { timeoutMs: 35_000, maxTokens: 560, stage: 'overview', cacheable: true, stageOutcomes: override.stageOutcomes })
      modelResponded = Boolean(output.trim())
      try {
        const intelligence = parseSearchIntelligence(output, query, results)
        overview = intelligence.overview || overview
        planResult = intelligence.plan
      } catch (error) { overview = salvageOverview(output) || overview; overviewError = `AI returned an incomplete overview: ${error.message}` }
    } catch (error) {
      overviewError = error.message
    }
    const ranked = await rankEveryResultWithAI(provider, query, results, override)
    if (ranked.complete) return { results: ranked.results, mode: 'ai', error: null, overview, plan: planResult, diagnostics: [] }
    const modelReturnedOverview = overview !== sourceOverview(query, results)
    if (ranked.rankedCount || modelReturnedOverview || modelResponded) {
      const warning = ranked.error || overviewError || `AI ranked ${ranked.rankedCount} of ${results.length} results; remaining results use relevance fallback.`
      return { results: ranked.results, mode: 'partial', error: null, warning, overview, plan: planResult, diagnostics: [{ provider, stage: 'overview/ranking', message: warning, severity: 'warning' }] }
    }
    const error = overviewError || ranked.error || 'The model did not return usable search intelligence.'
    return { results: ranked.results, mode: 'heuristic', error, overview, plan: planResult, diagnostics: [{ provider, stage: 'overview/ranking', message: error, severity: 'error' }] }
  }
  const prompt = `Query: ${query}\nSearch focus: ${plan?.focus || 'directly satisfy the user intent'}\n\nRank every candidate. Prefer direct, trustworthy, useful websites. Return ONLY JSON array: [{"id":number,"score":0-100,"reason":"max 8 words"}]. Every id exactly once.\n\nCandidates:\n${sourceList}`
  try {
    if (provider !== 'lmstudio' && (await commandStatus(provider)).authenticated) {
      const output = await curateViaCli(provider, prompt, override)
      return { results: parseCuratedRanking(output, query, results), mode: 'ai', error: null, overview: '', plan: null, diagnostics: [] }
    }
    const output = await chatCompletion(provider, 'You are a fast, precise web search ranking model. Rank supplied candidates only.', prompt, override, { timeoutMs: 22_000, maxTokens: Math.min(700, 80 + results.length * 14), stage: 'rank', cacheable: true, stageOutcomes: override.stageOutcomes })
    return { results: parseCuratedRanking(output, query, results), mode: 'ai', error: null, overview: '', plan: null, diagnostics: [] }
  } catch (error) {
    return { results: heuristicRank(query, results), mode: 'heuristic', error: error.message, overview: '', plan: null, diagnostics: [{ provider, stage: 'ranking', message: error.message, severity: 'error' }] }
  }
}

async function generateSearchOverview(provider, query, results, override = {}) {
  const strongestSources = results.slice(0, 6)
  if (provider !== 'lmstudio' && (await commandStatus(provider)).authenticated) return synthesizeViaCli(provider, query, strongestSources)
  return synthesize(provider, query, strongestSources, override, '', { timeoutMs: 28_000, maxTokens: 650, stage: 'overview', cacheable: true, stageOutcomes: override.stageOutcomes })
}

async function synthesizeViaCli(provider, query, results, override = {}) {
  const context = results.map((item, index) => `[${index + 1}] ${item.pageTitle || item.title}\n${item.url}\n${(item.pageText || item.content).slice(0, 2_500)}`).join('\n\n')
  const prompt = `You are Lumen, a rigorous web research agent. Use only the supplied website evidence. Cite every substantive claim inline as [1], [2], do not invent sources, and state uncertainty. Return concise Markdown with exactly these headings: ## Executive synthesis, ## Key findings (three evidence-backed bullets), ## Detailed analysis, ## Limits.\n\nQuestion: ${query}\n\nWebsite sources:\n${context}`
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
    // Search has already gathered the evidence. Keep Grok's OAuth CLI in a
    // single, tool-free turn so it summarizes/ranks that evidence rather than
    // attempting an unrelated MCP/browser action.
    args = ['--model', override.model || modelRuntimes.grok.model, '--output-format', 'json', '--max-turns', '2', '--reasoning-effort', 'low', '--no-plan', '--no-subagents', '--disable-web-search', '--tools', '', '--verbatim', '--single', prompt]
  } else return ''
  const result = await runCommand(command, args)
  if (!result.ok) throw new Error(result.error || `${provider} CLI synthesis failed`)
  return extractCliText(provider, result.output).replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

async function curateViaCli(provider, prompt, override = {}) {
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
    args = ['--model', override.model || modelRuntimes.grok.model, '--output-format', 'json', '--max-turns', '2', '--reasoning-effort', 'low', '--no-plan', '--no-subagents', '--disable-web-search', '--tools', '', '--verbatim', '--single', prompt]
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
  if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/models') {
    const body = req.method === 'POST' ? await readBody(req) : {}
    const requestedProvider = body.provider || url.searchParams.get('provider')
    const provider = modelRuntimes[requestedProvider] ? requestedProvider : 'lmstudio'
    try {
      return json(res, 200, { provider, ...(await discoverModels(provider, body.endpoint || url.searchParams.get('endpoint') || undefined, typeof body.key === 'string' ? body.key : '')) })
    } catch (error) { return json(res, 200, { provider, models: [], error: error.message }) }
  }
  if (url.pathname === '/api/local-runtime/profile') {
    const body = req.method === 'GET' ? {} : await readBody(req)
    const endpoint = body.endpoint || url.searchParams.get('endpoint') || modelRuntimes.lmstudio.endpoint
    const model = body.model || url.searchParams.get('model') || modelRuntimes.lmstudio.model
    const key = localRuntimeKey(endpoint, model)
    if (req.method === 'DELETE') {
      localRuntimeProfiles.delete(key)
      for (const [cacheKey, cacheValue] of localStageCache) if (cacheValue.profileKey === key) localStageCache.delete(cacheKey)
      return json(res, 200, { cleared: true })
    }
    if (req.method === 'PUT') {
      const profile = ensureLocalProfile(endpoint, model, body.overrides || body.localRuntime || {})
      return json(res, 200, { profile: publicLocalProfile(profile) })
    }
    if (req.method === 'GET') return json(res, 200, { profile: publicLocalProfile(ensureLocalProfile(endpoint, model)) })
  }
  if (req.method === 'POST' && url.pathname === '/api/local-runtime/probe') {
    const body = await readBody(req)
    const result = await probeLocalRuntime(body.providerConfig || body)
    return json(res, result.error ? 400 : 200, result)
  }
  if (req.method === 'POST' && url.pathname === '/api/providers/test') {
    const body = await readBody(req)
    const provider = modelRuntimes[body.provider] ? body.provider : 'lmstudio'
    try {
      const reply = await chatCompletion(provider, 'You are a connection test. Reply with exactly: Lumen model connection confirmed.', 'Confirm this model connection.', body.providerConfig || {}, { stage: 'connection-test', stageOutcomes: [] })
      if (!reply.trim()) throw new Error('The model returned an empty response')
      const probe = provider === 'lmstudio' ? await probeLocalRuntime(body.providerConfig || {}) : null
      return json(res, 200, { ok: true, provider, model: body.providerConfig?.model || modelRuntimes[provider].model, reply: reply.slice(0, 300), runtime: probe?.profile || null, probeError: probe?.error || null })
    } catch (error) { return json(res, 400, { ok: false, provider, error: error.message }) }
  }
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
    const search = await searchRankedWindow(body.query.trim().slice(0, 500), Math.min(Number(body.maxResults) || 10, 10), body.baseUrl || searxngUrl, body.category || 'general', body.page, selectedProvider, body.providerConfig || {}, body.curate !== false, body.includeOverview !== false)
    return json(res, 200, search)
  }
  if (req.method === 'POST' && url.pathname === '/api/search/warm') {
    const body = await readBody(req)
    if (!body.query || typeof body.query !== 'string') return json(res, 400, { error: 'query is required' })
    const selectedProvider = modelRuntimes[body.provider] ? body.provider : 'lmstudio'
    const started = warmSearchCategories(body.query.trim().slice(0, 500), Math.min(Number(body.maxResults) || 10, 10), body.baseUrl || searxngUrl, selectedProvider, body.providerConfig || {})
    return json(res, 202, { started, categories: ['news', 'github', 'science', 'images', 'videos'] })
  }
  if (req.method === 'POST' && url.pathname === '/api/research') {
    const body = await readBody(req)
    if (!body.query || typeof body.query !== 'string') return json(res, 400, { error: 'query is required' })
    const selectedProvider = modelRuntimes[body.provider] ? body.provider : 'lmstudio'
    const originalQuery = body.query.trim().slice(0, 500)
    const stageOutcomes = []
    const providerConfig = { ...(body.providerConfig || {}), stageOutcomes }
    const [plan, search] = await Promise.all([
      planSearch(selectedProvider, originalQuery, body.category || 'general', body.depth === 'quick' ? 'quick' : 'deep', providerConfig),
      searchSearxng(originalQuery, body.depth === 'quick' ? 'quick' : 'deep', Math.min(Number(body.maxResults) || 10, 10), body.baseUrl || searxngUrl, body.category || 'general', body.page),
    ])
    const curation = await curateResults(selectedProvider, body.query, search.results, providerConfig, plan)
    const curatedSearch = { ...search, results: curation.results, curation: { mode: curation.mode, error: curation.error } }
    const pagePass = body.depth === 'quick' || !curatedSearch.results.length ? { results: curatedSearch.results, errors: [] } : await readTopSourcePages(curatedSearch.results, curatedSearch.results.length)
    const researchSearch = { ...curatedSearch, results: pagePass.results, errors: [...search.errors, ...pagePass.errors], pageReads: pagePass.results.filter((item) => item.pageText).length }
    let answer = ''
    let evidenceReview = ''
    let synthesisMode = 'api'
    const synthesisErrors = []
    if (researchSearch.results.length) {
      try { evidenceReview = await crossCheckEvidence(selectedProvider, body.query, researchSearch.results, providerConfig) }
      catch (error) { synthesisErrors.push({ provider: `${selectedProvider}:evidence-check`, message: error.message }) }
      if (selectedProvider !== 'lmstudio' && (await commandStatus(selectedProvider)).authenticated) {
        try {
          answer = await synthesizeViaCli(selectedProvider, body.query, researchSearch.results, providerConfig)
          if (answer) synthesisMode = 'oauth-cli'
        } catch (error) { synthesisErrors.push({ provider: `${selectedProvider}:oauth-cli`, message: error.message }) }
      }
      if (!answer) {
        try { answer = await synthesize(selectedProvider, body.query, researchSearch.results, providerConfig, evidenceReview, { stage: 'synthesis', cacheable: true, stageOutcomes }) }
        catch (error) { synthesisErrors.push({ provider: selectedProvider, message: error.message }) }
      }
    }
    const trace = [
      { step: 'Plan', status: plan.mode === 'ai' ? 'complete' : 'skipped', detail: plan.mode === 'ai' ? `AI planned the search around ${plan.focus || 'the requested intent'}.` : 'Model planning unavailable; searched the user query directly.' },
      { step: 'Query SearXNG', status: researchSearch.results.length ? 'complete' : 'error', detail: `Retrieved ${researchSearch.results.length} unique website results.` },
      { step: 'Read source pages', status: body.depth === 'quick' ? 'skipped' : researchSearch.pageReads ? 'complete' : 'skipped', detail: body.depth === 'quick' ? 'Quick search uses result snippets without page crawling.' : `Read ${researchSearch.pageReads} of ${researchSearch.results.length} curated source pages for evidence.` },
      { step: 'Rank sources', status: researchSearch.results.length ? (curation.mode === 'ai' ? 'complete' : 'skipped') : 'skipped', detail: curation.mode === 'ai' ? `AI-ranked all ${researchSearch.results.length} retrieved sources for the requested intent.` : `Model ranking unavailable; used transparent lexical fallback${curation.error ? '.' : ''}` },
      { step: 'Cross-check', status: evidenceReview ? 'complete' : 'skipped', detail: evidenceReview ? `AI checked ${researchSearch.results.length} sources for support and disagreement before synthesis.` : 'Model evidence check unavailable; synthesis is limited to retrieved sources.' },
      { step: 'Synthesize', status: answer ? 'complete' : 'error', detail: answer ? `Synthesized with ${selectedProvider}${synthesisMode === 'oauth-cli' ? ' OAuth session' : ''}.` : 'No model synthesis was produced.' },
    ]
    const runtime = selectedProvider === 'lmstudio' ? publicLocalProfile(ensureLocalProfile(providerConfig.endpoint || modelRuntimes.lmstudio.endpoint, providerConfig.model || modelRuntimes.lmstudio.model, providerConfig.localRuntime || {})) : null
    const diagnostics = [...(curation.diagnostics || []), ...synthesisErrors.map((item) => ({ provider: item.provider, stage: 'research', message: item.message, severity: 'error' }))]
    return json(res, 200, { query: body.query, provider: selectedProvider, synthesisMode, plan, evidenceReview, search: { ...researchSearch, errors: [...researchSearch.errors, ...synthesisErrors], curation: { mode: curation.mode, error: curation.error, warning: curation.warning || null } }, trace, stages: stageOutcomes, runtime, diagnostics, answer: answer || (researchSearch.results.length ? `Research retrieved ${researchSearch.results.length} sources, but ${selectedProvider} could not synthesize them. Check the provider endpoint, model, or server-side credentials.` : 'SearXNG did not return sources. Check the SearXNG URL and JSON format configuration, then try again.') })
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
