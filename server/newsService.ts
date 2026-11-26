import { parseFeedXml } from './rssParser.ts';
import { cleanString, isSafeHttpUrl, sha256, usageStats } from './middleware/security.ts';

export type NewsCategory =
  | 'all'
  | 'business'
  | 'technology'
  | 'economy'
  | 'politics'
  | 'science'
  | 'startups'
  | 'education'
  | 'international';

export interface NewsArticle {
  id: string;
  title: string;
  description: string;
  publisher: string;
  author: string | null;
  url: string;
  publishedAt: string | null;
  retrievedAt: string;
  category: Exclude<NewsCategory, 'all'>;
  keywords: string[];
  imageUrl: string | null;
  sourceType: 'rss' | 'gnews' | 'newsapi';
}

export interface ProviderStatus {
  name: string;
  category: Exclude<NewsCategory, 'all'>;
  ok: boolean;
  itemCount: number;
  error?: string;
}

export interface NewsFeedResponse {
  articles: NewsArticle[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  cacheStatus: 'fresh' | 'cached' | 'stale_fallback' | 'error';
  lastRefreshedAt: string | null;
  sourcesSucceeded: number;
  sourcesFailed: number;
  providerStatuses: ProviderStatus[];
  errorMessage?: string;
}

interface FeedSource {
  name: string;
  url: string;
  category: Exclude<NewsCategory, 'all'>;
}

// Strict server-side allowlist of legitimate public publisher RSS feeds (no user-supplied URLs)
const RSS_SOURCES: readonly FeedSource[] = [
  { name: 'Mint Companies', url: 'https://www.livemint.com/rss/companies', category: 'business' },
  { name: 'Mint Markets', url: 'https://www.livemint.com/rss/markets', category: 'business' },
  { name: 'Economic Times Markets', url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms', category: 'business' },
  { name: 'BBC Business', url: 'https://feeds.bbci.co.uk/news/business/rss.xml', category: 'business' },
  { name: 'Mint Economy', url: 'https://www.livemint.com/rss/economy', category: 'economy' },
  { name: 'Economic Times Economy', url: 'https://economictimes.indiatimes.com/news/economy/rssfeeds/1373380680.cms', category: 'economy' },
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/', category: 'technology' },
  { name: 'BBC Technology', url: 'https://feeds.bbci.co.uk/news/technology/rss.xml', category: 'technology' },
  { name: 'Mint Technology', url: 'https://www.livemint.com/rss/technology', category: 'startups' },
  { name: 'The Hindu National', url: 'https://www.thehindu.com/news/national/feeder/default.rss', category: 'politics' },
  { name: 'BBC Science', url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', category: 'science' },
  { name: 'Mint Education', url: 'https://www.livemint.com/rss/education', category: 'education' },
  { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', category: 'international' },
];

const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

interface NewsCacheState {
  articles: NewsArticle[];
  lastRefreshedAt: string | null;
  expiresAt: number;
  providerStatuses: ProviderStatus[];
}

const cacheState: NewsCacheState = {
  articles: [],
  lastRefreshedAt: null,
  expiresAt: 0,
  providerStatuses: [],
};

let inFlightRefresh: Promise<void> | null = null;

function canonicalizeUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'fbclid', 'gclid'];
    for (const p of trackingParams) parsed.searchParams.delete(p);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function normalizeTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
}

function extractKeywords(title: string, feedCategories: string[]): string[] {
  const stopWords = new Set([
    'about', 'after', 'again', 'against', 'between', 'could', 'first', 'india',
    'indian', 'market', 'markets', 'million', 'billion', 'their', 'there', 'these',
    'those', 'through', 'under', 'where', 'which', 'while', 'would', 'years', 'today',
  ]);
  const set = new Set<string>();
  for (const cat of feedCategories) {
    const cleaned = cat.trim();
    if (cleaned.length >= 2 && cleaned.length <= 32) set.add(cleaned);
  }
  const words = title.replace(/[^a-zA-Z0-9\s]/g, ' ').split(/\s+/);
  for (const w of words) {
    const lower = w.toLowerCase();
    if (w.length >= 4 && !stopWords.has(lower) && set.size < 8) {
      set.add(w);
    }
  }
  return Array.from(set).slice(0, 8);
}

function inferCategory(
  defaultCategory: Exclude<NewsCategory, 'all'>,
  title: string,
  description: string
): Exclude<NewsCategory, 'all'> {
  const text = `${title} ${description}`.toLowerCase();
  if (/\b(startup|funding|series [a-d]|venture capital|unicorn|seed round|founder)\b/.test(text)) {
    return 'startups';
  }
  if (/\b(ai|artificial intelligence|openai|nvidia|semiconductor|llm|cybersecurity|cloud|saas)\b/.test(text)) {
    return 'technology';
  }
  if (/\b(rbi|gdp|inflation|cpi|monetary policy|fiscal|repo rate|central bank|fed rate|imf)\b/.test(text)) {
    return 'economy';
  }
  if (/\b(university|school|exam|iit|education|scholarship|curriculum|edtech)\b/.test(text)) {
    return 'education';
  }
  return defaultCategory;
}

async function fetchRssSource(source: FeedSource, retrievedAt: string): Promise<{ articles: NewsArticle[]; status: ProviderStatus }> {
  try {
    const response = await fetch(source.url, {
      headers: {
        'User-Agent': 'NewsBuddy/2.0 (RSS Reader)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        articles: [],
        status: {
          name: source.name,
          category: source.category,
          ok: false,
          itemCount: 0,
          error: `HTTP ${response.status}`,
        },
      };
    }

    const xml = await response.text();
    const parsed = parseFeedXml(xml).slice(0, 15);
    const articles: NewsArticle[] = parsed.map((item) => {
      const canonical = canonicalizeUrl(item.url);
      const category = inferCategory(source.category, item.title, item.description);
      return {
        id: sha256(canonical).slice(0, 16),
        title: item.title,
        description: item.description,
        publisher: source.name,
        author: item.author,
        url: canonical,
        publishedAt: item.publishedAt,
        retrievedAt,
        category,
        keywords: extractKeywords(item.title, item.categories),
        imageUrl: item.imageUrl,
        sourceType: 'rss',
      };
    });

    return {
      articles,
      status: {
        name: source.name,
        category: source.category,
        ok: true,
        itemCount: articles.length,
      },
    };
  } catch (err) {
    const message = err instanceof Error && err.name === 'TimeoutError'
      ? 'Request timed out'
      : 'Feed unavailable';
    return {
      articles: [],
      status: {
        name: source.name,
        category: source.category,
        ok: false,
        itemCount: 0,
        error: message,
      },
    };
  }
}

async function fetchOptionalGNews(retrievedAt: string): Promise<{ articles: NewsArticle[]; status: ProviderStatus } | null> {
  const apiKey = process.env.GNEWS_API_KEY?.trim();
  if (!apiKey || apiKey.startsWith('MY_') || apiKey.startsWith('YOUR_')) return null;

  try {
    const endpoint = new URL('https://gnews.io/api/v4/top-headlines');
    endpoint.searchParams.set('category', 'business');
    endpoint.searchParams.set('lang', 'en');
    endpoint.searchParams.set('country', 'in');
    endpoint.searchParams.set('max', '10');
    endpoint.searchParams.set('apikey', apiKey);

    const res = await fetch(endpoint.toString(), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      return {
        articles: [],
        status: { name: 'GNews API', category: 'business', ok: false, itemCount: 0, error: `HTTP ${res.status}` },
      };
    }

    const payload = (await res.json()) as {
      articles?: Array<{
        title?: string;
        description?: string;
        url?: string;
        image?: string;
        publishedAt?: string;
        source?: { name?: string };
      }>;
    };

    const items = (payload.articles || [])
      .filter((a) => a.title && isSafeHttpUrl(a.url))
      .map((a): NewsArticle => {
        const canonical = canonicalizeUrl(a.url!);
        const title = cleanString(a.title, 260);
        const description = cleanString(a.description, 420);
        return {
          id: sha256(canonical).slice(0, 16),
          title,
          description,
          publisher: cleanString(a.source?.name || 'GNews', 80),
          author: null,
          url: canonical,
          publishedAt: a.publishedAt ? new Date(a.publishedAt).toISOString() : null,
          retrievedAt,
          category: inferCategory('business', title, description),
          keywords: extractKeywords(title, []),
          imageUrl: isSafeHttpUrl(a.image) ? a.image : null,
          sourceType: 'gnews',
        };
      });

    return {
      articles: items,
      status: { name: 'GNews API', category: 'business', ok: true, itemCount: items.length },
    };
  } catch {
    return {
      articles: [],
      status: { name: 'GNews API', category: 'business', ok: false, itemCount: 0, error: 'Provider unavailable' },
    };
  }
}

function deduplicateArticles(rawArticles: NewsArticle[]): NewsArticle[] {
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  const unique: NewsArticle[] = [];

  for (const article of rawArticles) {
    const titleKey = normalizeTitleKey(article.title);
    if (seenUrls.has(article.url) || seenTitles.has(titleKey)) continue;
    seenUrls.add(article.url);
    seenTitles.add(titleKey);
    unique.push(article);
  }

  return unique.sort((a, b) => {
    const timeA = a.publishedAt ? Date.parse(a.publishedAt) : Date.parse(a.retrievedAt);
    const timeB = b.publishedAt ? Date.parse(b.publishedAt) : Date.parse(b.retrievedAt);
    return timeB - timeA;
  });
}

async function performRefresh(): Promise<void> {
  const retrievedAt = new Date().toISOString();
  const rssPromises = RSS_SOURCES.map((src) => fetchRssSource(src, retrievedAt));
  const optionalGNewsPromise = fetchOptionalGNews(retrievedAt);

  const [rssResults, gnewsResult] = await Promise.all([
    Promise.all(rssPromises),
    optionalGNewsPromise,
  ]);

  const allResults = gnewsResult ? [...rssResults, gnewsResult] : rssResults;
  const collected: NewsArticle[] = [];
  const statuses: ProviderStatus[] = [];

  for (const result of allResults) {
    statuses.push(result.status);
    collected.push(...result.articles);
  }

  const deduped = deduplicateArticles(collected);
  cacheState.providerStatuses = statuses;

  if (deduped.length > 0) {
    cacheState.articles = deduped;
    cacheState.lastRefreshedAt = retrievedAt;
    cacheState.expiresAt = Date.now() + CACHE_TTL_MS;
  }
}

export async function refreshNews(): Promise<NewsFeedResponse> {
  usageStats.newsRefreshes += 1;
  if (!inFlightRefresh) {
    inFlightRefresh = performRefresh().finally(() => {
      inFlightRefresh = null;
    });
  }
  await inFlightRefresh;
  return buildFeedResponse({ category: 'all', q: '', page: 1, limit: 24, wasFresh: true });
}

export async function getNews(params: {
  category?: string;
  q?: string;
  page?: number;
  limit?: number;
}): Promise<NewsFeedResponse> {
  usageStats.newsRequests += 1;
  const now = Date.now();
  let wasFresh = false;

  if (cacheState.articles.length === 0 || now >= cacheState.expiresAt) {
    wasFresh = true;
    if (!inFlightRefresh) {
      inFlightRefresh = performRefresh().finally(() => {
        inFlightRefresh = null;
      });
    }
    await inFlightRefresh;
  }

  return buildFeedResponse({
    category: params.category || 'all',
    q: params.q || '',
    page: params.page || 1,
    limit: params.limit || 18,
    wasFresh,
  });
}

function buildFeedResponse(params: {
  category: string;
  q: string;
  page: number;
  limit: number;
  wasFresh: boolean;
}): NewsFeedResponse {
  const validCategories: ReadonlySet<string> = new Set([
    'all', 'business', 'technology', 'economy', 'politics', 'science', 'startups', 'education', 'international',
  ]);
  const category = validCategories.has(params.category) ? params.category : 'all';
  const query = cleanString(params.q, 120).toLowerCase();
  const limit = Math.min(50, Math.max(1, Math.floor(params.limit)));
  const page = Math.max(1, Math.floor(params.page));

  const succeeded = cacheState.providerStatuses.filter((s) => s.ok).length;
  const failed = cacheState.providerStatuses.filter((s) => !s.ok).length;

  let filtered = cacheState.articles;
  if (category !== 'all') {
    filtered = filtered.filter((a) => a.category === category);
  }
  if (query) {
    filtered = filtered.filter((a) => {
      const haystack = `${a.title} ${a.description} ${a.publisher} ${a.keywords.join(' ')}`.toLowerCase();
      return haystack.includes(query);
    });
  }

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * limit;
  const articles = filtered.slice(start, start + limit);

  let cacheStatus: NewsFeedResponse['cacheStatus'] = params.wasFresh ? 'fresh' : 'cached';
  let errorMessage: string | undefined;

  if (cacheState.articles.length === 0 && succeeded === 0) {
    cacheStatus = 'error';
    errorMessage = 'All configured news providers are currently unreachable. Please try refreshing again shortly.';
  } else if (succeeded === 0 && cacheState.articles.length > 0) {
    cacheStatus = 'stale_fallback';
    errorMessage = 'Live refresh failed; showing previously retrieved cached articles.';
  }

  return {
    articles,
    total,
    page: safePage,
    limit,
    totalPages,
    cacheStatus,
    lastRefreshedAt: cacheState.lastRefreshedAt,
    sourcesSucceeded: succeeded,
    sourcesFailed: failed,
    providerStatuses: cacheState.providerStatuses,
    errorMessage,
  };
}

export function getArticleById(id: string): NewsArticle | undefined {
  return cacheState.articles.find((a) => a.id === id);
}

export function findRelevantArticles(query: string, maxResults = 6): NewsArticle[] {
  const terms = cleanString(query, 160)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3);

  if (terms.length === 0 || cacheState.articles.length === 0) {
    return cacheState.articles.slice(0, maxResults);
  }

  const scored = cacheState.articles
    .map((article) => {
      const text = `${article.title} ${article.description} ${article.keywords.join(' ')} ${article.publisher}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (article.title.toLowerCase().includes(term)) score += 3;
        else if (text.includes(term)) score += 1;
      }
      return { article, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, maxResults).map((s) => s.article);
}
