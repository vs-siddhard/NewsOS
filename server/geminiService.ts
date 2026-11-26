import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type { NewsArticle } from './newsService.ts';
import { cleanString, sha256, usageStats } from './middleware/security.ts';

const AI_CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheItem {
  value: unknown;
  expiresAt: number;
}

const aiCache = new Map<string, CacheItem>();

export class AiServiceError extends Error {
  statusCode: number;
  code: string;
  retryAfterSec?: number;

  constructor(message: string, statusCode = 500, code = 'AI_ERROR', retryAfterSec?: number) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
}

function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY' || apiKey.startsWith('YOUR_')) {
    throw new AiServiceError(
      'Gemini AI is not configured on the server. Add GEMINI_API_KEY in Settings > Secrets.',
      503,
      'AI_NOT_CONFIGURED'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function getCached<T>(key: string): T | null {
  const entry = aiCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    aiCache.delete(key);
    return null;
  }
  usageStats.aiCacheHits += 1;
  return entry.value as T;
}

function setCached(key: string, value: unknown): void {
  if (aiCache.size > 400) {
    const oldestKey = aiCache.keys().next().value;
    if (oldestKey) aiCache.delete(oldestKey);
  }
  aiCache.set(key, { value, expiresAt: Date.now() + AI_CACHE_TTL_MS });
}

function scrubSecrets(text: string): string {
  return text.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]').slice(0, 240);
}

function parseRetryAfterSec(rawMessage: string): number {
  const match = rawMessage.match(/retry(?:Delay| in)\s*[:"]*\s*(\d+(?:\.\d+)?)s/i);
  if (match?.[1]) {
    const parsed = Math.ceil(Number(match[1]));
    if (Number.isFinite(parsed) && parsed > 0) return Math.min(300, Math.max(15, parsed));
  }
  return 60;
}

function mapGeminiError(err: unknown, shouldLog = false): AiServiceError {
  if (err instanceof AiServiceError) return err;
  const rawMessage = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number })?.status;

  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(rawMessage)) {
    const retryAfterSec = parseRetryAfterSec(rawMessage);
    return new AiServiceError(
      `Gemini API quota reached. Retry in ~${retryAfterSec}s, or select a billing-enabled API key in Settings > Secrets for higher limits.`,
      429,
      'AI_QUOTA_EXCEEDED',
      retryAfterSec
    );
  }

  if (shouldLog) {
    console.warn('[NewsBuddy AI]', { status: status ?? 'unknown', message: scrubSecrets(rawMessage) });
  }

  if (status === 403 || /PERMISSION_DENIED|API_KEY_INVALID|API key not valid/i.test(rawMessage)) {
    return new AiServiceError(
      'AI request was rejected by the upstream provider. Please verify GEMINI_API_KEY in Settings > Secrets.',
      403,
      'AI_AUTH_ERROR'
    );
  }
  if (status === 404 || /NOT_FOUND/i.test(rawMessage)) {
    return new AiServiceError(
      'Configured AI model was not found upstream.',
      502,
      'AI_MODEL_NOT_FOUND'
    );
  }
  if (status === 400 || /INVALID_ARGUMENT/i.test(rawMessage)) {
    return new AiServiceError(
      'AI request parameters were rejected upstream.',
      400,
      'AI_INVALID_ARGUMENT'
    );
  }
  if (err instanceof SyntaxError || /JSON/i.test(rawMessage)) {
    return new AiServiceError(
      'AI returned an unexpected format. Please try again.',
      502,
      'AI_PARSE_ERROR'
    );
  }
  if (status === 401 || /UNAUTHENTICATED/i.test(rawMessage)) {
    return new AiServiceError(
      'AI authentication failed. Please check GEMINI_API_KEY in Settings > Secrets.',
      401,
      'AI_UNAUTHENTICATED'
    );
  }
  if (status === 503 || /UNAVAILABLE/i.test(rawMessage)) {
    return new AiServiceError(
      'AI service is temporarily overloaded upstream. Please retry in a few seconds.',
      503,
      'AI_UNAVAILABLE'
    );
  }
  if (status === 500 || /INTERNAL/i.test(rawMessage)) {
    return new AiServiceError(
      'Upstream AI service encountered an internal error. Please try again.',
      502,
      'AI_UPSTREAM_INTERNAL'
    );
  }
  if (/timed out/i.test(rawMessage)) {
    return new AiServiceError('AI request timed out. Please try again.', 504, 'AI_TIMEOUT');
  }
  return new AiServiceError('AI generation failed. Please try again shortly.', 502, `AI_UPSTREAM_${status ?? 'UNKNOWN'}`);
}

