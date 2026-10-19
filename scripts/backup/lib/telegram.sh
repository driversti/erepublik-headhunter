#!/usr/bin/env bash
# Telegram notification helper.
# Sends messages via Bot API. Silently skips if credentials are missing.

send_telegram() {
    local message="$1"
    local prefix="[headhunter-backup]"

    # Skip silently if credentials are not configured
    if [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_CHAT_ID:-}" ]]; then
        log_warn "Telegram credentials not configured — skipping notification"
        return 0
    fi

    local full_message="${prefix} ${message}"
    local api_url="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage"

    local response
    response=$(curl -s -w "\n%{http_code}" \
        --max-time 10 \
        -X POST "$api_url" \
        -d chat_id="$TELEGRAM_CHAT_ID" \
        -d text="$full_message" \
        -d parse_mode="HTML" \
        -d disable_web_page_preview="true" 2>&1) || true

    local http_code
    http_code=$(echo "$response" | tail -1)
    local body
    body=$(echo "$response" | head -n -1)

    if [[ "$http_code" != "200" ]]; then
        log_warn "Telegram notification failed (HTTP ${http_code}): ${body}"
    fi
}
