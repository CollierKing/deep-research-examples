from dotenv import load_dotenv, find_dotenv
from deepagents import create_deep_agent
from config import S3_BUCKET_NAME, RUN_NAME, MODEL, CONTEXT_WINDOW_TOTAL, MAX_OUTPUT_TOKENS
from middleware import LoggingMiddleware, S3DataMiddleware, ContentTruncationMiddleware
from subagents import subagents
from langgraph.checkpoint.sqlite import SqliteSaver

# MARK: - Configuration
load_dotenv(find_dotenv(), override=False)

s3_middleware = S3DataMiddleware(bucket_name=S3_BUCKET_NAME, run_name=RUN_NAME)

# Persistent checkpointer - saves to SQLite database
import sqlite3
db_conn = sqlite3.connect("checkpoints.db", check_same_thread=False)
checkpointer = SqliteSaver(db_conn)

# MARK: - Agent
agent = create_deep_agent(
    model=MODEL,
    tools=[],
    checkpointer=checkpointer,
    system_prompt="""You are a sequential analysis orchestrator.  
  
Execute this 4-step pipeline:  
  
1. Call transcript-analyzer subagent  
   - Reads: transcripts/transcript.txt from S3
   - Writes: themes_analysis.json (scoped to run)
     
2. Call company-matcher subagent  
   - Reads: themes_analysis.json from S3
   - Queries: PostgreSQL for company data (uses get_companies_from_postgres tool)
   - Writes: matched_companies.json (scoped to run)
     
3. Call press-release-validator subagent  
   - Reads: matched_companies.json from S3
   - Queries: MongoDB for press releases (uses get_press_releases_from_mongodb tool)
   - Writes: validated_results.json (scoped to run)

4. Call final-ranker subagent
   - Reads: matched_companies.json AND validated_results.json from S3
   - Merges both datasets:
     * For each company in matched_companies.json, find its validation (if exists)
     * Use adjusted_score from validation if available, else use original score
     * Combine all data (themes, alignment_factors, evidence, validation status)
   - Re-rank top 100 companies by final score
   - Writes: final_rankings.json (scoped to run)
  
Execute SEQUENTIALLY. Wait for each step to complete before proceeding.  
Use write_todos to track your progress.""",
    subagents=subagents,
    middleware=[
        ContentTruncationMiddleware(max_tokens=CONTEXT_WINDOW_TOTAL - MAX_OUTPUT_TOKENS - 5_000),
        s3_middleware,
        LoggingMiddleware()
    ],
)
