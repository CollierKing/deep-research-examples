/**
 * Configuration for web scraping with Stagehand
 *
 * S3 Persistence captures:
 * - Tool calls (via LangChain middleware)
 * - Stagehand metrics (token usage, timing)
 * - Stagehand history (all primitive calls)
 * - Stagehand logs (via custom logger)
 * - Cache entries (ActCache, AgentCache)
 * - Inference logs (LLM call details)
 */

//MARK: - Configuration
export const config = {
  // AWS Settings
  aws: {
    region: process.env.AWS_REGION || 'us-east-1',
    s3: {
      bucket: process.env.S3_PERSISTENCE_BUCKET || 'stagehand-test-bucket',
      prefix: process.env.S3_PERSISTENCE_PREFIX || 'stagehand-runs',
      enabled: process.env.S3_PERSISTENCE_ENABLED === 'true',
      // Buffer settings
      bufferSize: parseInt(process.env.S3_BUFFER_SIZE || '5'),
      bufferFlushIntervalMs: parseInt(process.env.S3_BUFFER_FLUSH_MS || '10000'),
      // Capture options
      captureLogsBatchSize: parseInt(process.env.S3_LOGS_BATCH_SIZE || '50'),
      captureInferenceLogs: process.env.S3_CAPTURE_INFERENCE !== 'false',
      captureCacheEntries: process.env.S3_CAPTURE_CACHE !== 'false',
    },
  },

  // Stagehand Settings
  stagehand: {
    env: (process.env.STAGEHAND_ENV || 'LOCAL') as 'LOCAL' | 'BROWSERBASE',
    verbose: parseInt(process.env.STAGEHAND_VERBOSE || '1') as 0 | 1 | 2,
    debugDom: process.env.STAGEHAND_DEBUG_DOM === 'true',
    headless: process.env.STAGEHAND_HEADLESS !== 'false',
    // Model configuration
    // Options: openai/gpt-4o, openai/gpt-4o-mini, openai/gpt-4.1-mini, etc.
    modelName: process.env.STAGEHAND_MODEL_NAME || 'openai/gpt-4.1-mini',
    // Cache directory for Stagehand's ActCache/AgentCache
    cacheDir: process.env.STAGEHAND_CACHE_DIR || '.stagehand-cache',
    // Enable inference logging to file (captured by S3 persistence)
    logInferenceToFile: process.env.STAGEHAND_LOG_INFERENCE === 'true',
  },
} as const;

export default config;
