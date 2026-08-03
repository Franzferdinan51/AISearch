import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const apiUrl = (process.env.LUMEN_API_URL || 'http://127.0.0.1:3001').replace(/\/$/, '')
const categories = ['general', 'news', 'images', 'videos', 'github', 'science']

async function lumenSearch({ query, category, page, maxResults }) {
  const response = await fetch(`${apiUrl}/api/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, category, page, maxResults, curate: false, includeOverview: false }),
    signal: AbortSignal.timeout(30_000),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `Lumen API returned ${response.status}`)
  return payload
}

const server = new McpServer({ name: 'lumen-search', version: '0.1.0' })
server.registerTool('search_web', {
  title: 'Search the web with Lumen',
  description: 'Search websites through Lumen’s SearXNG backend. Returns direct website results with titles, URLs, snippets, dates, and the requested page. Use categories for news, images, videos, GitHub repositories, or academic sources.',
  inputSchema: {
    query: z.string().min(1).max(500).describe('The website search query.'),
    category: z.enum(categories).default('general').describe('Result category.'),
    page: z.number().int().min(1).default(1).describe('One-indexed results page.'),
    maxResults: z.number().int().min(1).max(10).default(10).describe('Maximum website results to return.'),
  },
}, async (input) => {
  try {
    const payload = await lumenSearch(input)
    const result = {
      query: input.query,
      category: input.category,
      page: input.page,
      hasMore: Boolean(payload.hasMore),
      results: (payload.results || []).map((item) => ({ title: item.title, url: item.url, snippet: item.content || '', publishedDate: item.publishedDate || null, source: item.engine || 'SearXNG' })),
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: `Lumen search failed: ${error.message}. Start the Lumen API and confirm LUMEN_API_URL is correct.` }] }
  }
})

server.registerTool('search_status', {
  title: 'Check Lumen search status',
  description: 'Check whether Lumen’s local search API is running and which SearXNG instance it uses.',
}, async () => {
  try {
    const response = await fetch(`${apiUrl}/api/health`, { signal: AbortSignal.timeout(5_000) })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: `Lumen API is unavailable at ${apiUrl}: ${error.message}` }] }
  }
})

await server.connect(new StdioServerTransport())
