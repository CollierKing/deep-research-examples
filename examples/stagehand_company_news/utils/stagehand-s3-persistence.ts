/**
 * Stagehand S3 Persistence
 *
 * Direct integration with Stagehand v3's native observability features.
 * No LangChain middleware required - works with Stagehand's built-in:
 *
 * 1. Logger - Custom logger function captures all internal logs
 * 2. History - stagehand.history captures all primitive calls (act, extract, observe, navigate)
 * 3. Metrics - stagehand.metrics captures token usage and timing per primitive
 * 4. Cache - cacheDir option enables ActCache/AgentCache file persistence
 *
 * S3 Structure (Hybrid - Option 3):
 * - Global cache: s3://bucket/stagehand-cache/{domain}/{hash}.json
 *   Downloaded at session start, uploaded at session end
 *   Enables cache reuse across runs
 *
 * - Session data: s3://bucket/stagehand-runs/{session-id}/
 *   Contains: metadata, history, metrics, logs, cache-snapshot, stdout.txt
 *   Cache-snapshot is a copy of cache state for audit trail
 *   stdout.txt is the complete terminal output
 *
 * Based on Stagehand v3 architecture from DeepWiki documentation.
 */

import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { Stagehand, LogLine, StagehandMetrics, HistoryEntry } from '@browserbasehq/stagehand';
import { format } from 'date-fns';
import { randomUUID } from 'crypto';
import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import config from '../config';

// MARK: - Types

export interface S3PersistenceOptions {
  bucket: string;
  prefix?: string;
  cachePrefix?: string;  // Prefix for global cache (default: 'stagehand-cache')
  resultsPrefix?: string;  // Prefix for discovery results cache (default: 'results')
  modelName?: string;  // Model name for model-specific caching (e.g., 'gpt-oss-20b')
  region?: string;
  enabled?: boolean;
  // Batching options
  logBatchSize?: number;
  flushIntervalMs?: number;
  // Capture options
  captureHistory?: boolean;
  captureMetrics?: boolean;
  captureLogs?: boolean;
  syncCacheDir?: boolean;
  captureStdout?: boolean;  // Capture full stdout to S3
  // Cache sync options
  downloadCacheOnStart?: boolean;  // Download global cache before session
  uploadCacheOnEnd?: boolean;      // Upload to global cache after session
  snapshotCacheOnEnd?: boolean;    // Save cache snapshot to session for audit
}

export interface SessionInfo {
  sessionId: string;
  startTime: string;
  endTime?: string;
  status: 'running' | 'completed' | 'failed';
  stagehandEnv: string;
  model?: string;
  task?: string;
  cacheDownloaded?: number;  // Number of cache files downloaded at start
  cacheUploaded?: number;    // Number of cache files uploaded at end
  cacheHits?: number;        // Number of cache hits during session
  cacheMisses?: number;      // Number of cache misses during session
}

export interface SessionReport {
  session: SessionInfo;
  metrics: StagehandMetrics | null;
  history: ReadonlyArray<HistoryEntry>;
  logCount: number;
  cacheFileCount: number;
  cacheStats: {
    hits: number;
    misses: number;
    hitRate: string;
  };
  s3Paths: {
    base: string;
    metadata: string;
    history: string;
    metrics: string;
    logs: string;
    cacheSnapshot: string;
    globalCache: string;
    stdout: string;
  };
}

export interface CacheFileInfo {
  path: string;
  relativePath: string;
  domain?: string;
}

// MARK: - Utility Functions

function generateSessionId(modelName?: string): string {
  const timestamp = format(new Date(), 'yyyy-MM-dd_HH-mm-ss');
  const suffix = randomUUID().substring(0, 8);
  if (modelName && modelName !== 'default') {
    return `${timestamp}_${modelName}_${suffix}`;
  }
  return `${timestamp}_${suffix}`;
}

/**
 * Extract domain from a cache file's content (based on the URL field)
 */
function extractDomainFromCacheContent(content: string): string | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed.url) {
      const url = new URL(parsed.url);
      return url.hostname.replace(/^www\./, '').toLowerCase();
    }
  } catch {
    // Invalid JSON or no URL field
  }
  return null;
}
// MARK: - StagehandS3Persistence Class

export class StagehandS3Persistence {
  private s3Client: S3Client;
  private options: Required<S3PersistenceOptions>;
  private sessionId: string | null = null;
  private sessionInfo: SessionInfo | null = null;
  private localCacheDir: string | null = null;

