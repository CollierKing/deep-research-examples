/**
 * News/PR Page Discovery Module
 *
 * Discovers company news and press release listing pages using a 3-step flow:
 *
 * Step 1: DuckDuckGo Search (PRIMARY)
 *   - Search for site:{domain} news/press keywords
 *   - Heuristic URL filtering (no LLM)
 *   - LLM verification of candidates
 *   - Return immediately on first valid result
 *
 * Step 2: Homepage Exploration (FALLBACK)
 *   - Navigate to company homepage
 *   - Use observe() to find news/press links
 *   - Expand dropdown menus with act()
 *   - Rank and verify candidates with LLM
 *
 * Step 3: Site Search (LAST RESORT)
 *   - Navigate to company homepage
 *   - Use observe() to find search icon
 *   - Use act() to open and submit searches
 *   - Try multiple search terms (news, press releases, etc.)
 *   - Observe results and verify candidates
 *
 * Key implementation details:
 * - Uses observe() + act(element) pattern for reliable interactions
 * - Heuristic URL filtering before LLM calls to reduce costs
 * - Per-step logging with step IDs for debugging
 */

import { Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';

// MARK: - Imports

import {
  SearchResultsSchema,
  PressReleaseVerificationSchema,
  LinkRankingSchema,
} from './schemas';

import {
  CompanyInput,
  DiscoveryResult,
  DiscoveryConfig,
  SearchResult,
  DiscoveryStep,
} from './types';

import {
  getSearchExtractionInstruction,
  getVerificationInstruction,
  getHomepageVerificationInstruction,
  getLinkRankingPrompt,
} from './prompts';

import {
  getDomainFromUrl,
  log,
  filterNewsRelatedUrls,
  categorizeUrls,
  extractRootUrlsFromArticles,
  delay,
} from './utils';

// MARK: - Exports

export type { CompanyInput, DiscoveryResult, DiscoveryConfig } from './types';

// MARK: - Step Tracking

/**
 * Add a step to the discovery steps array
 */
function addStep(
  steps: DiscoveryStep[],
  step: string,
  action: string,
  result: 'success' | 'skip' | 'fail' | 'info',
  detail?: string,
  url?: string
): void {
  steps.push({
    step,
    action,
    detail,
    result,
    url,
    timestamp: new Date().toISOString(),
  });
}

// MARK: - Shared Helpers

/**
 * Extract href and text from an observed element using Playwright
 *
 * Handles both CSS selectors and XPath selectors returned by observe()
 */
async function extractHrefFromElement(
  page: ReturnType<Stagehand['context']['activePage']>,
  selector: string,
  description: string
): Promise<{ text: string; href: string } | null> {
  if (!page) return null;

  try {
    const result = await page.evaluate((sel: string) => {
      let el: Element | null = null;
      if (sel.startsWith('xpath=')) {
        const xpath = sel.replace('xpath=', '');
        const xpResult = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        el = xpResult.singleNodeValue as Element | null;
      } else {
        el = document.querySelector(sel);
      }
      if (!el) return null;
      return {
        href: el.getAttribute('href'),
        text: el.textContent,
      };
    }, selector);

    if (result?.href) {
      return {
        text: (result.text || description).trim(),
        href: result.href.trim(),
      };
    }
  } catch {
    // Element not found or evaluation failed
  }

  return null;
}

/**
 * Normalize a URL (convert relative to absolute, skip anchors)
 *
 * @returns Normalized absolute URL, or null if invalid/anchor-only
 */
function normalizeUrl(url: string, baseUrl: string): string | null {
  // Skip anchor-only links
  if (url === '#' || url.startsWith('#')) return null;

  // Convert relative URLs to absolute
  if (url.startsWith('/')) {
    return `${baseUrl}${url}`;
  } else if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return `${baseUrl}/${url}`;
  }

  return url;
}

/**
 * Check if a URL is on the target domain (including subdomains)
 */
function isOnDomain(url: string, targetDomain: string): boolean {
  try {
    const urlHost = new URL(url).hostname.toLowerCase();
    const domain = targetDomain.toLowerCase();
    return urlHost === domain || urlHost.endsWith('.' + domain);
  } catch {
    return false;
  }
}

// MARK: - Step 1: DuckDuckGo Search

/**
 * Step 1: Search DuckDuckGo and verify candidates
 *
 * Flow:
 * 1A: Search DuckDuckGo for site:{domain} news/press keywords
 * 1B: Extract and filter search results (heuristic, no LLM)
 * 1C: Categorize URLs as listing pages vs articles
 * 1D: Verify each candidate with LLM until one passes
 */
