import { useEffect, useMemo, useState } from 'react'
import Activity from 'lucide-react/dist/esm/icons/activity.mjs'
import ArrowUpRight from 'lucide-react/dist/esm/icons/arrow-up-right.mjs'
import Check from 'lucide-react/dist/esm/icons/check.mjs'
import Copy from 'lucide-react/dist/esm/icons/copy.mjs'
import ChevronDown from 'lucide-react/dist/esm/icons/chevron-down.mjs'
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right.mjs'
import CircleHelp from 'lucide-react/dist/esm/icons/circle-help.mjs'
import FileText from 'lucide-react/dist/esm/icons/file-text.mjs'
import Folder from 'lucide-react/dist/esm/icons/folder.mjs'
import Globe2 from 'lucide-react/dist/esm/icons/globe-2.mjs'
import Link2 from 'lucide-react/dist/esm/icons/link-2.mjs'
import Menu from 'lucide-react/dist/esm/icons/menu.mjs'
import Mic from 'lucide-react/dist/esm/icons/mic.mjs'
import MoreHorizontal from 'lucide-react/dist/esm/icons/more-horizontal.mjs'
import Paperclip from 'lucide-react/dist/esm/icons/paperclip.mjs'
import PlugZap from 'lucide-react/dist/esm/icons/plug-zap.mjs'
import Plus from 'lucide-react/dist/esm/icons/plus.mjs'
import RefreshCw from 'lucide-react/dist/esm/icons/refresh-cw.mjs'
import Search from 'lucide-react/dist/esm/icons/search.mjs'
import Send from 'lucide-react/dist/esm/icons/send.mjs'
import Settings from 'lucide-react/dist/esm/icons/settings.mjs'
import Sparkles from 'lucide-react/dist/esm/icons/sparkles.mjs'
import Square from 'lucide-react/dist/esm/icons/square.mjs'
import Split from 'lucide-react/dist/esm/icons/split.mjs'
import X from 'lucide-react/dist/esm/icons/x.mjs'

type Mode = 'Web search' | 'Quick answer' | 'Deep research' | 'Explore'
type SearchCategory = 'general' | 'news' | 'images' | 'videos' | 'github' | 'science'
type Provider = { id: string; name: string; model: string; endpoint: string; kind: string; connected: boolean; authPending?: boolean; color: string; apiKey?: string }
type ModelOption = { id: string; label: string; architecture?: string | null; quantization?: string | null }
type Preferences = { defaultMode: Mode; warmTabs: boolean; showOverview: boolean; resultDensity: 'comfortable' | 'compact' }

const providerModelSuggestions: Record<string, ModelOption[]> = {
  openai: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }, { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' }, { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' }, { id: 'gpt-5.6', label: 'GPT-5.6 (latest alias)' }],
  minimax: [{ id: 'MiniMax-M3', label: 'MiniMax M3' }, { id: 'MiniMax-M2.7', label: 'MiniMax M2.7' }, { id: 'MiniMax-M2.7-highspeed', label: 'MiniMax M2.7 Highspeed' }, { id: 'MiniMax-M2.5', label: 'MiniMax M2.5' }, { id: 'MiniMax-M2.5-highspeed', label: 'MiniMax M2.5 Highspeed' }, { id: 'MiniMax-M2.1', label: 'MiniMax M2.1' }, { id: 'MiniMax-M2.1-highspeed', label: 'MiniMax M2.1 Highspeed' }, { id: 'MiniMax-M2', label: 'MiniMax M2' }, { id: 'M2-her', label: 'MiniMax M2-her' }],
  grok: [{ id: 'grok-4.5', label: 'Grok 4.5' }, { id: 'grok-4.5-latest', label: 'Grok 4.5 (latest alias)' }, { id: 'grok-build-0.1', label: 'Grok Build 0.1' }, { id: 'grok-build-latest', label: 'Grok Build (latest alias)' }, { id: 'grok-4.3', label: 'Grok 4.3' }, { id: 'grok-4.20-0309-reasoning', label: 'Grok 4.20 Reasoning' }, { id: 'grok-4.20-reasoning-latest', label: 'Grok 4.20 Reasoning (latest alias)' }, { id: 'grok-4.20-0309-non-reasoning', label: 'Grok 4.20 Non-reasoning' }, { id: 'grok-4.20-non-reasoning-latest', label: 'Grok 4.20 Non-reasoning (latest alias)' }, { id: 'grok-4.20-multi-agent-0309', label: 'Grok 4.20 Multi-agent' }, { id: 'grok-4.20-multi-agent-latest', label: 'Grok 4.20 Multi-agent (latest alias)' }],
}

type WebMCPTool = { name: string; description: string; inputSchema: Record<string, unknown>; execute: (args: Record<string, unknown>) => Promise<unknown> }
type WebMCPContext = { registerTool: (tool: WebMCPTool, options?: { signal?: AbortSignal }) => Promise<unknown> }

const initialProviders: Provider[] = [
  { id: 'lmstudio', name: 'LM Studio', model: 'Qwen 3 30B', endpoint: 'http://localhost:1234/v1', kind: 'Local', connected: true, color: '#7b6af0' },
  { id: 'openai', name: 'OpenAI', model: 'GPT-5', endpoint: 'https://api.openai.com/v1', kind: 'OAuth', connected: false, color: '#9ac9b7' },
  { id: 'minimax', name: 'MiniMax', model: 'MiniMax-M2.7', endpoint: 'https://api.minimax.io/v1', kind: 'OAuth', connected: false, color: '#e3a457' },
  { id: 'grok', name: 'Grok / xAI', model: 'grok-4.5', endpoint: 'https://api.x.ai/v1', kind: 'OAuth', connected: false, color: '#b7c2d5' },
]

function loadSavedProviders() {
  try {
    const saved = JSON.parse(localStorage.getItem('lumen-providers') || '[]')
    if (!Array.isArray(saved)) return initialProviders
    return initialProviders.map((provider) => {
      const persisted = saved.find((item: Provider) => item?.id === provider.id)
      return persisted ? { ...provider, ...persisted } : provider
    })
  } catch { return initialProviders }
}

const defaultPreferences: Preferences = { defaultMode: 'Web search', warmTabs: true, showOverview: true, resultDensity: 'comfortable' }
function loadPreferences(): Preferences {
  try {
    const saved = JSON.parse(localStorage.getItem('lumen-preferences') || '{}')
    return { ...defaultPreferences, ...saved }
  } catch { return defaultPreferences }
}