  // Log buffering
  private logBuffer: LogLine[] = [];
  private logBatchIndex = 0;
  private totalLogCount = 0;
  private flushTimer: NodeJS.Timeout | null = null;

  // Stdout capture
  private stdoutBuffer: string[] = [];
  private originalStdoutWrite: typeof process.stdout.write | null = null;
  private originalStderrWrite: typeof process.stderr.write | null = null;

  // Cache statistics
  private cacheHits = 0;
  private cacheMisses = 0;

  // Upload tracking
  private pendingUploads: Set<Promise<void>> = new Set();

  // Stagehand reference (set after init)
  private stagehand: Stagehand | null = null;

  constructor(options?: Partial<S3PersistenceOptions>) {
    // Sanitize model name for use in S3 paths (replace colons/spaces with dashes)
    const modelName = options?.modelName
      ? options.modelName.replace(/[:\s]/g, '-').toLowerCase()
      : 'default';

    // Build model-specific prefixes
    const cachePrefix = options?.cachePrefix ?? `stagehand-cache-${modelName}`;
    const resultsPrefix = options?.resultsPrefix ?? `results-${modelName}`;

    this.options = {
      bucket: options?.bucket ?? config.aws.s3.bucket,
      prefix: options?.prefix ?? config.aws.s3.prefix,
      cachePrefix,
      resultsPrefix,
      modelName,
      region: options?.region ?? config.aws.region,
      enabled: options?.enabled ?? config.aws.s3.enabled,
      logBatchSize: options?.logBatchSize ?? 50,
      flushIntervalMs: options?.flushIntervalMs ?? 10000,
      captureHistory: options?.captureHistory ?? true,
      captureMetrics: options?.captureMetrics ?? true,
      captureLogs: options?.captureLogs ?? true,
      syncCacheDir: options?.syncCacheDir ?? true,
      captureStdout: options?.captureStdout ?? true,
      downloadCacheOnStart: options?.downloadCacheOnStart ?? true,
      uploadCacheOnEnd: options?.uploadCacheOnEnd ?? true,
      snapshotCacheOnEnd: options?.snapshotCacheOnEnd ?? true,
    };

    this.s3Client = new S3Client({ region: this.options.region });
  }

  // MARK: - Stdout Capture

  /**
   * Start capturing stdout/stderr to buffer while still writing to terminal
   */
  private startStdoutCapture(): void {
    if (!this.options.captureStdout) return;

    this.stdoutBuffer = [];

    // Capture stdout - use simpler approach to avoid type issues
    this.originalStdoutWrite = process.stdout.write.bind(process.stdout);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.stdout.write = (chunk: any, encodingOrCallback?: any, callback?: any): boolean => {
      const str = typeof chunk === 'string' ? chunk : chunk.toString();
      this.stdoutBuffer.push(str);
      return this.originalStdoutWrite!(chunk, encodingOrCallback, callback);
    };

    // Capture stderr
    this.originalStderrWrite = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.stderr.write = (chunk: any, encodingOrCallback?: any, callback?: any): boolean => {
      const str = typeof chunk === 'string' ? chunk : chunk.toString();
      this.stdoutBuffer.push(`[STDERR] ${str}`);
      return this.originalStderrWrite!(chunk, encodingOrCallback, callback);
    };
  }

  /**
   * Stop capturing stdout/stderr and restore original functions
   */
  private stopStdoutCapture(): void {
    if (this.originalStdoutWrite) {
      process.stdout.write = this.originalStdoutWrite;
      this.originalStdoutWrite = null;
    }
    if (this.originalStderrWrite) {
      process.stderr.write = this.originalStderrWrite;
      this.originalStderrWrite = null;
    }
  }

