import { isSafeHttpUrl } from './middleware/security.ts';

export interface ParsedFeedItem {
  title: string;
  description: string;
  url: string;
  publishedAt: string | null;
  author: string | null;
  categories: string[];
  imageUrl: string | null;
}

function decodeXmlEntities(input: string): string {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    });
}

function stripHtmlTags(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTag(block: string, tagNames: string[]): string {
  for (const tag of tagNames) {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const match = block.match(re);
    if (match && match[1]) {
      return decodeXmlEntities(match[1]).trim();
    }
  }
  return '';
}

function extractAllTags(block: string, tagName: string): string[] {
  const results: string[] = [];
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = re.exec(block)) !== null) {
    const val = stripHtmlTags(decodeXmlEntities(match[1] || ''));
    if (val) results.push(val);
  }
  return results;
}

function extractAtomLink(block: string): string {
  const altMatch = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  if (altMatch?.[1]) return decodeXmlEntities(altMatch[1]).trim();
  const anyMatch = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  if (anyMatch?.[1]) return decodeXmlEntities(anyMatch[1]).trim();
  return extractTag(block, ['link', 'guid']);
}

function extractImageUrl(block: string): string | null {
  const patterns = [
    /<media:content[^>]*url=["']([^"']+)["'][^>]*>/i,
    /<media:thumbnail[^>]*url=["']([^"']+)["'][^>]*>/i,
    /<enclosure[^>]*type=["']image\/[^"']+["'][^>]*url=["']([^"']+)["'][^>]*>/i,
    /<enclosure[^>]*url=["']([^"']+)["'][^>]*type=["']image\/[^"']+["'][^>]*>/i,
    /<img[^>]*src=["']([^"']+)["'][^>]*>/i,
  ];
  for (const re of patterns) {
    const match = block.match(re);
    if (match?.[1]) {
      const candidate = decodeXmlEntities(match[1]).trim();
      if (isSafeHttpUrl(candidate)) return candidate;
    }
  }
  return null;
}

function parseDateIso(raw: string): string | null {
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export function parseFeedXml(xml: string): ParsedFeedItem[] {
  const items: ParsedFeedItem[] = [];
  if (!xml || typeof xml !== 'string') return items;

  const isAtom = /<feed[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml);
  const blockRegex = isAtom ? /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi : /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;

  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(xml)) !== null) {
    const block = match[1] || '';
    const title = stripHtmlTags(extractTag(block, ['title'])).slice(0, 260);
    const rawLink = isAtom ? extractAtomLink(block) : extractTag(block, ['link', 'guid']);
    const url = rawLink.trim();

    if (!title || !isSafeHttpUrl(url)) continue;

    const rawDesc = extractTag(block, ['description', 'summary', 'content:encoded', 'content']);
    const description = stripHtmlTags(rawDesc).slice(0, 420);
    const rawDate = extractTag(block, ['pubDate', 'published', 'updated', 'dc:date']);
    const publishedAt = parseDateIso(rawDate);
    const rawAuthor = extractTag(block, ['dc:creator', 'author', 'creator']);
    const author = stripHtmlTags(rawAuthor).slice(0, 120) || null;
    const categories = extractAllTags(block, 'category').slice(0, 6);
    const imageUrl = extractImageUrl(block);

    items.push({
      title,
      description,
      url,
      publishedAt,
      author,
      categories,
      imageUrl,
    });
  }

  return items;
}
