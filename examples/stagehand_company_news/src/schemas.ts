/**
 * Zod Schemas for News/PR Page Discovery
 *
 * These schemas define the structure for:
 * - Search result extraction from DuckDuckGo
 * - Press release page verification
 * - Navigation link extraction from homepages
 */

import { z } from 'zod';

// MARK: - Search Results Schema

/**
 * Schema for extracting DuckDuckGo search results
 */
export const SearchResultsSchema = z.object({
  results: z
    .array(
      z.object({
        title: z
          .string()
          .describe('The title/heading of the search result as shown in the listing'),
        url: z
          .string()
          .describe(
            'The URL string for this search result (e.g., "https://example.com/news"). Extract the actual destination URL text, not a DuckDuckGo redirect link.'
          ),
        snippet: z
          .string()
          .describe(
            'The brief description or snippet text shown below the title in the search result'
          ),
      })
    )
    .describe(
      'Array of search results in the EXACT order they appear on the page from top to bottom. The first result in the array must be the topmost search result on the page.'
    ),
});

// MARK: - Verification Schema

/**
 * Schema for evaluating if a page is a press release/news page
 */
export const PressReleaseVerificationSchema = z.object({
  hasNews: z
    .boolean()
    .describe(
      'True if this page contains a listing of news articles, press releases, media updates, or company announcements. Look for: multiple dated articles/posts, news archive, press release listings, media center content, or corporate news updates. False if it is just a single article, blog post, or unrelated content.'
    ),
  latestDate: z
    .string()
    .nullable()
    .describe(
      'The most recent date found on any news article or press release on this page. Format as YYYY-MM-DD if found (e.g., "2024-03-15"). Return null if no dates are visible or if hasNews is false. Look in article timestamps, publication dates, or "Posted on" labels.'
    ),
  explanation: z
    .string()
    .describe(
      'Brief explanation (1-2 sentences) of why this page does or does not contain press releases/news, and where the latest date was found if applicable.'
    ),
});

// MARK: - Navigation Links Schema

/**
 * Schema for extracting navigation links from homepage
 */
export const NewsLinksSchema = z.object({
  links: z.array(
    z.object({
      text: z.string().describe('The visible text/label of the link (e.g., "News", "Newsroom", "Press Releases")'),
      url: z
        .string()
        .describe(
          'The FULL href URL that this link points to. Must be a complete URL starting with http:// or https:// (e.g., "https://www.company.com/newsroom"). DO NOT return element IDs, numbers, or partial paths. If you cannot determine the full URL, return an empty string.'
        ),
    })
  ).describe('Array of links found on the page that lead to news/press sections. Only include links with valid full URLs.'),
});

// MARK: - Link Ranking Schema

/**
 * Schema for ranking links by likelihood of being a news/PR listing page
 */
export const LinkRankingSchema = z.object({
  rankedLinks: z.array(
    z.object({
      url: z.string().describe('The URL being ranked'),
      score: z.number().min(1).max(10).describe('Likelihood score 1-10 (10 = most likely to be news/PR listing page)'),
      reason: z.string().describe('Brief reason for the score (e.g., "URL contains /newsroom/", "Link text says Press Releases")'),
    })
  ).describe('All links ranked from most likely (highest score) to least likely (lowest score) to be the main news/press release listing page'),
});

// MARK: - Inferred Types

export type SearchResults = z.infer<typeof SearchResultsSchema>;
export type PressReleaseVerification = z.infer<typeof PressReleaseVerificationSchema>;
export type NewsLinks = z.infer<typeof NewsLinksSchema>;
export type LinkRanking = z.infer<typeof LinkRankingSchema>;