const GEMINI_PRIMARY_MODEL = 'gemini-4-hydrogen';
const GEMINI_FALLBACK_MODEL = 'gemini-3.1-flash-lite';
const PER_ATTEMPT_TIMEOUT_MS = 18000;
const inFlightRequests = new Map<string, Promise<unknown>>();
const modelQuotaCooldownUntil = new Map<string, number>();

async function generateStructuredJson<T>(params: {
  cacheKey: string;
  systemInstruction: string;
  prompt: string;
  responseSchema: Record<string, unknown>;
  thinkingLevel?: ThinkingLevel;
  preferFastModel?: boolean;
}): Promise<T> {
  const cached = getCached<T>(params.cacheKey);
  if (cached) return cached;

  const existing = inFlightRequests.get(params.cacheKey);
  if (existing) {
    return existing as Promise<T>;
  }

  const run = (async (): Promise<T> => {
    const ai = getClient();
    const now = Date.now();

    const orderedModels = params.preferFastModel
      ? [GEMINI_FALLBACK_MODEL, GEMINI_PRIMARY_MODEL]
      : [GEMINI_PRIMARY_MODEL, GEMINI_FALLBACK_MODEL];
    const availableModels = orderedModels.filter((m) => (modelQuotaCooldownUntil.get(m) ?? 0) <= now);

    if (availableModels.length === 0) {
      const earliestExpiry = Math.min(...orderedModels.map((m) => modelQuotaCooldownUntil.get(m) ?? now + 60000));
      const retryAfterSec = Math.max(5, Math.ceil((earliestExpiry - now) / 1000));
      throw new AiServiceError(
        `Gemini API quota reached. Retry in ~${retryAfterSec}s, or select a billing-enabled API key in Settings > Secrets for higher limits.`,
        429,
        'AI_QUOTA_EXCEEDED',
        retryAfterSec
      );
    }

    usageStats.aiRequests += 1;
    let lastError: unknown;

    for (let i = 0; i < availableModels.length; i++) {
      const model = availableModels[i];
      const effectiveThinkingLevel =
        model === GEMINI_FALLBACK_MODEL
          ? ThinkingLevel.MINIMAL
          : (params.thinkingLevel ?? ThinkingLevel.LOW);
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      try {
        const responsePromise = ai.models.generateContent({
          model,
          contents: params.prompt,
          config: {
            systemInstruction: params.systemInstruction,
            responseMimeType: 'application/json',
            responseSchema: params.responseSchema,
            thinkingConfig: {
              thinkingLevel: effectiveThinkingLevel,
            },
          },
        });

        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('Gemini request timed out')), PER_ATTEMPT_TIMEOUT_MS);
        });

        const response = await Promise.race([responsePromise, timeoutPromise]);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        const rawText = (response.text ?? '').trim();
        if (!rawText) {
          throw new AiServiceError('AI returned an empty response.', 502, 'AI_EMPTY');
        }

        const cleaned = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
        const parsed = JSON.parse(cleaned) as T;
        setCached(params.cacheKey, parsed);
        return parsed;
      } catch (err) {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        lastError = err;
        const mapped = mapGeminiError(err, false);
        if (mapped.statusCode === 429) {
          modelQuotaCooldownUntil.set(model, Date.now() + (mapped.retryAfterSec ?? 60) * 1000);
        }
        if (mapped.statusCode === 401 || mapped.statusCode === 403 || mapped.code === 'AI_NOT_CONFIGURED') {
          usageStats.aiErrors += 1;
          throw mapGeminiError(err, true);
        }
        if (i < availableModels.length - 1) {
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    }

    usageStats.aiErrors += 1;
    throw mapGeminiError(lastError, true);
  })();

  inFlightRequests.set(params.cacheKey, run);
  try {
    return await run;
  } finally {
    inFlightRequests.delete(params.cacheKey);
  }
}

function formatArticlesContext(articles: NewsArticle[]): string {
  if (!articles.length) return 'No matching live articles were retrieved in the current feed.';
  return articles
    .map(
      (a, idx) =>
        `[Source ${idx + 1}] Title: ${a.title}\nPublisher: ${a.publisher}\nPublished: ${a.publishedAt || 'Unknown'}\nURL: ${a.url}\nExcerpt: ${a.description || 'No excerpt available.'}`
    )
    .join('\n\n');
}

