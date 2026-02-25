#!/bin/bash
set -euo pipefail

# Cloudflare Quick Tunnel for engie Claude Code Proxy
# Exposes localhost:18791 to the internet, captures the URL,
# and updates the Vercel env var so wyliewhimsy.co can reach engie.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${HOME}/.openclaw/logs"
TUNNEL_LOG="${LOG_DIR}/cloudflared.log"
URL_FILE="${LOG_DIR}/tunnel-url.txt"

PROXY_PORT="${ENGIE_PROXY_PORT:-18791}"
VERCEL_PROJECT="wyliewhimsyco"

mkdir -p "$LOG_DIR"

echo "[tunnel] Starting cloudflared quick tunnel → localhost:${PROXY_PORT}"

# Wait for the proxy to be up before tunneling
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${PROXY_PORT}/health" > /dev/null 2>&1; then
    echo "[tunnel] Proxy is healthy"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "[tunnel] ERROR: Proxy not responding on port ${PROXY_PORT} after 30s"
    exit 1
  fi
  sleep 1
done

# Start cloudflared in background, capture output
cloudflared tunnel --url "http://127.0.0.1:${PROXY_PORT}" > "$TUNNEL_LOG" 2>&1 &
CF_PID=$!
echo "[tunnel] cloudflared PID: ${CF_PID}"

# Wait for the URL to appear in logs (up to 30s)
TUNNEL_URL=""
for i in $(seq 1 30); do
  TUNNEL_URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1 || true)
  if [ -n "$TUNNEL_URL" ]; then
    break
  fi
  sleep 1
done

if [ -z "$TUNNEL_URL" ]; then
  echo "[tunnel] ERROR: Could not capture tunnel URL after 30s"
  echo "[tunnel] Log contents:"
  cat "$TUNNEL_LOG"
  kill "$CF_PID" 2>/dev/null || true
  exit 1
fi

echo "[tunnel] Tunnel URL: ${TUNNEL_URL}"
echo "$TUNNEL_URL" > "$URL_FILE"

# Update Vercel env var with new tunnel URL
# Remove old value first, then add new one
echo "[tunnel] Updating Vercel env var ENGIE_PROXY_URL..."
vercel env rm ENGIE_PROXY_URL production --yes 2>/dev/null || true
vercel env rm ENGIE_PROXY_URL preview --yes 2>/dev/null || true

printf '%s' "$TUNNEL_URL" | vercel env add ENGIE_PROXY_URL production 2>/dev/null && \
  echo "[tunnel] Set ENGIE_PROXY_URL for production" || \
  echo "[tunnel] WARN: Failed to set production env var"

printf '%s' "$TUNNEL_URL" | vercel env add ENGIE_PROXY_URL preview 2>/dev/null && \
  echo "[tunnel] Set ENGIE_PROXY_URL for preview" || \
  echo "[tunnel] WARN: Failed to set preview env var"

# Redeploy so the running deployment picks up the new URL
echo "[tunnel] Redeploying wyliewhimsy.co to pick up new tunnel URL..."
vercel --prod --yes 2>/dev/null && \
  echo "[tunnel] Redeploy complete" || \
  echo "[tunnel] WARN: Redeploy failed (site will use fallback Anthropic API)"

echo "[tunnel] Ready. Waiting on cloudflared process..."

# Keep running — launchd expects a long-lived process
wait "$CF_PID"
