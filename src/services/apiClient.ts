export interface ClientNewsArticle {
  id: string;
  title: string;
  description: string;
  publisher: string;
  author: string | null;
  url: string;
  publishedAt: string | null;
  retrievedAt: string;
  category: string;
  keywords: string[];
  imageUrl: string | null;
  sourceType: 'rss' | 'gnews' | 'newsapi';
}

export interface ClientNewsFeedResponse {
  articles: ClientNewsArticle[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  cacheStatus: 'fresh' | 'cached' | 'stale_fallback' | 'error';
  lastRefreshedAt: string | null;
  sourcesSucceeded: number;
  sourcesFailed: number;
  errorMessage?: string;
}

export interface ApiHealthResponse {
  status: string;
  service: string;
  timestamp: string;
  capabilities: {
    newsRss: boolean;
    ai: boolean;
    gnews: boolean;
    marketData: boolean;
  };
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      (payload && typeof payload.error === 'string' && payload.error) ||
      `Request failed (HTTP ${response.status})`;
    const err = new Error(message) as Error & { status?: number; code?: string };
    err.status = response.status;
    err.code = typeof payload?.code === 'string' ? payload.code : undefined;
    throw err;
  }

  return payload as T;
}

export function fetchHealth(): Promise<ApiHealthResponse> {
  return requestJson<ApiHealthResponse>('/api/health');
}

export function fetchNewsFeed(params: {
  category?: string;
  q?: string;
  page?: number;
  limit?: number;
}): Promise<ClientNewsFeedResponse> {
  const search = new URLSearchParams();
  if (params.category && params.category !== 'all') search.set('category', params.category);
  if (params.q) search.set('q', params.q);
  if (params.page) search.set('page', String(params.page));
  if (params.limit) search.set('limit', String(params.limit));
  return requestJson<ClientNewsFeedResponse>(`/api/news?${search.toString()}`);
}

export function refreshNewsFeed(): Promise<ClientNewsFeedResponse> {
  return requestJson<ClientNewsFeedResponse>('/api/news/refresh', { method: 'POST' });
}

export interface ClientTickerResponse {
  ok: boolean;
  source: string | null;
  retrievedAt: string;
  items: Array<{ symbol: string; price: number; changePercent: number }>;
  error?: string;
}

export function fetchTicker(): Promise<ClientTickerResponse> {
  return requestJson<ClientTickerResponse>('/api/ticker');
}

export function apiSummariseArticle(payload: {
  title: string;
  description?: string;
  publisher?: string;
  publishedAt?: string | null;
  profession: string;
}) {
  return requestJson<{
    summary: string;
    whyMatters: string;
    impact: number;
    sentiment: string;
  }>('/api/ai/summarise', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function apiSummariseBatch(payload: {
  articles: Array<{
    id: string;
    title: string;
    description?: string;
    publisher?: string;
    publishedAt?: string | null;
  }>;
  profession: string;
}) {
  return requestJson<{
    items: Array<{
      id: string;
      summary: string;
      whyMatters: string;
      impact: number;
      sentiment: string;
    }>;
  }>('/api/ai/summarise-batch', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function apiGenerateBriefing(query: string) {
  return requestJson<{
    headline: string;
    summary: string;
    insights: string[];
    contraA: string;
    contraB: string;
    sources?: Array<{ title: string; publisher: string; url: string; publishedAt: string | null }>;
  }>('/api/ai/briefing', {
    method: 'POST',
    body: JSON.stringify({ query }),
  });
}

export function apiChatAboutTopic(topic: string, question: string) {
  return requestJson<{
    answer: string;
    sources?: Array<{ title: string; publisher: string; url: string; publishedAt: string | null }>;
  }>('/api/ai/chat', {
    method: 'POST',
    body: JSON.stringify({ topic, question }),
  });
}

export function apiGenerateVideoScript(content: string, language: string) {
  return requestJson<{
    scenes: Array<{
      headline: string;
      subtitle: string;
      narration: string;
      duration: number;
      keyword: string;
    }>;
  }>('/api/ai/video-script', {
    method: 'POST',
    body: JSON.stringify({ content, language }),
  });
}

export function apiGenerateStoryArc(query: string) {
  return requestJson<{
    sentiment: number[];
    timeline: Array<{ date: string; event: string; publisher?: string; sourceUrl?: string }>;
    entities: Array<{ name: string; mentions: number; sentiment: string }>;
    predictions: string[];
    sentimentDistribution: { positive: number; neutral: number; negative: number };
    groundedArticleCount?: number;
  }>('/api/ai/story-arc', {
    method: 'POST',
    body: JSON.stringify({ query }),
  });
}

export function apiGenerateVernacular(text: string) {
  return requestJson<{
    hi: { title: string; content: string; context: string };
    ta: { title: string; content: string; context: string };
    te: { title: string; content: string; context: string };
    bn: { title: string; content: string; context: string };
  }>('/api/ai/vernacular', {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
}
