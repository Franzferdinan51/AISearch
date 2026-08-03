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
type Provider = { id: string; name: string; model: string; endpoint: string; kind: string; connected: boolean; authPending?: boolean; color: string }
type ModelOption = { id: string; label: string; architecture?: string | null; quantization?: string | null }

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

type SearchSource = { n: string; title: string; domain: string; date: string; url?: string; snippet?: string; aiScore?: number; aiReason?: string; pageRead?: boolean }
type SearchSession = { id: string; query: string; createdAt: string; sources: SearchSource[]; answer: string }
type TraceStep = { step: string; status: string; detail: string }
function normalizeSources(results: Array<{ title: string; url: string; content?: string; pageText?: string; publishedDate?: string; aiScore?: number; aiReason?: string }>, page = 1): SearchSource[] {
  return results.flatMap((item, index) => {
    try {
      return [{ n: String((page - 1) * 10 + index + 1), title: item.title, domain: new URL(item.url).hostname, date: item.publishedDate || 'Retrieved just now', url: item.url, snippet: item.content, aiScore: item.aiScore, aiReason: item.aiReason, pageRead: Boolean(item.pageText) }]
    } catch { return [] }
  })
}

function App() {
  const [view, setView] = useState<'search' | 'research' | 'library' | 'providers'>('search')
  const [mode, setMode] = useState<Mode>('Web search')
  const [providers, setProviders] = useState(loadSavedProviders)
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

  const provider = providers.find((item) => item.id === selectedProvider) ?? providers[0]
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

  useEffect(() => localStorage.setItem('lumen-providers', JSON.stringify(providers)), [providers])
  useEffect(() => localStorage.setItem('lumen-default-provider', selectedProvider), [selectedProvider])
  useEffect(() => localStorage.setItem('lumen-search-endpoint', searchEndpoint), [searchEndpoint])
  useEffect(() => localStorage.setItem('lumen-history', JSON.stringify(history.slice(0, 20))), [history])

  const discoverProviderModels = async (id: string) => {
    const target = providers.find((item) => item.id === id)
    if (!target) return
    setModelStatus((current) => ({ ...current, [id]: 'Loading models…' }))
    try {
      const response = await fetch(`/api/models?provider=${encodeURIComponent(id)}&endpoint=${encodeURIComponent(target.endpoint)}`)
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || 'Model discovery failed')
      const models = Array.isArray(payload.models) ? payload.models : []
      setAvailableModels((current) => ({ ...current, [id]: models }))
      setModelStatus((current) => ({ ...current, [id]: models.length ? `${models.length} model${models.length === 1 ? '' : 's'} available` : 'No language models found' }))
      if (models.length && !models.some((model: ModelOption) => model.id === target.model)) updateProvider(id, 'model', models[0].id)
    } catch (error) { setModelStatus((current) => ({ ...current, [id]: error instanceof Error ? error.message : 'Could not load models' })) }
  }

  useEffect(() => { discoverProviderModels('lmstudio') }, [])

  const runResearch = async (nextQuery = query, nextCategory = searchCategory) => {
    if (!nextQuery.trim()) return
    setQuery(nextQuery)
    setRunning(true)
    setStep(0)
    setResultsPage(1)
    setApiError('')
    setOverviewExpanded(false)
    let current = 0
    const timer = window.setInterval(() => { current += 1; setStep(Math.min(current, 5)); if (current >= 5) window.clearInterval(timer) }, 600)
    try {
      const isDeep = mode === 'Deep research' || mode === 'Explore' || view === 'research'
      const endpoint = view === 'search' && (nextCategory === 'images' || nextCategory === 'videos') ? '/api/search' : '/api/research'
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: nextQuery, provider: selectedProvider, providerConfig: { endpoint: provider.endpoint, model: provider.model }, baseUrl: searchEndpoint, category: nextCategory, depth: isDeep ? 'deep' : 'quick', maxResults: 10, page: 1 }) })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || 'Research request failed')
      const normalized = normalizeSources(payload.search?.results || payload.results || [], 1)
      setSourceList(normalized)
      setHasMoreResults(Boolean(payload.search?.hasMore ?? payload.hasMore))
      setCurationMode(payload.search?.curation?.mode || payload.curation?.mode || 'none')
      setAnswer(payload.answer || (nextCategory === 'images' ? `Image results for “${nextQuery}”.` : nextCategory === 'videos' ? `Video results for “${nextQuery}”.` : 'Research completed.'))
      if (payload.trace) setTraceSteps(payload.trace)
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
      const response = await fetch('/api/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, baseUrl: searchEndpoint, category: searchCategory, depth: 'quick', maxResults: 10, page, provider: selectedProvider, providerConfig: { endpoint: provider.endpoint, model: provider.model }, curate: true }) })
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

  const updateProvider = (id: string, field: 'endpoint' | 'model', value: string) => setProviders((current) => current.map((item) => item.id === id ? { ...item, [field]: value } : item))

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
  const newSearch = () => { setView('search'); setQuery(''); setInput(''); setSourceList([]); setAnswer(''); setTraceSteps([]); setApiError(''); setResultsPage(1); setHasMoreResults(true); setCurationMode('none'); setRunning(false) }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
        <div className="brand"><div className="brand-mark"><Sparkles size={18} /></div><span>Lumen</span></div>
        <nav>
          <NavItem icon={<Search size={19} />} label="Search" active={view === 'search'} onClick={() => { setView('search'); setMobileNav(false) }} />
          <NavItem icon={<Split size={19} />} label="Research" active={view === 'research'} onClick={() => { setView('research'); setMobileNav(false) }} />
          <NavItem icon={<Folder size={19} />} label="Library" active={view === 'library'} onClick={() => { setView('library'); setMobileNav(false) }} />
          <NavItem icon={<PlugZap size={19} />} label="Providers" active={view === 'providers'} onClick={() => { setView('providers'); setMobileNav(false) }} />
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
              {showMode && <Dropdown items={['Web search', 'Quick answer', 'Deep research', 'Explore']} onSelect={(item) => { setMode(item as Mode); setShowMode(false) }} />}
            </div>
          </div>
          <div className="topbar-actions">
            <div className="select-wrap provider-select">
              <button className="select-button" onClick={() => setShowProvider(!showProvider)}><ProviderIcon provider={provider} />{provider.name} <span className="muted-dot">•</span>{provider.model}<ChevronDown size={16} /></button>
              {showProvider && <Dropdown custom items={providers.map((item) => `${item.name} • ${item.model}`)} onSelect={(item) => { const found = providers.find((p) => `${p.name} • ${p.model}` === item); if (found) setSelectedProvider(found.id); setShowProvider(false) }} />}
            </div>
            <button className="icon-button gear" onClick={() => setView('providers')} aria-label="Provider settings"><Settings size={18} /></button>
            <button className="avatar-button" aria-label="Account">AV <ChevronDown size={14} /></button>
          </div>
        </header>

        {view === 'providers' ? <ProvidersView providers={providers} selected={selectedProvider} onSelect={setSelectedProvider} onConnect={connectProvider} onCheck={checkProvider} onUpdateProvider={updateProvider} availableModels={availableModels} modelStatus={modelStatus} onDiscoverModels={discoverProviderModels} searchEndpoint={searchEndpoint} onSearchEndpointChange={setSearchEndpoint} searchStatus={searchStatus} onTestSearch={testSearchEndpoint} /> : view === 'library' ? <LibraryView history={history} onOpen={openHistory} /> : (
          <div className={`workspace ${view === 'search' ? 'web-search-workspace' : ''} ${view === 'research' ? 'research-workspace' : ''}`}>
            {isEmptySearch ? <EmptySearch input={input} onInput={setInput} onSearch={(nextQuery) => { runResearch(nextQuery); setInput('') }} /> : isEmptyResearch ? <ResearchStart input={input} onInput={setInput} onSearch={(nextQuery) => { runResearch(nextQuery); setInput('') }} /> : <section className="answer-canvas">
              <div className="canvas-inner">
                <div className="eyebrow-row"><span className="eyebrow"><Activity size={13} /> {running ? 'Researching' : 'Research complete'}</span><button className="quiet-button"><Link2 size={14} /> Share</button></div>
                <h1>{answerTitle}</h1>
                {view === 'research' ? <><div className="research-thread-head"><div><span>Deep research</span><h2>{answerTitle}</h2></div><div className="research-thread-tools"><button onClick={() => navigator.clipboard?.writeText(answer)} aria-label="Copy research"><Copy size={16} /></button><button aria-label="Share research"><Link2 size={16} /></button><button aria-label="More research actions"><MoreHorizontal size={18} /></button></div></div><div className="research-layout"><article className="research-brief"><ResearchAnswer answer={answer} /></article><aside className="evidence-rail"><div className="evidence-rail-head"><strong>Evidence sources</strong><span>{sourceList.filter((source) => source.pageRead).length} read</span></div>{sourceList.map((source) => <EvidenceRow key={source.n} source={source} />)}</aside></div>{apiError && <div className="research-error"><CircleHelp size={15} /> {apiError}</div>}<TracePanel compact running={running} step={step} trace={traceSteps} /><div className="research-actions"><button onClick={() => navigator.clipboard?.writeText(answer)}><Copy size={15} /> Copy</button><button onClick={() => runResearch(query)}><RefreshCw size={15} /> Regenerate</button><button><Link2 size={15} /> Share</button><button><ArrowUpRight size={15} /> Export</button></div></> : <><div className="search-overview"><div><Sparkles size={15} /> AI overview</div><p className={overviewExpanded ? 'expanded' : ''}>{answer}</p>{answer.length > 260 && <button className="overview-expand" onClick={() => setOverviewExpanded(!overviewExpanded)}>{overviewExpanded ? 'Show less' : 'Show full overview'} <ChevronDown size={14} /></button>}</div><TracePanel compact running={running} step={step} trace={traceSteps} /><div className="search-filters" role="tablist" aria-label="Search scope">{([['general', 'Web'], ['news', 'News'], ['images', 'Images'], ['videos', 'Videos'], ['github', 'GitHub'], ['science', 'Academic']] as const).map(([value, label]) => <button key={value} className={searchCategory === value ? 'selected' : ''} onClick={() => { setSearchCategory(value); runResearch(query, value) }} role="tab" aria-selected={searchCategory === value}>{label}</button>)}</div><div className="results-scroller"><div className="sources-heading"><span>{searchCategory === 'github' ? 'GitHub results' : searchCategory === 'images' ? 'Image results' : searchCategory === 'videos' ? 'Video results' : 'Search results'}</span><span className={`source-count curation-status ${curationMode}`}>{curationMode === 'ai' ? 'AI-curated' : curationMode === 'heuristic' ? 'Relevance-ranked' : 'Retrieved'} · Page {resultsPage} · {sourceList.length} results</span></div>{apiError && <div className="research-error"><CircleHelp size={15} /> {apiError}</div>}<div className="source-list">{sourceList.map((source) => <SourceRow key={source.n} source={source} />)}</div><nav className="pagination" aria-label="Search result pages"><button disabled={resultsPage === 1 || running} onClick={() => loadResultsPage(resultsPage - 1)}>Previous</button>{[resultsPage - 1, resultsPage, resultsPage + 1].filter((page) => page > 0 && (page <= resultsPage || hasMoreResults)).map((page) => <button key={page} className={page === resultsPage ? 'active' : ''} disabled={running} onClick={() => loadResultsPage(page)} aria-current={page === resultsPage ? 'page' : undefined}>{page}</button>)}<button disabled={!hasMoreResults || running} onClick={() => loadResultsPage(resultsPage + 1)}>Next</button></nav></div></>}
              </div>
            </section>}
          </div>
        )}

        {view !== 'providers' && view !== 'library' && !isEmptySearch && !isEmptyResearch && <form className={`composer ${view === 'research' ? 'research-composer' : ''}`} onSubmit={(event) => { event.preventDefault(); if (input.trim()) { runResearch(input); setInput('') } }}>
          <button type="button" className="attach-button" aria-label="Attach a file"><Paperclip size={19} /></button>
          <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (input.trim()) { runResearch(input); setInput('') } } }} placeholder="Ask a follow-up or refine the research..." rows={1} />
          <div className="composer-footer">{view === 'research' ? <div className="composer-options"><button type="button"><Globe2 size={14} /> Web</button><button type="button" className="selected"><Sparkles size={14} /> Deep research</button></div> : <span>Press Enter to send&nbsp; · &nbsp;Shift+Enter for new line</span>}<div className="composer-send-actions">{view === 'research' && <button type="button" className="composer-mic" aria-label="Voice input"><Mic size={18} /></button>}{running && <button type="button" className="composer-stop" onClick={() => setRunning(false)}><Square size={13} /> Stop</button>}<button className="send-button" aria-label="Send research query"><Send size={19} /></button></div></div>
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
    <div className="result-topline"><span className="result-index">{source.n}</span><Favicon url={source.url} /><span className="result-domain">{source.domain}</span><span className="result-kind">Web</span><ArrowUpRight size={15} /></div>
    <strong>{source.title}</strong>
    {source.snippet && <em>{source.snippet}</em>}
    {source.aiReason && <span className="curation-reason"><Sparkles size={13} /> {source.aiReason}{typeof source.aiScore === 'number' && <b>{source.aiScore}% match</b>}</span>}
  </a>
}

