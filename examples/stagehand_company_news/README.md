# Stagehand News Discovery with S3 Persistence

This example demonstrates how to use Stagehand with Ollama for automated news/press release page discovery, with full S3 persistence for session data, logs, metrics, and cache.

## Overview

This project implements a **4-stage discovery flow** to find company news and press release pages:

1. **Stage 1: DuckDuckGo Search (PRIMARY)** - Search for `site:{domain}` with news/press keywords
2. **Stage 2: Heuristic URL Filtering (NO LLM)** - Classify URLs as listing pages vs articles, extract root URLs
3. **Stage 3: Candidate Verification Loop** - LLM verification with detailed examples and HTTP validation
4. **Stage 4: Homepage Exploration (LAST RESORT)** - Navigate homepage, expand menus, verify links

Key features:
- **Stagehand v3**: Browser automation with AI-powered tools (navigate, act, observe, extract)
- **Ollama**: Local LLM for verification (no API costs)
- **S3 Persistence**: Automatic capture and storage of all session data
- **Bidirectional Cache Sync**: Global cache shared across runs + per-session snapshots

## Architecture

```
Discovery Flow:
                                   ┌─────────────────────────────────────────┐
                                   │         Stage 1: DuckDuckGo Search       │
                                   │    site:{domain} (news OR press OR ...)  │
                                   └─────────────────┬───────────────────────┘
                                                     │
                                                     ▼
                                   ┌─────────────────────────────────────────┐
                                   │    Stage 2: Heuristic URL Filtering      │
                                   │          (NO LLM - Fast & Free)          │
                                   │  • Filter by keywords in URL/title       │
                                   │  • Classify: listing page vs article     │
                                   │  • Extract root URLs from article paths  │
                                   └─────────────────┬───────────────────────┘
                                                     │
                                                     ▼
                                   ┌─────────────────────────────────────────┐
                                   │   Stage 3: Candidate Verification Loop   │
                                   │  • Navigate to each candidate            │
                                   │  • LLM verification (12 detailed examples)│
                                   │  • 5 critical checks must ALL pass       │
                                   │  • HTTP status validation (2xx only)     │
                                   │  • Return immediately on first valid     │
                                   └─────────────────┬───────────────────────┘
                                                     │
                                           Success?──┤
                                             YES     │ NO
                                              ▼      ▼
                                           DONE    ┌─────────────────────────────────────────┐
                                                   │  Stage 4: Homepage Exploration (Fallback)│
                                                   │  • Navigate to company homepage          │
                                                   │  • Extract links from nav/header/footer  │
                                                   │  • Expand dropdown menus with act()      │
                                                   │  • Verify each link found                │
                                                   └───────────────────────────────────────────┘
```

## S3 Persistence Architecture

```
S3 Bucket Structure:
stagehand-runs/
├── {session-id}/                    # Per-session folder
│   ├── metadata.json                # Session metadata
│   ├── history.json                 # Stagehand action history
│   ├── metrics.json                 # Token usage metrics
│   ├── logs.json                    # Buffered log entries
│   ├── stdout.txt                   # Full terminal output
│   └── cache-snapshot/              # Session cache snapshot (audit trail)
│       └── {domain}_{hash}.json
│
stagehand-cache/                     # Global cache (shared across runs)
├── {domain}/
│   └── {instruction-hash}.json      # Cached act() responses
```

## Prerequisites

1. **Node.js** (v18+)
2. **AWS Account** with S3 access
3. **Ollama** running locally or remotely with a compatible model
4. **AWS Credentials** configured (via `~/.aws/credentials` or environment variables)

## Setup

### 1. Install Dependencies

```bash
npm install --legacy-peer-deps
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Required environment variables:

```bash
# AWS Configuration
AWS_REGION=us-east-1
S3_PERSISTENCE_BUCKET=your-s3-bucket-name
S3_PERSISTENCE_PREFIX=stagehand-runs
S3_PERSISTENCE_ENABLED=true

# Stagehand Configuration
STAGEHAND_ENV=LOCAL
STAGEHAND_VERBOSE=1
STAGEHAND_HEADLESS=true
STAGEHAND_CACHE_DIR=.stagehand-cache
```

### 3. Set Up Ollama

Make sure Ollama is running with a compatible model. Update the configuration in the test files:

```typescript
const MODEL = 'gpt-oss:20b';  // Change to your model
const OLLAMA_BASE_URL = 'http://100.122.179.22:11434';  // Change to your Ollama server
```

### 4. Create S3 Bucket

```bash
aws s3 mb s3://your-s3-bucket-name --region us-east-1
```

## Running the Tests

### News Discovery Test (4-Stage Flow)

```bash
# Run locally (no S3)
npm run test:discovery

# Run with S3 persistence
npm run test:discovery:s3
```

### Native Stagehand Test

```bash
# Run locally
npm run test:native

