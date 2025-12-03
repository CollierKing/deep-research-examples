/**
 * Configuration for News/PR Page Discovery with Stagehand
 *
 * This module centralizes all configuration for:
 * - LLM providers (Ollama, OpenAI, Claude, Gemini)
 * - Stagehand browser automation settings
 * - S3 persistence for logs, metrics, and cache
 * - Discovery process parameters
 *
 * All settings can be overridden via environment variables.
 */

import type { LLMProvider } from './src/llm-providers';

// MARK: - Configuration Export

export const config = {
  // MARK: - AWS / S3 Settings

  aws: {
    region: process.env.AWS_REGION || 'us-east-1',
    s3: {
      /** S3 bucket for storing session data */
      bucket: process.env.S3_PERSISTENCE_BUCKET || 'stagehand-test-bucket',
      /** Prefix for all S3 keys */
      prefix: process.env.S3_PERSISTENCE_PREFIX || 'stagehand-runs',
      /** Enable S3 persistence (default: false) */
      enabled: process.env.S3_PERSISTENCE_ENABLED === 'true',
      /** Number of log entries to buffer before uploading */
      bufferSize: parseInt(process.env.S3_BUFFER_SIZE || '5'),
      /** Flush buffer interval in milliseconds */
      bufferFlushIntervalMs: parseInt(process.env.S3_BUFFER_FLUSH_MS || '10000'),
      /** Batch size for log uploads */
      captureLogsBatchSize: parseInt(process.env.S3_LOGS_BATCH_SIZE || '50'),
      /** Capture LLM inference logs */
      captureInferenceLogs: process.env.S3_CAPTURE_INFERENCE !== 'false',
      /** Capture Stagehand cache entries */
      captureCacheEntries: process.env.S3_CAPTURE_CACHE !== 'false',
    },
  },

  // MARK: - LLM Provider Settings

  llm: {
    /**
     * LLM provider to use
     * Options: 'ollama' | 'openai' | 'anthropic' | 'google'
     */
    provider: (process.env.LLM_PROVIDER || 'ollama') as LLMProvider,

    /**
     * Model name (provider-specific format)
     *
     * Examples:
     *   ollama: 'gpt-oss:20b', 'llama3.1:70b', 'qwen2.5:72b'
     *   openai: 'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'
     *   anthropic: 'claude-sonnet-4-20250514', 'claude-3-5-sonnet-20241022'
     *   google: 'gemini-2.5-flash', 'gemini-1.5-pro'
     */
    model: process.env.LLM_MODEL || 'gpt-oss:20b',

    /** Ollama-specific settings */
    ollama: {
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    },

    /** API keys for cloud providers (loaded from environment) */
    apiKeys: {
      openai: process.env.OPENAI_API_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
      google: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    },
  },

  // MARK: - Stagehand Settings

  stagehand: {
    /** Browser environment: 'LOCAL' or 'BROWSERBASE' */
    env: (process.env.STAGEHAND_ENV || 'LOCAL') as 'LOCAL' | 'BROWSERBASE',
    /** Verbosity level: 0=silent, 1=normal, 2=debug */
    verbose: parseInt(process.env.STAGEHAND_VERBOSE || '1') as 0 | 1 | 2,
    /** Enable DOM debugging overlay */
    debugDom: process.env.STAGEHAND_DEBUG_DOM === 'true',
    /** Run browser in headless mode */
    headless: process.env.STAGEHAND_HEADLESS !== 'false',
    /** Directory for Stagehand's act() cache */
    cacheDir: process.env.STAGEHAND_CACHE_DIR || '.stagehand-cache',
    /** Log LLM inference calls to file */
    logInferenceToFile: process.env.STAGEHAND_LOG_INFERENCE === 'true',
  },

  // MARK: - Discovery Settings

  discovery: {
    /** Maximum search results to extract from DuckDuckGo */
    maxSearchResults: parseInt(process.env.DISCOVERY_MAX_SEARCH_RESULTS || '10'),
    /** Maximum candidates to verify with LLM per discovery step */
    maxCandidatesToCheck: parseInt(process.env.DISCOVERY_MAX_CANDIDATES || '5'),
    /** Timeout for page navigation in milliseconds */
    timeoutMs: parseInt(process.env.DISCOVERY_TIMEOUT_MS || '30000'),
    /** Delay between browser actions in milliseconds */
    delayBetweenActionsMs: parseInt(process.env.DISCOVERY_DELAY_MS || '2000'),
  },
} as const;

// MARK: - Default Export

export default config;