function Favicon({ url }: { url?: string }) {
  const origin = url ? (() => { try { return new URL(url).origin } catch { return '' } })() : ''
  return origin ? <img className="result-favicon" src={`${origin}/favicon.ico`} alt="" onError={(event) => { event.currentTarget.style.display = 'none' }} /> : <span className="result-favicon fallback"><Globe2 size={13} /></span>
}

function EmptySearch({ input, onInput, onSearch }: { input: string; onInput: (value: string) => void; onSearch: (query: string) => void }) {
  const suggestions = [
    'What are the most useful open-source AI tools right now?',
    'How does a search engine decide which website to rank first?',
    'Find a practical weekend itinerary for New York City.',
  ]
  const submit = (event: React.FormEvent) => { event.preventDefault(); if (input.trim()) onSearch(input.trim()) }
  return <section className="empty-search-canvas"><div className="empty-search-inner"><h1>Hi Duckets, what would you like to search?</h1><form className="empty-search-composer" onSubmit={submit}><textarea value={input} onChange={(event) => onInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (input.trim()) onSearch(input.trim()) } }} placeholder="Ask anything" rows={1} autoFocus /><div className="empty-composer-actions"><button type="button" className="empty-attach" aria-label="Attach a file"><Plus size={24} /></button><button className="empty-submit" aria-label="Search"><Search size={22} /></button></div></form><div className="search-suggestions">{suggestions.map((suggestion) => <button key={suggestion} onClick={() => onSearch(suggestion)}><Sparkles size={20} />{suggestion}</button>)}</div></div></section>
}

