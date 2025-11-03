# MARK: - Imports
from langchain.agents import create_agent
from config import (
    S3_BUCKET_NAME,
    RUN_NAME,
    TRANSCRIPT_S3_KEY,
    MODEL,
    COMPANY_BATCH_SIZE,
    PRESS_RELEASE_BATCH_SIZE,
    TOP_COMPANY_MATCHES,
    CONTEXT_WINDOW_TOTAL,
    MAX_OUTPUT_TOKENS,
)
from middleware import LoggingMiddleware, S3DataMiddleware, ContentTruncationMiddleware
from tools import get_companies_from_postgres, get_press_releases_from_mongodb
from models import ThemesOutput, CompanyMatchesOutput, ValidationOutput, FinalOutput
import json

# MARK: - Configuration
model = MODEL
s3_middleware = S3DataMiddleware(bucket_name=S3_BUCKET_NAME, run_name=RUN_NAME)
content_truncation = ContentTruncationMiddleware(
    max_tokens=CONTEXT_WINDOW_TOTAL - MAX_OUTPUT_TOKENS - 5_000
)

# Extract S3 tools from middleware
read_from_s3 = s3_middleware.tools[0]
write_to_s3 = s3_middleware.tools[1]

# MARK: - Subagent 1: Transcript Analyzer
analyzer_system_prompt = f"""You are an expert at analyzing transcripts.  
  
1. Use read_from_s3 to read '{TRANSCRIPT_S3_KEY}'
2. Analyze it to identify key themes, trends, and focus areas  
3. Write your analysis to 'themes_analysis.json' using write_to_s3

OUTPUT SCHEMA (ThemesOutput from models.py):
{json.dumps(ThemesOutput.model_json_schema(), indent=2)}"""

analyzer_graph = create_agent(
    model=model,
    tools=[read_from_s3, write_to_s3],
    system_prompt=analyzer_system_prompt,
    middleware=[content_truncation, s3_middleware, LoggingMiddleware()],
)

# MARK: - Subagent 2: Company Matcher
matcher_system_prompt = f"""You are an expert at matching companies to market trends.  

⚠️ ABSOLUTE RULES - NO EXCEPTIONS:
1. Process EVERY SINGLE COMPANY in the database - no sampling, no shortcuts
2. START at offset=0 and process EVERY batch sequentially until has_more=false
3. NEVER skip offsets or jump to arbitrary values
4. NEVER decide "I have enough matches" and stop early
5. The database order is RANDOM - you cannot predict where companies are
6. Write a batch file after EVERY query - this keeps your context manageable

DO NOT rationalize skipping batches because:
- "There are too many companies" → Process them all anyway
- "I have a good sample" → Keep going until has_more=false
- "I'll focus on relevant ones" → Evaluate ALL, then pick top {TOP_COMPANY_MATCHES}

WORKFLOW:

1. Read themes: read_from_s3('themes_analysis.json')

2. Initialize tracking:
   - current_offset = 0
   - batches_processed = 0

3. SEQUENTIAL BATCH PROCESSING LOOP (Process ALL companies):
   
   DO THIS EXACTLY - NO VARIATIONS:
   
   a) Query: get_companies_from_postgres(offset=current_offset, limit={COMPANY_BATCH_SIZE})
   
   b) Evaluate each company in results against themes
   
   c) Write results: write_to_s3('company_matches/batch_{{current_offset:04d}}.json', <matches_json>)
      ↳ Use 4-digit zero-padded offset (e.g., batch_0000.json, batch_0050.json)
      ↳ Write this file even if matches list is empty []
   
   d) Update state:
      - current_offset += {COMPANY_BATCH_SIZE}
      - batches_processed += 1
   
   e) Check has_more field in the response:
      - If has_more == false: ALL companies processed → STOP and go to step 4
      - If has_more == true: More companies remain → GO BACK TO step a) with NEW current_offset
   
   KEEP LOOPING until has_more=false (this is your ONLY stop condition)
   
   ❌ FORBIDDEN:
   - Using offset values that are NOT (batches_processed × {COMPANY_BATCH_SIZE})
   - Skipping any offset values in the sequence
   - Changing the limit parameter
   - Trying to "search" for specific companies
   - Stopping early because you think you have "enough" matches
   - Deciding to "sample" instead of processing all companies

4. Consolidation (only after ALL batches complete):
   - Review all batch_*.json files (batch_0000.json, batch_0050.json, etc.)
   - Select top {TOP_COMPANY_MATCHES} matches
   - Write to 'matched_companies.json'

OUTPUT SCHEMA (CompanyMatchesOutput from models.py):
{json.dumps(CompanyMatchesOutput.model_json_schema(), indent=2)}"""

matcher_graph = create_agent(
    model=model,
    tools=[read_from_s3, write_to_s3, get_companies_from_postgres],
    system_prompt=matcher_system_prompt,
    middleware=[
        # Sequential enforcement is built into get_companies_from_postgres tool itself
        content_truncation,
        s3_middleware,
        LoggingMiddleware(),
    ],
)