  /**
   * Upload captured stdout to S3
   */
  private async uploadStdout(): Promise<void> {
    if (!this.options.enabled || !this.options.captureStdout || this.stdoutBuffer.length === 0) {
      return;
    }

    const stdout = this.stdoutBuffer.join('');
    const key = this.buildSessionKey('stdout.txt');

    try {
      await this.s3Client.send(new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: stdout,
        ContentType: 'text/plain',
      }));
    } catch (err) {
      console.warn('[StagehandS3] Failed to upload stdout:', err);
    }
  }

  // MARK: - Session Management

  /**
   * Start a new persistence session.
   * Call this before stagehand.init()
   *
   * If downloadCacheOnStart is true, this will download the global cache
   * from S3 to the local cacheDir before Stagehand starts.
   */
  async startSession(options?: {
    sessionId?: string;
    stagehandEnv?: string;
    model?: string;
    task?: string;
    cacheDir?: string;
  }): Promise<string> {
    this.sessionId = options?.sessionId ?? generateSessionId(this.options.modelName);
    this.localCacheDir = options?.cacheDir ?? config.stagehand.cacheDir;

    this.sessionInfo = {
      sessionId: this.sessionId,
      startTime: new Date().toISOString(),
      status: 'running',
      stagehandEnv: options?.stagehandEnv ?? 'LOCAL',
      model: options?.model,
      task: options?.task,
    };

    // Reset buffers and stats
    this.logBuffer = [];
    this.logBatchIndex = 0;
    this.totalLogCount = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;

    // Start stdout capture
    this.startStdoutCapture();

    // Download global cache from S3 BEFORE Stagehand starts
    if (this.options.enabled && this.options.downloadCacheOnStart && this.localCacheDir) {
      const downloaded = await this.downloadGlobalCache(this.localCacheDir);
      this.sessionInfo.cacheDownloaded = downloaded;
      console.log(`[StagehandS3] Downloaded ${downloaded} cache files from S3`);
    }

    // Start flush timer
    if (this.options.captureLogs && this.options.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        this.flushLogBuffer();
      }, this.options.flushIntervalMs);
    }

    // Upload initial metadata
    if (this.options.enabled) {
      this.uploadMetadata();
    }

    console.log(`[StagehandS3] Session started: ${this.sessionId}`);
    console.log(`[StagehandS3] Session path: s3://${this.options.bucket}/${this.options.prefix}/${this.sessionId}/`);
    console.log(`[StagehandS3] Global cache: s3://${this.options.bucket}/${this.options.cachePrefix}/`);

    return this.sessionId;
  }

  /**
   * Attach to a Stagehand instance to capture history/metrics at the end.
   * Call this after stagehand.init()
   */
  attachStagehand(stagehand: Stagehand): void {
    this.stagehand = stagehand;
  }

  /**
   * Create a Stagehand-compatible logger that captures logs to S3.
   * Pass this to the Stagehand constructor.
   *
   * This logger also tracks cache hits/misses from Stagehand's internal logs.
   */
  createLogger(): (logLine: LogLine) => void {
    return (logLine: LogLine) => {
      // Enrich with timestamp if missing
      const enrichedLog: LogLine = {
        ...logLine,
        timestamp: logLine.timestamp ?? new Date().toISOString(),
      };

      // Track cache hits/misses from Stagehand logs
      if (logLine.category === 'cache') {
        if (logLine.message.includes('cache hit')) {
          this.cacheHits++;
          // Add visual indicator for cache hits
          console.log(`\x1b[32m[CACHE HIT]\x1b[0m ${logLine.message}`);
        } else if (logLine.message.includes('cache miss') || logLine.message.includes('no cache')) {
          this.cacheMisses++;
          console.log(`\x1b[33m[CACHE MISS]\x1b[0m ${logLine.message}`);
        } else {
          this.logToConsole(enrichedLog);
        }
      } else {
        // Log to console (preserve default behavior)
        this.logToConsole(enrichedLog);
      }

      // Buffer for S3
      if (this.options.captureLogs && this.sessionId) {
        this.logBuffer.push(enrichedLog);
        this.totalLogCount++;

        if (this.logBuffer.length >= this.options.logBatchSize) {
          this.flushLogBuffer();
        }
      }
    };
  }

  /**
   * End the session and upload final data.
   * Call this before stagehand.close()
   *
   * This will:
   * 1. Upload cache files to global cache (for reuse)
   * 2. Save cache snapshot to session (for audit)
   * 3. Upload history, metrics, logs
   * 4. Upload stdout
   */
  async endSession(status: 'completed' | 'failed' = 'completed'): Promise<SessionReport | null> {
    if (!this.sessionId || !this.sessionInfo) {
      console.warn('[StagehandS3] No active session to end');
      return null;
    }

    // Stop flush timer
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Flush remaining logs
    await this.flushLogBufferSync();

    // Capture final history and metrics from Stagehand
    let finalMetrics: StagehandMetrics | null = null;
    let finalHistory: ReadonlyArray<HistoryEntry> = [];

    if (this.stagehand) {
      if (this.options.captureMetrics) {
        try {
          finalMetrics = await this.stagehand.metrics;
          await this.uploadMetrics(finalMetrics);
        } catch (err) {
          console.warn('[StagehandS3] Failed to capture metrics:', err);
        }
      }

      if (this.options.captureHistory) {
        try {
          finalHistory = await this.stagehand.history;
          await this.uploadHistory(finalHistory);
        } catch (err) {
          console.warn('[StagehandS3] Failed to capture history:', err);
        }
      }
    }

    // Handle cache: upload to global + snapshot to session
    let cacheFileCount = 0;
    if (this.options.syncCacheDir && this.localCacheDir) {
      // Upload to global cache (for reuse across sessions)
      if (this.options.uploadCacheOnEnd) {
        const uploaded = await this.uploadToGlobalCache(this.localCacheDir);
        this.sessionInfo.cacheUploaded = uploaded;
        console.log(`[StagehandS3] Uploaded ${uploaded} cache files to global cache`);
      }

      // Save snapshot to session (for audit trail)
      if (this.options.snapshotCacheOnEnd) {
        cacheFileCount = await this.snapshotCacheToSession(this.localCacheDir);
        console.log(`[StagehandS3] Saved ${cacheFileCount} cache files to session snapshot`);
      }
    }

    // Wait for all pending uploads
    await this.waitForPendingUploads();

    // Update session info with cache stats
    this.sessionInfo.endTime = new Date().toISOString();
    this.sessionInfo.status = status;
    this.sessionInfo.cacheHits = this.cacheHits;
    this.sessionInfo.cacheMisses = this.cacheMisses;

    // Calculate cache hit rate
    const totalCacheOps = this.cacheHits + this.cacheMisses;
    const hitRate = totalCacheOps > 0
      ? `${((this.cacheHits / totalCacheOps) * 100).toFixed(1)}%`
      : 'N/A';

    // Upload final metadata
    await this.uploadMetadataSync();

    // Build report
    const report: SessionReport = {
      session: this.sessionInfo,
      metrics: finalMetrics,
      history: finalHistory,
      logCount: this.totalLogCount,
      cacheFileCount,
      cacheStats: {
        hits: this.cacheHits,
        misses: this.cacheMisses,
        hitRate,
      },
      s3Paths: {
        base: `s3://${this.options.bucket}/${this.options.prefix}/${this.sessionId}/`,
        metadata: `s3://${this.options.bucket}/${this.buildSessionKey('metadata.json')}`,
        history: `s3://${this.options.bucket}/${this.buildSessionKey('history.json')}`,
        metrics: `s3://${this.options.bucket}/${this.buildSessionKey('metrics.json')}`,
        logs: `s3://${this.options.bucket}/${this.buildSessionKey('logs/')}`,
        cacheSnapshot: `s3://${this.options.bucket}/${this.buildSessionKey('cache-snapshot/')}`,
        globalCache: `s3://${this.options.bucket}/${this.options.cachePrefix}/`,
        stdout: `s3://${this.options.bucket}/${this.buildSessionKey('stdout.txt')}`,
      },
    };

    // Upload final report
    await this.uploadSync(this.buildSessionKey('report.json'), report);

    // Print cache statistics
    console.log(`\n[StagehandS3] Cache Statistics:`);
    console.log(`[StagehandS3]   Hits: ${this.cacheHits}`);
    console.log(`[StagehandS3]   Misses: ${this.cacheMisses}`);
    console.log(`[StagehandS3]   Hit Rate: ${hitRate}`);

    console.log(`[StagehandS3] Session ended: ${this.sessionId} (${status})`);
    console.log(`[StagehandS3]   History entries: ${finalHistory.length}`);
    console.log(`[StagehandS3]   Log entries: ${this.totalLogCount}`);
    console.log(`[StagehandS3]   Cache files: ${cacheFileCount}`);
    if (finalMetrics) {
      console.log(`[StagehandS3]   Total tokens: ${finalMetrics.totalPromptTokens + finalMetrics.totalCompletionTokens}`);
    }

    // Upload stdout (do this last so it captures all the above logs)
    await this.uploadStdout();

    // Stop stdout capture
    this.stopStdoutCapture();

    // Reset state
    const savedReport = report;
    this.sessionId = null;
    this.sessionInfo = null;
    this.stagehand = null;
    this.localCacheDir = null;

    return savedReport;
  }

  // MARK: - Global Cache Operations

  /**
   * Download all cache files from global S3 cache to local cacheDir
   * This enables cache reuse across sessions
   */
  async downloadGlobalCache(localCacheDir: string): Promise<number> {
    if (!this.options.enabled) return 0;

    let downloadCount = 0;
    let continuationToken: string | undefined;

    try {
      // Ensure local cache directory exists
      await mkdir(localCacheDir, { recursive: true });

      // List all objects in global cache
      do {
        const listResponse = await this.s3Client.send(new ListObjectsV2Command({
          Bucket: this.options.bucket,
          Prefix: this.options.cachePrefix + '/',
          ContinuationToken: continuationToken,
        }));

        if (listResponse.Contents) {
          for (const object of listResponse.Contents) {
            if (!object.Key || !object.Key.endsWith('.json')) continue;

            try {
              // Download the file
              const getResponse = await this.s3Client.send(new GetObjectCommand({
                Bucket: this.options.bucket,
                Key: object.Key,
              }));

              if (getResponse.Body) {
                const content = await getResponse.Body.transformToString();

                // Determine local path based on S3 key structure
                // S3: stagehand-cache/{domain}/{hash}.json
                // Local: .stagehand-cache/{hash}.json (Stagehand expects flat structure)
                const keyParts = object.Key.split('/');
                const fileName = keyParts[keyParts.length - 1];
                const localPath = join(localCacheDir, fileName);

                // Ensure parent directory exists
                await mkdir(dirname(localPath), { recursive: true });

                // Write to local file
                await writeFile(localPath, content, 'utf-8');
                downloadCount++;
              }
            } catch (downloadErr) {
              console.warn(`[StagehandS3] Failed to download ${object.Key}:`, downloadErr);
            }
          }
        }

        continuationToken = listResponse.NextContinuationToken;
      } while (continuationToken);

    } catch (err) {
      console.warn('[StagehandS3] Failed to download global cache:', err);
    }

    return downloadCount;
  }

  /**
   * Upload local cache files to global S3 cache
   * Files are organized by domain extracted from the cache content
   */
  async uploadToGlobalCache(localCacheDir: string): Promise<number> {
    if (!this.options.enabled) return 0;

    let uploadCount = 0;

    try {
      const files = await this.findCacheFiles(localCacheDir);

      for (const file of files) {
        try {
          const content = await readFile(file.path, 'utf-8');
          const domain = extractDomainFromCacheContent(content) || 'unknown';
          const parsed = JSON.parse(content);

          // IMPORTANT: Preserve the original filename that Stagehand generated
          // Stagehand uses SHA256(JSON.stringify({instruction, url, variables})) as the cache key
          // We must keep this exact filename for cache hits to work when downloaded
          const originalFilename = file.relativePath;

          // Upload to global cache: stagehand-cache/{domain}/{originalFilename}
          const globalKey = `${this.options.cachePrefix}/${domain}/${originalFilename}`;

          await this.uploadSync(globalKey, parsed);
          uploadCount++;
        } catch (fileErr) {
          console.warn(`[StagehandS3] Failed to upload cache file ${file.path}:`, fileErr);
        }
      }
    } catch (err) {
      console.warn('[StagehandS3] Failed to upload to global cache:', err);
    }

    return uploadCount;
  }

  /**
   * Save a snapshot of the current cache to the session for audit trail
   */
  async snapshotCacheToSession(localCacheDir: string): Promise<number> {
    if (!this.options.enabled) return 0;

    let snapshotCount = 0;

    try {
      const files = await this.findCacheFiles(localCacheDir);

      for (const file of files) {
        try {
          const content = await readFile(file.path, 'utf-8');
          const parsed = JSON.parse(content);

          // Save to session: stagehand-runs/{session}/cache-snapshot/{filename}
          const snapshotKey = this.buildSessionKey('cache-snapshot', file.relativePath);
          await this.uploadSync(snapshotKey, parsed);
          snapshotCount++;
        } catch (fileErr) {
          console.warn(`[StagehandS3] Failed to snapshot cache file ${file.path}:`, fileErr);
        }
      }
    } catch (err) {
      console.warn('[StagehandS3] Failed to snapshot cache:', err);
    }

    return snapshotCount;
  }

  // MARK: - Console Logging

  private logToConsole(logLine: LogLine): void {
    const prefix = logLine.category ? `[${logLine.category}]` : '';
    const level = logLine.level ?? 1;

    // Truncate long messages (like full prompts/instructions)
    let msg = logLine.message;
    if (msg.length > 200) {
      msg = msg.substring(0, 200) + '...';
    }

    // Skip verbose extraction/observation instruction logs entirely
    if (msg.includes('instruction=') && msg.length > 100) {
      return; // Don't print full instructions to console
    }

    let auxStr = '';
    if (logLine.auxiliary) {
      const auxParts = Object.entries(logLine.auxiliary)
        .map(([key, val]) => {
          // Truncate long auxiliary values too
          const valStr = String(val.value);
          return `${key}=${valStr.length > 50 ? valStr.substring(0, 50) + '...' : valStr}`;
        })
        .join(', ');
      auxStr = auxParts ? ` (${auxParts})` : '';
    }

    const message = `${prefix} ${msg}${auxStr}`;

    switch (level) {
      case 0:
        console.error(message);
        break;
      case 2:
        console.debug(message);
        break;
      default:
        console.log(message);
    }
  }

  // MARK: - Log Buffer Management

  private flushLogBuffer(): void {
    if (!this.options.enabled || this.logBuffer.length === 0 || !this.sessionId) {
      return;
    }

    const batch = [...this.logBuffer];
    this.logBuffer = [];
    this.logBatchIndex++;

    const key = this.buildSessionKey('logs', `batch-${String(this.logBatchIndex).padStart(4, '0')}.json`);
    this.uploadAsync(key, {
      sessionId: this.sessionId,
      batchIndex: this.logBatchIndex,
      timestamp: new Date().toISOString(),
      logs: batch,
    });
  }

  private async flushLogBufferSync(): Promise<void> {
    if (!this.options.enabled || this.logBuffer.length === 0 || !this.sessionId) {
      return;
    }

    const batch = [...this.logBuffer];
    this.logBuffer = [];
    this.logBatchIndex++;

    const key = this.buildSessionKey('logs', `batch-${String(this.logBatchIndex).padStart(4, '0')}.json`);
    await this.uploadSync(key, {
      sessionId: this.sessionId,
      batchIndex: this.logBatchIndex,
      timestamp: new Date().toISOString(),
      logs: batch,
    });
  }

  // MARK: - S3 Upload Methods

  private async uploadMetrics(metrics: StagehandMetrics): Promise<void> {
    if (!this.options.enabled) return;
    await this.uploadSync(this.buildSessionKey('metrics.json'), {
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      metrics,
    });
  }

  private async uploadHistory(history: ReadonlyArray<HistoryEntry>): Promise<void> {
    if (!this.options.enabled) return;
    await this.uploadSync(this.buildSessionKey('history.json'), {
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      entryCount: history.length,
      history: [...history],
    });
  }

  private uploadMetadata(): void {
    if (!this.options.enabled || !this.sessionInfo) return;
    this.uploadAsync(this.buildSessionKey('metadata.json'), this.sessionInfo);
  }

  private async uploadMetadataSync(): Promise<void> {
    if (!this.options.enabled || !this.sessionInfo) return;
    await this.uploadSync(this.buildSessionKey('metadata.json'), this.sessionInfo);
  }

  private uploadAsync(key: string, data: unknown): void {
    const promise = this.uploadWithRetry(key, data).catch((err) => {
      console.error(`[StagehandS3] Upload failed: ${key}`, err.message);
    }).finally(() => {
      this.pendingUploads.delete(promise);
    });
    this.pendingUploads.add(promise);
  }

  private async uploadSync(key: string, data: unknown): Promise<void> {
    await this.uploadWithRetry(key, data);
  }

  private async uploadWithRetry(key: string, data: unknown, attempt = 1): Promise<void> {
    try {
      await this.s3Client.send(new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: JSON.stringify(data, null, 2),
        ContentType: 'application/json',
      }));
    } catch (error) {
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 100));
        return this.uploadWithRetry(key, data, attempt + 1);
      }
      throw error;
    }
  }

  private async waitForPendingUploads(): Promise<void> {
    if (this.pendingUploads.size > 0) {
      console.log(`[StagehandS3] Waiting for ${this.pendingUploads.size} pending uploads...`);
      await Promise.allSettled(Array.from(this.pendingUploads));
    }
  }

  // MARK: - Cache File Discovery

  private async findCacheFiles(
    dir: string,
    basePath = dir
  ): Promise<Array<{ path: string; relativePath: string }>> {
    const files: Array<{ path: string; relativePath: string }> = [];

    try {
      if (!existsSync(dir)) {
        return files;
      }

      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        const relativePath = fullPath.substring(basePath.length + 1);

        if (entry.isDirectory()) {
          const subFiles = await this.findCacheFiles(fullPath, basePath);
          files.push(...subFiles);
        } else if (entry.name.endsWith('.json')) {
          files.push({ path: fullPath, relativePath });
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }

    return files;
  }

  // MARK: - Key Building

  private buildSessionKey(...parts: string[]): string {
    return `${this.options.prefix}/${this.sessionId}/${parts.join('/')}`;
  }

  // MARK: - Getters

  getSessionId(): string | null {
    return this.sessionId;
  }

  getSessionUrl(): string | null {
    if (!this.sessionId) return null;
    return `s3://${this.options.bucket}/${this.options.prefix}/${this.sessionId}/`;
  }

  getGlobalCacheUrl(): string {
    return `s3://${this.options.bucket}/${this.options.cachePrefix}/`;
  }

  isEnabled(): boolean {
    return this.options.enabled;
  }

  getCacheStats(): { hits: number; misses: number; hitRate: string } {
    const total = this.cacheHits + this.cacheMisses;
    const hitRate = total > 0 ? `${((this.cacheHits / total) * 100).toFixed(1)}%` : 'N/A';
    return { hits: this.cacheHits, misses: this.cacheMisses, hitRate };
  }

  // MARK: - Incremental Flush

  /**
   * Flush all pending data to S3 immediately.
   * Call this after processing each company to ensure data is persisted.
   *
   * This uploads:
   * - Pending logs
   * - Current metrics snapshot
   * - Current history snapshot
   * - Cache files to global cache
   * - Session metadata update
   */
  async flushAll(): Promise<void> {
    if (!this.options.enabled || !this.sessionId) {
      return;
    }

    // Flush pending logs
    await this.flushLogBufferSync();

    // Upload current metrics if we have stagehand attached
    if (this.stagehand && this.options.captureMetrics) {
      try {
        const metrics = await this.stagehand.metrics;
        await this.uploadMetrics(metrics);
      } catch {
        // Ignore errors - metrics might not be ready
      }
    }

    // Upload current history if we have stagehand attached
    if (this.stagehand && this.options.captureHistory) {
      try {
        const history = await this.stagehand.history;
        await this.uploadHistory(history);
      } catch {
        // Ignore errors - history might not be ready
      }
    }

    // Upload cache files to global cache
    if (this.options.syncCacheDir && this.localCacheDir) {
      await this.uploadToGlobalCache(this.localCacheDir);
    }

    // Update session metadata
    await this.uploadMetadataSync();

    // Wait for any pending async uploads
    await this.waitForPendingUploads();
  }

  // MARK: - Discovery Results Upload

  /**
   * Upload discovery results to S3
   * Creates a results.json file in the session directory with company -> URL mappings
   */
  async uploadDiscoveryResults(results: Array<{
    companyName: string;
    companyWebsite: string;
    success: boolean;
    newsPageUrl: string | null;
    latestDate: string | null;
    discoveryMethod?: string;
    error?: string;
    steps?: Array<{
      step: string;
      action: string;
      detail?: string;
      result: string;
      url?: string;
      timestamp: string;
    }>;
  }>): Promise<void> {
    if (!this.options.enabled || !this.sessionId) {
      console.log('[StagehandS3] Skipping results upload (S3 disabled or no session)');
      return;
    }

    const resultsData = {
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      totalCompanies: results.length,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results: results.map(r => ({
        company: r.companyName,
        website: r.companyWebsite,
        success: r.success,
        newsPageUrl: r.newsPageUrl,
        latestDate: r.latestDate,
        discoveryMethod: r.discoveryMethod || null,
        error: r.error || null,
        // Include steps summary
        stepsSummary: r.steps ? summarizeSteps(r.steps) : null,
        // Full steps for detailed audit
        steps: r.steps || [],
      })),
      // Quick lookup map: company name -> news URL
      companyNewsUrls: Object.fromEntries(
        results
          .filter(r => r.success && r.newsPageUrl)
          .map(r => [r.companyName, r.newsPageUrl])
      ),
    };

    const key = this.buildSessionKey('discovery-results.json');
    await this.uploadSync(key, resultsData);

    console.log(`[StagehandS3] Uploaded discovery results to s3://${this.options.bucket}/${key}`);
    console.log(`[StagehandS3]   Total: ${results.length}, Success: ${resultsData.successful}, Failed: ${resultsData.failed}`);

    // Also save per-domain results to the results cache folder
    // This enables quick lookups without re-running discovery
    for (const result of results) {
      if (result.success && result.newsPageUrl) {
        const domain = result.companyWebsite.replace(/^www\./, '').toLowerCase();
        const domainResultKey = `${this.options.resultsPrefix}/${domain}.json`;

        const domainResult = {
          domain,
          companyName: result.companyName,
          newsPageUrl: result.newsPageUrl,
          latestDate: result.latestDate,
          discoveryMethod: result.discoveryMethod || null,
          discoveredAt: new Date().toISOString(),
          sessionId: this.sessionId,
          modelName: this.options.modelName,
        };

        await this.uploadSync(domainResultKey, domainResult);
        console.log(`[StagehandS3] Cached result for ${domain} to s3://${this.options.bucket}/${domainResultKey}`);
      }
    }
  }

  // MARK: - Discovery Result Cache Lookup

  /**
   * Check if we have a cached discovery result for a domain
   * Returns the cached result if found, null otherwise
   */
  async getCachedDiscoveryResult(domain: string): Promise<{
    domain: string;
    companyName: string;
    newsPageUrl: string;
    latestDate: string | null;
    discoveryMethod: string | null;
    discoveredAt: string;
    sessionId: string;
    modelName: string;
  } | null> {
    if (!this.options.enabled) {
      return null;
    }

    const normalizedDomain = domain.replace(/^www\./, '').toLowerCase();
    const key = `${this.options.resultsPrefix}/${normalizedDomain}.json`;

    try {
      const response = await this.s3Client.send(new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
      }));

      if (response.Body) {
        const content = await response.Body.transformToString();
        const result = JSON.parse(content);
        console.log(`[StagehandS3] Cache HIT for ${normalizedDomain} (discovered ${result.discoveredAt})`);
        return result;
      }
    } catch (err: unknown) {
      // NoSuchKey is expected when cache doesn't exist
      if (err && typeof err === 'object' && 'name' in err && err.name !== 'NoSuchKey') {
        console.warn(`[StagehandS3] Error checking cache for ${normalizedDomain}:`, err);
      }
    }

    console.log(`[StagehandS3] Cache MISS for ${normalizedDomain}`);
    return null;
  }
}

