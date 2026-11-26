import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  clampNumber,
  cleanString,
  createRateLimiter,
  getEnvSummary,
  usageStats,
} from './server/middleware/security.ts';
import {
  findRelevantArticles,
  getArticleById,
  getNews,
  refreshNews,
} from './server/newsService.ts';
import {
  AiServiceError,
  chatAboutTopic,
  generateBriefing,
  generateStoryArc,
  generateVernacular,
  generateVideoScript,
  summariseArticle,
  summariseArticlesBatch,
} from './server/geminiService.ts';
import { getLiveTicker } from './server/tickerService.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isProd = process.env.NODE_ENV === 'production';
const PORT = isProd ? Number(process.env.PORT) || 3000 : 3000;

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);

  // Security headers (iframe-compatible; do not set X-Frame-Options: DENY)
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.use(express.json({ limit: '64kb' }));

  const aiRateLimit = createRateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 40,
    keyPrefix: 'ai',
  });

  const refreshRateLimit = createRateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 10,
    keyPrefix: 'news-refresh',
  });

  // Health & configuration readiness (booleans only — never returns secrets)
  app.get('/api/health', (_req, res) => {
    const env = getEnvSummary();
    res.json({
      status: 'ok',
      service: 'NewsBuddy 2.0 API',
      timestamp: new Date().toISOString(),
      capabilities: {
        newsRss: true,
        ai: env.geminiConfigured,
        gnews: env.gnewsConfigured,
        marketData: env.marketProviderConfigured,
      },
      usage: usageStats,
    });
  });

  // --- NEWS ENDPOINTS (Phase 1) ---
  app.get('/api/news', async (req, res) => {
    try {
      const category = cleanString(req.query.category, 32) || 'all';
      const q = cleanString(req.query.q, 120);
      const page = clampNumber(req.query.page, 1, 50, 1);
      const limit = clampNumber(req.query.limit, 1, 50, 18);

      const data = await getNews({ category, q, page, limit });
      res.json(data);
    } catch {
      res.status(502).json({
        error: 'Unable to retrieve news feeds right now. Please try again shortly.',
      });
    }
  });

  app.get('/api/news/search', async (req, res) => {
    try {
      const q = cleanString(req.query.q, 120);
      const category = cleanString(req.query.category, 32) || 'all';
      const page = clampNumber(req.query.page, 1, 50, 1);
      const limit = clampNumber(req.query.limit, 1, 50, 18);

      const data = await getNews({ category, q, page, limit });
      res.json(data);
    } catch {
      res.status(502).json({ error: 'News search failed.' });
    }
  });

  app.get('/api/news/:id', async (req, res) => {
    const id = cleanString(req.params.id, 64);
    let article = getArticleById(id);
    if (!article) {
      await getNews({ limit: 1 });
      article = getArticleById(id);
    }
    if (!article) {
      res.status(404).json({ error: 'Article not found in current feed cache.' });
      return;
    }
    res.json({ article });
  });

  app.post('/api/news/refresh', refreshRateLimit, async (_req, res) => {
    try {
      const data = await refreshNews();
      res.json(data);
    } catch {
      res.status(502).json({ error: 'Failed to refresh news feeds.' });
    }
  });

  // --- LIVE TICKER PROXY (prevents browser CORS / geo-block failures) ---
  app.get('/api/ticker', async (_req, res) => {
    try {
      const data = await getLiveTicker();
      res.json(data);
    } catch {
      res.json({
        ok: false,
        source: null,
        retrievedAt: new Date().toISOString(),
        items: [],
        error: 'Market ticker temporarily unavailable',
      });
    }
  });

  // --- AI ENDPOINTS (Phase 2 — Server-Side Gemini Only) ---
  function handleAiError(res: express.Response, err: unknown) {
    if (err instanceof AiServiceError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    res.status(500).json({ error: 'Unexpected AI service error.', code: 'AI_INTERNAL' });
  }

  app.post('/api/ai/summarise', aiRateLimit, async (req, res) => {
    try {
      const body = req.body ?? {};
      const result = await summariseArticle({
        title: cleanString(body.title, 280),
        description: cleanString(body.description, 500),
        publisher: cleanString(body.publisher, 80),
        publishedAt: typeof body.publishedAt === 'string' ? body.publishedAt : null,
        profession: cleanString(body.profession, 40) || 'investor',
      });
      res.json(result);
    } catch (err) {
      handleAiError(res, err);
    }
  });

  app.post('/api/ai/summarise-batch', aiRateLimit, async (req, res) => {
    try {
      const body = req.body ?? {};
      const articles = Array.isArray(body.articles) ? body.articles : [];
      const result = await summariseArticlesBatch({
        articles,
        profession: cleanString(body.profession, 40) || 'investor',
      });
      res.json(result);
    } catch (err) {
      handleAiError(res, err);
    }
  });

  app.post('/api/ai/briefing', aiRateLimit, async (req, res) => {
    try {
      const query = cleanString(req.body?.query, 200);
      await getNews({ limit: 1 });
      const relevant = findRelevantArticles(query, 6);
      const result = await generateBriefing({ query, articles: relevant });
      res.json(result);
    } catch (err) {
      handleAiError(res, err);
    }
  });

  app.post('/api/ai/chat', aiRateLimit, async (req, res) => {
    try {
      const topic = cleanString(req.body?.topic, 200);
      const question = cleanString(req.body?.question, 500);
      await getNews({ limit: 1 });
      const relevant = findRelevantArticles(`${topic} ${question}`, 5);
      const result = await chatAboutTopic({ topic, question, articles: relevant });
      res.json(result);
    } catch (err) {
      handleAiError(res, err);
    }
  });

  app.post('/api/ai/video-script', aiRateLimit, async (req, res) => {
    try {
      const content = cleanString(req.body?.content, 3000);
      const language = cleanString(req.body?.language, 16) || 'en-IN';
      const result = await generateVideoScript({ content, language });
      res.json(result);
    } catch (err) {
      handleAiError(res, err);
    }
  });

  app.post('/api/ai/story-arc', aiRateLimit, async (req, res) => {
    try {
      const query = cleanString(req.body?.query, 200);
      await getNews({ limit: 1 });
      const relevant = findRelevantArticles(query, 8);
      const result = await generateStoryArc({ query, articles: relevant });
      res.json(result);
    } catch (err) {
      handleAiError(res, err);
    }
  });

  app.post('/api/ai/vernacular', aiRateLimit, async (req, res) => {
    try {
      const text = cleanString(req.body?.text, 3000);
      const result = await generateVernacular({ text });
      res.json(result);
    } catch (err) {
      handleAiError(res, err);
    }
  });

  // Frontend serving (Vite dev middleware in development, static dist in production)
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.use((_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    const env = getEnvSummary();
    console.log(
      `[NewsBuddy] Server running on http://0.0.0.0:${PORT} (mode=${isProd ? 'production' : 'development'}, aiConfigured=${env.geminiConfigured})`
    );
  });
}

startServer().catch((err) => {
  console.error('[NewsBuddy] Fatal startup error:', err instanceof Error ? err.message : 'Unknown error');
  process.exit(1);
});
