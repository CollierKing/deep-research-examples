/**
 * LLM Prompts for News/PR Page Discovery
 *
 * Contains all prompts used for:
 * - Search result extraction
 * - Press release page verification (with 12 examples)
 * - Homepage link verification
 */

// MARK: - Search Extraction Prompt

/**
 * Generate the search results extraction instruction
 */
export function getSearchExtractionInstruction(maxResults: number): string {
  return `
Extract the organic search results from this DuckDuckGo results page IN THE EXACT ORDER they appear on the page.

For each search result, identify:
1. The title/heading of the result (the clickable blue link text)
2. The destination URL (the actual link, NOT DuckDuckGo's redirect URL)
3. The snippet/description text shown below the title

Important guidelines:
- ONLY extract organic search results, not ads or sponsored results
- Skip navigation links, footer links, or DuckDuckGo's own links
- Extract up to ${maxResults} results
- The URL should be the actual destination website URL
- Look for results that appear to be news, press release, or media pages
- CRITICAL: Preserve the exact order of results as they appear on the page (top to bottom)

If there are no search results (e.g., "No results found"), return an empty array.
  `.trim();
}

// MARK: - Verification Prompt (12 Examples)

/**
 * Generate the detailed verification instruction with 12 examples
 * Used for verifying candidates from search results (Stage 3)
 */
export function getVerificationInstruction(): string {
  return `
Determine if this is the MAIN press release listing page. Use these examples to guide your decision:

EXAMPLE 1 - ACCEPT
URL: https://investors.company.com/press-releases
Page shows: List of 20+ press releases with titles like:
- "Company Reports Q4 2024 Financial Results" (Dec 15, 2024)
- "Company Announces New Partnership with Tech Corp" (Nov 30, 2024)
- "Company Appoints New Chief Financial Officer" (Nov 10, 2024)
Decision: hasNews = TRUE (this is a listing page showing multiple press releases)

EXAMPLE 2 - REJECT
URL: https://investors.company.com/press-releases/company-reports-q4-2024-financial-results
Page shows: Single full article titled "Company Reports Q4 2024 Financial Results" with multiple paragraphs of text, detailed financial tables, and forward-looking statements
Decision: hasNews = FALSE (this is ONE specific press release article, not the listing page)

EXAMPLE 3 - REJECT
URL: https://adsknews.autodesk.com/en/pressrelease/autodesk-inc-announces-fiscal-2026-second-quarter-results
Page shows: Single press release with title "Autodesk Inc. Announces Fiscal 2026 Second Quarter Results", full article text, contact information at bottom
Decision: hasNews = FALSE (URL contains "/pressrelease/" and shows one specific announcement, not a list)

EXAMPLE 4 - REJECT
URL: https://www.asteralabs.com/news/astera-labs-expands-collaboration-with-nvidia-to-advance-nvlink-fusion-ecosystem
Page shows: Single news article with title "Astera Labs Expands Collaboration with NVIDIA...", detailed article content, publication date
Decision: hasNews = FALSE (long URL slug with full article title, shows single article content)

EXAMPLE 5 - REJECT
URL: https://www.amnhealthcare.com/amn-insights/physician/whitepapers/2025-review-of-physician-and-advanced-practitioner-recruiting-incentives/
Page shows: Single whitepaper page with title "2025 Review of Physician and Advanced Practitioner Recruiting Incentives", download button, description text
Decision: hasNews = FALSE (URL contains "/whitepapers/" and shows one document, not a press release listing)

EXAMPLE 6 - REJECT
URL: https://investors.company.com/press-releases?page=2
Page shows: List of press releases, but "Page 2 of 10" at bottom
Decision: hasNews = FALSE (this is page 2, not the main listing page)

EXAMPLE 7 - REJECT
URL: https://ir.company.com/sec-filings/all-sec-filings/content/0001628280-24-003688/form8-k.htm
Page shows: SEC Form 8-K filing document
Decision: hasNews = FALSE (this is a SEC filing, not a press release listing)

EXAMPLE 8 - REJECT
URL: https://investors.company.com/financials/quarterly-results/default.aspx
Page shows: Table of quarterly financial data
Decision: hasNews = FALSE (this is financial data, not press releases)

EXAMPLE 9 - ACCEPT
URL: https://newsroom.company.com
Page shows: Grid of 15 recent news articles with dates and summaries
Decision: hasNews = TRUE (this is the main newsroom listing page)

EXAMPLE 10 - REJECT
URL: https://blog.company.com/page/2
Page shows: Blog posts on page 2
Decision: hasNews = FALSE (this is page 2, and blogs are informal content)

EXAMPLE 11 - REJECT
URL: https://company.com/news/2024/11/company-announces-merger
Page shows: Full article about merger announcement
Decision: hasNews = FALSE (this is ONE specific news article with date in URL)

EXAMPLE 12 - REJECT
URL: https://media.company.com/press-releases?o=1100
Page shows: Press releases but with query parameter indicating filtered/sorted view
Decision: hasNews = FALSE (query params suggest this is not the default main page)

NOW ANALYZE THE CURRENT PAGE:

Critical checks - ALL must pass:
1. Does this page show a LIST of MULTIPLE press releases/news items with different titles? (If you only see ONE article with its full text/content, answer NO)
2. Is this the MAIN/FIRST page? (Not page 2, 3, etc. and no pagination query params)
3. Are these formal PRESS RELEASES or official NEWS? (Not blogs, whitepapers, SEC filings, or financial tables)
4. Is the URL path simple? (Does NOT contain "/pressrelease/single-article", "/whitepapers/", "/article/", or long article slugs)
5. Is the page content showing a LIST VIEW? (Multiple clickable headlines/summaries, not one full article body with paragraphs)

If ALL 5 answers are YES:
- Set hasNews to true
- Extract the most recent date from any press release (format: YYYY-MM-DD)

If ANY answer is NO:
- Set hasNews to false
- Set latestDate to null
- In explanation, clearly state which check failed
  `.trim();
}

