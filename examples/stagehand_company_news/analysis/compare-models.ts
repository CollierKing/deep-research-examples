/**
 * Model Comparison Analysis Script
 *
 * Downloads discovery results and reports from S3 for multiple models,
 * aggregates metrics, and exports a comparison CSV.
 *
 * Usage:
 *   npx tsx analysis/compare-models.ts [model1] [model2] ...
 *
 * Example:
 *   npx tsx analysis/compare-models.ts ollama-gpt-oss-20b anthropic-claude-sonnet-4-20250514 openai-gpt-4o
 *
 * If no models specified, lists available sessions in S3.
 *
 * Output:
 *   - Console summary of metrics per model
 *   - analysis/model-comparison.csv with newsPageUrl by model/website
 */

import 'dotenv/config';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import * as fs from 'fs';
import * as path from 'path';
import config from '../config';

// MARK: - Types

interface SessionReport {
  session: {
    sessionId: string;
    startTime: string;
    endTime?: string;
    status: string;
    model?: string;
  };
  metrics: {
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalInferenceTimeMs: number;
  } | null;
  cacheStats: {
    hits: number;
    misses: number;
    hitRate: string;
  };
}

interface DiscoveryResults {
  sessionId: string;
  timestamp: string;
  totalCompanies: number;
  successful: number;
  failed: number;
  results: Array<{
    company: string;
    website: string;
    success: boolean;
    newsPageUrl: string | null;
    discoveryMethod: string | null;
    error: string | null;
  }>;
}

interface ModelMetrics {
  model: string;
  sessionId: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalInferenceTimeMs: number;
  companiesTotal: number;
  companiesSuccessful: number;
  companiesFailed: number;
  successRate: string;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: string;
  results: Array<{
    website: string;
    newsPageUrl: string | null;
    success: boolean;
    discoveryMethod: string | null;
  }>;
}

// MARK: - S3 Client

const s3Client = new S3Client({ region: config.aws.region });

// MARK: - S3 Helpers

/**
 * List all session folders in S3
 */