type SearchSource = { n: string; title: string; domain: string; date: string; url?: string; snippet?: string; aiScore?: number; aiReason?: string; pageRead?: boolean; category?: string; thumbnail?: string; imgSrc?: string; iframeSrc?: string; source?: string; resolution?: string; length?: string; author?: string; metadata?: string }
type SearchSession = { id: string; query: string; createdAt: string; sources: SearchSource[]; answer: string }
type TraceStep = { step: string; status: string; detail: string }
function normalizeSources(results: Array<{ title: string; url: string; content?: string; pageText?: string; publishedDate?: string; aiScore?: number; aiReason?: string; category?: string; thumbnail?: string; imgSrc?: string; iframeSrc?: string; source?: string; resolution?: string; length?: string; author?: string; metadata?: string }>, page = 1): SearchSource[] {
  return results.flatMap((item, index) => {
    try {
      return [{ n: String((page - 1) * 10 + index + 1), title: item.title, domain: new URL(item.url).hostname, date: item.publishedDate || 'Retrieved just now', url: item.url, snippet: item.content, aiScore: item.aiScore, aiReason: item.aiReason, pageRead: Boolean(item.pageText), category: item.category, thumbnail: item.thumbnail, imgSrc: item.imgSrc, iframeSrc: item.iframeSrc, source: item.source, resolution: item.resolution, length: item.length, author: item.author, metadata: item.metadata }]
    } catch { return [] }
  })
}

