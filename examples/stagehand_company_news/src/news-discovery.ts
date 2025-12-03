/**
 * News/PR Page Discovery with 3-Step Flow
 *
 * This module discovers company news and press release pages using a
 * 3-step discovery flow:
 *
 * Step 1: DuckDuckGo Search (PRIMARY)
 *   - Search for site:{domain} news/press keywords
 *   - Heuristic URL filtering (no LLM)
 *   - Candidate verification with LLM (12 examples)
 *   - Return immediately on first valid result
 *
 * Step 2: Homepage Exploration (FALLBACK)
 *   - Navigate to company homepage
 *   - Extract links from nav/header/footer
 *   - Expand dropdown menus with act()
 *   - Verify each link found
 *
 * Step 3: Site Search (LAST RESORT)
 *   - Navigate to company homepage
 *   - Find and use site's search bar
 *   - Search for news/press terms in order
 *   - Observe results and verify candidates
 *
 * Key features:
 * - S3 persistence for logs, metrics, history, and cache
 * - Per-company cache keys (domain-based)
 * - Uses Stagehand's act() for cacheable operations
 */

import { Stagehand, AISdkClient } from '@browserbasehq/stagehand';
import { createOllama } from 'ollama-ai-provider-v2';
import { z } from 'zod';

// MARK: - Internal Imports

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

// Re-export types for external use
export type { CompanyInput, DiscoveryResult, DiscoveryConfig } from './types';

// MARK: - Stage 1 & 3: DuckDuckGo Search + Verification