async function listSessions(): Promise<string[]> {
  const sessions: string[] = [];
  let continuationToken: string | undefined;

  do {
    const command = new ListObjectsV2Command({
      Bucket: config.aws.s3.bucket,
      Prefix: config.aws.s3.prefix + '/',
      Delimiter: '/',
      ContinuationToken: continuationToken,
    });

    const response = await s3Client.send(command);

    if (response.CommonPrefixes) {
      for (const prefix of response.CommonPrefixes) {
        if (prefix.Prefix) {
          // Extract session ID from prefix
          const sessionId = prefix.Prefix.replace(config.aws.s3.prefix + '/', '').replace('/', '');
          if (sessionId) {
            sessions.push(sessionId);
          }
        }
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return sessions.sort().reverse(); // Most recent first
}

/**
 * Find the most recent session for a model
 */
async function findSessionForModel(modelName: string): Promise<string | null> {
  const sessions = await listSessions();

  // Model name in session ID is sanitized (: replaced with -)
  const sanitizedModel = modelName.replace(/:/g, '-');

  for (const session of sessions) {
    if (session.includes(sanitizedModel)) {
      return session;
    }
  }

  return null;
}

/**
 * Download a JSON file from S3
 */
async function downloadJson<T>(key: string): Promise<T | null> {
  try {
    const command = new GetObjectCommand({
      Bucket: config.aws.s3.bucket,
      Key: key,
    });

    const response = await s3Client.send(command);
    const body = await response.Body?.transformToString();

    if (body) {
      return JSON.parse(body) as T;
    }
  } catch (error) {
    if ((error as { name?: string }).name !== 'NoSuchKey') {
      console.error(`Error downloading ${key}:`, error);
    }
  }

  return null;
}

// MARK: - Analysis Functions

/**
 * Download and analyze a single model's results
 */
async function analyzeModel(sessionId: string): Promise<ModelMetrics | null> {
  const prefix = `${config.aws.s3.prefix}/${sessionId}`;

  // Download report.json
  const report = await downloadJson<SessionReport>(`${prefix}/report.json`);
  if (!report) {
    console.error(`  Could not download report.json for ${sessionId}`);
    return null;
  }

  // Download discovery-results.json
  const results = await downloadJson<DiscoveryResults>(`${prefix}/discovery-results.json`);
  if (!results) {
    console.error(`  Could not download discovery-results.json for ${sessionId}`);
    return null;
  }

  // Calculate duration
  const startTime = new Date(report.session.startTime);
  const endTime = report.session.endTime ? new Date(report.session.endTime) : new Date();
  const durationMs = endTime.getTime() - startTime.getTime();

  // Build metrics
  const metrics: ModelMetrics = {
    model: report.session.model || sessionId,
    sessionId,
    startTime: report.session.startTime,
    endTime: report.session.endTime || '',
    durationMs,
    totalPromptTokens: report.metrics?.totalPromptTokens || 0,
    totalCompletionTokens: report.metrics?.totalCompletionTokens || 0,
    totalTokens: (report.metrics?.totalPromptTokens || 0) + (report.metrics?.totalCompletionTokens || 0),
    totalInferenceTimeMs: report.metrics?.totalInferenceTimeMs || 0,
    companiesTotal: results.totalCompanies,
    companiesSuccessful: results.successful,
    companiesFailed: results.failed,
    successRate: results.totalCompanies > 0
      ? `${((results.successful / results.totalCompanies) * 100).toFixed(1)}%`
      : 'N/A',
    cacheHits: report.cacheStats?.hits || 0,
    cacheMisses: report.cacheStats?.misses || 0,
    cacheHitRate: report.cacheStats?.hitRate || 'N/A',
    results: results.results.map(r => ({
      website: r.website,
      newsPageUrl: r.newsPageUrl,
      success: r.success,
      discoveryMethod: r.discoveryMethod,
    })),
  };

  return metrics;
}

/**
 * Print metrics summary for a model
 */
function printModelSummary(metrics: ModelMetrics): void {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`MODEL: ${metrics.model}`);
  console.log(`${'─'.repeat(70)}`);
  console.log(`Session ID: ${metrics.sessionId}`);
  console.log(`Start Time: ${metrics.startTime}`);
  console.log(`End Time:   ${metrics.endTime}`);
  console.log(`Duration:   ${(metrics.durationMs / 1000).toFixed(1)}s`);
  console.log('');
  console.log(`Token Usage:`);
  console.log(`  Prompt:     ${metrics.totalPromptTokens.toLocaleString()}`);
  console.log(`  Completion: ${metrics.totalCompletionTokens.toLocaleString()}`);
  console.log(`  Total:      ${metrics.totalTokens.toLocaleString()}`);
  console.log(`  Inference:  ${(metrics.totalInferenceTimeMs / 1000).toFixed(1)}s`);
  console.log('');
  console.log(`Discovery Results:`);
  console.log(`  Total:      ${metrics.companiesTotal}`);
  console.log(`  Successful: ${metrics.companiesSuccessful}`);
  console.log(`  Failed:     ${metrics.companiesFailed}`);
  console.log(`  Success Rate: ${metrics.successRate}`);
  console.log('');
  console.log(`Cache Stats:`);
  console.log(`  Hits:     ${metrics.cacheHits}`);
  console.log(`  Misses:   ${metrics.cacheMisses}`);
  console.log(`  Hit Rate: ${metrics.cacheHitRate}`);
}

/**
 * Export comparison CSV
 */
function exportCsv(allMetrics: ModelMetrics[], outputPath: string): void {
  // Header
  const lines: string[] = ['model,website,newsPageUrl,success,discoveryMethod'];

  // Data rows
  for (const metrics of allMetrics) {
    for (const result of metrics.results) {
      const row = [
        `"${metrics.model}"`,
        `"${result.website}"`,
        `"${result.newsPageUrl || ''}"`,
        result.success.toString(),
        `"${result.discoveryMethod || ''}"`,
      ];
      lines.push(row.join(','));
    }
  }

  fs.writeFileSync(outputPath, lines.join('\n'));
  console.log(`\nExported CSV to: ${outputPath}`);
}

/**
 * Export summary CSV
 */
function exportSummaryCsv(allMetrics: ModelMetrics[], outputPath: string): void {
  // Header
  const lines: string[] = [
    'model,sessionId,durationSec,totalTokens,promptTokens,completionTokens,inferenceTimeSec,companiesTotal,successful,failed,successRate,cacheHits,cacheMisses,cacheHitRate',
  ];

  // Data rows
  for (const metrics of allMetrics) {
    const row = [
      `"${metrics.model}"`,
      `"${metrics.sessionId}"`,
      (metrics.durationMs / 1000).toFixed(1),
      metrics.totalTokens.toString(),
      metrics.totalPromptTokens.toString(),
      metrics.totalCompletionTokens.toString(),
      (metrics.totalInferenceTimeMs / 1000).toFixed(1),
      metrics.companiesTotal.toString(),
      metrics.companiesSuccessful.toString(),
      metrics.companiesFailed.toString(),
      `"${metrics.successRate}"`,
      metrics.cacheHits.toString(),
      metrics.cacheMisses.toString(),
      `"${metrics.cacheHitRate}"`,
    ];
    lines.push(row.join(','));
  }

  fs.writeFileSync(outputPath, lines.join('\n'));
  console.log(`Exported summary CSV to: ${outputPath}`);
}

// MARK: - Main

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  console.log('=' .repeat(70));
  console.log('MODEL COMPARISON ANALYSIS');
  console.log('=' .repeat(70));
  console.log(`S3 Bucket: ${config.aws.s3.bucket}`);
  console.log(`S3 Prefix: ${config.aws.s3.prefix}`);

  // If no models specified, list available sessions
  if (args.length === 0) {
    console.log('\nNo models specified. Available sessions:');
    const sessions = await listSessions();

    if (sessions.length === 0) {
      console.log('  (no sessions found)');
    } else {
      for (const session of sessions.slice(0, 20)) {
        console.log(`  - ${session}`);
      }
      if (sessions.length > 20) {
        console.log(`  ... and ${sessions.length - 20} more`);
      }
    }

    console.log('\nUsage: npx tsx analysis/compare-models.ts [session1] [session2] ...');
    console.log('Example: npx tsx analysis/compare-models.ts ollama-gpt-oss anthropic-claude openai-gpt-4o');
    return;
  }

  // Analyze each model
  const allMetrics: ModelMetrics[] = [];

  for (const modelArg of args) {
    console.log(`\nLooking for session matching: ${modelArg}`);

    // Try to find session (could be full session ID or partial model name)
    let sessionId = modelArg;

    // If it doesn't look like a full session ID, search for it
    if (!modelArg.match(/^\d{4}-\d{2}-\d{2}/)) {
      const found = await findSessionForModel(modelArg);
      if (found) {
        sessionId = found;
        console.log(`  Found session: ${sessionId}`);
      } else {
        console.error(`  No session found for model: ${modelArg}`);
        continue;
      }
    }

    const metrics = await analyzeModel(sessionId);
    if (metrics) {
      allMetrics.push(metrics);
      printModelSummary(metrics);
    }
  }

  if (allMetrics.length === 0) {
    console.error('\nNo valid metrics found. Exiting.');
    return;
  }

  // Print comparison table
  console.log('\n' + '=' .repeat(70));
  console.log('COMPARISON SUMMARY');
  console.log('=' .repeat(70));

  console.log('\n%-30s %10s %12s %8s %10s'.replace(/%(-?\d+)s/g, (_, n) => {
    return `${''.padEnd(Math.abs(parseInt(n)))}`;
  }));

  const header = 'Model'.padEnd(30) +
    'Duration'.padStart(10) +
    'Tokens'.padStart(12) +
    'Success'.padStart(10) +
    'Rate'.padStart(10);
  console.log(header);
  console.log('-'.repeat(70));

  for (const m of allMetrics) {
    const modelName = m.model.length > 28 ? m.model.substring(0, 28) + '..' : m.model;
    const row =
      modelName.padEnd(30) +
      `${(m.durationMs / 1000).toFixed(0)}s`.padStart(10) +
      m.totalTokens.toLocaleString().padStart(12) +
      `${m.companiesSuccessful}/${m.companiesTotal}`.padStart(10) +
      m.successRate.padStart(10);
    console.log(row);
  }

  // Export CSVs
  const analysisDir = path.dirname(__filename);
  exportCsv(allMetrics, path.join(analysisDir, 'model-comparison-results.csv'));
  exportSummaryCsv(allMetrics, path.join(analysisDir, 'model-comparison-summary.csv'));

  console.log('\nDone!');
}

// MARK: - Entry Point

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Analysis failed:', err);
    process.exit(1);
  });