/**
 * Summarize discovery steps into a human-readable format
 */
function summarizeSteps(steps: Array<{
  step: string;
  action: string;
  detail?: string;
  result: string;
  url?: string;
}>): string {
  if (steps.length === 0) return 'No steps recorded';

  const lines: string[] = [];
  let currentStepPrefix = '';

  for (const step of steps) {
    // Extract the main step number (e.g., "1" from "1A", "1B", "1D-1")
    const mainStep = step.step.charAt(0);

    if (mainStep !== currentStepPrefix) {
      currentStepPrefix = mainStep;
      const stageName = mainStep === '1' ? 'Search' : mainStep === '2' ? 'Homepage' : 'Other';
      lines.push(`[Step ${mainStep}: ${stageName}]`);
    }

    const resultIcon = step.result === 'success' ? '✓' : step.result === 'fail' ? '✗' : step.result === 'skip' ? '○' : '→';
    const urlPart = step.url ? ` (${step.url})` : '';
    const detailPart = step.detail ? `: ${step.detail}` : '';
    lines.push(`  ${resultIcon} [${step.step}] ${step.action}${detailPart}${urlPart}`);
  }

  return lines.join('\n');
}

// MARK: - Factory Functions

/**
 * Create a new StagehandS3Persistence instance
 */
export function createStagehandS3Persistence(
  options?: Partial<S3PersistenceOptions>
): StagehandS3Persistence {
  return new StagehandS3Persistence(options);
}

/**
 * Create persistence and logger together for easy setup
 *
 * @example
 * ```ts
 * const { persistence, logger } = createS3PersistenceWithLogger({
 *   bucket: 'my-bucket',
 *   enabled: true,
 * });
 *
 * // Start session - downloads global cache from S3
 * await persistence.startSession({
 *   task: 'My automation',
 *   cacheDir: '.stagehand-cache',
 * });
 *
 * const stagehand = new Stagehand({
 *   logger,
 *   cacheDir: '.stagehand-cache',
 * });
 *
 * await stagehand.init();
 * persistence.attachStagehand(stagehand);
 *
 * // ... run automation ...
 *
 * // End session - uploads cache to global + saves snapshot + uploads stdout
 * await persistence.endSession();
 * await stagehand.close();
 * ```
 */
export function createS3PersistenceWithLogger(options?: Partial<S3PersistenceOptions>): {
  persistence: StagehandS3Persistence;
  logger: (logLine: LogLine) => void;
} {
  const persistence = new StagehandS3Persistence(options);
  const logger = persistence.createLogger();
  return { persistence, logger };
}
