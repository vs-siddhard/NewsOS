import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  keyPrefix: string;
}

interface BucketEntry {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, BucketEntry>();

export function createRateLimiter(options: RateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const forwarded = req.headers['x-forwarded-for'];
    const rawIp = Array.isArray(forwarded)
      ? forwarded[0]
      : typeof forwarded === 'string'
        ? forwarded.split(',')[0]
        : req.ip || 'unknown';
    const ip = rawIp.trim();
    const key = `${options.keyPrefix}:${ip}`;
    const now = Date.now();

    const current = buckets.get(key);
    if (!current || now >= current.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    if (current.count >= options.maxRequests) {
      const retryAfterSec = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({
        error: 'Too many requests. Please wait a moment and try again.',
        retryAfterSec,
      });
      return;
    }

    current.count += 1;
    next();
  };
}

export function cleanString(value: unknown, maxLen: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\0/g, '').trim().slice(0, maxLen);
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

export function isSafeHttpUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  try {
    const parsed = new URL(raw.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export interface EnvValidationSummary {
  geminiConfigured: boolean;
  gnewsConfigured: boolean;
  newsApiConfigured: boolean;
  marketProviderConfigured: boolean;
}

function isNonPlaceholderKey(value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('MY_') || trimmed.startsWith('YOUR_') || trimmed === 'placeholder') {
    return false;
  }
  return true;
}

export function getEnvSummary(): EnvValidationSummary {
  return {
    geminiConfigured: isNonPlaceholderKey(process.env.GEMINI_API_KEY),
    gnewsConfigured: isNonPlaceholderKey(process.env.GNEWS_API_KEY),
    newsApiConfigured: isNonPlaceholderKey(process.env.NEWS_API_KEY),
    marketProviderConfigured: isNonPlaceholderKey(process.env.MARKET_DATA_API_KEY),
  };
}

export const usageStats = {
  newsRequests: 0,
  newsRefreshes: 0,
  aiRequests: 0,
  aiCacheHits: 0,
  aiErrors: 0,
};