function cleanMarkdown(value: string) {
  return value.replace(/^#{1,6}\s*/gm, '').replace(/^[-*]\s+/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\n{2,}/g, '\n\n').trim()
}

function App() {
  const [view, setView] = useState<'search' | 'research' | 'library' | 'providers' | 'settings'>('search')
  const [mode, setMode] = useState<Mode>('Web search')
  const [providers, setProviders] = useState(loadSavedProviders)
  const [preferences, setPreferences] = useState<Preferences>(loadPreferences)
  const [selectedProvider, setSelectedProvider] = useState(() => {
    const saved = localStorage.getItem('lumen-default-provider')
    return saved && initialProviders.some((provider) => provider.id === saved) ? saved : 'lmstudio'
  })
  const [searchCategory, setSearchCategory] = useState<SearchCategory>('general')
  const [searchEndpoint, setSearchEndpoint] = useState(() => localStorage.getItem('lumen-search-endpoint') || 'http://127.0.0.1:8080')
  const [searchStatus, setSearchStatus] = useState('')
  const [availableModels, setAvailableModels] = useState<Record<string, ModelOption[]>>({})
  const [modelStatus, setModelStatus] = useState<Record<string, string>>({})
  const [query, setQuery] = useState('')
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [step, setStep] = useState(4)
  const [resultsPage, setResultsPage] = useState(1)
  const [hasMoreResults, setHasMoreResults] = useState(true)
  const [curationMode, setCurationMode] = useState<'ai' | 'heuristic' | 'disabled' | 'none'>('none')
  const [overviewExpanded, setOverviewExpanded] = useState(false)
  const [sourceList, setSourceList] = useState<SearchSource[]>([])
  const [answer, setAnswer] = useState('')
  const [history, setHistory] = useState<SearchSession[]>(() => { try { return JSON.parse(localStorage.getItem('lumen-history') || '[]') } catch { return [] } })
  const [apiError, setApiError] = useState('')
  const [traceSteps, setTraceSteps] = useState<TraceStep[]>([])
  const [showMode, setShowMode] = useState(false)
  const [showProvider, setShowProvider] = useState(false)
  const [mobileNav, setMobileNav] = useState(false)
  const [selectedImage, setSelectedImage] = useState<SearchSource | null>(null)

  const provider = providers.find((item) => item.id === selectedProvider) ?? providers[0]
  const activeModelOptions = availableModels[provider.id]?.length ? availableModels[provider.id] : providerModelSuggestions[provider.id] || []
  const activeModelMissing = !activeModelOptions.some((item) => item.id === provider.model)
  const isEmptySearch = view === 'search' && !query && !running && sourceList.length === 0
  const isEmptyResearch = view === 'research' && !query && !running && sourceList.length === 0

  useEffect(() => {
    let cancelled = false
    Promise.all(initialProviders.filter((item) => item.id !== 'lmstudio').map(async (item) => {
      try {
        const response = await fetch(`/api/cli-auth/${item.id}`)
        const payload = await response.json()
        return { id: item.id, authenticated: Boolean(payload.authenticated) }
      } catch { return { id: item.id, authenticated: false } }
    })).then((statuses) => {
      if (cancelled) return
      setProviders((current) => current.map((item) => {
        const status = statuses.find((entry) => entry.id === item.id)
        return status ? { ...item, connected: status.authenticated, authPending: status.authenticated ? false : item.authPending } : item
      }))
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => localStorage.setItem('lumen-providers', JSON.stringify(providers.map(({ apiKey: _apiKey, ...saved }) => saved))), [providers])
  useEffect(() => localStorage.setItem('lumen-default-provider', selectedProvider), [selectedProvider])
  useEffect(() => localStorage.setItem('lumen-search-endpoint', searchEndpoint), [searchEndpoint])
  useEffect(() => localStorage.setItem('lumen-history', JSON.stringify(history.slice(0, 20))), [history])
  useEffect(() => localStorage.setItem('lumen-preferences', JSON.stringify(preferences)), [preferences])

  const discoverProviderModels = async (id: string) => {
    const target = providers.find((item) => item.id === id)
    if (!target) return
    setModelStatus((current) => ({ ...current, [id]: 'Loading models…' }))
    try {
      const response = await fetch('/api/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: id, endpoint: target.endpoint, key: target.apiKey }) })
      const payload = await response.json()
      if (!response.ok || payload.error) throw new Error(payload.error || 'Model discovery failed')
      const models = Array.isArray(payload.models) ? payload.models : []
      setAvailableModels((current) => ({ ...current, [id]: models }))
      setModelStatus((current) => ({ ...current, [id]: models.length ? `${models.length} model${models.length === 1 ? '' : 's'} available` : 'No language models found' }))
      if (models.length && !models.some((model: ModelOption) => model.id === target.model)) updateProvider(id, 'model', models[0].id)
    } catch (error) { setModelStatus((current) => ({ ...current, [id]: error instanceof Error ? error.message : 'Could not load models' })) }
  }

  const testProviderModel = async (id: string) => {
    const target = providers.find((item) => item.id === id)
    if (!target) return
    setModelStatus((current) => ({ ...current, [id]: 'Testing model connection…' }))
    try {
      const response = await fetch('/api/providers/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: id, providerConfig: { endpoint: target.endpoint, model: target.model, key: target.apiKey } }) })
      const payload = await response.json()
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'Model connection failed')
      setModelStatus((current) => ({ ...current, [id]: `Connected · ${payload.model} answered` }))
    } catch (error) { setModelStatus((current) => ({ ...current, [id]: error instanceof Error ? error.message : 'Model connection failed' })) }
  }

  useEffect(() => { discoverProviderModels('lmstudio') }, [])

  useEffect(() => {
    const modelContext = (document as Document & { modelContext?: WebMCPContext }).modelContext
    if (!modelContext) return
    const controller = new AbortController()
    void modelContext.registerTool({
      name: 'search_lumen_web',
      description: 'Search the web through Lumen and return ranked website results from SearXNG. Use this for websites, news, images, videos, GitHub, or academic sources.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'The search query.' }, category: { type: 'string', enum: ['general', 'news', 'images', 'videos', 'github', 'science'], description: 'Optional result category.' }, maxResults: { type: 'number', minimum: 1, maximum: 10, description: 'Number of results to return.' } }, required: ['query'] },
      async execute(args) {
        const response = await fetch('/api/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: String(args.query || '').slice(0, 500), category: args.category || 'general', maxResults: Math.min(Math.max(Number(args.maxResults) || 10, 1), 10), curate: false, includeOverview: false, baseUrl: searchEndpoint }) })
        const payload = await response.json()
        if (!response.ok) throw new Error(payload.error || 'Lumen search failed')
        return { content: [{ type: 'text', text: JSON.stringify({ query: payload.query, category: payload.category, results: (payload.results || []).map((item: { title: string; url: string; content?: string; publishedDate?: string }) => ({ title: item.title, url: item.url, snippet: item.content || '', publishedDate: item.publishedDate || null })) }) }] }
      },
    }, { signal: controller.signal }).catch(() => {})
    return () => controller.abort()
  }, [searchEndpoint])

  const warmSearchTabs = (nextQuery: string) => {
    void fetch('/api/search/warm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: nextQuery, baseUrl: searchEndpoint, maxResults: 10, provider: selectedProvider, providerConfig: { endpoint: provider.endpoint, model: provider.model, key: provider.apiKey } }) }).catch(() => {})
  }

  const runResearch = async (nextQuery = query, nextCategory = searchCategory, execution: { mode?: Mode; view?: 'search' | 'research' } = {}) => {
    if (!nextQuery.trim()) return
    const activeMode = execution.mode || mode
    const activeView = execution.view || view
    setQuery(nextQuery)
    setRunning(true)
    setStep(0)
    setResultsPage(1)
    setApiError('')
    setOverviewExpanded(false)
    if (preferences.warmTabs && activeView === 'search' && nextCategory === 'general') warmSearchTabs(nextQuery)
    let current = 0
    const timer = window.setInterval(() => { current += 1; setStep(Math.min(current, 5)); if (current >= 5) window.clearInterval(timer) }, 600)
    try {
      const isDeep = activeMode === 'Deep research' || activeMode === 'Explore' || activeView === 'research'
      const endpoint = activeView === 'research' ? '/api/research' : '/api/search'
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: nextQuery, provider: selectedProvider, providerConfig: { endpoint: provider.endpoint, model: provider.model, key: provider.apiKey }, baseUrl: searchEndpoint, category: nextCategory, depth: isDeep ? 'deep' : 'quick', maxResults: activeMode === 'Quick answer' ? 5 : 10, page: 1, includeOverview: preferences.showOverview && nextCategory === 'general' }) })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || 'Research request failed')
      const normalized = normalizeSources(payload.search?.results || payload.results || [], 1)
      setSourceList(normalized)
      setHasMoreResults(Boolean(payload.search?.hasMore ?? payload.hasMore))
      setCurationMode(payload.search?.curation?.mode || payload.curation?.mode || 'none')
      const curationError = payload.search?.curation?.error || payload.curation?.error
      if (curationError && selectedProvider === 'lmstudio') setApiError(`LM Studio was not used for this search: ${curationError}`)
      setAnswer(payload.answer || (nextCategory === 'news' ? `Latest news results for “${nextQuery}”.` : nextCategory === 'images' ? `Image results for “${nextQuery}”.` : nextCategory === 'videos' ? `Video results for “${nextQuery}”.` : nextCategory === 'github' ? `GitHub repositories for “${nextQuery}”.` : nextCategory === 'science' ? `Academic and technical results for “${nextQuery}”.` : `Found ${normalized.length} ${payload.curation?.mode === 'ai' ? 'AI-curated' : 'relevance-ranked'} web results for “${nextQuery}”. Review the overview and sources below, or switch to Deep research for a cited synthesis.`))
      if (payload.trace) setTraceSteps(payload.trace); else setTraceSteps([])
      if (normalized.length) setHistory((current) => [{ id: crypto.randomUUID(), query: nextQuery, createdAt: new Date().toISOString(), sources: normalized, answer: payload.answer || '' }, ...current.filter((item) => item.query !== nextQuery)].slice(0, 20))
      setStep(5)
    } catch (error) {
      setApiError(error instanceof Error ? error.message : 'Research API unavailable. Start `npm run dev:api`.')
    } finally {
      window.clearInterval(timer)
      setRunning(false)
    }
  }

  const loadResultsPage = async (page: number) => {
    if (page < 1 || running || (page > resultsPage && !hasMoreResults)) return
    setRunning(true)
    setApiError('')
    try {
      const response = await fetch('/api/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, baseUrl: searchEndpoint, category: searchCategory, depth: 'quick', maxResults: 10, page, provider: selectedProvider, providerConfig: { endpoint: provider.endpoint, model: provider.model, key: provider.apiKey }, curate: true, includeOverview: false }) })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || 'Search results request failed')
      setSourceList(normalizeSources(payload.results || [], page))
      setResultsPage(page)
      setHasMoreResults(Boolean(payload.hasMore))
      setCurationMode(payload.curation?.mode || 'none')
      document.querySelector('.results-scroller')?.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (error) {
      setApiError(error instanceof Error ? error.message : 'Could not load this page of results')
    } finally { setRunning(false) }
  }

  const connectProvider = async (id: string) => {
    if (id !== 'lmstudio') {
      try {
        const response = await fetch(`/api/cli-auth/${id}/login`, { method: 'POST' })
        const payload = await response.json()
        if (!payload.started) throw new Error(payload.message || 'OAuth CLI is unavailable')
      } catch (error) { setApiError(error instanceof Error ? error.message : 'OAuth bridge unavailable. Start `npm run dev:api`.'); return }
    }
    setProviders((current) => current.map((item) => item.id === id ? { ...item, authPending: true } : item))
    setSelectedProvider(id)
  }

  const checkProvider = async (id: string) => {
    try {
      const response = await fetch(`/api/cli-auth/${id}`)
      const payload = await response.json()
      if (!payload.authenticated) throw new Error(payload.message || 'OAuth session is not authenticated yet')
      setProviders((current) => current.map((item) => item.id === id ? { ...item, connected: true, authPending: false } : item))
      setApiError('')
    } catch (error) { setApiError(error instanceof Error ? error.message : 'Could not inspect the local OAuth session') }
  }

  const updateProvider = (id: string, field: 'endpoint' | 'model' | 'apiKey', value: string) => setProviders((current) => current.map((item) => item.id === id ? { ...item, [field]: value } : item))

  const exportResearch = () => {
    const documentText = `${answerTitle}\n\n${cleanMarkdown(answer)}\n\nSources\n${sourceList.map((source) => `- ${source.title}: ${source.url || source.domain}`).join('\n')}`
    const blob = new Blob([documentText], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${answerTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'lumen-research'}.md`
    link.click()
    URL.revokeObjectURL(url)
  }

  const testSearchEndpoint = async () => {
    setSearchStatus('Testing…')
    try {
      const response = await fetch(`/api/search/health?baseUrl=${encodeURIComponent(searchEndpoint)}`)
      const payload = await response.json()
      if (!response.ok || !payload.ok) throw new Error(payload.error || payload.errors?.[0]?.message || 'SearXNG did not respond with JSON')
      setSearchStatus(`Connected · ${payload.resultCount} result`)
    } catch (error) { setSearchStatus(error instanceof Error ? error.message : 'SearXNG connection failed') }
  }

  const answerTitle = useMemo(() => query || 'Start a new research thread', [query])
  const openHistory = (session: SearchSession) => { setQuery(session.query); setSourceList(session.sources); setAnswer(session.answer); setResultsPage(1); setHasMoreResults(true); setView('search') }
  const newSearch = () => { const nextMode = preferences.defaultMode; setView(nextMode === 'Deep research' || nextMode === 'Explore' ? 'research' : 'search'); setMode(nextMode); setQuery(''); setInput(''); setSourceList([]); setAnswer(''); setTraceSteps([]); setApiError(''); setResultsPage(1); setHasMoreResults(true); setCurationMode('none'); setRunning(false) }
  const selectMode = (nextMode: Mode) => {
    const nextView = nextMode === 'Deep research' || nextMode === 'Explore' ? 'research' : 'search'
    setMode(nextMode)
    setView(nextView)
    setShowMode(false)
    if (query) void runResearch(query, searchCategory, { mode: nextMode, view: nextView })
  }
  const shareResearch = async () => {
    const shareData = { title: answerTitle, text: cleanMarkdown(answer) }
    if (navigator.share) { await navigator.share(shareData); return }
    await navigator.clipboard?.writeText(`${shareData.title}\n\n${shareData.text}`)
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
        <div className="brand"><div className="brand-mark"><Sparkles size={18} /></div><span>Lumen</span></div>
        <nav>
          <NavItem icon={<Search size={19} />} label="Search" active={view === 'search'} onClick={() => { setView('search'); setMode('Web search'); setMobileNav(false) }} />
          <NavItem icon={<Split size={19} />} label="Research" active={view === 'research'} onClick={() => { setView('research'); setMode('Deep research'); setMobileNav(false) }} />
          <NavItem icon={<Folder size={19} />} label="Library" active={view === 'library'} onClick={() => { setView('library'); setMobileNav(false) }} />
          <NavItem icon={<PlugZap size={19} />} label="Providers" active={view === 'providers'} onClick={() => { setView('providers'); setMobileNav(false) }} />
          <NavItem icon={<Settings size={19} />} label="Settings" active={view === 'settings'} onClick={() => { setView('settings'); setMobileNav(false) }} />
        </nav>
        <button className="new-search-button" onClick={newSearch}><Plus size={17} /> New search</button>
        <div className="sidebar-bottom">
          <div className="status-line"><span className="status-dot" /> <span><b>System status</b><small>All systems operational</small></span><ChevronRight size={16} /></div>
          <div className="sidebar-meta"><span>v0.1.0</span><span>Local-first</span></div>
        </div>
      </aside>

      <main className={`main-shell ${view === 'search' ? 'search-shell' : ''} ${view === 'research' ? 'research-shell' : ''} ${isEmptySearch ? 'empty-search' : ''}`}>
        <header className="topbar">
          <button className="mobile-menu icon-button" onClick={() => setMobileNav(!mobileNav)} aria-label="Open navigation"><Menu size={20} /></button>
          <div className="topbar-group">
            <div className="select-wrap">
              <button className="select-button" onClick={() => setShowMode(!showMode)}><span className="round-icon"><Split size={15} /></span>{mode}<ChevronDown size={16} /></button>
              {showMode && <Dropdown items={['Web search', 'Quick answer', 'Deep research', 'Explore']} onSelect={(item) => selectMode(item as Mode)} />}
            </div>
          </div>
          <div className="topbar-actions">
            <div className="select-wrap provider-select">
              <button className="select-button provider-button" onClick={() => setShowProvider(!showProvider)}><ProviderIcon provider={provider} />{provider.name}<ChevronDown size={16} /></button>
              {showProvider && <Dropdown custom items={providers.map((item) => `${item.name} • ${item.model}`)} onSelect={(item) => { const found = providers.find((p) => `${p.name} • ${p.model}` === item); if (found) setSelectedProvider(found.id); setShowProvider(false) }} />}
            </div>
            <label className="topbar-model-picker"><span>Model</span><select aria-label="Active search model" value={provider.model} onChange={(event) => updateProvider(provider.id, 'model', event.target.value)}>{activeModelMissing && <option value={provider.model}>{provider.model} (current)</option>}{activeModelOptions.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
            <button className="icon-button gear" onClick={() => setView('settings')} aria-label="Settings"><Settings size={18} /></button>
            <button className="avatar-button" aria-label="Account">AV <ChevronDown size={14} /></button>
          </div>
        </header>

        {view === 'providers' ? <ProvidersView providers={providers} selected={selectedProvider} onSelect={setSelectedProvider} onConnect={connectProvider} onCheck={checkProvider} onUpdateProvider={updateProvider} availableModels={availableModels} modelStatus={modelStatus} onDiscoverModels={discoverProviderModels} onTestModel={testProviderModel} searchEndpoint={searchEndpoint} onSearchEndpointChange={setSearchEndpoint} searchStatus={searchStatus} onTestSearch={testSearchEndpoint} /> : view === 'settings' ? <SettingsView preferences={preferences} onUpdate={(field, value) => setPreferences((current) => ({ ...current, [field]: value }))} onReset={() => setPreferences(defaultPreferences)} onClearHistory={() => { if (window.confirm('Clear all saved searches from this browser?')) setHistory([]) }} onOpenProviders={() => setView('providers')} /> : view === 'library' ? <LibraryView history={history} onOpen={openHistory} /> : (
          <div className={`workspace ${view === 'search' ? 'web-search-workspace' : ''} ${view === 'research' ? 'research-workspace' : ''} ${preferences.resultDensity === 'compact' ? 'compact-results' : ''}`}>
            {isEmptySearch ? <EmptySearch input={input} mode={mode} onInput={setInput} onModeChange={selectMode} onSearch={(nextQuery) => { runResearch(nextQuery); setInput('') }} /> : isEmptyResearch ? <ResearchStart input={input} onInput={setInput} onSearch={(nextQuery) => { runResearch(nextQuery); setInput('') }} /> : <section className="answer-canvas">
              <div className="canvas-inner">
                <div className="eyebrow-row"><span className="eyebrow"><Activity size={13} /> {running ? 'Researching' : 'Research complete'}</span><button className="quiet-button" onClick={shareResearch}><Link2 size={14} /> Share</button></div>
                <h1>{answerTitle}</h1>
                {view === 'research' ? <><div className="research-thread-head"><div><span>Deep research</span><h2>{answerTitle}</h2></div><div className="research-thread-tools"><button onClick={() => navigator.clipboard?.writeText(answer)} aria-label="Copy research"><Copy size={16} /></button><button onClick={shareResearch} aria-label="Share research"><Link2 size={16} /></button><button aria-label="More research actions" disabled title="More research actions are coming soon"><MoreHorizontal size={18} /></button></div></div><div className="research-layout"><article className="research-brief"><ResearchAnswer answer={answer} sources={sourceList} /></article><aside className="evidence-rail"><div className="evidence-rail-head"><strong>Evidence sources</strong><span>{sourceList.filter((source) => source.pageRead).length} read</span></div>{sourceList.map((source) => <EvidenceRow key={source.n} source={source} />)}</aside></div>{apiError && <div className="research-error"><CircleHelp size={15} /> {apiError}</div>}<TracePanel compact running={running} step={step} trace={traceSteps} /><div className="research-actions"><button onClick={() => navigator.clipboard?.writeText(answer)}><Copy size={15} /> Copy</button><button onClick={() => runResearch(query)}><RefreshCw size={15} /> Regenerate</button><button onClick={shareResearch}><Link2 size={15} /> Share</button><button onClick={exportResearch}><ArrowUpRight size={15} /> Export</button></div></> : <>{preferences.showOverview && <SearchOverview answer={answer} sources={sourceList} expanded={overviewExpanded} onToggle={() => setOverviewExpanded(!overviewExpanded)} />}<TracePanel compact running={running} step={step} trace={traceSteps} /><div className="search-filters" role="tablist" aria-label="Search scope">{([['general', 'Web'], ['news', 'News'], ['images', 'Images'], ['videos', 'Videos'], ['github', 'GitHub'], ['science', 'Academic']] as const).map(([value, label]) => <button key={value} className={searchCategory === value ? 'selected' : ''} onClick={() => { setSearchCategory(value); runResearch(query, value) }} role="tab" aria-selected={searchCategory === value}>{label}</button>)}</div><div className="results-scroller"><div className="sources-heading"><span>{searchCategory === 'github' ? 'GitHub results' : searchCategory === 'images' ? 'Image results' : searchCategory === 'videos' ? 'Video results' : searchCategory === 'news' ? 'Latest news' : 'Search results'}</span><span className={`source-count curation-status ${curationMode}`}>{running ? 'Gathering typed results…' : `${curationMode === 'ai' ? 'AI-curated' : curationMode === 'heuristic' ? 'Relevance-ranked' : 'Retrieved'} · Page ${resultsPage} · ${sourceList.length} results`}</span></div>{apiError && <div className="research-error"><CircleHelp size={15} /> {apiError}</div>}{searchCategory === 'images' ? <ImageResults sources={sourceList} onSelect={setSelectedImage} /> : searchCategory === 'videos' ? <VideoResults sources={sourceList} /> : <div className="source-list">{sourceList.map((source) => <SourceRow key={source.n} source={source} />)}</div>}</div><ResultPagination page={resultsPage} hasMore={hasMoreResults} running={running} onPage={loadResultsPage} />{selectedImage && <ImageLightbox source={selectedImage} onClose={() => setSelectedImage(null)} />}</>}
              </div>
            </section>}
          </div>
        )}

        {view !== 'providers' && view !== 'settings' && view !== 'library' && !isEmptySearch && !isEmptyResearch && <form className={`composer ${view === 'research' ? 'research-composer' : ''}`} onSubmit={(event) => { event.preventDefault(); if (input.trim()) { runResearch(input); setInput('') } }}>
          <button type="button" className="attach-button" aria-label="Attach a file" disabled title="File search is not configured yet"><Paperclip size={19} /></button>
          <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (input.trim()) { runResearch(input); setInput('') } } }} placeholder="Ask a follow-up or refine the research..." rows={1} />
          <div className="composer-footer">{view === 'research' ? <div className="composer-options"><button type="button"><Globe2 size={14} /> Web</button><button type="button" className="selected"><Sparkles size={14} /> Deep research</button></div> : <span>Press Enter to send&nbsp; · &nbsp;Shift+Enter for new line</span>}<div className="composer-send-actions">{view === 'research' && <button type="button" className="composer-mic" aria-label="Voice input" disabled title="Voice input is not configured yet"><Mic size={18} /></button>}{running && <button type="button" className="composer-stop" onClick={() => setRunning(false)}><Square size={13} /> Stop</button>}<button className="send-button" aria-label="Send research query"><Send size={19} /></button></div></div>
        </form>}
      </main>
    </div>
  )
}

function NavItem({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) { return <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}>{icon}<span>{label}</span></button> }
function ProviderIcon({ provider }: { provider: Provider }) { return <span className="provider-icon" style={{ background: provider.color }}>{provider.id === 'lmstudio' ? <Sparkles size={14} /> : provider.name.charAt(0)}</span> }
function Dropdown({ items, onSelect, custom = false }: { items: string[]; onSelect: (item: string) => void; custom?: boolean }) { return <div className="dropdown">{items.map((item) => <button key={item} onClick={() => onSelect(item)}>{custom && <span className="tiny-dot" />} {item}</button>)}</div> }
function SourceRow({ source }: { source: SearchSource }) {
  return <a className="source-row" href={source.url || '#'} target={source.url ? '_blank' : undefined} rel="noreferrer">
    <div className="result-topline"><span className="result-index">{source.n}</span><Favicon url={source.url} /><span className="result-domain">{source.source || source.domain}</span><span className="result-kind">{source.category === 'news' ? 'News' : 'Web'}</span>{source.category === 'news' && <time>{source.date}</time>}<ArrowUpRight size={15} /></div>
    <strong>{source.title}</strong>
    {source.snippet && <em>{source.snippet}</em>}
    {source.aiReason && <span className="curation-reason"><Sparkles size={13} /> {source.aiReason}{typeof source.aiScore === 'number' && <b>{source.aiScore}% match</b>}</span>}
  </a>
}

function ImageResults({ sources, onSelect }: { sources: SearchSource[]; onSelect: (source: SearchSource) => void }) {
  return <div className="image-results-grid">{sources.map((source) => <button className="image-result-card" key={source.n} onClick={() => onSelect(source)}><img src={source.thumbnail || source.imgSrc || ''} alt={source.title} loading="lazy" onError={(event) => { event.currentTarget.parentElement?.classList.add('image-missing') }} /><span className="image-result-copy"><strong>{source.title}</strong><small>{source.source || source.domain}{source.resolution ? ` · ${source.resolution}` : ''}</small></span></button>)}</div>
}

function ImageLightbox({ source, onClose }: { source: SearchSource; onClose: () => void }) {
  return <div className="image-lightbox" role="dialog" aria-modal="true" aria-label="Image details" onClick={onClose}><section onClick={(event) => event.stopPropagation()}><button className="image-lightbox-close" onClick={onClose} aria-label="Close image details"><X size={19} /></button><img src={source.imgSrc || source.thumbnail || ''} alt={source.title} /><div><span>{source.source || source.domain}</span><h2>{source.title}</h2><p>{source.snippet}</p>{source.resolution && <small>{source.resolution}</small>}<a href={source.url} target="_blank" rel="noreferrer">Open source <ArrowUpRight size={15} /></a></div></section></div>
}

function VideoResults({ sources }: { sources: SearchSource[] }) {
  return <div className="video-results-grid">{sources.map((source) => <a className="video-result-card" key={source.n} href={source.url || '#'} target="_blank" rel="noreferrer"><div className="video-thumbnail">{source.thumbnail ? <img src={source.thumbnail} alt="" loading="lazy" /> : <span><Globe2 size={24} /></span>}<i>▶</i>{source.length && <b>{source.length}</b>}</div><strong>{source.title}</strong><small>{source.author || source.source || source.domain}{source.metadata ? ` · ${source.metadata}` : ''}</small><p>{source.snippet}</p></a>)}</div>
}

function Favicon({ url }: { url?: string }) {
  const origin = url ? (() => { try { return new URL(url).origin } catch { return '' } })() : ''
  return origin ? <img className="result-favicon" src={`${origin}/favicon.ico`} alt="" onError={(event) => { event.currentTarget.style.display = 'none' }} /> : <span className="result-favicon fallback"><Globe2 size={13} /></span>
}

function EmptySearch({ input, mode, onInput, onModeChange, onSearch }: { input: string; mode: Mode; onInput: (value: string) => void; onModeChange: (mode: Mode) => void; onSearch: (query: string) => void }) {
  const suggestions = [
    'What are the most useful open-source AI tools right now?',
    'How does a search engine decide which website to rank first?',
    'Find a practical weekend itinerary for New York City.',
  ]
  const submit = (event: React.FormEvent) => { event.preventDefault(); if (input.trim()) onSearch(input.trim()) }
  return <section className="empty-search-canvas"><div className="empty-search-inner"><h1>Hi Duckets, what would you like to search?</h1><div className="empty-mode-tabs" role="tablist" aria-label="Search mode">{(['Web search', 'Quick answer', 'Deep research', 'Explore'] as Mode[]).map((item) => <button key={item} className={item === mode ? 'selected' : ''} onClick={() => onModeChange(item)} role="tab" aria-selected={item === mode}>{item}</button>)}</div><form className="empty-search-composer" onSubmit={submit}><textarea value={input} onChange={(event) => onInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (input.trim()) onSearch(input.trim()) } }} placeholder="Ask anything" rows={1} autoFocus /><div className="empty-composer-actions"><button type="button" className="empty-attach" aria-label="Attach a file" disabled title="File search is not configured yet"><Plus size={24} /></button><button className="empty-submit" aria-label="Search"><Search size={22} /></button></div></form><div className="search-suggestions">{suggestions.map((suggestion) => <button key={suggestion} onClick={() => onSearch(suggestion)}><Sparkles size={20} />{suggestion}</button>)}</div></div></section>
}

function ResearchStart({ input, onInput, onSearch }: { input: string; onInput: (value: string) => void; onSearch: (query: string) => void }) {
  const submit = (event: React.FormEvent) => { event.preventDefault(); if (input.trim()) onSearch(input.trim()) }
  return <section className="research-start"><div className="research-start-inner"><span>Deep research</span><h1>Follow a question wherever the web leads.</h1><p>Lumen plans a bounded search, curates the strongest website evidence, reads source pages, and produces a grounded answer you can inspect.</p><form className="research-start-form" onSubmit={submit}><textarea value={input} onChange={(event) => onInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (input.trim()) onSearch(input.trim()) } }} placeholder="What would you like to investigate?" rows={2} /><button><Sparkles size={18} /> Start research</button></form><div className="research-start-steps"><span><b>01</b> Plan focused web queries</span><span><b>02</b> Curate and read evidence</span><span><b>03</b> Cross-check the answer</span></div></div></section>
}

function CitationText({ text, sources }: { text: string; sources: SearchSource[] }) {
  return <>{text.split(/(\*\*[^*]+\*\*|\[\d+\])/g).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>
    const citation = part.match(/^\[(\d+)\]$/)
    if (!citation) return part
    const source = sources.find((item) => Number(item.n) === Number(citation[1])) || sources[Number(citation[1]) - 1]
    return source?.url ? <a className="citation-link" key={index} href={source.url} target="_blank" rel="noreferrer" title={source.title} aria-label={`Open source ${citation[1]}: ${source.title}`}>{part}</a> : part
  })}</>
}

function ResearchAnswer({ answer, sources }: { answer: string; sources: SearchSource[] }) {
  const sections = answer.trim().split(/(?=^##\s+)/m).filter(Boolean)
  if (!sections.length) return <p>{answer}</p>
  return <>{sections.map((section, index) => {
    const lines = section.trim().split('\n').filter(Boolean)
    const heading = lines[0].replace(/^##\s+/, '')
    const body = lines.slice(1)
    return <section className="research-answer-section" key={`${heading}-${index}`}><h3>{heading}</h3>{body.map((line, lineIndex) => line.startsWith('- ') ? <p className="research-finding" key={lineIndex}><CitationText text={line.slice(2)} sources={sources} /></p> : <p key={lineIndex}><CitationText text={line} sources={sources} /></p>)}</section>
  })}</>
}

function SearchOverview({ answer, sources, expanded, onToggle }: { answer: string; sources: SearchSource[]; expanded: boolean; onToggle: () => void }) {
  const sections = answer.trim().split(/(?=^##\s+)/m).filter(Boolean)
  const content = sections.length ? sections.map((section, index) => {
    const lines = section.trim().split('\n').filter(Boolean)
    const heading = lines[0].replace(/^##\s+/, '')
    return <section key={`${heading}-${index}`}><h3>{heading}</h3>{lines.slice(1).map((line, lineIndex) => <p className={line.startsWith('- ') ? 'overview-finding' : ''} key={lineIndex}><CitationText text={line.replace(/^-\s+/, '')} sources={sources} /></p>)}</section>
  }) : <p>{cleanMarkdown(answer)}</p>
  return <div className="search-overview"><div><Sparkles size={15} /> AI overview</div><div className={`overview-content ${expanded ? 'expanded' : ''}`}>{content}</div><button className="overview-expand" onClick={onToggle}>{expanded ? 'Show less' : 'Show full overview'} <ChevronDown size={14} /></button>{sources.length > 0 && <div className="overview-sources" aria-label="Overview sources"><span>Sources</span>{sources.slice(0, 6).map((source) => <a href={source.url || '#'} target={source.url ? '_blank' : undefined} rel="noreferrer" key={source.n} title={source.title}><Favicon url={source.url} /><b>{source.domain}</b><small>{source.n}</small></a>)}</div>}</div>
}

function EvidenceRow({ source }: { source: SearchSource }) {
  return <a className="evidence-row" href={source.url || '#'} target={source.url ? '_blank' : undefined} rel="noreferrer"><Favicon url={source.url} /><span><strong>{source.domain}</strong><small>{source.title}</small><em>{source.pageRead ? 'Read for synthesis' : source.aiReason || source.date}</em></span><ArrowUpRight size={15} /></a>
}

function ResultPagination({ page, hasMore, running, onPage }: { page: number; hasMore: boolean; running: boolean; onPage: (page: number) => void }) {
  const pages = [page - 1, page, page + 1].filter((nextPage) => nextPage > 0 && (nextPage <= page || hasMore))
  return <nav className="pagination results-pagination" aria-label="Search result pages"><button disabled={page === 1 || running} onClick={() => onPage(page - 1)}>Previous</button>{pages.map((nextPage) => <button key={nextPage} className={nextPage === page ? 'active' : ''} disabled={running} onClick={() => onPage(nextPage)} aria-current={nextPage === page ? 'page' : undefined}>{nextPage}</button>)}<button disabled={!hasMore || running} onClick={() => onPage(page + 1)}>Next</button></nav>
}

function TracePanel({ running, step, trace, compact = false }: { running: boolean; step: number; trace: TraceStep[]; compact?: boolean }) {
  const events = [
    ['Plan', 'Decomposed the question and defined sub-queries and evaluation criteria.', '00:04'],
    ['Query SearXNG', 'Searched multiple engines via SearXNG with privacy-preserving settings.', '00:18'],
    ['Read source pages', 'Opened the strongest websites and extracted readable evidence.', '00:26'],
    ['Rank sources', 'Ranked results using relevance, recency, and source quality signals.', '00:12'],
    ['Cross-check', 'Comparing claims across sources and checking for contradictions.', '00:22'],
    ['Synthesize', 'Drafting the synthesis with citations and key takeaways.', '—'],
  ]
  if (compact) return <section className="activity-strip" aria-label="Research activity"><span className="activity-title"><Activity size={15} /> Research activity <i className={running ? 'active' : ''} /></span><div className="activity-steps">{events.map(([title], index) => <span key={title} className={index < step ? 'done' : index === step ? 'current' : ''}><b>{index < step ? <Check size={12} /> : <i />}</b>{title.replace('Query SearXNG', 'Search').replace('Read source pages', 'Read').replace('Rank sources', 'Rank').replace('Cross-check', 'Check').replace('Synthesize', 'Answer')}</span>)}</div></section>
  return <section className="trace-panel"><div className="trace-header"><span><Activity size={20} /> Agent trace</span><span className="live"><i /> {running ? 'Live' : 'Ready'}</span><button>Clear</button></div><div className="trace-list">{events.map(([title, desc, time], index) => { const done = index < step; const active = index === step; const recorded = trace.find((item) => item.step === title); return <div className={`trace-event ${done ? 'done' : ''} ${active ? 'current' : ''}`} key={title}><div className="event-marker">{done ? <Check size={14} /> : active ? <span /> : null}</div><div className="event-copy"><div className="event-title"><strong>{title}</strong><span>{time} {active ? <ChevronDown size={15} /> : done ? <ChevronDown size={15} /> : ''}</span></div><p>{recorded?.detail || desc}</p>{(active || done) && index === 4 && <div className="connected-list"><ConnectedCard label="SearXNG" sub="docs.searxng.org" icon="search" /><ConnectedCard label="Vane" sub="agentic search pattern" icon="vane" /><ConnectedCard label="LM Studio" sub="localhost:1234" icon="lm" /></div>}</div></div> })}</div></section>
}
function ConnectedCard({ label, sub, icon }: { label: string; sub: string; icon: string }) { return <div className="connected-card"><span className={`connected-icon ${icon}`}>{icon === 'search' ? <Search size={18} /> : icon === 'lm' ? <Sparkles size={16} /> : 'V'}</span><span><strong>{label}</strong><small>{sub}</small></span><span className="connected"><Check size={11} /> Connected</span><ChevronRight size={17} /></div> }

function SettingsView({ preferences, onUpdate, onReset, onClearHistory, onOpenProviders }: { preferences: Preferences; onUpdate: (field: keyof Preferences, value: Preferences[keyof Preferences]) => void; onReset: () => void; onClearHistory: () => void; onOpenProviders: () => void }) {
  return <div className="settings-view preferences-view">
    <div className="settings-heading"><div><span className="section-kicker">Workspace</span><h1>Settings</h1><p>Control how Lumen starts a search, prepares its sources, and presents results. Model connections live separately in Providers.</p></div><button className="subtle-action" onClick={onReset}><RefreshCw size={14} /> Reset preferences</button></div>
    <div className="settings-sections">
      <section className="settings-section"><div className="settings-section-heading"><span className="settings-section-icon"><Sparkles size={17} /></span><div><h2>Search experience</h2><p>Defaults for every new search thread.</p></div></div><div className="setting-row"><div><strong>Default search mode</strong><small>Choose the mode that opens when you start a new search.</small></div><select aria-label="Default search mode" value={preferences.defaultMode} onChange={(event) => onUpdate('defaultMode', event.target.value as Mode)}>{(['Web search', 'Quick answer', 'Deep research', 'Explore'] as Mode[]).map((mode) => <option key={mode} value={mode}>{mode}</option>)}</select></div><div className="setting-row"><div><strong>Result density</strong><small>Use a tighter layout when you want to scan more websites at once.</small></div><select aria-label="Result density" value={preferences.resultDensity} onChange={(event) => onUpdate('resultDensity', event.target.value as Preferences['resultDensity'])}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></div></section>
      <section className="settings-section"><div className="settings-section-heading"><span className="settings-section-icon"><Activity size={17} /></span><div><h2>AI search</h2><p>Decide how much work happens before you switch tabs.</p></div></div><div className="setting-row"><div><strong>Preload ranked tabs</strong><small>Warm News, Images, Videos, GitHub, and Academic results after a web search.</small></div><button className={`setting-switch ${preferences.warmTabs ? 'on' : ''}`} role="switch" aria-checked={preferences.warmTabs} aria-label="Preload ranked tabs" onClick={() => onUpdate('warmTabs', !preferences.warmTabs)}><span /></button></div><div className="setting-row"><div><strong>Show AI Overview</strong><small>Generate and display the evidence-grounded overview above general web results.</small></div><button className={`setting-switch ${preferences.showOverview ? 'on' : ''}`} role="switch" aria-checked={preferences.showOverview} aria-label="Show AI Overview" onClick={() => onUpdate('showOverview', !preferences.showOverview)}><span /></button></div></section>
      <section className="settings-section"><div className="settings-section-heading"><span className="settings-section-icon"><Folder size={17} /></span><div><h2>Data and connections</h2><p>Manage saved work and the services Lumen uses.</p></div></div><div className="setting-row"><div><strong>Model providers</strong><small>Set provider endpoints, OAuth connections, models, and LM Studio credentials.</small></div><button className="row-action" onClick={onOpenProviders}>Open Providers <ArrowUpRight size={14} /></button></div><div className="setting-row"><div><strong>Search library</strong><small>Remove saved searches and research threads from this browser.</small></div><button className="row-action danger" onClick={onClearHistory}>Clear library</button></div></section>
    </div>
  </div>
}

  function ProvidersView({ providers, selected, onSelect, onConnect, onCheck, onUpdateProvider, availableModels, modelStatus, onDiscoverModels, onTestModel, searchEndpoint, onSearchEndpointChange, searchStatus, onTestSearch }: { providers: Provider[]; selected: string; onSelect: (id: string) => void; onConnect: (id: string) => void; onCheck: (id: string) => void; onUpdateProvider: (id: string, field: 'endpoint' | 'model' | 'apiKey', value: string) => void; availableModels: Record<string, ModelOption[]>; modelStatus: Record<string, string>; onDiscoverModels: (id: string) => void; onTestModel: (id: string) => void; searchEndpoint: string; onSearchEndpointChange: (value: string) => void; searchStatus: string; onTestSearch: () => void }) {
    return <div className="settings-view">
      <div className="settings-heading"><div><span className="section-kicker">Connections</span><h1>Providers</h1><p>Choose the model that curates your web results. LM Studio tokens stay only in this browser session.</p><div className="default-model-summary"><Sparkles size={15} /> Default for new searches: <strong>{providers.find((provider) => provider.id === selected)?.name} · {providers.find((provider) => provider.id === selected)?.model}</strong></div></div><span className="settings-built-in">{providers.length} built-in providers</span></div>
      <div className="search-provider-card"><div><span className="provider-kind">Web search</span><h2>SearXNG</h2><p>Private metasearch for websites, documentation, GitHub, news, and more.</p></div><div className="search-endpoint-row"><label htmlFor="searxng-url">Instance URL</label><input id="searxng-url" value={searchEndpoint} onChange={(event) => onSearchEndpointChange(event.target.value)} /><button className="connect-button" onClick={onTestSearch}>Test connection</button></div>{searchStatus && <small className="search-status">{searchStatus}</small>}</div>
      <div className="provider-grid">{providers.map((provider) => {
        const discoveredModels = availableModels[provider.id] || []
        const models = discoveredModels.length ? discoveredModels : providerModelSuggestions[provider.id] || []
        const currentMissing = !models.some((model) => model.id === provider.model)
        return <div className={`provider-card ${selected === provider.id ? 'selected' : ''}`} key={provider.id}>
          <div className="provider-card-top"><ProviderIcon provider={provider} /><span className="provider-kind">{selected === provider.id ? 'Active for search' : provider.kind}</span></div>
          <h2>{provider.name}</h2>
          <p>{provider.id === 'lmstudio' ? 'The dropdown is populated by the language models installed on your local LM Studio server.' : `Refresh to load every model available to your ${provider.name} account; OAuth remains available for synthesis.`}</p>
          <div className="provider-field"><small>Endpoint</small><input className="provider-edit" aria-label={`${provider.name} endpoint`} value={provider.endpoint} onChange={(event) => onUpdateProvider(provider.id, 'endpoint', event.target.value)} /></div>
          <div className="provider-field provider-model-field"><small>{selected === provider.id ? 'Default model' : 'Saved model'}</small><select className="provider-model-select" aria-label={`${provider.name} model`} value={provider.model} onChange={(event) => onUpdateProvider(provider.id, 'model', event.target.value)}>{currentMissing && <option value={provider.model}>{provider.model} (current)</option>}{models.map((model) => <option key={model.id} value={model.id}>{model.label}{model.quantization ? ` · ${model.quantization}` : ''}</option>)}</select></div>
          <div className="provider-field provider-key-field"><label htmlFor={`${provider.id}-api-key`}>{provider.id === 'lmstudio' ? 'Server API key' : 'Account API key'}</label><input id={`${provider.id}-api-key`} className="provider-edit" aria-label={`${provider.name} API key`} type="password" autoComplete="off" value={provider.apiKey || ''} placeholder={provider.id === 'lmstudio' ? 'Optional LM Studio server token' : 'Optional — enables the live model catalog'} onChange={(event) => onUpdateProvider(provider.id, 'apiKey', event.target.value)} /></div>
          <div className="model-discovery"><span><button className="model-refresh" type="button" onClick={() => onDiscoverModels(provider.id)}><RefreshCw size={14} /> {provider.id === 'lmstudio' ? 'Refresh installed models' : 'Refresh available models'}</button><button className="model-test" type="button" onClick={() => onTestModel(provider.id)}>Test model connection</button></span>{modelStatus[provider.id] && <small className={/^(Connected|\d+ models available|Loading)/.test(modelStatus[provider.id]) ? 'model-status' : 'model-status error'}>{modelStatus[provider.id]}</small>}</div>
          <button className={`use-provider-button ${selected === provider.id ? 'active' : ''}`} onClick={() => onSelect(provider.id)}>{selected === provider.id ? <><Check size={15} /> Default for new searches</> : 'Make default for new searches'}</button>
          {provider.id !== 'lmstudio' && <button className={`connect-button ${provider.connected ? 'connected-button' : ''}`} onClick={() => provider.connected ? onCheck(provider.id) : provider.authPending ? onCheck(provider.id) : onConnect(provider.id)}>{provider.connected ? <><Check size={15} /> OAuth connected</> : provider.authPending ? <>Check OAuth session <Settings size={14} /></> : <>Connect with OAuth <ArrowUpRight size={15} /></>}</button>}
        </div>
      })}</div>
      <div className="security-note"><CircleHelp size={17} /><span><strong>LM Studio models are loaded from its local server</strong><br />Add its optional server token above when authentication is enabled. It is sent only to this local Lumen API for model discovery and requests, and is never stored in localStorage. OAuth providers use local CLI sessions.</span></div>
    </div>
  }
function LibraryView({ history, onOpen }: { history: SearchSession[]; onOpen: (session: SearchSession) => void }) { return history.length ? <div className="library-view"><div className="settings-heading"><div><span className="section-kicker">Local history</span><h1>Search library</h1><p>Your recent website searches and research threads stay on this device.</p></div><span className="source-count">{history.length} saved</span></div><div className="history-list">{history.map((session) => <button className="history-item" key={session.id} onClick={() => onOpen(session)}><span className="history-date">{new Date(session.createdAt).toLocaleDateString()}</span><strong>{session.query}</strong><small>{session.sources.length} web results</small><ChevronRight size={17} /></button>)}</div></div> : <div className="empty-view"><div className="empty-icon"><FileText size={26} /></div><h1>Your search library</h1><p>Saved website searches and research threads will appear here as you work.</p><button className="primary-button"><Plus size={16} /> New search</button></div> }

export default App
