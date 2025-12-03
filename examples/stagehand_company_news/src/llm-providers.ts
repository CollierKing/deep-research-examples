/**
 * LLM Provider Factory
 *
 * Creates AISdkClient instances for different LLM providers.
 * Supports: Ollama (local), OpenAI, Anthropic (Claude), Google (Gemini)
 *
 * Usage:
 *   const { client } = await createLLMClient({
 *     provider: 'anthropic',
 *     model: 'claude-sonnet-4-20250514',
 *     apiKey: process.env.ANTHROPIC_API_KEY,
 *   });
 */

import { AISdkClient } from '@browserbasehq/stagehand';

// MARK: - Types

/**
 * Supported LLM providers
 */
export type LLMProvider = 'ollama' | 'openai' | 'anthropic' | 'google';

/**
 * Configuration for creating an LLM client
 */
export interface LLMConfig {
  /** The LLM provider to use */
  provider: LLMProvider;
  /** Model name (provider-specific format) */
  model: string;
  /** API key for cloud providers (not needed for Ollama) */
  apiKey?: string;
  /** Base URL for self-hosted providers like Ollama */
  baseUrl?: string;
}

/**
 * Result of creating an LLM client
 */
export interface LLMClientResult {
  client: AISdkClient;
  provider: LLMProvider;
  model: string;
}

// MARK: - Ollama Provider

/**
 * Create Ollama client for local LLM inference
 */
async function createOllamaClient(config: LLMConfig): Promise<AISdkClient> {
  const { createOllama } = await import('ollama-ai-provider-v2');

  if (!config.baseUrl) {
    throw new Error('Ollama requires baseUrl to be specified');
  }

  const ollamaProvider = createOllama({
    baseURL: `${config.baseUrl}/api`,
  });

  return new AISdkClient({
    model: ollamaProvider(config.model),
  });
}

// MARK: - OpenAI Provider

/**
 * Create OpenAI client
 */
async function createOpenAIClient(config: LLMConfig): Promise<AISdkClient> {
  const { createOpenAI } = await import('@ai-sdk/openai');

  const openaiProvider = createOpenAI({
    apiKey: config.apiKey,
  });

  return new AISdkClient({
    model: openaiProvider(config.model),
  });
}

// MARK: - Anthropic Provider

/**
 * Create Anthropic (Claude) client
 */
async function createAnthropicClient(config: LLMConfig): Promise<AISdkClient> {
  const { createAnthropic } = await import('@ai-sdk/anthropic');

  const anthropicProvider = createAnthropic({
    apiKey: config.apiKey,
  });

  return new AISdkClient({
    model: anthropicProvider(config.model),
  });
}

// MARK: - Google Provider

/**
 * Create Google (Gemini) client
 */
async function createGoogleClient(config: LLMConfig): Promise<AISdkClient> {
  const { createGoogleGenerativeAI } = await import('@ai-sdk/google');

  const googleProvider = createGoogleGenerativeAI({
    apiKey: config.apiKey,
  });

  return new AISdkClient({
    model: googleProvider(config.model),
  });
}

// MARK: - Factory Function

/**
 * Create an LLM client for the specified provider
 *
 * @param config - LLM configuration
 * @returns AISdkClient configured for the provider
 *
 * @example
 * // Ollama (local)
 * const { client } = await createLLMClient({
 *   provider: 'ollama',
 *   model: 'gpt-oss:20b',
 *   baseUrl: 'http://localhost:11434',
 * });
 *
 * @example
 * // OpenAI
 * const { client } = await createLLMClient({
 *   provider: 'openai',
 *   model: 'gpt-4o',
 *   apiKey: process.env.OPENAI_API_KEY,
 * });
 *
 * @example
 * // Anthropic Claude
 * const { client } = await createLLMClient({
 *   provider: 'anthropic',
 *   model: 'claude-sonnet-4-20250514',
 *   apiKey: process.env.ANTHROPIC_API_KEY,
 * });
 *
 * @example
 * // Google Gemini
 * const { client } = await createLLMClient({
 *   provider: 'google',
 *   model: 'gemini-2.5-flash',
 *   apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
 * });
 */
export async function createLLMClient(config: LLMConfig): Promise<LLMClientResult> {
  // Validate API key for cloud providers
  if (config.provider !== 'ollama' && !config.apiKey) {
    throw new Error(`${config.provider} provider requires an API key`);
  }

  let client: AISdkClient;

  switch (config.provider) {
    case 'ollama':
      client = await createOllamaClient(config);
      break;

    case 'openai':
      client = await createOpenAIClient(config);
      break;

    case 'anthropic':
      client = await createAnthropicClient(config);
      break;

    case 'google':
      client = await createGoogleClient(config);
      break;

    default:
      throw new Error(`Unsupported LLM provider: ${config.provider}`);
  }

  return {
    client,
    provider: config.provider,
    model: config.model,
  };
}

// MARK: - Display Names

/**
 * Get a human-readable name for a provider
 */
export function getProviderDisplayName(provider: LLMProvider): string {
  const names: Record<LLMProvider, string> = {
    ollama: 'Ollama (Local)',
    openai: 'OpenAI',
    anthropic: 'Anthropic Claude',
    google: 'Google Gemini',
  };
  return names[provider] || provider;
}

// MARK: - Environment Variables

/**
 * Get the environment variable name for a provider's API key
 */
export function getApiKeyEnvVar(provider: LLMProvider): string | null {
  const envVars: Record<LLMProvider, string | null> = {
    ollama: null, // No API key needed
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    google: 'GOOGLE_API_KEY',
  };
  return envVars[provider];
}

// MARK: - Recommended Models

/**
 * Get recommended models for each provider
 */
export function getRecommendedModels(provider: LLMProvider): string[] {
  const models: Record<LLMProvider, string[]> = {
    ollama: ['gpt-oss:20b', 'llama3.1:70b', 'qwen2.5:72b'],
    openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
    anthropic: ['claude-sonnet-4-20250514', 'claude-3-5-sonnet-20241022', 'claude-3-haiku-20240307'],
    google: ['gemini-2.5-flash', 'gemini-2.0-flash-exp', 'gemini-1.5-pro'],
  };
  return models[provider] || [];
}
