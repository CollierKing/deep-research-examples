/**
 * Utility Functions for News/PR Page Discovery
 *
 * Contains:
 * - URL parsing and domain matching
 * - Logging helpers
 * - Heuristic URL filtering (Stage 2)
 * - URL categorization (listing vs article)
 * - Root URL extraction from article paths
 */

import { URL } from 'url';
import { SearchResult } from './types';

// MARK: - URL Utilities

/**
 * Extract domain from URL
 */
export function getDomainFromUrl(url: string): string {
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    return parsed.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return url.replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0].toLowerCase();
  }
}

/**
 * Check if a URL belongs to the expected company domain
 * Handles subdomains (e.g., investors.apple.com matches apple.com)
 */
export function isUrlOnDomain(urlString: string, companyDomain: string): boolean {
  try {
    const url = new URL(urlString);
    const urlHost = url.hostname.toLowerCase();
    const targetDomain = companyDomain.toLowerCase().replace(/^www\./, '');

    // Exact match or subdomain match
    // e.g., "investors.apple.com" matches "apple.com"
    // e.g., "apple.com" matches "apple.com"
    return urlHost === targetDomain || urlHost.endsWith('.' + targetDomain);
  } catch {
    return false;
  }
}

// MARK: - Logging

/**
 * Simple logging helper with colored prefixes
 */
export function log(type: 'info' | 'success' | 'warn' | 'error', message: string): void {
  const prefix = {
    info: '[INFO]',
    success: '[OK]',
    warn: '[WARN]',
    error: '[ERR]',
  }[type];
  console.log(`${prefix} ${message}`);
}

// MARK: - Stage 2: Heuristic URL Filtering

/**
 * Filter URLs that:
 * 1. Belong to the company's domain (including subdomains)
 * 2. Have news/press-related keywords
 * 3. Are not file downloads (PDF, images, etc.)
 */
export function filterNewsRelatedUrls(results: SearchResult[], companyDomain: string): SearchResult[] {
  return results.filter((result) => {
    // CRITICAL: Must be on the company's domain
    if (!isUrlOnDomain(result.url, companyDomain)) {
      return false;
    }

    const urlLower = result.url.toLowerCase();
    const titleLower = result.title.toLowerCase();
    const snippetLower = result.snippet.toLowerCase();

    // Must have news/press keywords
    const hasRelevantKeywords =
      urlLower.includes('news') ||
      urlLower.includes('press') ||
      urlLower.includes('media') ||
      urlLower.includes('blog') ||
      urlLower.includes('updates') ||
      titleLower.includes('news') ||
      titleLower.includes('press') ||
      titleLower.includes('media') ||
      snippetLower.includes('news') ||
      snippetLower.includes('press release');

    // Filter out PDFs, images
    const isNotFile =
      !urlLower.endsWith('.pdf') &&
      !urlLower.endsWith('.jpg') &&
      !urlLower.endsWith('.png');

    return hasRelevantKeywords && isNotFile;
  });
}

/**
 * Classify URLs as listing pages vs specific articles (NO LLM)
 */