async function discoverViaSearch(
  stagehand: Stagehand,
  company: CompanyInput,
  config: DiscoveryConfig,
  steps: DiscoveryStep[]
): Promise<{
  success: boolean;
  newsPageUrl: string | null;
  latestDate: string | null;
  searchResultsCount: number;
  candidatesChecked: number;
  error?: string;
}> {
  const page = stagehand.context.activePage();
  if (!page) {
    throw new Error('No active page');
  }

  // Step 1: DuckDuckGo Search
  console.log('\n' + '─'.repeat(60));
  console.log('STEP 1: Search via DuckDuckGo');
  console.log('─'.repeat(60));

  const domain = getDomainFromUrl(company.website);
  const searchQuery = `site:${domain} (news OR press OR media OR updates)`;
  const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(searchQuery)}`;

  log('info', `Target domain: ${domain}`);
  log('info', `Query: ${searchQuery}`);

  addStep(steps, '1', 'DuckDuckGo search', 'info', `Query: site:${domain} news/press keywords`, searchUrl);

  await page.goto(searchUrl, {
    waitUntil: 'networkidle',
    timeoutMs: config.timeoutMs,
  });

  await delay(config.delayBetweenActionsMs);

  // Step 1A: Extract search results
  log('info', '  Extracting search results...');

  const extractionInstruction = getSearchExtractionInstruction(config.maxSearchResults);

  // Try observe() first to find search result links, then extract URLs from them
  log('info', '  Using observe() to find search result links...');
  const observedLinks = await stagehand.observe(
    'Find all the main search result links on this page. These are the clickable result titles that link to external websites. On DuckDuckGo, these are the blue title links in each search result.'
  );
  log('info', `  Found ${observedLinks.length} observed link elements`);

  let searchResults: z.infer<typeof SearchResultsSchema>;

  if (observedLinks.length > 0) {
    // Extract URLs from observed elements
    log('info', '  Extracting URLs from observed elements...');
    const extractedResults: Array<{ title: string; url: string; snippet: string }> = [];
    const baseUrl = page.url();

    for (const link of observedLinks.slice(0, config.maxSearchResults)) {
      const result = await extractHrefFromElement(page, link.selector, link.description);
      if (result?.href) {
        // Normalize the URL
        let normalizedUrl = result.href;
        try {
          if (result.href.startsWith('/')) {
            normalizedUrl = new URL(result.href, baseUrl).href;
          } else if (!result.href.startsWith('http')) {
            normalizedUrl = new URL(result.href, baseUrl).href;
          }
        } catch {
          // Keep original if URL parsing fails
        }

        // Skip DuckDuckGo internal links
        if (normalizedUrl.includes('duckduckgo.com')) {
          continue;
        }

        extractedResults.push({
          title: result.text || link.description,
          url: normalizedUrl,
          snippet: link.description,
        });
        console.log(`    ${extractedResults.length}. ${normalizedUrl}`);
      }
    }

    if (extractedResults.length > 0) {
      searchResults = { results: extractedResults };
      addStep(steps, '1A', 'Extract search results', 'success', `Found ${extractedResults.length} results via observe`);
    } else {
      // Fall back to extract() if observe didn't yield URLs
      log('info', '  No URLs extracted from observed elements, falling back to extract()...');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      searchResults = (await stagehand.extract(extractionInstruction, SearchResultsSchema as any)) as z.infer<
        typeof SearchResultsSchema
      >;
      addStep(steps, '1A', 'Extract search results', 'success', `Found ${searchResults.results.length} results via extract`);
    }
  } else {
    // No observed links, use extract() directly
    log('info', '  No observed links, using extract()...');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    searchResults = (await stagehand.extract(extractionInstruction, SearchResultsSchema as any)) as z.infer<
      typeof SearchResultsSchema
    >;

    // Always log what we got back
    console.log('\n  === EXTRACT RESULTS ===');
    console.log(`  Raw response: ${JSON.stringify(searchResults, null, 2)}`);
    console.log(`  Results count: ${searchResults.results?.length ?? 'undefined'}`);

    if (!searchResults.results || searchResults.results.length === 0) {
      addStep(steps, '1A', 'Extract search results', 'fail', 'No results found');
      log('error', '  Extract returned 0 results - this may indicate DuckDuckGo blocked the request or the page structure changed');

      // Take a screenshot for debugging
      try {
        const screenshotPath = `/tmp/ddg-debug-${Date.now()}.png`;
        await page.screenshot({ path: screenshotPath, fullPage: true });
        log('info', `  Debug screenshot saved: ${screenshotPath}`);
      } catch {
        // Ignore screenshot errors
      }

      return {
        success: false,
        newsPageUrl: null,
        latestDate: null,
        searchResultsCount: 0,
        candidatesChecked: 0,
        error: 'No search results found - extract() returned empty',
      };
    }

    addStep(steps, '1A', 'Extract search results', 'success', `Found ${searchResults.results.length} results`);

    // Log extracted URLs
    log('info', '  Extracted URLs (in order):');
    searchResults.results.forEach((r, i) => {
      console.log(`    ${i + 1}. ${r.title || 'No title'}`);
      console.log(`       URL: ${r.url || 'No URL'}`);
      console.log(`       Snippet: ${(r.snippet || 'No snippet').substring(0, 100)}...`);
    });
  }

  log('info', `  Total search results: ${searchResults.results.length}`);

  if (searchResults.results.length === 0) {
    return {
      success: false,
      newsPageUrl: null,
      latestDate: null,
      searchResultsCount: 0,
      candidatesChecked: 0,
      error: 'No search results found',
    };
  }

  // Step 1B: Heuristic URL filtering (no LLM)
  console.log('\n' + '─'.repeat(60));
  console.log('STEP 1B: Filter & Categorize URLs');
  console.log('─'.repeat(60));
  log('info', `Filtering for domain: ${domain}`);

  // Filter out incomplete results
  const completeResults: SearchResult[] = searchResults.results.filter(
    (r): r is { title: string; url: string; snippet: string } =>
      Boolean(r.title && r.url && r.snippet)
  );

  const newsRelatedUrls = filterNewsRelatedUrls(completeResults, domain);
  log('info', `  Found ${newsRelatedUrls.length} URLs on ${domain} with news/press keywords`);

  addStep(steps, '1B', 'Filter by domain', 'info', `${newsRelatedUrls.length}/${searchResults.results.length} URLs on ${domain}`);

  // Step 1C: Categorize URLs
  const { listingPages, articles } = categorizeUrls(newsRelatedUrls);
  console.log(`  Listing pages: ${listingPages.length}, Articles: ${articles.length}`);

  addStep(steps, '1C', 'Categorize URLs', 'info', `${listingPages.length} listing pages, ${articles.length} articles`);

  // Build candidate list: listing pages first, then root URLs from articles
  const candidates: SearchResult[] = [];
  candidates.push(...listingPages.slice(0, config.maxCandidatesToCheck));

  if (articles.length > 0) {
    log('info', '  Extracting potential root URLs from articles...');
    const rootUrls = extractRootUrlsFromArticles(articles);
    log('info', `  Extracted ${rootUrls.length} potential root URLs`);

    const remaining = config.maxCandidatesToCheck - candidates.length;
    candidates.push(...rootUrls.slice(0, remaining));
  }

  log('info', `Total candidates to verify: ${candidates.length}`);

  // Step 1D: Verify each candidate with LLM
  console.log('\n' + '─'.repeat(60));
  console.log('STEP 1D: Verify Candidates');
  console.log('─'.repeat(60));
  let candidatesChecked = 0;

  for (const candidate of candidates) {
    candidatesChecked++;
    log('info', `  [${candidatesChecked}/${candidates.length}] ${candidate.url}`);

    try {
      const response = await page.goto(candidate.url, {
        waitUntil: 'networkidle',
        timeoutMs: config.timeoutMs,
      });

      const status = response?.status();
      if (!status || status >= 400) {
        log('warn', `    HTTP ${status || 'unknown'} - skipping`);
        addStep(steps, `1D-${candidatesChecked}`, 'Check candidate', 'skip', `HTTP ${status || 'unknown'}`, candidate.url);
        continue;
      }

      await delay(config.delayBetweenActionsMs / 2);

      // LLM verification
      const verificationInstruction = getVerificationInstruction();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const verification = (await stagehand.extract(verificationInstruction, PressReleaseVerificationSchema as any)) as z.infer<
        typeof PressReleaseVerificationSchema
      >;

      log('info', `    ${verification.hasNews ? 'VALID' : 'INVALID'}: ${verification.explanation}`);

      if (verification.hasNews) {
        // Double-check URL is still accessible
        log('info', `    Validating URL...`);
        const validationResponse = await page.goto(candidate.url, {
          waitUntil: 'domcontentloaded',
          timeoutMs: config.timeoutMs,
        });

        const validationStatus = validationResponse?.status();
        if (!validationStatus || validationStatus >= 400) {
          log('warn', `    Validation failed: HTTP ${validationStatus || 'unknown'}`);
          addStep(steps, `1D-${candidatesChecked}`, 'Verify candidate', 'fail', `Validation failed: HTTP ${validationStatus}`, candidate.url);
          continue;
        }

        addStep(steps, `1D-${candidatesChecked}`, 'Verify candidate', 'success', verification.explanation, candidate.url);

        console.log('\n' + '='.repeat(60));
        console.log(`FOUND: ${candidate.url}`);
        console.log(`Latest Date: ${verification.latestDate || 'N/A'}`);
        console.log('='.repeat(60));

        return {
          success: true,
          newsPageUrl: candidate.url,
          latestDate: verification.latestDate,
          searchResultsCount: searchResults.results.length,
          candidatesChecked,
        };
      } else {
        addStep(steps, `1D-${candidatesChecked}`, 'Verify candidate', 'fail', verification.explanation, candidate.url);
      }
    } catch (verifyError) {
      log('warn', `    Error: ${verifyError instanceof Error ? verifyError.message : 'Unknown'}`);
    }
  }

  return {
    success: false,
    newsPageUrl: null,
    latestDate: null,
    searchResultsCount: searchResults.results.length,
    candidatesChecked,
    error: 'No valid press release pages found in search results',
  };
}

// MARK: - Step 2: Homepage Exploration

/**
 * Step 2: Homepage exploration fallback
 *
 * Flow:
 * 2A: Navigate to homepage, expand dropdown menus
 * 2B: Use observe() to find news/press links, filter by domain/keywords
 * 2C: Rank links by likelihood using LLM
 * 2D: Verify each candidate until one passes
 */
async function discoverViaHomepage(
  stagehand: Stagehand,
  company: CompanyInput,
  config: DiscoveryConfig,
  steps: DiscoveryStep[]
): Promise<{
  success: boolean;
  newsPageUrl: string | null;
  latestDate: string | null;
  candidatesChecked: number;
  error?: string;
}> {
  const page = stagehand.context.activePage();
  if (!page) {
    throw new Error('No active page');
  }

  console.log('\n' + '─'.repeat(60));
  console.log('STEP 2: Homepage Link Extraction');
  console.log('─'.repeat(60));

  const companyUrl = company.website.startsWith('http') ? company.website : `https://${company.website}`;
  const domain = getDomainFromUrl(company.website);
  const baseUrl = companyUrl.endsWith('/') ? companyUrl.slice(0, -1) : companyUrl;

  log('info', `  Navigating to: ${companyUrl}`);
  addStep(steps, '2', 'Navigate to homepage', 'info', company.website, companyUrl);

  try {
    await page.goto(companyUrl, {
      waitUntil: 'domcontentloaded',
      timeoutMs: config.timeoutMs,
    });
    await delay(2000);
  } catch (navError) {
    log('warn', `  Failed to navigate: ${navError instanceof Error ? navError.message : 'Unknown'}`);
    addStep(steps, '2', 'Navigate to homepage', 'fail', navError instanceof Error ? navError.message : 'Unknown');
    return {
      success: false,
      newsPageUrl: null,
      latestDate: null,
      candidatesChecked: 0,
      error: `Failed to navigate to homepage: ${navError instanceof Error ? navError.message : 'Unknown'}`,
    };
  }

  await delay(config.delayBetweenActionsMs);

  // Step 2A: Skip dropdown expansion - it seems to be causing navigation issues
  // Just try to observe links directly from the current page
  log('info', '  Skipping dropdown expansion (observe will find all visible and expandable links)');
  addStep(steps, '2A', 'Expand nav dropdowns', 'skip', 'Skipping - observe() searches the full page');

  // Use observe() to find news/press links
  log('info', '  Looking for news/press links on homepage...');

  const validLinks: Array<{ text: string; url: string }> = [];

  try {
    log('info', `  Current page URL: ${page.url()}`);
    const actions = await stagehand.observe(
      'Find all links (<a> tags) related to company news or press releases. This includes links with text like: News, Newsroom, Press, Press Center, Press Releases, Media, Media Center, Media Room, Announcements, Updates, Investor News, Corporate News, Latest News, or any similar variations. Look in navigation menus, dropdowns, header, footer, and sidebar sections.'
    );

    console.log(`\n  Observe found ${actions.length} elements:`);
    actions.forEach((action, i) => {
      console.log(`    ${i + 1}. "${action.description}" -> selector: ${action.selector}`);
    });

    // Extract hrefs from observed elements
    if (actions.length > 0) {
      console.log(`\n  Extracting URLs from ${actions.length} observed elements:`);
    }
    for (const action of actions) {
      const result = await extractHrefFromElement(page, action.selector, action.description);
      if (result?.href) {
        const normalizedUrl = normalizeUrl(result.href, baseUrl);
        if (normalizedUrl) {
          validLinks.push({ text: result.text, url: normalizedUrl });
          console.log(`    ✓ "${action.description}" -> ${normalizedUrl}`);
        } else {
          console.log(`    ✗ "${action.description}" -> invalid URL: ${result.href}`);
        }
      } else {
        console.log(`    ✗ "${action.description}" -> could not extract href`);
      }
    }
  } catch (observeError) {
    log('warn', `  Failed to observe links: ${observeError instanceof Error ? observeError.message : 'Unknown'}`);
  }

  // Deduplicate links by URL
  const seenUrls = new Set<string>();
  const uniqueLinks = validLinks.filter((link) => {
    if (seenUrls.has(link.url)) return false;
    seenUrls.add(link.url);
    return true;
  });

  log('info', `Found ${uniqueLinks.length} unique link(s) (${validLinks.length - uniqueLinks.length} duplicates removed)`);

  if (uniqueLinks.length === 0) {
    addStep(steps, '2B', 'Extract nav links', 'info', 'No valid links found');
    log('info', '  No news/press links found on homepage');
    return {
      success: false,
      newsPageUrl: null,
      latestDate: null,
      candidatesChecked: 0,
      error: 'No news/press links found on homepage',
    };
  }

  // Step 2B: Filter by domain and keywords
  console.log('\n' + '─'.repeat(60));
  console.log('STEP 2B: Filter & Categorize Links');
  console.log('─'.repeat(60));

  log('info', `Filtering for domain: ${domain}`);

  const domainFilteredLinks = uniqueLinks.filter((link) => {
    const urlLower = link.url.toLowerCase();
    const textLower = link.text.toLowerCase();

    // Must be on the company's domain
    if (!isOnDomain(link.url, domain)) {
      console.log(`    ✗ WRONG DOMAIN: "${link.text}" -> ${link.url}`);
      return false;
    }

    // Filter out PDFs, images
    if (urlLower.endsWith('.pdf') || urlLower.endsWith('.jpg') || urlLower.endsWith('.png')) {
      console.log(`    ✗ FILE TYPE: "${link.text}" -> ${link.url}`);
      return false;
    }

    // Must have news/press keywords in URL or link text
    const keywords = ['news', 'press', 'media', 'blog', 'updates', 'investor', 'announcement'];
    const hasKeyword = keywords.some(kw => urlLower.includes(kw) || textLower.includes(kw));
    if (!hasKeyword) {
      console.log(`    ✗ NO KEYWORDS: "${link.text}" -> ${link.url}`);
      return false;
    }

    console.log(`    ✓ PASS: "${link.text}" -> ${link.url}`);
    return true;
  });

  log('info', `  After domain/keyword filter: ${domainFilteredLinks.length}/${uniqueLinks.length} links`);
  addStep(steps, '2B', 'Filter by domain/keywords', 'info', `${domainFilteredLinks.length}/${uniqueLinks.length} links match`);

  // Convert to SearchResult format for categorization
  const linksAsSearchResults: SearchResult[] = domainFilteredLinks.map(link => ({
    title: link.text,
    url: link.url,
    snippet: '',
  }));

  const { listingPages, articles } = categorizeUrls(linksAsSearchResults);
  log('info', `  Listing pages: ${listingPages.length}, Articles: ${articles.length}`);
  addStep(steps, '2B', 'Categorize URLs', 'info', `${listingPages.length} listing pages, ${articles.length} articles`);

  // Prioritize listing pages, then articles
  let filteredLinks: Array<{ text: string; url: string }> = [
    ...listingPages.map(r => ({ text: r.title, url: r.url })),
    ...articles.map(r => ({ text: r.title, url: r.url })),
  ];

  if (filteredLinks.length === 0) {
    log('warn', '  Filtering removed all links, using original unique links');
    addStep(steps, '2B', 'Filter fallback', 'info', 'Using all unique links (filtering too strict)');
    filteredLinks = [...uniqueLinks];
  }

  console.log('\n  Filtered links (listing pages first):');
  filteredLinks.forEach((link, i) => {
    console.log(`    ${i + 1}. "${link.text}" -> ${link.url}`);
  });

  // Step 2C: Rank links by likelihood
  console.log('\n' + '─'.repeat(60));
  console.log('STEP 2C: Rank Links by Likelihood');
  console.log('─'.repeat(60));
  log('info', '  Asking LLM to rank links by likelihood of being news/PR page...');

  let rankedLinks = filteredLinks;

  try {
    const rankingPrompt = getLinkRankingPrompt(filteredLinks);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ranking = (await stagehand.extract(rankingPrompt, LinkRankingSchema as any)) as z.infer<typeof LinkRankingSchema>;

    if (ranking.rankedLinks && ranking.rankedLinks.length > 0) {
      const sortedRanking = [...ranking.rankedLinks].sort((a, b) => b.score - a.score);

      console.log('\n  LLM Ranking (sorted by score):');
      sortedRanking.forEach((item, i) => {
        console.log(`    ${i + 1}. [${item.score}/10] ${item.url}`);
        console.log(`       Reason: ${item.reason}`);
      });

      // Reorder links based on ranking
      const urlToLink = new Map(filteredLinks.map(l => [l.url, l]));
      rankedLinks = sortedRanking
        .map(r => urlToLink.get(r.url))
        .filter((l): l is { text: string; url: string } => l !== undefined);

      // Add any links not in ranking (shouldn't happen)
      const rankedUrls = new Set(sortedRanking.map(r => r.url));
      for (const link of filteredLinks) {
        if (!rankedUrls.has(link.url)) {
          rankedLinks.push(link);
        }
      }

      addStep(steps, '2C', 'Rank links', 'success', `Ranked ${sortedRanking.length} links by likelihood`);
    } else {
      log('warn', '  LLM returned empty ranking, using original order');
      addStep(steps, '2C', 'Rank links', 'info', 'LLM returned empty ranking, using original order');
    }
  } catch (rankError) {
    log('warn', `  Failed to rank links: ${rankError instanceof Error ? rankError.message : 'Unknown'}`);
    addStep(steps, '2C', 'Rank links', 'skip', 'Ranking failed, using original order');
  }

  // Step 2D: Verify each link
  console.log('\n' + '─'.repeat(60));
  console.log('STEP 2D: Verify Candidates');
  console.log('─'.repeat(60));

  console.log('\n  Candidates to verify (in order):');
  rankedLinks.forEach((link, i) => {
    console.log(`    ${i + 1}. ${link.text}: ${link.url}`);
  });
  console.log('');

  let candidatesChecked = 0;

  log('info', `  Verifying ${rankedLinks.length} link(s)...`);

  for (const link of rankedLinks) {
    candidatesChecked++;
    log('info', `  [${candidatesChecked}/${rankedLinks.length}] ${link.text}: ${link.url}`);

    try {
      const response = await page.goto(link.url, {
        waitUntil: 'networkidle',
        timeoutMs: config.timeoutMs,
      });

      const status = response?.status();
      if (!status || status >= 400) {
        log('warn', `    HTTP ${status || 'unknown'} - skipping`);
        addStep(steps, `2D-${candidatesChecked}`, 'Check link', 'skip', `HTTP ${status || 'unknown'}`, link.url);
        continue;
      }

      await delay(config.delayBetweenActionsMs / 2);

      // LLM verification
      const verificationInstruction = getHomepageVerificationInstruction();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const verification = (await stagehand.extract(verificationInstruction, PressReleaseVerificationSchema as any)) as z.infer<
        typeof PressReleaseVerificationSchema
      >;

      log('info', `    ${verification.hasNews ? 'VALID' : 'INVALID'}: ${verification.explanation}`);

      if (verification.hasNews) {
        log('info', `    Validating URL...`);
        const validationResponse = await page.goto(link.url, {
          waitUntil: 'domcontentloaded',
          timeoutMs: config.timeoutMs,
        });

        const validationStatus = validationResponse?.status();
        if (!validationStatus || validationStatus >= 400) {
          log('warn', `    Validation failed: HTTP ${validationStatus || 'unknown'}`);
          addStep(steps, `2D-${candidatesChecked}`, 'Verify link', 'fail', `Validation failed: HTTP ${validationStatus}`, link.url);
          continue;
        }

        log('success', `    Validated successfully (HTTP ${validationStatus})`);
        addStep(steps, `2D-${candidatesChecked}`, 'Verify link', 'success', verification.explanation, link.url);

        return {
          success: true,
          newsPageUrl: link.url,
          latestDate: verification.latestDate,
          candidatesChecked,
        };
      } else {
        addStep(steps, `2D-${candidatesChecked}`, 'Verify link', 'fail', verification.explanation, link.url);
      }
    } catch (verifyError) {
      log('warn', `    Error: ${verifyError instanceof Error ? verifyError.message : 'Unknown'}`);
    }
  }

  return {
    success: false,
    newsPageUrl: null,
    latestDate: null,
    candidatesChecked,
    error: 'No valid press release pages found on homepage',
  };
}