export async function summariseArticle(input: {
  title: string;
  description?: string;
  publisher?: string;
  publishedAt?: string | null;
  profession: string;
}) {
  const title = cleanString(input.title, 280);
  const description = cleanString(input.description || '', 500);
  const publisher = cleanString(input.publisher || 'News Source', 80);
  const profession = cleanString(input.profession || 'investor', 40);

  if (!title) {
    throw new AiServiceError('Article title is required.', 400, 'INVALID_INPUT');
  }

  const cacheKey = sha256(`summarise:${profession}:${title}:${description}`);
  return generateStructuredJson<{
    summary: string;
    whyMatters: string;
    impact: number;
    sentiment: 'Bullish' | 'Neutral' | 'Bearish';
  }>({
    cacheKey,
    systemInstruction: `You are a factual business news analyst writing for a ${profession}. Base your response strictly on the provided article title and excerpt. Do not invent numbers, quotes, or claims not present in the source.`,
    prompt: `Publisher: ${publisher}\nPublished: ${input.publishedAt || 'Recent'}\nTitle: ${title}\nExcerpt: ${description || 'No excerpt provided.'}\n\nProvide a concise grounded summary (~25-35 words), why it matters for a ${profession} (~15-25 words), an impact score from 1 to 10, and overall sentiment (Bullish, Neutral, or Bearish).`,
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        summary: { type: Type.STRING },
        whyMatters: { type: Type.STRING },
        impact: { type: Type.INTEGER },
        sentiment: { type: Type.STRING },
      },
      required: ['summary', 'whyMatters', 'impact', 'sentiment'],
    },
  });
}

export async function summariseArticlesBatch(input: {
  articles: Array<{
    id: string;
    title: string;
    description?: string;
    publisher?: string;
    publishedAt?: string | null;
  }>;
  profession: string;
}) {
  const profession = cleanString(input.profession || 'investor', 40);
  const items = (input.articles || [])
    .slice(0, 6)
    .map((a) => ({
      id: cleanString(a.id, 64),
      title: cleanString(a.title, 260),
      description: cleanString(a.description || '', 360),
      publisher: cleanString(a.publisher || 'News Source', 80),
      publishedAt: typeof a.publishedAt === 'string' ? a.publishedAt : null,
    }))
    .filter((a) => a.id && a.title);

  if (items.length === 0) {
    throw new AiServiceError('At least one article is required.', 400, 'INVALID_INPUT');
  }

  const cacheKey = sha256(`summarise-batch:${profession}:${items.map((i) => `${i.id}:${i.title}`).join('|')}`);
  const formatted = items
    .map(
      (a, idx) =>
        `[${idx + 1}] id="${a.id}" | Publisher: ${a.publisher} | Title: ${a.title} | Excerpt: ${a.description || 'None'}`
    )
    .join('\n');

  return generateStructuredJson<{
    items: Array<{
      id: string;
      summary: string;
      whyMatters: string;
      impact: number;
      sentiment: 'Bullish' | 'Neutral' | 'Bearish';
    }>;
  }>({
    cacheKey,
    preferFastModel: true,
    systemInstruction: `You are a factual business news analyst writing for a ${profession}. Base every summary strictly on the provided title and excerpt. Do not fabricate numbers, quotes, or claims.`,
    prompt: `Summarize each article below for a ${profession}. Return an array matching every input id with: summary (~22-30 words), whyMatters (~15-20 words), impact (integer 1-10), and sentiment ("Bullish", "Neutral", or "Bearish").\n\n${formatted}`,
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        items: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING },
              summary: { type: Type.STRING },
              whyMatters: { type: Type.STRING },
              impact: { type: Type.INTEGER },
              sentiment: { type: Type.STRING },
            },
            required: ['id', 'summary', 'whyMatters', 'impact', 'sentiment'],
          },
        },
      },
      required: ['items'],
    },
  });
}

