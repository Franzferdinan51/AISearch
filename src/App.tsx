import { useEffect, useMemo, useState } from 'react'
import Activity from 'lucide-react/dist/esm/icons/activity.mjs'
import ArrowUpRight from 'lucide-react/dist/esm/icons/arrow-up-right.mjs'
import Check from 'lucide-react/dist/esm/icons/check.mjs'
import ChevronDown from 'lucide-react/dist/esm/icons/chevron-down.mjs'
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right.mjs'
import CircleHelp from 'lucide-react/dist/esm/icons/circle-help.mjs'
import FileText from 'lucide-react/dist/esm/icons/file-text.mjs'
import Folder from 'lucide-react/dist/esm/icons/folder.mjs'
import Globe2 from 'lucide-react/dist/esm/icons/globe-2.mjs'
import Link2 from 'lucide-react/dist/esm/icons/link-2.mjs'
import Menu from 'lucide-react/dist/esm/icons/menu.mjs'
import Paperclip from 'lucide-react/dist/esm/icons/paperclip.mjs'
import PlugZap from 'lucide-react/dist/esm/icons/plug-zap.mjs'
import Plus from 'lucide-react/dist/esm/icons/plus.mjs'
import Search from 'lucide-react/dist/esm/icons/search.mjs'
import Send from 'lucide-react/dist/esm/icons/send.mjs'
import Settings from 'lucide-react/dist/esm/icons/settings.mjs'
import Sparkles from 'lucide-react/dist/esm/icons/sparkles.mjs'
import Split from 'lucide-react/dist/esm/icons/split.mjs'
import X from 'lucide-react/dist/esm/icons/x.mjs'

type Mode = 'Web search' | 'Quick answer' | 'Deep research' | 'Explore'
type SearchCategory = 'general' | 'news' | 'science'
type Provider = { id: string; name: string; model: string; endpoint: string; kind: string; connected: boolean; authPending?: boolean; color: string }

const initialProviders: Provider[] = [
  { id: 'lmstudio', name: 'LM Studio', model: 'Qwen 3 30B', endpoint: 'http://localhost:1234/v1', kind: 'Local', connected: true, color: '#7b6af0' },
  { id: 'openai', name: 'OpenAI', model: 'GPT-5', endpoint: 'https://api.openai.com/v1', kind: 'OAuth', connected: false, color: '#9ac9b7' },
  { id: 'minimax', name: 'MiniMax', model: 'MiniMax-M2.7', endpoint: 'https://api.minimax.io/v1', kind: 'OAuth', connected: false, color: '#e3a457' },
  { id: 'grok', name: 'Grok / xAI', model: 'grok-4.5', endpoint: 'https://api.x.ai/v1', kind: 'OAuth', connected: false, color: '#b7c2d5' },
]

type SearchSource = { n: string; title: string; domain: string; date: string; url?: string; snippet?: string }
type SearchSession = { id: string; query: string; createdAt: string; sources: SearchSource[]; answer: string }
type TraceStep = { step: string; status: string; detail: string }
const initialSources: SearchSource[] = [
  { n: '1', title: 'SearXNG documentation — Search API and engines', domain: 'docs.searxng.org', date: 'Web result' , url: 'https://docs.searxng.org/', snippet: 'Official documentation for configuring engines, formats, and the JSON search endpoint.' },
  { n: '2', title: 'SearXNG — privacy-respecting metasearch engine', domain: 'github.com/searxng/searxng', date: 'Web result', url: 'https://github.com/searxng/searxng', snippet: 'Open-source metasearch that aggregates results from multiple search services without tracking users.' },
  { n: '3', title: 'Vane — AI-powered answering engine', domain: 'github.com/ItzCrazyKns/Vane', date: 'Web result', url: 'https://github.com/ItzCrazyKns/Vane', snippet: 'Self-hosted answering engine combining SearXNG retrieval with local and hosted language models.' },
]

