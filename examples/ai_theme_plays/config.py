from datetime import datetime
from dotenv import load_dotenv, find_dotenv
from langchain_anthropic import ChatAnthropic

# Load environment variables first
load_dotenv(find_dotenv(), override=False)

S3_BUCKET_NAME = "ai-theme-plays"
RUN_NAME = f"run_{datetime.now().strftime('%Y_%m_%d_%H%M%S')}"
TRANSCRIPT_S3_KEY = "transcripts/transcript.txt"

# Batch sizes for context management
COMPANY_BATCH_SIZE = 50
PRESS_RELEASE_BATCH_SIZE = 100
TOP_COMPANY_MATCHES = 100

# Context window settings (Claude Sonnet 4.5 has 200K context)
CONTEXT_WINDOW_TOTAL = 200_000
MAX_OUTPUT_TOKENS = 16_000  # Reduced from 64K to leave more room for input
CONTEXT_TRIM_LIMIT = CONTEXT_WINDOW_TOTAL - MAX_OUTPUT_TOKENS - 5_000  # Safety buffer

# Shared model configuration with retry logic
# max_retries will automatically retry on:
# - 408 (Request Timeout), 429 (Rate Limit), 500 (Server Error)
# - 502 (Bad Gateway), 503 (Service Unavailable), 504 (Gateway Timeout)
# If you see a 500 error, it means all 10 retries failed (Anthropic outage)
MODEL = ChatAnthropic(
    model="claude-sonnet-4-20250514",
    max_retries=10,
    timeout=600,
    max_tokens=MAX_OUTPUT_TOKENS
)