// MARK: - Step 3: Site Search

/**
 * Step 3: Site search fallback
 *
 * Uses the site's own search functionality to find news/PR pages.
 * Uses observe() + act(element) pattern for reliable interactions.
 *
 * Flow:
 * 3A: Use observe() to find search icon, act() to click it
 * 3B: For each search term (news, press releases, etc.):
 *     - Type search term and submit
 * 3C: Use observe() to find search result links
 * 3D: Verify each candidate until one passes
 */
async function discoverViaSiteSearch(
  stagehand: Stagehand,
  company: CompanyInput,
  config: DiscoveryConfig,
  steps: DiscoveryStep[]
): Promise<{
  success: boolean;
  newsPageUrl: string | null;
  latestDate: string | null;
  candidatesChecked: number;
  error?: string;
}> {
  const page = stagehand.context.activePage();
  if (!page) {
    throw new Error('No active page');
  }

  console.log('\n' + '─'.repeat(60));
  console.log('STEP 3: Site Search');
  console.log('─'.repeat(60));

  const companyUrl = company.website.startsWith('http') ? company.website : `https://${company.website}`;
  const domain = getDomainFromUrl(company.website);
  const baseUrl = companyUrl.endsWith('/') ? companyUrl.slice(0, -1) : companyUrl;

  log('info', `  Navigating to: ${companyUrl}`);
  addStep(steps, '3', 'Navigate to homepage for search', 'info', company.website, companyUrl);

  try {
    await page.goto(companyUrl, {
      waitUntil: 'domcontentloaded',
      timeoutMs: config.timeoutMs,
    });
    await delay(2000);
  } catch (navError) {
    log('warn', `  Failed to navigate: ${navError instanceof Error ? navError.message : 'Unknown'}`);
    addStep(steps, '3', 'Navigate to homepage', 'fail', navError instanceof Error ? navError.message : 'Unknown');
    return {
      success: false,
      newsPageUrl: null,
      latestDate: null,
      candidatesChecked: 0,
      error: `Failed to navigate to homepage: ${navError instanceof Error ? navError.message : 'Unknown'}`,
    };
  }

  // Step 3A: Find search icon using observe()
  console.log('\n' + '─'.repeat(60));
  console.log('STEP 3A: Find Site Search Icon');
  console.log('─'.repeat(60));
  log('info', '  Looking for search icon/bar on site using observe()...');
  addStep(steps, '3A', 'Find search', 'info', 'Looking for search icon on homepage');

  let searchElement: { selector: string; description: string } | null = null;
  try {
    const searchElements = await stagehand.observe(
      'Find the search icon or search button on this page. Look for a magnifying glass icon or a button/link labeled "Search" in the header or navigation bar. Do NOT select product navigation menu items.'
    );

    log('info', `  Observe found ${searchElements.length} potential search elements`);

    if (searchElements.length > 0) {
      searchElements.forEach((el, i) => {
        console.log(`    ${i + 1}. "${el.description}" -> ${el.selector}`);
      });

      searchElement = searchElements[0];
      log('info', `  Selected: "${searchElement.description}"`);
      addStep(steps, '3A', 'Find search', 'success', `Found: ${searchElement.description}`);
    }
  } catch (observeError) {
    log('warn', `  Failed to observe search elements: ${observeError instanceof Error ? observeError.message : 'Unknown'}`);
  }

  if (!searchElement) {
    log('warn', '  Could not find search icon on page');
    addStep(steps, '3A', 'Find search', 'fail', 'No search icon found');
    return {
      success: false,
      newsPageUrl: null,
      latestDate: null,
      candidatesChecked: 0,
      error: 'Could not find site search icon',
    };
  }

  // Step 3A-2: Click search icon using Playwright directly (bypasses Stagehand method validation)
  console.log('\n' + '─'.repeat(60));
  console.log('STEP 3A-2: Open Site Search');
  console.log('─'.repeat(60));
  log('info', '  Clicking search icon to open search input...');

  let searchInputOpened = false;
  try {
    // Use Playwright directly to click the element - this avoids Stagehand's method validation
    // which fails with local models that return invalid method names
    const selector = searchElement.selector;
    if (selector.startsWith('xpath=')) {
      const xpath = selector.replace('xpath=', '');
      await page.locator(`xpath=${xpath}`).click();
    } else {
      await page.locator(selector).click();
    }
    searchInputOpened = true;
    addStep(steps, '3A-2', 'Open search', 'success', 'Clicked search icon to open search input');
    await delay(1000);
    log('info', '  Open search result: success - clicked via Playwright');
  } catch (openError) {
    log('warn', `  Failed to open search: ${openError instanceof Error ? openError.message : 'Unknown'}`);
  }

  if (!searchInputOpened) {
    log('warn', '  Could not click search icon');
    addStep(steps, '3A-2', 'Open search', 'fail', 'Could not click search icon');
    return {
      success: false,
      newsPageUrl: null,
      latestDate: null,
      candidatesChecked: 0,
      error: 'Could not open site search',
    };
  }

  // Helper to re-open search using observe + Playwright click pattern
  const reopenSearch = async (): Promise<boolean> => {
    try {
      const searchElements = await stagehand.observe(
        'Find the search icon or search button in the header or navigation bar.'
      );
      if (searchElements.length > 0) {
        const selector = searchElements[0].selector;
        if (selector.startsWith('xpath=')) {
          const xpath = selector.replace('xpath=', '');
          await page.locator(`xpath=${xpath}`).click();
        } else {
          await page.locator(selector).click();
        }
        await delay(500);
        return true;
      }
    } catch {
      // Ignore errors
    }
    return false;
  };

  // Search terms to try
  const searchTerms = ['news', 'press releases', 'press', 'newsroom', 'media'];
  let searchSucceeded = false;
  let termIndex = 0;
  let totalCandidatesChecked = 0;

  for (const searchTerm of searchTerms) {
    termIndex++;
    const termLabel = searchTerm.replace(/\s+/g, '-');

    console.log('\n' + '─'.repeat(60));
    console.log(`STEP 3B-${termIndex}: Search for "${searchTerm}"`);
    console.log('─'.repeat(60));
    log('info', `  Typing search term: "${searchTerm}"`);

    try {
      const typeResult = await stagehand.act(
        `Type "${searchTerm}" into the search input field that is now open/visible and press Enter to search. The search input should already be open and focused. Just type the text and press Enter.`
      );

      log('info', `  Type result: ${typeResult.success ? 'success' : 'failed'} - ${typeResult.message}`);

      if (typeResult.success) {
        searchSucceeded = true;
        addStep(steps, `3B-${termLabel}`, 'Submit search', 'success', `Searched for "${searchTerm}"`, page.url());

        await delay(config.delayBetweenActionsMs);

        const currentUrl = page.url();
        log('info', `  Current URL after search: ${currentUrl}`);

        // Check if URL changed
        if (currentUrl === companyUrl || currentUrl === companyUrl + '/') {
          log('warn', `  URL didn't change after search, search may not have worked`);
          addStep(steps, `3B-${termLabel}`, 'Check URL', 'skip', 'URL unchanged after search');
          await reopenSearch();
          continue;
        }

        // Step 3C: Observe search results
        console.log('\n' + '─'.repeat(60));
        console.log(`STEP 3C-${termIndex}: Observe Results for "${searchTerm}"`);
        console.log('─'.repeat(60));
        log('info', '  Observing search results...');

        const actions = await stagehand.observe(
          `Find all search result links on this page. These are the clickable results from the site search. Look for links that might lead to:
          - A news or newsroom page
          - A press releases page or section
          - A media center
          - News listing pages
          Ignore navigation links, footer links, and sidebar elements. Focus only on the main search results content area.`
        );

        console.log(`\n  Observe found ${actions.length} search result elements`);

        if (actions.length === 0) {
          log('info', `  No search results found for "${searchTerm}", trying next term...`);
          addStep(steps, `3C-${termLabel}`, 'Extract results', 'skip', `No results for "${searchTerm}"`);

          await page.goto(companyUrl, {
            waitUntil: 'domcontentloaded',
            timeoutMs: config.timeoutMs,
          });
          await delay(1000);
          await reopenSearch();
          continue;
        }

        addStep(steps, `3C-${termLabel}`, 'Extract results', 'success', `Found ${actions.length} results for "${searchTerm}"`);

        // Extract hrefs from observed elements
        const candidateLinks: Array<{ text: string; url: string }> = [];

        for (const action of actions) {
          const result = await extractHrefFromElement(page, action.selector, action.description);
          if (result?.href) {
            const normalizedUrl = normalizeUrl(result.href, baseUrl);
            if (normalizedUrl && isOnDomain(normalizedUrl, domain)) {
              candidateLinks.push({ text: result.text, url: normalizedUrl });
              console.log(`    -> ${result.text}: ${normalizedUrl}`);
            }
          }
        }

        // Deduplicate
        const seenUrls = new Set<string>();
        const uniqueLinks = candidateLinks.filter((link) => {
          if (seenUrls.has(link.url)) return false;
          seenUrls.add(link.url);
          return true;
        });

        log('info', `  Found ${uniqueLinks.length} unique candidate links`);

        if (uniqueLinks.length === 0) {
          log('info', `  No valid candidate links from search results, trying next term...`);
          addStep(steps, `3C-${termLabel}`, 'Filter candidates', 'skip', 'No valid links found');

          await page.goto(companyUrl, {
            waitUntil: 'domcontentloaded',
            timeoutMs: config.timeoutMs,
          });
          await delay(1000);
          await reopenSearch();
          continue;
        }

        // Step 3D: Verify each candidate
        console.log('\n' + '─'.repeat(60));
        console.log(`STEP 3D-${termIndex}: Verify Candidates for "${searchTerm}"`);
        console.log('─'.repeat(60));

        let candidatesChecked = 0;
        const maxToCheck = Math.min(uniqueLinks.length, config.maxCandidatesToCheck);

        for (let i = 0; i < maxToCheck; i++) {
          const link = uniqueLinks[i];
          candidatesChecked++;
          totalCandidatesChecked++;
          log('info', `  [${candidatesChecked}/${maxToCheck}] ${link.text}: ${link.url}`);

          try {
            const response = await page.goto(link.url, {
              waitUntil: 'networkidle',
              timeoutMs: config.timeoutMs,
            });

            const status = response?.status();
            if (!status || status >= 400) {
              log('warn', `    HTTP ${status || 'unknown'} - skipping`);
              addStep(steps, `3D-${termLabel}-${candidatesChecked}`, 'Check candidate', 'skip', `HTTP ${status || 'unknown'}`, link.url);
              continue;
            }

            await delay(config.delayBetweenActionsMs / 2);

            // LLM verification
            const verificationInstruction = getHomepageVerificationInstruction();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const verification = (await stagehand.extract(verificationInstruction, PressReleaseVerificationSchema as any)) as z.infer<
              typeof PressReleaseVerificationSchema
            >;

            log('info', `    ${verification.hasNews ? 'VALID' : 'INVALID'}: ${verification.explanation}`);

            if (verification.hasNews) {
              log('info', `    Validating URL...`);
              const validationResponse = await page.goto(link.url, {
                waitUntil: 'domcontentloaded',
                timeoutMs: config.timeoutMs,
              });

              const validationStatus = validationResponse?.status();
              if (!validationStatus || validationStatus >= 400) {
                log('warn', `    Validation failed: HTTP ${validationStatus || 'unknown'}`);
                addStep(steps, `3D-${termLabel}-${candidatesChecked}`, 'Verify candidate', 'fail', `Validation failed: HTTP ${validationStatus}`, link.url);
                continue;
              }

              log('success', `    Validated successfully (HTTP ${validationStatus})`);
              addStep(steps, `3D-${termLabel}-${candidatesChecked}`, 'Verify candidate', 'success', verification.explanation, link.url);

              return {
                success: true,
                newsPageUrl: link.url,
                latestDate: verification.latestDate,
                candidatesChecked: totalCandidatesChecked,
              };
            } else {
              addStep(steps, `3D-${termLabel}-${candidatesChecked}`, 'Verify candidate', 'fail', verification.explanation, link.url);
            }
          } catch (verifyError) {
            log('warn', `    Error: ${verifyError instanceof Error ? verifyError.message : 'Unknown'}`);
          }
        }

        // No valid page found with this search term, try next
        log('info', `  No valid news page found with "${searchTerm}", trying next term...`);

        await page.goto(companyUrl, {
          waitUntil: 'domcontentloaded',
          timeoutMs: config.timeoutMs,
        });
        await delay(1000);
        await reopenSearch();

      } else {
        log('info', `  Could not use search bar for "${searchTerm}": ${typeResult.message}`);
      }
    } catch (actError) {
      log('warn', `  Failed to search for "${searchTerm}": ${actError instanceof Error ? actError.message : 'Unknown'}`);
    }
  }

  if (!searchSucceeded) {
    log('warn', '  Could not find or use site search bar');
    addStep(steps, '3B', 'Use search bar', 'fail', 'No search bar found or could not interact with it');
  }

  return {
    success: false,
    newsPageUrl: null,
    latestDate: null,
    candidatesChecked: totalCandidatesChecked,
    error: 'No valid press release pages found via site search',
  };
}

