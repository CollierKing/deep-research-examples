/**
 * Type Definitions for News/PR Page Discovery
 *
 * Contains all TypeScript interfaces and types used across the discovery module.
 */

// MARK: - Input Types

/**
 * Company input for discovery
 */
export interface CompanyInput {
  name: string;
  website: string;
  ticker?: string;
}

// MARK: - Result Types

/**
 * A single step in the discovery process
 */
export interface DiscoveryStep {
  /** Step identifier like "1", "1A", "2", "2A", "2B" */
  step: string;
  action: string;
  detail?: string;
  result: 'success' | 'skip' | 'fail' | 'info';
  url?: string;
  timestamp: string;
}

/**
 * Result of discovering a company's news/PR page
 */
export interface DiscoveryResult {
  companyName: string;
  companyWebsite: string;
  success: boolean;
  newsPageUrl: string | null;
  latestDate: string | null;
  error?: string;
  durationMs: number;
  searchResultsCount: number;
  candidatesChecked: number;
  discoveryMethod?: 'search' | 'homepage' | 'site-search' | 'cached';
  /** Ordered list of steps taken during discovery */
  steps: DiscoveryStep[];
}

// MARK: - Configuration Types

/**
 * Configuration for the discovery process
 *
 * Note: LLM provider configuration is handled separately via config.ts
 * and the llm-providers.ts factory. This interface only contains
 * discovery-specific settings.
 */
export interface DiscoveryConfig {
  /** Run browser in headless mode */
  headless: boolean;
  /** Stagehand verbosity level (0=silent, 1=normal, 2=debug) */
  verbose: 0 | 1 | 2;
  /** Directory for Stagehand's act() cache */
  cacheDir: string;
  /** Maximum search results to extract from DuckDuckGo */
  maxSearchResults: number;
  /** Maximum candidates to verify with LLM per step */
  maxCandidatesToCheck: number;
  /** Timeout for page navigation in milliseconds */
  timeoutMs: number;
  /** Delay between browser actions in milliseconds */
  delayBetweenActionsMs: number;
}

// MARK: - Internal Types

/**
 * Search result from DuckDuckGo
 */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Result of URL categorization
 */
export interface CategorizedUrls {
  listingPages: SearchResult[];
  articles: SearchResult[];
}

/**
 * Result from search-based discovery (Stages 1-3)
 */
export interface SearchDiscoveryResult {
  success: boolean;
  newsPageUrl: string | null;
  latestDate: string | null;
  searchResultsCount: number;
  candidatesChecked: number;
  error?: string;
}

/**
 * Result from homepage-based discovery (Stage 4)
 */
export interface HomepageDiscoveryResult {
  success: boolean;
  newsPageUrl: string | null;
  latestDate: string | null;
  candidatesChecked: number;
  error?: string;
}

/**
 * Metrics from multi-company discovery
 */
export interface DiscoveryMetrics {
  totalCompanies: number;
  successful: number;
  failed: number;
  totalDurationMs: number;
  discoveryByMethod: {
    search: number;
    homepage: number;
    'site-search': number;
    cached: number;
  };
}

/**
 * Result from multi-company discovery
 */
export interface MultiCompanyDiscoveryResult {
  results: DiscoveryResult[];
  metrics: DiscoveryMetrics;
}