# MARK: - Subagent 3: Press Release Validator
validator_system_prompt = f"""You are an expert at validating company-theme alignment through press releases.  

YOUR GOAL: Find press releases that SUPPORT and VALIDATE each company's alignment with the identified themes.

IGNORE: Legal issues, accounting matters, lawsuits, or any non-theme-related content.
FOCUS ON: Product announcements, technology developments, partnerships, and initiatives that relate to the themes.

⚠️ ABSOLUTE RULES - NO EXCEPTIONS:
1. Process EVERY SINGLE COMPANY in matched_companies.json - no skipping
2. Process ONE company at a time (symbols parameter must have exactly ONE ticker)
3. NEVER query the same company twice
4. ALWAYS use skip=0 (no pagination - get all press releases in one call)
5. Write validation file for EACH company before moving to next

DO NOT rationalize skipping companies because:
- "I have enough validations" → Process ALL companies in the list
- "This company probably doesn't match" → Validate it anyway
- "I'll just do a sample" → Process the entire matched_companies list

WORKFLOW:

1. Read companies: read_from_s3('matched_companies.json')

2. SEQUENTIAL COMPANY PROCESSING (Process ALL companies):
   
   DO THIS EXACTLY - NO VARIATIONS:
   
   For EACH and EVERY company in the matched_companies list (loop through entire list):
   
   a) Extract: ticker and matched_themes for this company
   
   b) Query: get_press_releases_from_mongodb(symbols="TICKER", skip=0, limit={PRESS_RELEASE_BATCH_SIZE})
      ↳ Use ONLY one ticker at a time
      ↳ Always use skip=0
   
   c) Evaluate: Review each press release for theme support:
      - Does pr_title or content relate to the identified themes?
      - Does it show company activity in this theme area?
      - Is it a positive indicator of alignment?
      - For supporting evidence, capture: evidence text, pr_title, pr_link
   
   d) Write: write_to_s3('validations/company_{{TICKER}}.json', <validation_list_json>)
      ↳ key_evidence should be array of objects: [{{"evidence": "...", "pr_title": "...", "pr_link": "..."}}]
      ↳ Use exact ticker symbol (e.g., company_NVDA.json, company_MSFT.json)
      ↳ Write this file even if validation list is empty []
      ↳ Must write BEFORE processing next company
   
   e) Move to next company in list
   
   ❌ FORBIDDEN:
   - Querying multiple companies at once (comma-separated symbols)
   - Using skip > 0 for pagination
   - Querying the same company twice
   - Skipping companies in the list
   - Stopping early because you think you have "enough" validations
   - Deciding to validate only a "sample" of companies

3. Consolidation (only after ALL companies complete):
   - Review all validations/company_*.json files (company_NVDA.json, company_MSFT.json, etc.)
   - Combine all validations
   - Write to 'validated_results.json'
   - ONLY include press releases where supports_theme=true

OUTPUT SCHEMA (ValidationOutput from models.py):
{json.dumps(ValidationOutput.model_json_schema(), indent=2)}"""

validator_graph = create_agent(
    model=model,
    tools=[read_from_s3, write_to_s3, get_press_releases_from_mongodb],
    system_prompt=validator_system_prompt,
    middleware=[
        # Sequential enforcement is built into get_press_releases_from_mongodb tool itself
        content_truncation,
        s3_middleware,
        LoggingMiddleware(),
    ],
)

# MARK: - Subagent 4: Final Ranker
ranker_system_prompt = f"""You are an expert at consolidating and ranking analysis results.

YOUR GOAL: Merge company matches with their validation results and create final rankings.

WORKFLOW:

1. Read both files from S3:
   - matched_companies.json (contains matches with original scores)
   - validated_results.json (contains validations with adjusted scores)

2. Merge the data:
   a) Start with all companies from matched_companies.json
   b) For EACH company, look up its validation in validated_results.json (if exists)
   c) Create merged record:
      - If validation exists AND has adjusted_score: use adjusted_score as final_score
      - If validation exists but NO adjusted_score: use original_score
      - If no validation exists: use original_score
      - Combine: matched_themes, alignment_factors from match
      - Add (if available): validation_status, press_release_validation, evidence_summary, key_evidence, confidence_adjustment, notes from validation

3. Re-rank companies:
   - Sort ALL companies by final_score (descending)
   - Take top {TOP_COMPANY_MATCHES} companies
   - Assign rank: 1 to {TOP_COMPANY_MATCHES}

4. Create summary statistics:
   - Calculate theme_distribution (count of companies per theme)
   - Calculate average_score across top {TOP_COMPANY_MATCHES}
   - Calculate score_ranges distribution
   - Calculate industry_representation (if industry data available)

5. Write final output:
   - Write to 'final_rankings.json' using write_to_s3
   - Include metadata, top_100_companies, and summary_statistics

OUTPUT SCHEMA (FinalOutput from models.py):
{{json.dumps(FinalOutput.model_json_schema(), indent=2)}}"""

ranker_graph = create_agent(
    model=model,
    tools=[read_from_s3, write_to_s3],
    system_prompt=ranker_system_prompt,
    middleware=[
        content_truncation,
        s3_middleware,
        LoggingMiddleware(),
    ],
)

# MARK: - Subagent Definitions
subagents = [
    {
        "name": "transcript-analyzer",
        "description": "Analyzes transcripts to identify key themes, trends and focus areas",
        "runnable": analyzer_graph,
    },
    {
        "name": "company-matcher",
        "description": "Matches companies to identified themes and trends",
        "runnable": matcher_graph,
    },
    {
        "name": "press-release-validator",
        "description": "Validates company matches using press releases",
        "runnable": validator_graph,
    },
    {
        "name": "final-ranker",
        "description": "Merges matches and validations, re-ranks companies by final score",
        "runnable": ranker_graph,
    },
]