// MARK: - Main Discovery Function

/**
 * Discover news/PR page for a single company
 *
 * Tries each discovery method in order until one succeeds:
 * 1. DuckDuckGo Search + Verification
 * 2. Homepage Exploration + Link Verification
 * 3. Site Search (use site's own search bar)
 *
 * @param stagehand - Initialized Stagehand instance
 * @param company - Company to discover news page for
 * @param config - Discovery configuration
 * @returns Discovery result with URL, method used, and steps taken
 */
export async function discoverNewsPage(
  stagehand: Stagehand,
  company: CompanyInput,
  config: DiscoveryConfig
): Promise<DiscoveryResult> {
  const startTime = Date.now();
  const steps: DiscoveryStep[] = [];

  console.log(`\n${'='.repeat(70)}`);
  console.log(`Company: ${company.name}`);
  console.log(`Website: ${company.website}`);
  console.log(`${'='.repeat(70)}`);

  try {
    // Step 1: DuckDuckGo Search
    const searchResult = await discoverViaSearch(stagehand, company, config, steps);

    if (searchResult.success) {
      return {
        companyName: company.name,
        companyWebsite: company.website,
        success: true,
        newsPageUrl: searchResult.newsPageUrl,
        latestDate: searchResult.latestDate,
        durationMs: Date.now() - startTime,
        searchResultsCount: searchResult.searchResultsCount,
        candidatesChecked: searchResult.candidatesChecked,
        discoveryMethod: 'search',
        steps,
      };
    }

    log('info', 'Search-based discovery failed, trying homepage exploration...');

    // Step 2: Homepage Exploration
    const homepageResult = await discoverViaHomepage(stagehand, company, config, steps);

    if (homepageResult.success) {
      return {
        companyName: company.name,
        companyWebsite: company.website,
        success: true,
        newsPageUrl: homepageResult.newsPageUrl,
        latestDate: homepageResult.latestDate,
        durationMs: Date.now() - startTime,
        searchResultsCount: searchResult.searchResultsCount,
        candidatesChecked: searchResult.candidatesChecked + homepageResult.candidatesChecked,
        discoveryMethod: 'homepage',
        steps,
      };
    }

    log('info', 'Homepage exploration failed, trying site search...');

    // Step 3: Site Search
    const siteSearchResult = await discoverViaSiteSearch(stagehand, company, config, steps);

    if (siteSearchResult.success) {
      return {
        companyName: company.name,
        companyWebsite: company.website,
        success: true,
        newsPageUrl: siteSearchResult.newsPageUrl,
        latestDate: siteSearchResult.latestDate,
        durationMs: Date.now() - startTime,
        searchResultsCount: searchResult.searchResultsCount,
        candidatesChecked: searchResult.candidatesChecked + homepageResult.candidatesChecked + siteSearchResult.candidatesChecked,
        discoveryMethod: 'site-search',
        steps,
      };
    }

    // All methods failed
    log('warn', 'All discovery methods exhausted');

    return {
      companyName: company.name,
      companyWebsite: company.website,
      success: false,
      newsPageUrl: null,
      latestDate: null,
      durationMs: Date.now() - startTime,
      searchResultsCount: searchResult.searchResultsCount,
      candidatesChecked: searchResult.candidatesChecked + homepageResult.candidatesChecked + siteSearchResult.candidatesChecked,
      error: 'No valid press release pages found (checked search results + homepage + site search)',
      steps,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log('error', `Discovery failed: ${errorMessage}`);
    addStep(steps, 'ERR', 'Discovery error', 'fail', errorMessage);

    return {
      companyName: company.name,
      companyWebsite: company.website,
      success: false,
      newsPageUrl: null,
      latestDate: null,
      durationMs: Date.now() - startTime,
      searchResultsCount: 0,
      candidatesChecked: 0,
      error: errorMessage,
      steps,
    };
  }
}