export function categorizeUrls(
  results: SearchResult[]
): {
  listingPages: SearchResult[];
  articles: SearchResult[];
} {
  const listingPages: SearchResult[] = [];
  const articles: SearchResult[] = [];

  results.forEach((result) => {
    try {
      const urlPath = result.url.split('?')[0];
      const url = new URL(result.url);
      const pathParts = url.pathname.split('/').filter((s) => s);
      const pathLower = url.pathname.toLowerCase();
      const titleLower = result.title.toLowerCase();

      // Check for year in path
      const hasYearInPath = /\/(20\d{2}|19\d{2})\//.test(urlPath);

      // Check if URL looks like a specific article by examining the last path segment
      const lastSegment = pathParts[pathParts.length - 1] || '';
      const lastSegmentLower = lastSegment.toLowerCase();

      // Indicators of a specific article:
      // 1. Has year in path (e.g., /2025/01/article)
      // 2. Last segment is very long (likely an article slug)
      // 3. Last segment contains multiple hyphens (article-title-like-this)
      // 4. Path contains words like "pressrelease", "whitepapers", "article"
      // 5. Title contains "announces", "reports", specific product names, etc.
      const hyphenCount = (lastSegment.match(/-/g) || []).length;
      const isLongSlug = lastSegment.length > 30;
      const hasMultipleHyphens = hyphenCount >= 4;
      const looksLikeArticleSlug = isLongSlug || hasMultipleHyphens;

      // Check for specific article indicators in path
      const hasArticlePathIndicators =
        pathLower.includes('/pressrelease/') ||
        pathLower.includes('/article/') ||
        pathLower.includes('/whitepapers/') ||
        pathLower.includes('/whitepaper/') ||
        pathLower.includes('/insights/') ||
        pathLower.includes('/story/') ||
        pathLower.includes('/post/');

      // Check if title indicates a specific announcement (not a listing page title)
      const hasSpecificTitleIndicators =
        titleLower.includes(' announces ') ||
        titleLower.includes(' reports ') ||
        titleLower.includes(' expands ') ||
        titleLower.includes(' launches ') ||
        titleLower.includes(' releases ') ||
        titleLower.includes(' unveils ') ||
        titleLower.includes(' introduces ') ||
        titleLower.includes('fiscal 20') ||
        titleLower.includes('q1 ') ||
        titleLower.includes('q2 ') ||
        titleLower.includes('q3 ') ||
        titleLower.includes('q4 ') ||
        titleLower.includes('quarter ') ||
        titleLower.includes('2025 review') ||
        titleLower.includes('2024 review');

      // Common listing page patterns (must be exact matches, not substrings)
      const isGenericPage =
        lastSegmentLower === '' ||
        lastSegmentLower === 'news' ||
        lastSegmentLower === 'press' ||
        lastSegmentLower === 'media' ||
        lastSegmentLower === 'newsroom' ||
        lastSegmentLower === 'press-releases' ||
        lastSegmentLower === 'news-releases' ||
        lastSegmentLower === 'presrel.html' ||
        lastSegmentLower === 'index.html' ||
        lastSegmentLower === 'announcements';

      const isSpecificArticle =
        (hasYearInPath ||
          looksLikeArticleSlug ||
          hasArticlePathIndicators ||
          hasSpecificTitleIndicators) &&
        !isGenericPage;

      if (isSpecificArticle) {
        articles.push(result);
      } else {
        listingPages.push(result);
      }
    } catch {
      // If URL parsing fails, treat as listing page
      listingPages.push(result);
    }
  });

  return { listingPages, articles };
}

/**
 * Extract potential root URLs from article paths (NO LLM)
 */
export function extractRootUrlsFromArticles(articles: SearchResult[]): SearchResult[] {
  const rootUrlCandidates = new Set<string>();

  // Limit to avoid memory issues
  const articlesToProcess = articles.slice(0, Math.min(10, articles.length));

  articlesToProcess.forEach((article) => {
    try {
      const url = new URL(article.url);
      const pathParts = url.pathname.split('/').filter((s) => s);

      // Try progressively shorter paths to find the root
      // e.g., /news-releases/2025/article -> /news-releases
      for (let i = 1; i <= Math.min(3, pathParts.length); i++) {
        const shortenedPath = '/' + pathParts.slice(0, i).join('/');
        const rootUrl = `${url.protocol}//${url.host}${shortenedPath}`;

        // Only add if path looks like it could be a news/press section
        const pathLower = shortenedPath.toLowerCase();
        if (
          pathLower.includes('news') ||
          pathLower.includes('press') ||
          pathLower.includes('media') ||
          pathLower.includes('blog')
        ) {
          rootUrlCandidates.add(rootUrl);
        }
      }
    } catch {
      // Skip invalid URLs
    }
  });

  // Convert to SearchResult format
  return Array.from(rootUrlCandidates).map((url) => ({
    title: `Extracted root: ${url}`,
    url: url,
    snippet: 'Root URL extracted from article path',
  }));
}

// MARK: - Async Helpers

/**
 * Create a delay promise
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Race a promise against a timeout
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, errorMessage: string): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(errorMessage)), ms)
  );
  return Promise.race([promise, timeoutPromise]);
}