// MARK: - Homepage Verification Prompt

/**
 * Generate the homepage verification instruction (simpler version)
 * Used for verifying links found on homepage (Stage 4)
 */
export function getHomepageVerificationInstruction(): string {
  return `
Analyze this web page to determine if it is a press release or news listing page.

Look for evidence that this page contains:
- Multiple news articles or press releases with dates
- A news archive or media center
- Corporate announcements or updates
- Press release listings

IMPORTANT: This should be a LISTING page with multiple articles, not a single specific article.
Examples of GOOD listing pages:
- /newsroom, /press-releases, /news, /media, /presrel.html, /press/releases
- Pages showing multiple dated press releases or news items
- Investor relations press release sections

Examples of BAD pages to REJECT:
- Single articles: /news/2024/company-announces-earnings
- Blog posts or articles: /press-releases/article-title-here
- Company blogs with informal content, industry insights, or thought leadership pieces
- Marketing blogs focused on tips, tutorials, or educational content
- Pages with article slugs in the path
- Personal opinion pieces or commentary

CRITICAL: Distinguish between PRESS RELEASES and BLOG POSTS:
- PRESS RELEASES: Official company announcements, earnings reports, product launches, partnerships, executive appointments
- BLOG POSTS: Informal articles, thought leadership, industry insights, how-to guides, tips, opinion pieces
- If the page is primarily a blog (even with dates), set hasNews to FALSE
- Only accept pages that contain formal press releases or official news announcements

If this page contains a LISTING of multiple PRESS RELEASES or official NEWS (not blog posts):
- Set hasNews to true
- Find the most recent date visible on any article/press release
- Extract that date in YYYY-MM-DD format

If this is a single article, blog post, informal content, or unrelated content:
- Set hasNews to false
- Set latestDate to null
  `.trim();
}

// MARK: - Homepage Link Extraction Prompt

/**
 * Prompt for extracting news/press links from homepage
 */
export const HOMEPAGE_LINKS_EXTRACTION_PROMPT = `Find all links (<a> tags) that lead to news, press releases, media center, newsroom, or announcements.

Look in:
- Main navigation menu
- Header links
- Footer links
- Sidebar menus

Include links with text like: News, Newsroom, Press, Press Releases, Media, Media Center, Announcements, Updates, Blog

CRITICAL: For each link, you MUST extract the actual href attribute value (the URL path like "/press-center" or "https://example.com/news").
- DO NOT return element IDs like [1-391] or [1-803]
- DO NOT return numbers or bracket notation
- Return the actual URL path from the href attribute
- If the href is a relative path like "/press-center", return that exact path
- If the href is a full URL like "https://example.com/news", return that

Return empty array if no news/press links found.`;

// MARK: - Site Search Prompts

/**
 * Generate the instruction for extracting site search results
 * Used after searching the site's own search functionality
 */
export function getSiteSearchResultsInstruction(): string {
  return `
Extract the search results from this page. This is the site's internal search results page.

For each search result, identify:
1. The title/heading of the result
2. The destination URL (the link the result points to)
3. Any snippet or description text shown

Important guidelines:
- Extract ALL search results visible on the page
- The URL should be the actual destination page URL
- Look for results that appear to be news, press release, or media pages
- Skip navigation elements, ads, or sidebar content
- Preserve the order of results as they appear on the page

If there are no search results, return an empty array.
  `.trim();
}

// MARK: - Link Ranking Prompt

/**
 * Generate prompt for ranking links by likelihood of being news/PR page
 */
export function getLinkRankingPrompt(links: Array<{ text: string; url: string }>): string {
  const linkList = links.map((l, i) => `${i + 1}. "${l.text}" -> ${l.url}`).join('\n');

  return `
Rank these links by how likely they are to be the MAIN press release or news LISTING page for a company.

LINKS TO RANK:
${linkList}

RANKING CRITERIA (in order of importance):
1. URL contains "press-releases", "newsroom", "press", or "news" as a path segment (score 8-10)
2. Link text explicitly says "Press Releases", "Newsroom", "News", or "Media Center" (score 7-9)
3. URL is on investor relations subdomain (investors.*, ir.*) with news path (score 7-8)
4. URL is short and looks like a section landing page, not a specific article (score 6-8)
5. URL does NOT contain dates, article slugs, or query parameters (score +1)

LOWER SCORES FOR:
- Blog pages (often informal content, not press releases) - score 3-5
- URLs with dates in path (likely specific articles) - score 2-4
- URLs with long slugs (likely specific articles) - score 2-4
- Generic "About" or "Company" pages without news keywords - score 1-3

Return ALL links with scores from 1-10, sorted by score descending (highest first).
  `.trim();
}
