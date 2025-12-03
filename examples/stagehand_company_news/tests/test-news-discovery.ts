/**
 * News/PR Page Discovery Test with S3 Persistence
 *
 * This test demonstrates the 3-step discovery flow:
 *
 * Step 1: DuckDuckGo Search (PRIMARY)
 *   - Search for site:{domain} news/press keywords
 *   - Heuristic URL filtering (no LLM)
 *   - LLM verification with 12 detailed examples
 *
 * Step 2: Homepage Exploration (FALLBACK)
 *   - Extract links from nav/header/footer
 *   - Expand dropdown menus with act()
 *   - Verify candidates with LLM
 *
 * Step 3: Site Search (LAST RESORT)
 *   - Find and use site's search bar
 *   - Search for news/press terms
 *   - Observe and verify results
 *
 * Run with S3:
 *   S3_PERSISTENCE_ENABLED=true tsx tests/test-news-discovery.ts
 *
 * Run locally:
 *   tsx tests/test-news-discovery.ts
 */

import { Stagehand, AISdkClient } from '@browserbasehq/stagehand';
import { createOllama } from 'ollama-ai-provider-v2';
import * as fs from 'fs';
import * as path from 'path';
import config from '../config';
import { createS3PersistenceWithLogger } from '../utils/stagehand-s3-persistence';
import { discoverNewsPage, DiscoveryResult, DiscoveryConfig } from '../src/news-discovery';
import { TEST_COMPANIES } from '../companies';

// MARK: - Configuration

const MODEL = 'gpt-oss:20b';
const OLLAMA_BASE_URL = 'http://100.122.179.22:11434';

// Discovery configuration
const DISCOVERY_CONFIG: DiscoveryConfig = {
  ollamaBaseUrl: OLLAMA_BASE_URL,
  ollamaModel: MODEL,
  headless: config.stagehand.headless ?? true,
  verbose: config.stagehand.verbose as 0 | 1 | 2,
  cacheDir: config.stagehand.cacheDir,
  maxSearchResults: 10,
  maxCandidatesToCheck: 5,
  timeoutMs: 30000,
  delayBetweenActionsMs: 2000,
};

// MARK: - Utilities

function log(type: 'info' | 'success' | 'warn' | 'error', message: string): void {
  const prefix = {
    info: '[INFO]',
    success: '[OK]',
    warn: '[WARN]',
    error: '[ERR]',
  }[type];
  console.log(`${prefix} ${message}`);
}

// MARK: - Main Test