function normalizeSources(results: Array<{ title: string; url: string; content?: string; publishedDate?: string }>, page = 1): SearchSource[] {
  return results.flatMap((item, index) => {
    try {
      return [{ n: String((page - 1) * 10 + index + 1), title: item.title, domain: new URL(item.url).hostname, date: item.publishedDate || 'Retrieved just now', url: item.url, snippet: item.content }]
    } catch { return [] }
  })
}

function App() {
  const [view, setView] = useState<'search' | 'research' | 'library' | 'providers'>('search')
  const [mode, setMode] = useState<Mode>('Web search')
  const [providers, setProviders] = useState(initialProviders)
  const [selectedProvider, setSelectedProvider] = useState('lmstudio')
  const [searchCategory, setSearchCategory] = useState<SearchCategory>('general')
  const [searchEndpoint, setSearchEndpoint] = useState(() => localStorage.getItem('lumen-search-endpoint') || 'http://127.0.0.1:8080')
  const [searchStatus, setSearchStatus] = useState('')
  const [query, setQuery] = useState('What changes in open-source AI search are worth watching in 2026?')
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [step, setStep] = useState(4)
  const [resultsPage, setResultsPage] = useState(1)
  const [hasMoreResults, setHasMoreResults] = useState(true)
  const [sourceList, setSourceList] = useState<SearchSource[]>(initialSources)
  const [answer, setAnswer] = useState('Open-source AI search in 2026 is moving from classical retrieval pipelines to agentic, tool-using systems. Projects are converging on standardized retrieval interfaces, richer grounding signals, and modular agents that can plan, retrieve, verify, and iterate across multiple sources with auditable traces [1][2].')
  const [history, setHistory] = useState<SearchSession[]>(() => { try { return JSON.parse(localStorage.getItem('lumen-history') || '[]') } catch { return [] } })
  const [apiError, setApiError] = useState('')
  const [traceSteps, setTraceSteps] = useState<TraceStep[]>([])
  const [showMode, setShowMode] = useState(false)
  const [showProvider, setShowProvider] = useState(false)
  const [mobileNav, setMobileNav] = useState(false)

  const provider = providers.find((item) => item.id === selectedProvider) ?? providers[0]

  useEffect(() => {
    const saved = localStorage.getItem('lumen-providers')
    if (saved) setProviders(JSON.parse(saved))
  }, [])

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
  useEffect(() => localStorage.setItem('lumen-search-endpoint', searchEndpoint), [searchEndpoint])
  useEffect(() => localStorage.setItem('lumen-history', JSON.stringify(history.slice(0, 20))), [history])

  const runResearch = async (nextQuery = query, nextCategory = searchCategory) => {
    if (!nextQuery.trim()) return
    setQuery(nextQuery)
    setRunning(true)
    setStep(0)
    setResultsPage(1)
    setApiError('')
    let current = 0
    const timer = window.setInterval(() => { current += 1; setStep(Math.min(current, 5)); if (current >= 5) window.clearInterval(timer) }, 600)
    try {
      const isDeep = mode === 'Deep research' || mode === 'Explore' || view === 'research'
      const endpoint = '/api/research'
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: nextQuery, provider: selectedProvider, providerConfig: { endpoint: provider.endpoint, model: provider.model }, baseUrl: searchEndpoint, category: nextCategory, depth: isDeep ? 'deep' : 'quick', maxResults: 10, page: 1 }) })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || 'Research request failed')
      const normalized = normalizeSources(payload.search?.results || payload.results || [], 1)
      if (normalized.length) setSourceList(normalized)
      setHasMoreResults(Boolean(payload.search?.hasMore ?? payload.hasMore))
      setAnswer(payload.answer || 'Research completed.')
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
      const response = await fetch('/api/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, baseUrl: searchEndpoint, category: searchCategory, depth: 'quick', maxResults: 10, page }) })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || 'Search results request failed')
      setSourceList(normalizeSources(payload.results || [], page))
      setResultsPage(page)
      setHasMoreResults(Boolean(payload.hasMore))
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
        <div className="sidebar-bottom">
          <div className="status-line"><span className="status-dot" /> <span><b>System status</b><small>All systems operational</small></span><ChevronRight size={16} /></div>
          <div className="sidebar-meta"><span>v0.1.0</span><span>Local-first</span></div>
        </div>
      </aside>

      <main className={`main-shell ${view === 'search' ? 'search-shell' : ''}`}>
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

        {view === 'providers' ? <ProvidersView providers={providers} selected={selectedProvider} onConnect={connectProvider} onCheck={checkProvider} onUpdateProvider={updateProvider} searchEndpoint={searchEndpoint} onSearchEndpointChange={setSearchEndpoint} searchStatus={searchStatus} onTestSearch={testSearchEndpoint} /> : view === 'library' ? <LibraryView history={history} onOpen={openHistory} /> : (
          <div className={`workspace ${view === 'search' ? 'web-search-workspace' : ''}`}>
            <section className="answer-canvas">
              <div className="canvas-inner">
                <div className="eyebrow-row"><span className="eyebrow"><Activity size={13} /> {running ? 'Researching' : 'Research complete'}</span><button className="quiet-button"><Link2 size={14} /> Share</button></div>
                <h1>{answerTitle}</h1>
                {view === 'research' ? <><h2>Synthesis</h2><p>{answer}</p><TracePanel compact running={running} step={step} trace={traceSteps} /><p>SearXNG continues to evolve as a privacy-first metasearch backbone, adding improved engine adapters, query transformations, and local ranking plugins. Lumen keeps the retrieval layer separate so you can inspect the web evidence before asking a model to synthesize it <cite>[1][3]</cite>.</p><p>Agentic research adds planning, source ranking, contradiction checks, and explainability on top of ordinary web search—so the agent can justify an answer instead of hiding the trail <cite>[2][3]</cite>.</p><div className="sources-heading"><span>Research sources</span><span className="source-count">{sourceList.length} websites</span></div>{apiError && <div className="research-error"><CircleHelp size={15} /> {apiError}</div>}<div className="source-list">{sourceList.map((source) => <SourceRow key={source.n} source={source} />)}</div></> : <><div className="search-overview"><div><Sparkles size={15} /> AI overview</div><p>{answer}</p></div><TracePanel compact running={running} step={step} trace={traceSteps} /><div className="search-filters" role="tablist" aria-label="Search scope">{([['general', 'Web'], ['news', 'News'], ['science', 'Academic']] as const).map(([value, label]) => <button key={value} className={searchCategory === value ? 'selected' : ''} onClick={() => { setSearchCategory(value); runResearch(query, value) }} role="tab" aria-selected={searchCategory === value}>{label}</button>)}</div><div className="results-scroller"><div className="sources-heading"><span>Search results</span><span className="source-count">Page {resultsPage} · {sourceList.length} websites</span></div>{apiError && <div className="research-error"><CircleHelp size={15} /> {apiError}</div>}<div className="source-list">{sourceList.map((source) => <SourceRow key={source.n} source={source} />)}</div><nav className="pagination" aria-label="Search result pages"><button disabled={resultsPage === 1 || running} onClick={() => loadResultsPage(resultsPage - 1)}>Previous</button>{[resultsPage - 1, resultsPage, resultsPage + 1].filter((page) => page > 0 && (page <= resultsPage || hasMoreResults)).map((page) => <button key={page} className={page === resultsPage ? 'active' : ''} disabled={running} onClick={() => loadResultsPage(page)} aria-current={page === resultsPage ? 'page' : undefined}>{page}</button>)}<button disabled={!hasMoreResults || running} onClick={() => loadResultsPage(resultsPage + 1)}>Next</button></nav></div></>}
              </div>
            </section>
          </div>
        )}

        {view !== 'providers' && view !== 'library' && <form className="composer" onSubmit={(event) => { event.preventDefault(); if (input.trim()) { runResearch(input); setInput('') } }}>
          <button type="button" className="attach-button" aria-label="Attach a file"><Paperclip size={19} /></button>
          <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (input.trim()) { runResearch(input); setInput('') } } }} placeholder="Ask a follow-up or refine the research..." rows={1} />
          <div className="composer-footer"><span>Press Enter to send&nbsp; · &nbsp;Shift+Enter for new line</span><button className="send-button" aria-label="Send research query"><Send size={19} /></button></div>
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
  </a>
}