function ResearchStart({ input, onInput, onSearch }: { input: string; onInput: (value: string) => void; onSearch: (query: string) => void }) {
  const submit = (event: React.FormEvent) => { event.preventDefault(); if (input.trim()) onSearch(input.trim()) }
  return <section className="research-start"><div className="research-start-inner"><span>Deep research</span><h1>Follow a question wherever the web leads.</h1><p>Lumen plans a bounded search, curates the strongest website evidence, reads source pages, and produces a grounded answer you can inspect.</p><form className="research-start-form" onSubmit={submit}><textarea value={input} onChange={(event) => onInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (input.trim()) onSearch(input.trim()) } }} placeholder="What would you like to investigate?" rows={2} /><button><Sparkles size={18} /> Start research</button></form><div className="research-start-steps"><span><b>01</b> Plan focused web queries</span><span><b>02</b> Curate and read evidence</span><span><b>03</b> Cross-check the answer</span></div></div></section>
}

function InlineMarkdown({ text }: { text: string }) {
  return <>{text.split(/(\*\*[^*]+\*\*)/g).map((part, index) => part.startsWith('**') && part.endsWith('**') ? <strong key={index}>{part.slice(2, -2)}</strong> : part)}</>
}

function ResearchAnswer({ answer }: { answer: string }) {
  const sections = answer.trim().split(/(?=^##\s+)/m).filter(Boolean)
  if (!sections.length) return <p>{answer}</p>
  return <>{sections.map((section, index) => {
    const lines = section.trim().split('\n').filter(Boolean)
    const heading = lines[0].replace(/^##\s+/, '')
    const body = lines.slice(1)
    return <section className="research-answer-section" key={`${heading}-${index}`}><h3>{heading}</h3>{body.map((line, lineIndex) => line.startsWith('- ') ? <p className="research-finding" key={lineIndex}><InlineMarkdown text={line.slice(2)} /></p> : <p key={lineIndex}><InlineMarkdown text={line} /></p>)}</section>
  })}</>
}

function EvidenceRow({ source }: { source: SearchSource }) {
  return <a className="evidence-row" href={source.url || '#'} target={source.url ? '_blank' : undefined} rel="noreferrer"><Favicon url={source.url} /><span><strong>{source.domain}</strong><small>{source.title}</small><em>{source.pageRead ? 'Read for synthesis' : source.aiReason || source.date}</em></span><ArrowUpRight size={15} /></a>
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

  function ProvidersView({ providers, selected, onSelect, onConnect, onCheck, onUpdateProvider, availableModels, modelStatus, onDiscoverModels, searchEndpoint, onSearchEndpointChange, searchStatus, onTestSearch }: { providers: Provider[]; selected: string; onSelect: (id: string) => void; onConnect: (id: string) => void; onCheck: (id: string) => void; onUpdateProvider: (id: string, field: 'endpoint' | 'model', value: string) => void; availableModels: Record<string, ModelOption[]>; modelStatus: Record<string, string>; onDiscoverModels: (id: string) => void; searchEndpoint: string; onSearchEndpointChange: (value: string) => void; searchStatus: string; onTestSearch: () => void }) {
    return <div className="settings-view">
      <div className="settings-heading"><div><span className="section-kicker">Connections</span><h1>Providers</h1><p>Choose the model that curates your web results. Credentials stay in the local session and never enter the browser UI.</p><div className="default-model-summary"><Sparkles size={15} /> Default for new searches: <strong>{providers.find((provider) => provider.id === selected)?.name} · {providers.find((provider) => provider.id === selected)?.model}</strong></div></div><button className="primary-button"><Plus size={16} /> Add provider</button></div>
      <div className="search-provider-card"><div><span className="provider-kind">Web search</span><h2>SearXNG</h2><p>Private metasearch for websites, documentation, GitHub, news, and more.</p></div><div className="search-endpoint-row"><label htmlFor="searxng-url">Instance URL</label><input id="searxng-url" value={searchEndpoint} onChange={(event) => onSearchEndpointChange(event.target.value)} /><button className="connect-button" onClick={onTestSearch}>Test connection</button></div>{searchStatus && <small className="search-status">{searchStatus}</small>}</div>
      <div className="provider-grid">{providers.map((provider) => {
        const models = availableModels[provider.id] || []
        const hasDiscoveredModels = models.length > 0
        const currentMissing = hasDiscoveredModels && !models.some((model) => model.id === provider.model)
        return <div className={`provider-card ${selected === provider.id ? 'selected' : ''}`} key={provider.id}>
          <div className="provider-card-top"><ProviderIcon provider={provider} /><span className="provider-kind">{selected === provider.id ? 'Active for search' : provider.kind}</span></div>
          <h2>{provider.name}</h2>
          <p>{provider.id === 'lmstudio' ? 'Choose from models available on your local LM Studio server.' : `OAuth session for ${provider.name} models.`}</p>
          <div className="provider-field"><small>Endpoint</small><input className="provider-edit" aria-label={`${provider.name} endpoint`} value={provider.endpoint} onChange={(event) => onUpdateProvider(provider.id, 'endpoint', event.target.value)} /></div>
          <div className="provider-field provider-model-field"><small>{selected === provider.id ? 'Default model' : 'Saved model'}</small>{hasDiscoveredModels ? <select className="provider-model-select" aria-label={`${provider.name} model`} value={provider.model} onChange={(event) => onUpdateProvider(provider.id, 'model', event.target.value)}><option value={provider.model} hidden={!currentMissing}>{provider.model}{currentMissing ? ' (current)' : ''}</option>{models.map((model) => <option key={model.id} value={model.id}>{model.label}{model.quantization ? ` · ${model.quantization}` : ''}</option>)}</select> : <input className="provider-edit" aria-label={`${provider.name} model`} value={provider.model} placeholder="Enter model ID" onChange={(event) => onUpdateProvider(provider.id, 'model', event.target.value)} />}</div>
          {provider.id === 'lmstudio' && <div className="model-discovery"><button className="model-refresh" type="button" onClick={() => onDiscoverModels(provider.id)}><RefreshCw size={14} /> Refresh installed models</button>{modelStatus[provider.id] && <small className={modelStatus[provider.id].startsWith('Could not') ? 'model-status error' : 'model-status'}>{modelStatus[provider.id]}</small>}</div>}
          <button className={`use-provider-button ${selected === provider.id ? 'active' : ''}`} onClick={() => onSelect(provider.id)}>{selected === provider.id ? <><Check size={15} /> Default for new searches</> : 'Make default for new searches'}</button>
          {provider.id !== 'lmstudio' && <button className={`connect-button ${provider.connected ? 'connected-button' : ''}`} onClick={() => provider.connected ? onCheck(provider.id) : provider.authPending ? onCheck(provider.id) : onConnect(provider.id)}>{provider.connected ? <><Check size={15} /> OAuth connected</> : provider.authPending ? <>Check OAuth session <Settings size={14} /></> : <>Connect with OAuth <ArrowUpRight size={15} /></>}</button>}
        </div>
      })}</div>
      <div className="security-note"><CircleHelp size={17} /><span><strong>LM Studio models are loaded from its local server</strong><br />If your server requires authentication, start Lumen with <code>LM_API_TOKEN</code>. OAuth providers use local CLI sessions; tokens are never returned to the browser or stored in localStorage.</span></div>
    </div>
  }
function LibraryView({ history, onOpen }: { history: SearchSession[]; onOpen: (session: SearchSession) => void }) { return history.length ? <div className="library-view"><div className="settings-heading"><div><span className="section-kicker">Local history</span><h1>Search library</h1><p>Your recent website searches and research threads stay on this device.</p></div><span className="source-count">{history.length} saved</span></div><div className="history-list">{history.map((session) => <button className="history-item" key={session.id} onClick={() => onOpen(session)}><span className="history-date">{new Date(session.createdAt).toLocaleDateString()}</span><strong>{session.query}</strong><small>{session.sources.length} web results</small><ChevronRight size={17} /></button>)}</div></div> : <div className="empty-view"><div className="empty-icon"><FileText size={26} /></div><h1>Your search library</h1><p>Saved website searches and research threads will appear here as you work.</p><button className="primary-button"><Plus size={16} /> New search</button></div> }

export default App