/**
 * Helper to add a step
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

/**
 * Stage 1 & 3: Search DuckDuckGo and verify candidates
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

  // Extract search results
  log('info', '  Extracting search results...');

  const extractionInstruction = getSearchExtractionInstruction(config.maxSearchResults);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const searchResults = (await stagehand.extract(extractionInstruction, SearchResultsSchema as any)) as z.infer<
    typeof SearchResultsSchema
  >;

  log('info', `  Found ${searchResults.results.length} search results`);

  if (searchResults.results.length === 0) {
    addStep(steps, '1A', 'Extract search results', 'fail', 'No results found');
    return {
      success: false,
      newsPageUrl: null,
      latestDate: null,
      searchResultsCount: 0,
      candidatesChecked: 0,
      error: 'No search results found',
    };
  }

  addStep(steps, '1A', 'Extract search results', 'success', `Found ${searchResults.results.length} results`);

  // Log extracted URLs
  log('info', '  Extracted URLs (in order):');
  searchResults.results.forEach((r, i) => {
    console.log(`    ${i + 1}. ${r.url}`);
  });

  // Step 1B: Heuristic URL filtering (NO LLM)
  console.log('\n' + '─'.repeat(60));
  console.log('STEP 1B: Filter & Categorize URLs');
  console.log('─'.repeat(60));
  log('info', `Filtering for domain: ${domain}`);

  // Filter out incomplete results (ensure all required fields are present)
  const completeResults: SearchResult[] = searchResults.results
    .filter((r): r is { title: string; url: string; snippet: string } =>
      typeof r.title === 'string' && typeof r.url === 'string' && typeof r.snippet === 'string'
    );

  const newsRelatedUrls = filterNewsRelatedUrls(completeResults, domain);
  log('info', `  Found ${newsRelatedUrls.length} URLs on ${domain} with news/press keywords`);

  addStep(steps, '1B', 'Filter by domain', 'info', `${newsRelatedUrls.length}/${searchResults.results.length} URLs on ${domain}`);

  const { listingPages, articles } = categorizeUrls(newsRelatedUrls);
  console.log(`  Listing pages: ${listingPages.length}, Articles: ${articles.length}`);

  addStep(steps, '1C', 'Categorize URLs', 'info', `${listingPages.length} listing pages, ${articles.length} articles`);

  // Build candidate list
  const candidates: SearchResult[] = [];

  // Add listing pages first (up to limit)
  candidates.push(...listingPages.slice(0, config.maxCandidatesToCheck));

  // Extract root URLs from articles
  if (articles.length > 0) {
    log('info', '  Extracting potential root URLs from articles...');
    const rootUrls = extractRootUrlsFromArticles(articles);
    log('info', `  Extracted ${rootUrls.length} potential root URLs`);

    // Add root URLs to candidates
    const remaining = config.maxCandidatesToCheck - candidates.length;
    candidates.push(...rootUrls.slice(0, remaining));
  }

  log('info', `Total candidates to verify: ${candidates.length}`);

  // Step 1D: Candidate verification loop
  console.log('\n' + '─'.repeat(60));
  console.log('STEP 1D: Verify Candidates');
  console.log('─'.repeat(60));
  let candidatesChecked = 0;

  for (const candidate of candidates) {
    candidatesChecked++;
    log('info', `  [${candidatesChecked}/${candidates.length}] ${candidate.url}`);

    try {
      // Navigate to candidate
      const response = await page.goto(candidate.url, {
        waitUntil: 'networkidle',
        timeoutMs: config.timeoutMs,
      });

      // Check HTTP status
      const status = response?.status();
      if (!status || status >= 400) {
        log('warn', `    HTTP ${status || 'unknown'} - skipping`);
        addStep(steps, `1D-${candidatesChecked}`, 'Check candidate', 'skip', `HTTP ${status || 'unknown'}`, candidate.url);
        continue;
      }

      await delay(config.delayBetweenActionsMs / 2);

      // Verify with LLM
      const verificationInstruction = getVerificationInstruction();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const verification = (await stagehand.extract(verificationInstruction, PressReleaseVerificationSchema as any)) as z.infer<
        typeof PressReleaseVerificationSchema
      >;

      log('info', `    ${verification.hasNews ? 'VALID' : 'INVALID'}: ${verification.explanation}`);

      if (verification.hasNews) {
        // Validate URL with a second navigation
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

        log('success', `    Validated successfully (HTTP ${validationStatus})`);
        addStep(steps, `1D-${candidatesChecked}`, 'Verify candidate', 'success', verification.explanation, candidate.url);

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

  // No valid page found via search
  return {
    success: false,
    newsPageUrl: null,
    latestDate: null,
    searchResultsCount: searchResults.results.length,
    candidatesChecked,
    error: 'No valid press release pages found in search results',
  };
}

// MARK: - Stage 4: Homepage Exploration

/**
 * Stage 4: Homepage exploration (last resort fallback)
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
  console.log('STEP 2: Homepage Link Extraction (fallback)');
  console.log('─'.repeat(60));

  // Navigate to homepage
  const companyUrl = company.website.startsWith('http') ? company.website : `https://${company.website}`;

  log('info', `  Navigating to: ${companyUrl}`);
  addStep(steps, '2', 'Navigate to homepage', 'info', company.website, companyUrl);

  try {
    // Use domcontentloaded instead of networkidle for faster/more reliable loading
    await page.goto(companyUrl, {
      waitUntil: 'domcontentloaded',
      timeoutMs: config.timeoutMs,
    });
    // Give the page a moment to finish loading JS
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

  // Step 2A: Expand navigation dropdowns to reveal hidden links
  log('info', '  Expanding navigation dropdowns...');
  addStep(steps, '2A', 'Expand nav dropdowns', 'info', 'Looking for dropdown menus to expand');

  try {
    // Use Stagehand to find and expand dropdown menus in the navigation
    // This will hover/click on nav items that have dropdowns
    await stagehand.act(
      'Look at the main navigation menu at the top of the page. Find any menu items that have dropdown arrows, submenus, or expandable sections (like "About", "Company", "Resources", "Media", etc.). Hover over or click on each one to expand any hidden dropdown menus. Do this for all navigation items that appear to have submenus.'
    );

    await delay(config.delayBetweenActionsMs / 2);
    log('info', '  Dropdowns expanded (if any found)');
  } catch (expandError) {
    log('warn', `  Failed to expand dropdowns: ${expandError instanceof Error ? expandError.message : 'Unknown'}`);
    // Continue anyway - we can still try to extract visible links
  }

  // Use observe() to find news/press links, then get their hrefs via Playwright
  log('info', '  Looking for news/press links on homepage...');

  const baseUrl = companyUrl.endsWith('/') ? companyUrl.slice(0, -1) : companyUrl;
  const validLinks: Array<{ text: string; url: string }> = [];

  try {
    // Use observe to find links related to news/press
    // The LLM understands semantic similarity, so variations like "Press Center" vs "Press Releases" will match
    const actions = await stagehand.observe(
      'Find all links (<a> tags) related to company news or press releases. This includes links with text like: News, Newsroom, Press, Press Center, Press Releases, Media, Media Center, Media Room, Announcements, Updates, Investor News, Corporate News, Latest News, or any similar variations. Look in navigation menus, dropdowns, header, footer, and sidebar sections.'
    );

    console.log(`\n  Observe found ${actions.length} elements:`);
    actions.forEach((action, i) => {
      console.log(`    ${i + 1}. "${action.description}" -> selector: ${action.selector}`);
    });

    // For each found element, get href and text using page.evaluate with XPath
    for (const action of actions) {
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
        }, action.selector);

        if (result?.href) {
          // Normalize the URL
          let url = result.href.trim();

          // Skip anchor-only links
          if (url === '#' || url.startsWith('#')) continue;

          // Convert relative URLs to absolute
          if (url.startsWith('/')) {
            url = `${baseUrl}${url}`;
          } else if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = `${baseUrl}/${url}`;
          }

          const text = (result.text || action.description).trim();
          validLinks.push({ text, url });
          console.log(`    -> Got href: ${url}`);
        }
      } catch (err) {
        // Skip elements we can't get href from
        console.log(`    -> Failed to get href for "${action.description}": ${err}`);
      }
    }
  } catch (observeError) {
    log('warn', `  Failed to observe links: ${observeError instanceof Error ? observeError.message : 'Unknown'}`);
  }

  // Deduplicate links by URL (keep first occurrence)
  const seenUrls = new Set<string>();
  const uniqueLinks = validLinks.filter((link) => {
    if (seenUrls.has(link.url)) {
      return false;
    }
    seenUrls.add(link.url);
    return true;
  });

  log('info', `Found ${uniqueLinks.length} unique link(s) with hrefs (${validLinks.length - uniqueLinks.length} duplicates removed)`);

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

  // Step 2B: Apply heuristic filtering (same as search step)
  console.log('\n' + '─'.repeat(60));
  console.log('STEP 2B: Filter & Categorize Links');
  console.log('─'.repeat(60));

  const domain = getDomainFromUrl(company.website);
  log('info', `Filtering for domain: ${domain}`);

  // Convert to SearchResult format for filtering functions
  const linksAsSearchResults: SearchResult[] = uniqueLinks.map(link => ({
    title: link.text,
    url: link.url,
    snippet: '', // No snippet for homepage links
  }));

  // Apply domain and keyword filtering
  const domainFilteredLinks = linksAsSearchResults.filter((result) => {
    const urlLower = result.url.toLowerCase();
    const textLower = result.title.toLowerCase();

    // Must be on the company's domain (including subdomains)
    try {
      const urlHost = new URL(result.url).hostname.toLowerCase();
      const targetDomain = domain.toLowerCase();
      const isOnDomain = urlHost === targetDomain || urlHost.endsWith('.' + targetDomain);
      if (!isOnDomain) {
        return false;
      }
    } catch {
      return false;
    }

    // Filter out PDFs, images
    if (urlLower.endsWith('.pdf') || urlLower.endsWith('.jpg') || urlLower.endsWith('.png')) {
      return false;
    }

    // Must have news/press keywords in URL or link text
    const hasRelevantKeywords =
      urlLower.includes('news') ||
      urlLower.includes('press') ||
      urlLower.includes('media') ||
      urlLower.includes('blog') ||
      urlLower.includes('updates') ||
      urlLower.includes('investor') ||
      textLower.includes('news') ||
      textLower.includes('press') ||
      textLower.includes('media') ||
      textLower.includes('announcement');

    return hasRelevantKeywords;
  });

  log('info', `  After domain/keyword filter: ${domainFilteredLinks.length}/${uniqueLinks.length} links`);
  addStep(steps, '2B', 'Filter by domain/keywords', 'info', `${domainFilteredLinks.length}/${uniqueLinks.length} links match`);

  // Categorize as listing pages vs articles
  const { listingPages, articles } = categorizeUrls(domainFilteredLinks);
  log('info', `  Listing pages: ${listingPages.length}, Articles: ${articles.length}`);
  addStep(steps, '2B', 'Categorize URLs', 'info', `${listingPages.length} listing pages, ${articles.length} articles`);

  // Prioritize listing pages, then articles
  const filteredLinks: Array<{ text: string; url: string }> = [
    ...listingPages.map(r => ({ text: r.title, url: r.url })),
    ...articles.map(r => ({ text: r.title, url: r.url })),
  ];

  if (filteredLinks.length === 0) {
    // Fall back to all unique links if filtering removed everything
    log('warn', '  Filtering removed all links, using original unique links');
    addStep(steps, '2B', 'Filter fallback', 'info', 'Using all unique links (filtering too strict)');
    filteredLinks.push(...uniqueLinks);
  }

  console.log('\n  Filtered links (listing pages first):');
  filteredLinks.forEach((link, i) => {
    console.log(`    ${i + 1}. "${link.text}" -> ${link.url}`);
  });

  // Step 2C: Use LLM to rank links by likelihood
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
      // Sort by score descending
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

      // Add any links that weren't in the ranking (shouldn't happen, but just in case)
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

  // Step 2D: Verify each link (in ranked order)
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

      // Verify with LLM
      const verificationInstruction = getHomepageVerificationInstruction();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const verification = (await stagehand.extract(verificationInstruction, PressReleaseVerificationSchema as any)) as z.infer<
        typeof PressReleaseVerificationSchema
      >;

      log('info', `    ${verification.hasNews ? 'VALID' : 'INVALID'}: ${verification.explanation}`);

      if (verification.hasNews) {
        // Validate URL
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
 * If DuckDuckGo search and homepage exploration fail, try using the site's
 * own search functionality to find the news/PR page.
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
  console.log('STEP 3: Site Search (fallback)');
  console.log('─'.repeat(60));

  // Navigate to homepage first
  const companyUrl = company.website.startsWith('http') ? company.website : `https://${company.website}`;
  const domain = getDomainFromUrl(company.website);

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

  // Step 3A: Find the site's search icon/bar using observe()
  console.log('\n' + '─'.repeat(60));
  console.log('STEP 3A: Find Site Search Icon');
  console.log('─'.repeat(60));
  log('info', '  Looking for search icon/bar on site using observe()...');
  addStep(steps, '3A', 'Find search', 'info', 'Looking for search icon on homepage');

  // Use observe() to find the search icon - this is more reliable than act() alone
  let searchElement: { selector: string; description: string } | null = null;
  try {
    const searchElements = await stagehand.observe(
      'Find the search icon or search button on this page. It is usually a magnifying glass icon (🔍) in the header or navigation bar. Do NOT select navigation menu items like "Store", "Mac", "iPad", "iPhone", etc. Look specifically for a search/magnifying glass icon or a button/link labeled "Search".'
    );

    log('info', `  Observe found ${searchElements.length} potential search elements`);

    if (searchElements.length > 0) {
      // Log all found elements
      searchElements.forEach((el, i) => {
        console.log(`    ${i + 1}. "${el.description}" -> ${el.selector}`);
      });

      // Use the first search element found
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

  // Step 3A-2: Click the search icon using act() with the observed element
  console.log('\n' + '─'.repeat(60));
  console.log('STEP 3A-2: Open Site Search');
  console.log('─'.repeat(60));
  log('info', '  Clicking search icon to open search input...');

  let searchInputOpened = false;
  try {
    // Pass the observed element directly to act() - no additional LLM call needed
    const openSearchResult = await stagehand.act(searchElement);

    log('info', `  Open search result: ${openSearchResult.success ? 'success' : 'failed'} - ${openSearchResult.message}`);

    if (openSearchResult.success) {
      searchInputOpened = true;
      addStep(steps, '3A-2', 'Open search', 'success', 'Clicked search icon to open search input');
      await delay(1000); // Wait for search overlay/input to appear
    }
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

  // Helper to re-open search using observe + act pattern
  const reopenSearch = async (): Promise<boolean> => {
    try {
      const searchElements = await stagehand.observe(
        'Find the search icon or search button (usually a magnifying glass icon 🔍) in the header or navigation bar.'
      );
      if (searchElements.length > 0) {
        await stagehand.act(searchElements[0]);
        await delay(500);
        return true;
      }
    } catch {
      // Ignore errors
    }
    return false;
  };

  // Search terms to try (same as DuckDuckGo search)
  const searchTerms = ['news', 'press releases', 'press', 'newsroom', 'media'];
  let searchSucceeded = false;
  let termIndex = 0;

  for (const searchTerm of searchTerms) {
    termIndex++;
    const termLabel = searchTerm.replace(/\s+/g, '-'); // e.g., "press-releases"

    console.log('\n' + '─'.repeat(60));
    console.log(`STEP 3B-${termIndex}: Search for "${searchTerm}"`);
    console.log('─'.repeat(60));
    log('info', `  Typing search term: "${searchTerm}"`);

    try {
      // Type the search term and submit
      const typeResult = await stagehand.act(
        `Type "${searchTerm}" into the search input field that is now open/visible and press Enter to search. The search input should already be open and focused. Just type the text and press Enter.`
      );

      log('info', `  Type result: ${typeResult.success ? 'success' : 'failed'} - ${typeResult.message}`);

      if (typeResult.success) {
        searchSucceeded = true;
        addStep(steps, `3B-${termLabel}`, 'Submit search', 'success', `Searched for "${searchTerm}"`, page.url());

        // Wait for search results to load
        await delay(config.delayBetweenActionsMs);

        // Check if we're on a search results page
        const currentUrl = page.url();
        log('info', `  Current URL after search: ${currentUrl}`);

        // Check if URL changed (indicates search worked)
        if (currentUrl === companyUrl || currentUrl === companyUrl + '/') {
          log('warn', `  URL didn't change after search, search may not have worked`);
          addStep(steps, `3B-${termLabel}`, 'Check URL', 'skip', 'URL unchanged after search');

          // Try to re-open search for next term
          await reopenSearch();
          continue;
        }

        // Step 3C: Observe search results
        console.log('\n' + '─'.repeat(60));
        console.log(`STEP 3C-${termIndex}: Observe Results for "${searchTerm}"`);
        console.log('─'.repeat(60));
        log('info', '  Observing search results...');

        // Use observe to find search result links
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

          // Navigate back to homepage for next search attempt
          await page.goto(companyUrl, {
            waitUntil: 'domcontentloaded',
            timeoutMs: config.timeoutMs,
          });
          await delay(1000);

          // Re-open search for next term
          await reopenSearch();
          continue;
        }

        addStep(steps, `3C-${termLabel}`, 'Extract results', 'success', `Found ${actions.length} results for "${searchTerm}"`);

        // Extract hrefs from observed elements
        const baseUrl = companyUrl.endsWith('/') ? companyUrl.slice(0, -1) : companyUrl;
        const candidateLinks: Array<{ text: string; url: string }> = [];

        for (const action of actions) {
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
            }, action.selector);

            if (result?.href) {
              let url = result.href.trim();

              // Skip anchor-only links
              if (url === '#' || url.startsWith('#')) continue;

              // Convert relative URLs to absolute
              if (url.startsWith('/')) {
                url = `${baseUrl}${url}`;
              } else if (!url.startsWith('http://') && !url.startsWith('https://')) {
                url = `${baseUrl}/${url}`;
              }

              // Filter: must be on the company's domain
              try {
                const urlHost = new URL(url).hostname.toLowerCase();
                const targetDomain = domain.toLowerCase();
                const isOnDomain = urlHost === targetDomain || urlHost.endsWith('.' + targetDomain);
                if (!isOnDomain) continue;
              } catch {
                continue;
              }

              const text = (result.text || action.description).trim();
              candidateLinks.push({ text, url });
              console.log(`    -> ${text}: ${url}`);
            }
          } catch (err) {
            // Skip elements we can't get href from
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

          // Navigate back to homepage for next search attempt
          await page.goto(companyUrl, {
            waitUntil: 'domcontentloaded',
            timeoutMs: config.timeoutMs,
          });
          await delay(1000);

          // Re-open search for next term
          await reopenSearch();
          continue;
        }

        // Step 3D: Verify each candidate link
        console.log('\n' + '─'.repeat(60));
        console.log(`STEP 3D-${termIndex}: Verify Candidates for "${searchTerm}"`);
        console.log('─'.repeat(60));

        let candidatesChecked = 0;
        const maxToCheck = Math.min(uniqueLinks.length, config.maxCandidatesToCheck);

        for (let i = 0; i < maxToCheck; i++) {
          const link = uniqueLinks[i];
          candidatesChecked++;
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

            // Verify with LLM (use homepage verification since we're looking for listing pages)
            const verificationInstruction = getHomepageVerificationInstruction();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const verification = (await stagehand.extract(verificationInstruction, PressReleaseVerificationSchema as any)) as z.infer<
              typeof PressReleaseVerificationSchema
            >;

            log('info', `    ${verification.hasNews ? 'VALID' : 'INVALID'}: ${verification.explanation}`);

            if (verification.hasNews) {
              // Validate URL with a second navigation
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
                candidatesChecked,
              };
            } else {
              addStep(steps, `3D-${termLabel}-${candidatesChecked}`, 'Verify candidate', 'fail', verification.explanation, link.url);
            }
          } catch (verifyError) {
            log('warn', `    Error: ${verifyError instanceof Error ? verifyError.message : 'Unknown'}`);
          }
        }

        // If we checked candidates but none worked, try next search term
        log('info', `  No valid news page found with "${searchTerm}", trying next term...`);

        // Navigate back to homepage for next search attempt
        await page.goto(companyUrl, {
          waitUntil: 'domcontentloaded',
          timeoutMs: config.timeoutMs,
        });
        await delay(1000);

      } else {
        log('info', `  Could not use search bar for "${searchTerm}": ${typeResult.message}`);
      }
    } catch (actError) {
      log('warn', `  Failed to search for "${searchTerm}": ${actError instanceof Error ? actError.message : 'Unknown'}`);
    }
  }

  // If we never succeeded in using the search bar
  if (!searchSucceeded) {
    log('warn', '  Could not find or use site search bar');
    addStep(steps, '3A', 'Find search bar', 'fail', 'No search bar found or could not interact with it');
  }

  return {
    success: false,
    newsPageUrl: null,
    latestDate: null,
    candidatesChecked: 0,
    error: 'No valid press release pages found via site search',
  };
}

// MARK: - Main Discovery Function

/**
 * Discover news/PR page for a single company using the discovery flow:
 *
 * Step 1: DuckDuckGo Search + Heuristic Filtering + Verification
 * Step 2: Homepage Exploration + Link Verification
 * Step 3: Site Search (use site's own search bar)
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
    // Try Stage 1-3: DuckDuckGo Search
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

    // Try Stage 4: Homepage Exploration
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

    // Try Step 3: Site Search
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

// MARK: - Multi-Company Discovery

/**
 * Discover news pages for multiple companies
 */