export async function generateBriefing(input: {
  query: string;
  articles: NewsArticle[];
}) {
  const query = cleanString(input.query, 200);
  if (!query) {
    throw new AiServiceError('Briefing topic query is required.', 400, 'INVALID_INPUT');
  }

  const context = formatArticlesContext(input.articles);
  const cacheKey = sha256(`briefing:${query}:${input.articles.map((a) => a.id).join(',')}`);

  const result = await generateStructuredJson<{
    headline: string;
    summary: string;
    insights: string[];
    contraA: string;
    contraB: string;
  }>({
    cacheKey,
    systemInstruction:
      'You are NewsBuddy, a source-grounded research engine. Synthesize a clear briefing using the provided retrieved articles. Clearly distinguish verified source facts from analytical perspectives. Never invent citations or fake URLs. If retrieved coverage is limited, explicitly mention that in the summary.',
    prompt: `Topic: ${query}\n\nRetrieved Articles:\n${context}\n\nCreate a briefing with a headline, a 3-sentence grounded summary, 5 concise key insights, and two contrasting analytical viewpoints (contraA and contraB).`,
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        headline: { type: Type.STRING },
        summary: { type: Type.STRING },
        insights: { type: Type.ARRAY, items: { type: Type.STRING } },
        contraA: { type: Type.STRING },
        contraB: { type: Type.STRING },
      },
      required: ['headline', 'summary', 'insights', 'contraA', 'contraB'],
    },
  });

  return {
    ...result,
    sources: input.articles.map((a) => ({
      id: a.id,
      title: a.title,
      publisher: a.publisher,
      url: a.url,
      publishedAt: a.publishedAt,
    })),
  };
}

export async function chatAboutTopic(input: {
  topic: string;
  question: string;
  articles: NewsArticle[];
}) {
  const topic = cleanString(input.topic, 200);
  const question = cleanString(input.question, 500);
  if (!question) {
    throw new AiServiceError('Question is required.', 400, 'INVALID_INPUT');
  }

  const context = formatArticlesContext(input.articles);
  const cacheKey = sha256(`chat:${topic}:${question}:${input.articles.map((a) => a.id).join(',')}`);

  const result = await generateStructuredJson<{ answer: string }>({
    cacheKey,
    systemInstruction:
      'You are Ask NewsBuddy. Answer concisely in under 120 words, grounded in the provided articles. If the sources do not contain enough evidence to answer definitively, state that clearly instead of guessing.',
    prompt: `Topic: ${topic || 'Current News'}\nQuestion: ${question}\n\nRetrieved Sources:\n${context}`,
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        answer: { type: Type.STRING },
      },
      required: ['answer'],
    },
  });

  return {
    answer: result.answer,
    sources: input.articles.slice(0, 4).map((a) => ({
      title: a.title,
      publisher: a.publisher,
      url: a.url,
      publishedAt: a.publishedAt,
    })),
  };
}

export async function generateVideoScript(input: {
  content: string;
  language?: string;
}) {
  const content = cleanString(input.content, 3000);
  const language = cleanString(input.language || 'en-IN', 16);
  if (!content) {
    throw new AiServiceError('Source material is required to generate a storyboard.', 400, 'INVALID_INPUT');
  }

  const langLabel: Record<string, string> = {
    'en-IN': 'English',
    'hi-IN': 'Hindi',
    'ta-IN': 'Tamil',
    'te-IN': 'Telugu',
    'bn-IN': 'Bengali',
  };
  const targetLanguage = langLabel[language] || 'English';

  const cacheKey = sha256(`video:${targetLanguage}:${content}`);
  return generateStructuredJson<{
    scenes: Array<{
      headline: string;
      subtitle: string;
      narration: string;
      duration: number;
      keyword: string;
    }>;
  }>({
    cacheKey,
    systemInstruction: `You are a factual news video producer. Create a 5-scene storyboard script grounded strictly in the provided source text. Write narration in ${targetLanguage}, keep headlines punchy, and preserve exact company names, stock tickers, dates, and numbers. For each scene, provide a single English visual keyword (e.g., "skyscraper", "trading", "microchip") for background imagery.`,
    prompt: `Source material:\n${content}\n\nGenerate 5 scenes with headline, subtitle, narration (${targetLanguage}), duration (integer 4-7 seconds), and keyword.`,
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        scenes: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              headline: { type: Type.STRING },
              subtitle: { type: Type.STRING },
              narration: { type: Type.STRING },
              duration: { type: Type.INTEGER },
              keyword: { type: Type.STRING },
            },
            required: ['headline', 'subtitle', 'narration', 'duration', 'keyword'],
          },
        },
      },
      required: ['scenes'],
    },
  });
}

