#!/bin/bash
set -e

# Deploy script for deep-research-workflow

# Load .env file if it exists
if [ -f .env ]; then
    source .env
fi

# Deploy the worker
npx wrangler deploy

# Set secrets from .env values (piped to avoid interactive prompt)
if [ -n "$AUTH_TOKEN" ]; then
    printf "%s" "$AUTH_TOKEN" | npx wrangler secret put AUTH_TOKEN
fi

if [ -n "$GOOGLE_API_KEY" ]; then
    printf "%s" "$GOOGLE_API_KEY" | npx wrangler secret put GOOGLE_API_KEY
fi

if [ -n "$CF_AI_API_TOKEN" ]; then
    printf "%s" "$CF_AI_API_TOKEN" | npx wrangler secret put CF_AI_API_TOKEN
fi

echo "Deployment complete!"
