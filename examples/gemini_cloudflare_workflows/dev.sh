#!/bin/bash
set -e

# Create logs directory if it doesn't exist
mkdir -p logs

# Run dev server with debug logging and tee to timestamped log file
LOG_FILE="logs/dev_$(date +%Y%m%d_%H%M%S).log"
echo "Starting dev server, logging to: $LOG_FILE"

uv run pywrangler dev --log-level debug 2>&1 | tee "$LOG_FILE"