# Run with S3
npm run test:native:s3
```

### S3 Persistence Test

```bash
npm run test:s3:enabled
```

## Project Structure

```
.
├── config.ts                          # Central configuration
├── tests/
│   ├── news-discovery.ts              # 4-stage discovery module
│   ├── test-news-discovery.ts         # Discovery test with S3
│   ├── test-stagehand-native.ts       # Native Stagehand test
│   └── schemas.ts                     # Zod schemas
├── utils/
│   └── stagehand-s3-persistence.ts    # S3 persistence with cache sync
├── package.json
├── tsconfig.json
└── .env.example
```

## Discovery Flow Details

### Stage 1: DuckDuckGo Search

The primary discovery method uses a targeted search:

```
site:{domain} (news OR "press release" OR press OR media OR updates)
```

This finds pages on the company's domain that are likely to be news/press sections.

### Stage 2: Heuristic URL Filtering (NO LLM)

URLs are filtered and classified without using the LLM:

**Listing Page Indicators:**
- Path ends with: `/news`, `/press`, `/media`, `/newsroom`, `/press-releases`
- Short path segments, no year patterns

**Article Indicators:**
- Year in path: `/2024/`, `/2025/`
- Long slugs with 4+ hyphens
- Path contains: `/pressrelease/`, `/article/`, `/whitepapers/`
- Title contains: "announces", "reports", "Q1", "fiscal"

**Root URL Extraction:**
From articles like `/news/2024/company-announces-deal`, extract `/news` as a candidate.

### Stage 3: Candidate Verification

Each candidate is verified with a detailed LLM prompt containing **12 examples** of accept/reject decisions:

**5 Critical Checks (ALL must pass):**
1. Shows a LIST of MULTIPLE press releases (not single article)
2. Is the MAIN/FIRST page (not page 2, 3, etc.)
3. Contains formal PRESS RELEASES (not blogs, whitepapers, SEC filings)
4. URL path is simple (no article slugs)
5. Shows LIST VIEW (multiple headlines, not full article body)

HTTP status is validated (must be 2xx).

### Stage 4: Homepage Exploration

If search fails, the homepage is explored:

1. Navigate to company homepage
2. Extract links from navigation, header, footer
3. Try expanding dropdown menus (Company, About, Investors, etc.)
4. Verify each discovered link

## S3 Data Captured

### Session Report

```typescript
{
  session: {
    sessionId: string;
    startTime: string;
    endTime: string;
    status: 'completed' | 'failed';
  };
  history: HistoryEntry[];        // Stagehand action history
  metrics: {
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalInferenceTimeMs: number;
  };
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
```

### Bidirectional Cache Sync

**On Session Start:**
1. Download all files from `s3://bucket/stagehand-cache/` to local `cacheDir`
2. Stagehand uses these cached responses for subsequent `act()` calls

**On Session End:**
1. Upload new cache files to global cache (organized by domain)
2. Create session snapshot for audit trail

## Customization

### Change Test Companies

Edit `TEST_COMPANIES` in `tests/test-news-discovery.ts`:

```typescript
const TEST_COMPANIES: CompanyInput[] = [
  { name: 'Your Company', website: 'yourcompany.com' },
];
```

### Adjust Discovery Configuration

```typescript
const DISCOVERY_CONFIG: DiscoveryConfig = {
  maxSearchResults: 10,           // Max search results to extract
  maxCandidatesToCheck: 5,        // Max candidates to verify
  timeoutMs: 30000,               // Navigation timeout
  delayBetweenActionsMs: 2000,    // Delay between actions
};
```

### Adjust S3 Persistence

```typescript
const { persistence, logger } = createS3PersistenceWithLogger({
  bucket: 'my-bucket',
  prefix: 'my-prefix',
  enabled: true,
  logBatchSize: 50,               // Logs before batch upload
  captureHistory: true,
  captureMetrics: true,
  captureLogs: true,
  syncCacheDir: true,             // Enable bidirectional cache sync
  captureStdout: true,            // Capture terminal output
});
```

## Troubleshooting

### "The specified bucket does not exist"
Create the S3 bucket or update `S3_PERSISTENCE_BUCKET`.

### AWS credential errors
Configure credentials via `~/.aws/credentials` or environment variables.

### Ollama connection errors
- Verify Ollama is running: `curl http://localhost:11434/api/tags`
- Update `OLLAMA_BASE_URL` in the test file

### No search results found
- Check if the domain is valid
- Some sites may block DuckDuckGo indexing
- Falls back to homepage exploration automatically

### Peer dependency warnings
Use `--legacy-peer-deps` flag with npm install.

## Dependencies

### Core
- `@browserbasehq/stagehand` (^3.0.1) - Browser automation
- `ollama-ai-provider-v2` (^1.5.5) - Ollama provider
- `zod` (^3.25.67) - Schema validation

### AWS
- `@aws-sdk/client-s3` (^3.940.0) - S3 client
- `@aws-sdk/lib-storage` (^3.940.0) - Upload utilities

### Other
- `dotenv` (^16.6.1) - Environment variables
- `date-fns` (^4.1.0) - Date utilities

## License

ISC
