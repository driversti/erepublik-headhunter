#!/usr/bin/env bash
# Hourly disk monitoring script.
# Checks disk usage, backup freshness, and sends alerts via Telegram.
#
# Usage: ./disk-monitor.sh
#
# Cron entry:
#   0 * * * * /home/yurii/docker/headhunter/scripts/disk-monitor.sh >> /home/yurii/backups/headhunter/logs/cron.log 2>&1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Load config and libraries ──────────────────────────────────────────
# shellcheck source=backup.conf
source "${SCRIPT_DIR}/backup.conf"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/telegram.sh
source "${SCRIPT_DIR}/lib/telegram.sh"

# ── Setup ───────────────────────────────────────────────────────────────
# Used by log_info/log_error/log_warn from common.sh
LOG_FILE="${BACKUP_LOG_DIR}/monitor_$(date '+%Y%m%d').log"
ensure_dir "$BACKUP_LOG_DIR"

# ── Disk usage check ──────────────────────────────────────────────────
disk_usage=$(df / --output=pcent 2>/dev/null | tail -1 | tr -d ' %')
log_info "Disk usage: ${disk_usage}%"

now_epoch=$(date +%s)

if (( disk_usage >= DISK_THRESHOLD_PERCENT )); then
    should_alert=true

    # Check if we already alerted recently (suppress re-alerts)
    if [[ -f "$DISK_ALERT_MARKER" ]]; then
        last_alert=$(cat "$DISK_ALERT_MARKER" 2>/dev/null) || last_alert=0
        elapsed=$(( now_epoch - last_alert ))
        suppress_seconds=$(( DISK_ALERT_SUPPRESS_HOURS * 3600 ))
        if (( elapsed < suppress_seconds )); then
            should_alert=false
            log_info "Disk alert suppressed (last alert ${elapsed}s ago, threshold ${suppress_seconds}s)"
        fi
    fi

    if [[ "$should_alert" == "true" ]]; then
        echo "$now_epoch" > "$DISK_ALERT_MARKER"
        send_telegram "🚨 Disk usage: ${disk_usage}% (threshold: ${DISK_THRESHOLD_PERCENT}%)"
    fi
else
    # Clear marker if usage is back to normal
    if [[ -f "$DISK_ALERT_MARKER" ]]; then
        rm -f "$DISK_ALERT_MARKER"
        log_info "Disk usage back to normal — alert cleared"
    fi
fi

# ── Storage report ──────────────────────────────────────────────────────

# Postgres data size
pg_data_size="N/A"
pg_data_dir="${PROJECT_DIR}/postgres_data"
if [[ -d "$pg_data_dir" ]]; then
    pg_data_size=$(du -sh "$pg_data_dir" 2>/dev/null | cut -f1) || pg_data_size="N/A"
fi

# Local backup directory size
backup_dir_size="N/A"
if [[ -d "$BACKUP_DIR" ]]; then
    backup_dir_size=$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1) || backup_dir_size="N/A"
fi

log_info "Postgres data: ${pg_data_size}, Backup dir: ${backup_dir_size}"

# ── Backup freshness check ──────────────────────────────────────────────
latest_backup=$(ls -1t "${BACKUP_DIR}"/headhunter_*.sql.gz 2>/dev/null | head -1) || true

if [[ -n "$latest_backup" ]]; then
    backup_mtime=$(stat -c %Y "$latest_backup" 2>/dev/null) || backup_mtime=0
    backup_age_hours=$(( (now_epoch - backup_mtime) / 3600 ))
    backup_age_human="${backup_age_hours}h ago"
    latest_backup_name=$(basename "$latest_backup")
    log_info "Latest backup: ${latest_backup_name} (${backup_age_human})"

    if (( backup_age_hours >= BACKUP_STALE_HOURS )); then
        send_telegram "⚠️ Backup stale: last backup is ${backup_age_hours}h old (threshold: ${BACKUP_STALE_HOURS}h)
• File: ${latest_backup_name}
• Backup cron may be broken — check with: crontab -l"
    fi
else
    log_warn "No backup files found in ${BACKUP_DIR}"
    send_telegram "⚠️ No backup files found in ${BACKUP_DIR} — backup system may not be configured"
fi

log_info "=== Monitor check complete ==="