export async function generateStoryArc(input: {
  query: string;
  articles: NewsArticle[];
}) {
  const query = cleanString(input.query, 200);
  if (!query) {
    throw new AiServiceError('Story topic is required.', 400, 'INVALID_INPUT');
  }

  const context = formatArticlesContext(input.articles);
  const cacheKey = sha256(`tracker:${query}:${input.articles.map((a) => a.id).join(',')}`);

  const result = await generateStructuredJson<{
    sentiment: number[];
    timeline: Array<{ date: string; event: string; sourceUrl?: string; publisher?: string }>;
    entities: Array<{ name: string; mentions: number; sentiment: string }>;
    predictions: string[];
    sentimentDistribution: { positive: number; neutral: number; negative: number };
  }>({
    cacheKey,
    systemInstruction:
      'You are a factual news analyst visualizing a developing story arc. Use the retrieved articles and their exact dates/publishers wherever available. Do not invent fake URLs; only include a sourceUrl if it matches one of the provided URLs verbatim. Clearly phrase predictions as analytical scenarios, not guaranteed outcomes.',
    prompt: `Topic: ${query}\n\nRetrieved Articles:\n${context}\n\nProvide:\n- sentiment: array of 5-6 numbers (0-100) reflecting chronological tone\n- timeline: chronological array of { date (YYYY-MM-DD), event, publisher, sourceUrl }\n- entities: array of { name, mentions (integer), sentiment ("Positive"|"Neutral"|"Negative") }\n- predictions: 2-3 analytical scenarios to watch\n- sentimentDistribution: { positive, neutral, negative } summing to 100`,
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        sentiment: { type: Type.ARRAY, items: { type: Type.NUMBER } },
        timeline: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              date: { type: Type.STRING },
              event: { type: Type.STRING },
              publisher: { type: Type.STRING },
              sourceUrl: { type: Type.STRING },
            },
            required: ['date', 'event'],
          },
        },
        entities: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              mentions: { type: Type.INTEGER },
              sentiment: { type: Type.STRING },
            },
            required: ['name', 'mentions', 'sentiment'],
          },
        },
        predictions: { type: Type.ARRAY, items: { type: Type.STRING } },
        sentimentDistribution: {
          type: Type.OBJECT,
          properties: {
            positive: { type: Type.NUMBER },
            neutral: { type: Type.NUMBER },
            negative: { type: Type.NUMBER },
          },
          required: ['positive', 'neutral', 'negative'],
        },
      },
      required: ['sentiment', 'timeline', 'entities', 'predictions', 'sentimentDistribution'],
    },
  });

  // Strictly verify any returned sourceUrl belongs to our retrieved articles
  const validUrls = new Set(input.articles.map((a) => a.url));
  result.timeline = (result.timeline || []).map((item) => ({
    ...item,
    sourceUrl: item.sourceUrl && validUrls.has(item.sourceUrl) ? item.sourceUrl : undefined,
  }));

  return {
    ...result,
    groundedArticleCount: input.articles.length,
  };
}

export async function generateVernacular(input: { text: string }) {
  const text = cleanString(input.text, 3000);
  if (!text) {
    throw new AiServiceError('Article text is required for localization.', 400, 'INVALID_INPUT');
  }

  const cacheKey = sha256(`vernacular:${text}`);
  const langSchema = {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING },
      content: { type: Type.STRING },
      context: { type: Type.STRING },
    },
    required: ['title', 'content', 'context'],
  };

  return generateStructuredJson<{
    hi: { title: string; content: string; context: string };
    ta: { title: string; content: string; context: string };
    te: { title: string; content: string; context: string };
    bn: { title: string; content: string; context: string };
  }>({
    cacheKey,
    systemInstruction:
      'You are an Indian multilingual news localization specialist. Translate and adapt the provided news text naturally for Hindi (hi), Tamil (ta), Telugu (te), and Bengali (bn) readers while strictly preserving proper names, company names, stock ticker symbols, dates, URLs, and financial figures.',
    prompt: `Article:\n${text}\n\nProvide localized title, content, and a brief local context note explaining regional phrasing choices for hi, ta, te, and bn.`,
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        hi: langSchema,
        ta: langSchema,
        te: langSchema,
        bn: langSchema,
      },
      required: ['hi', 'ta', 'te', 'bn'],
    },
  });
}