function Favicon({ url }: { url?: string }) {
  const origin = url ? (() => { try { return new URL(url).origin } catch { return '' } })() : ''
  return origin ? <img className="result-favicon" src={`${origin}/favicon.ico`} alt="" onError={(event) => { event.currentTarget.style.display = 'none' }} /> : <span className="result-favicon fallback"><Globe2 size={13} /></span>
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

  function ProvidersView({ providers, selected, onConnect, onCheck, onUpdateProvider, searchEndpoint, onSearchEndpointChange, searchStatus, onTestSearch }: { providers: Provider[]; selected: string; onConnect: (id: string) => void; onCheck: (id: string) => void; onUpdateProvider: (id: string, field: 'endpoint' | 'model', value: string) => void; searchEndpoint: string; onSearchEndpointChange: (value: string) => void; searchStatus: string; onTestSearch: () => void }) { return <div className="settings-view"><div className="settings-heading"><div><span className="section-kicker">Connections</span><h1>Providers</h1><p>Choose where Lumen reasons. Credentials stay in the local session and never enter the browser UI.</p></div><button className="primary-button"><Plus size={16} /> Add provider</button></div><div className="search-provider-card"><div><span className="provider-kind">Web search</span><h2>SearXNG</h2><p>Private metasearch for websites, documentation, GitHub, news, and more.</p></div><div className="search-endpoint-row"><label htmlFor="searxng-url">Instance URL</label><input id="searxng-url" value={searchEndpoint} onChange={(event) => onSearchEndpointChange(event.target.value)} /><button className="connect-button" onClick={onTestSearch}>Test connection</button></div>{searchStatus && <small className="search-status">{searchStatus}</small>}</div><div className="provider-grid">{providers.map((provider) => <div className={`provider-card ${selected === provider.id ? 'selected' : ''}`} key={provider.id}><div className="provider-card-top"><ProviderIcon provider={provider} /><span className="provider-kind">{provider.kind}</span></div><h2>{provider.name}</h2><p>{provider.id === 'lmstudio' ? 'Local inference with automatic model discovery.' : `OAuth session for ${provider.name} models.`}</p><div className="provider-field"><small>Endpoint</small><input className="provider-edit" value={provider.endpoint} onChange={(event) => onUpdateProvider(provider.id, 'endpoint', event.target.value)} /></div><div className="provider-field"><small>Model</small><input className="provider-edit" value={provider.model} onChange={(event) => onUpdateProvider(provider.id, 'model', event.target.value)} /></div><button className={`connect-button ${provider.connected ? 'connected-button' : ''}`} onClick={() => provider.connected ? undefined : provider.authPending ? onCheck(provider.id) : onConnect(provider.id)}>{provider.connected ? <><Check size={15} /> Connected</> : provider.authPending ? <>Check OAuth session <Settings size={14} /></> : <>Connect with OAuth <ArrowUpRight size={15} /></>}</button></div>)}</div><div className="security-note"><CircleHelp size={17} /><span><strong>OAuth is handled by local CLI sessions</strong><br />Following the Prediction pattern, Lumen exposes install/auth state only. Tokens are never returned to the browser or persisted in localStorage.</span></div></div> }
function LibraryView({ history, onOpen }: { history: SearchSession[]; onOpen: (session: SearchSession) => void }) { return history.length ? <div className="library-view"><div className="settings-heading"><div><span className="section-kicker">Local history</span><h1>Search library</h1><p>Your recent website searches and research threads stay on this device.</p></div><span className="source-count">{history.length} saved</span></div><div className="history-list">{history.map((session) => <button className="history-item" key={session.id} onClick={() => onOpen(session)}><span className="history-date">{new Date(session.createdAt).toLocaleDateString()}</span><strong>{session.query}</strong><small>{session.sources.length} web results</small><ChevronRight size={17} /></button>)}</div></div> : <div className="empty-view"><div className="empty-icon"><FileText size={26} /></div><h1>Your search library</h1><p>Saved website searches and research threads will appear here as you work.</p><button className="primary-button"><Plus size={16} /> New search</button></div> }

export default App