export async function discoverNewsPages(
  companies: CompanyInput[],
  config: DiscoveryConfig
): Promise<{
  results: DiscoveryResult[];
  metrics: {
    totalCompanies: number;
    successful: number;
    failed: number;
    totalDurationMs: number;
    discoveryByMethod: {
      search: number;
      homepage: number;
    };
  };
}> {
  console.log(`\nStarting discovery for ${companies.length} companies`);
  console.log(`Cache directory: ${config.cacheDir}`);
  console.log('Discovery strategy: Search FIRST, Homepage LAST');
  console.log('');

  // Create Ollama client
  const ollamaProvider = createOllama({
    baseURL: `${config.ollamaBaseUrl}/api`,
  });

  const llmClient = new AISdkClient({
    model: ollamaProvider(config.ollamaModel),
  });

  // Create Stagehand with caching enabled
  const stagehand = new Stagehand({
    env: 'LOCAL',
    verbose: config.verbose,
    llmClient,
    cacheDir: config.cacheDir,
    localBrowserLaunchOptions: {
      headless: config.headless,
    },
  });

  const results: DiscoveryResult[] = [];
  let searchSuccesses = 0;
  let homepageSuccesses = 0;

  try {
    await stagehand.init();
    log('success', 'Stagehand initialized');

    for (let i = 0; i < companies.length; i++) {
      const company = companies[i];
      console.log(`\n[${i + 1}/${companies.length}] Processing ${company.name}...`);

      const result = await discoverNewsPage(stagehand, company, config);
      results.push(result);

      if (result.success) {
        if (result.discoveryMethod === 'search') {
          searchSuccesses++;
        } else if (result.discoveryMethod === 'homepage') {
          homepageSuccesses++;
        }
      }

      // Brief delay between companies
      if (i < companies.length - 1) {
        await delay(2000);
      }
    }

    // Print final metrics
    const metrics = await stagehand.metrics;
    console.log('\n' + '='.repeat(60));
    console.log('STAGEHAND METRICS');
    console.log('='.repeat(60));
    console.log(`Total Prompt Tokens: ${metrics.totalPromptTokens}`);
    console.log(`Total Completion Tokens: ${metrics.totalCompletionTokens}`);
    console.log(`Total Inference Time: ${metrics.totalInferenceTimeMs}ms`);

    return {
      results,
      metrics: {
        totalCompanies: companies.length,
        successful: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
        totalDurationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
        discoveryByMethod: {
          search: searchSuccesses,
          homepage: homepageSuccesses,
        },
      },
    };
  } finally {
    await stagehand.close();
    log('success', 'Browser closed');
  }
}