async function testNewsDiscovery(): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log('NEWS/PR PAGE DISCOVERY TEST');
  console.log('4-Stage Flow: Search FIRST, Homepage LAST');
  console.log('='.repeat(70));

  // Wipe local cache at start - S3 is the source of truth
  const cacheDir = path.resolve(config.stagehand.cacheDir);
  if (fs.existsSync(cacheDir)) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    log('info', `Wiped local cache: ${cacheDir}`);
  }

  log('info', `Model: ${MODEL}`);
  log('info', `Ollama: ${OLLAMA_BASE_URL}`);
  log('info', `S3 Enabled: ${config.aws.s3.enabled}`);
  log('info', `Cache Dir: ${config.stagehand.cacheDir}`);
  log('info', `Companies to test: ${TEST_COMPANIES.length}`);

  // Create S3 persistence with model-specific paths
  // This creates:
  //   - stagehand-cache-{model}/ for Stagehand's act() cache
  //   - results-{model}/ for discovery results cache (per domain)
  const { persistence, logger } = createS3PersistenceWithLogger({
    bucket: config.aws.s3.bucket,
    prefix: config.aws.s3.prefix,
    enabled: config.aws.s3.enabled,
    modelName: MODEL,  // Model-specific cache paths
    logBatchSize: 50,
    captureHistory: true,
    captureMetrics: true,
    captureLogs: true,
    syncCacheDir: true,
  });

  // Start session BEFORE creating Stagehand
  // This downloads global cache from S3 to enable cache reuse
  const sessionId = await persistence.startSession({
    stagehandEnv: config.stagehand.env,
    model: MODEL,
    task: 'News/PR page discovery - 4-stage flow',
    cacheDir: config.stagehand.cacheDir,
  });

  log('success', `Session started: ${sessionId}`);

  // Create Ollama client
  const ollamaProvider = createOllama({
    baseURL: `${OLLAMA_BASE_URL}/api`,
  });

  const llmClient = new AISdkClient({
    model: ollamaProvider(MODEL),
  });

  // Create Stagehand with caching and S3 logger
  const stagehand = new Stagehand({
    env: config.stagehand.env,
    verbose: config.stagehand.verbose,
    llmClient,
    logger, // S3-enabled logger
    cacheDir: config.stagehand.cacheDir, // Enable per-action caching
    localBrowserLaunchOptions: {
      headless: config.stagehand.headless,
    },
  });

  const results: DiscoveryResult[] = [];

  try {
    await stagehand.init();
    log('success', 'Stagehand initialized with caching');

    // Attach for history/metrics capture
    persistence.attachStagehand(stagehand);

    // Process each company using the 4-stage discovery flow
    for (let i = 0; i < TEST_COMPANIES.length; i++) {
      const company = TEST_COMPANIES[i];
      console.log(`\n[${i + 1}/${TEST_COMPANIES.length}] Processing ${company.name}...`);

      // Check for cached discovery result first
      const cachedResult = await persistence.getCachedDiscoveryResult(company.website);

      if (cachedResult) {
        // Use cached result - skip discovery entirely
        log('success', `Using cached result for ${company.name}`);
        results.push({
          companyName: cachedResult.companyName,
          companyWebsite: cachedResult.domain,
          success: true,
          newsPageUrl: cachedResult.newsPageUrl,
          latestDate: cachedResult.latestDate,
          discoveryMethod: 'cached',
          durationMs: 0,
          searchResultsCount: 0,
          candidatesChecked: 0,
          steps: [],
        });
      } else {
        // Run discovery
        const result = await discoverNewsPage(stagehand, company, DISCOVERY_CONFIG);
        results.push(result);
      }

      // Brief delay between companies
      if (i < TEST_COMPANIES.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    // Print results summary
    console.log('\n' + '-'.repeat(70));
    console.log('DISCOVERY RESULTS');
    console.log('-'.repeat(70));

    for (const result of results) {
      const status = result.success ? '[OK]' : '[FAIL]';
      console.log(`\n${status} ${result.companyName} (${result.companyWebsite})`);
      if (result.success) {
        console.log(`  URL: ${result.newsPageUrl}`);
        console.log(`  Method: ${result.discoveryMethod}`);
        console.log(`  Latest Date: ${result.latestDate || 'N/A'}`);
      } else {
        console.log(`  Error: ${result.error}`);
      }
      console.log(`  Duration: ${result.durationMs}ms`);
      console.log(`  Search results: ${result.searchResultsCount}`);
      console.log(`  Candidates checked: ${result.candidatesChecked}`);
    }

    // Print Stagehand metrics
    console.log('\n' + '-'.repeat(70));
    console.log('STAGEHAND METRICS');
    console.log('-'.repeat(70));

    const metrics = await stagehand.metrics;
    console.log(`Total Prompt Tokens: ${metrics.totalPromptTokens}`);
    console.log(`Total Completion Tokens: ${metrics.totalCompletionTokens}`);
    console.log(`Total Inference Time: ${metrics.totalInferenceTimeMs}ms`);
    console.log('\nPer-Primitive:');
    console.log(`  Act: ${metrics.actPromptTokens} prompt, ${metrics.actCompletionTokens} completion`);
    console.log(`  Extract: ${metrics.extractPromptTokens} prompt, ${metrics.extractCompletionTokens} completion`);
    console.log(`  Observe: ${metrics.observePromptTokens} prompt, ${metrics.observeCompletionTokens} completion`);

    // Print history
    const history = await stagehand.history;
    console.log(`\nHistory (${history.length} entries):`);
    for (const entry of history.slice(-10)) {
      console.log(`  - ${entry.method} @ ${entry.timestamp}`);
    }

    // Upload discovery results to S3
    log('info', 'Uploading discovery results to S3...');
    await persistence.uploadDiscoveryResults(results);

    // End S3 session
    log('info', 'Ending S3 session...');
    const report = await persistence.endSession('completed');

    if (report) {
      console.log('\n' + '-'.repeat(70));
      console.log('S3 SESSION REPORT');
      console.log('-'.repeat(70));
      console.log(`Session ID: ${report.session.sessionId}`);
      console.log(`Status: ${report.session.status}`);
      console.log(
        `Duration: ${new Date(report.session.endTime!).getTime() - new Date(report.session.startTime).getTime()}ms`
      );
      console.log(`\nData Captured:`);
      console.log(`  History entries: ${report.history.length}`);
      console.log(`  Log entries: ${report.logCount}`);
      console.log(`  Cache files: ${report.cacheFileCount}`);
      if (report.metrics) {
        console.log(`  Total tokens: ${report.metrics.totalPromptTokens + report.metrics.totalCompletionTokens}`);
      }
      console.log(`\nS3 Paths:`);
      console.log(`  Base: ${report.s3Paths.base}`);
      console.log(`  Cache Snapshot: ${report.s3Paths.cacheSnapshot}`);
      console.log(`  Global Cache: ${report.s3Paths.globalCache}`);
    }

    // Final summary
    const successful = results.filter((r) => r.success).length;
    const bySearch = results.filter((r) => r.discoveryMethod === 'search').length;
    const byHomepage = results.filter((r) => r.discoveryMethod === 'homepage').length;
    const bySiteSearch = results.filter((r) => r.discoveryMethod === 'site-search').length;
    const byCached = results.filter((r) => r.discoveryMethod === 'cached').length;

    console.log('\n' + '='.repeat(70));
    console.log('FINAL SUMMARY');
    console.log('='.repeat(70));
    console.log(`Total companies: ${results.length}`);
    console.log(`Successful: ${successful}`);
    console.log(`Failed: ${results.length - successful}`);
    console.log(`\nDiscovery Method Breakdown:`);
    console.log(`  Via Cache: ${byCached}`);
    console.log(`  Via Search: ${bySearch}`);
    console.log(`  Via Homepage: ${byHomepage}`);
    console.log(`  Via Site Search: ${bySiteSearch}`);
    console.log(`\nTotal duration: ${results.reduce((sum, r) => sum + r.durationMs, 0)}ms`);
    console.log(
      `Total candidates checked: ${results.reduce((sum, r) => sum + r.candidatesChecked, 0)}`
    );

    log('success', 'Test completed!');
  } catch (error) {
    log('error', `Test failed: ${error instanceof Error ? error.message : String(error)}`);
    await persistence.endSession('failed');
    throw error;
  } finally {
    log('info', 'Closing browser...');
    await stagehand.close();
    log('success', 'Browser closed');
  }
}

// MARK: - Entry Point

testNewsDiscovery()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });
