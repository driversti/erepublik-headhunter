#!/usr/bin/env bash
# Main database backup script.
# Runs every 6 hours via cron. Dumps PostgreSQL, compresses, syncs to NAS.
#
# Usage: ./backup-db.sh
#
# Cron entry:
#   0 */6 * * * /home/yurii/docker/headhunter/scripts/backup-db.sh >> /home/yurii/backups/headhunter/logs/cron.log 2>&1

set -euo pipefail
# Dumps contain the live eRepublik session cookie (bot_session); keep every
# file and directory these scripts create private to the owner. rsync -a
# carries the 600 mode over to the NAS copy too.
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Load config and libraries ──────────────────────────────────────────
# shellcheck source=backup.conf
source "${SCRIPT_DIR}/backup.conf"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/telegram.sh
source "${SCRIPT_DIR}/lib/telegram.sh"

# ── Setup ───────────────────────────────────────────────────────────────
TIMESTAMP=$(date '+%Y%m%d_%H%M%S')
BACKUP_FILENAME="headhunter_${TIMESTAMP}.sql.gz"
TEMP_FILE="${BACKUP_TEMP_DIR}/${BACKUP_FILENAME}.tmp"
FINAL_FILE="${BACKUP_DIR}/${BACKUP_FILENAME}"
CHECKSUM_FILE="${FINAL_FILE}.sha256"

# Used by log_info/log_error/log_warn from common.sh
LOG_FILE="${BACKUP_LOG_DIR}/backup_$(date '+%Y%m%d').log"

ensure_dir "$BACKUP_DIR"
ensure_dir "$BACKUP_TEMP_DIR"
ensure_dir "$BACKUP_LOG_DIR"

trap trap_exit EXIT
register_temp_file "$TEMP_FILE"

log_info "=== Backup started ==="

# ── Pre-flight checks ──────────────────────────────────────────────────

# Check container before acquiring lock (no point locking if container is down)
if ! check_container_running "$DB_CONTAINER"; then
    send_telegram "⚠️ Backup FAILED: container '${DB_CONTAINER}' is not running"
    exit 1
fi

# Check available disk space (need at least 1 GB free)
available_kb=$(df --output=avail / 2>/dev/null | tail -1 | tr -d ' ')
if [[ -n "$available_kb" ]] && (( available_kb < 1048576 )); then
    available_mb=$((available_kb / 1024))
    log_error "Insufficient disk space: ${available_mb}MB free (need 1GB)"
    send_telegram "🚨 Backup FAILED: only ${available_mb}MB free disk space (need 1GB)"
    exit 1
fi

# ── Acquire lock ────────────────────────────────────────────────────────
if ! acquire_lock "$LOCK_FILE" 10; then
    log_error "Another backup is already running — exiting"
    exit 1
fi

START_TIME=$(date +%s)

# ── Step 1: pg_dump + gzip ─────────────────────────────────────────────
log_info "Dumping database '${DB_NAME}' from container '${DB_CONTAINER}'..."

if ! docker exec "$DB_CONTAINER" \
    pg_dump -U "$DB_USER" -d "$DB_NAME" --no-owner --no-acl \
    | gzip -9 > "$TEMP_FILE"; then
    log_error "pg_dump or gzip failed"
    send_telegram "⚠️ Backup FAILED: pg_dump error — check logs"
    exit 1
fi

# ── Step 2: Validate dump ──────────────────────────────────────────────
# Check file exists and is non-empty
if [[ ! -s "$TEMP_FILE" ]]; then
    log_error "Dump file is empty or missing: $TEMP_FILE"
    send_telegram "⚠️ Backup FAILED: dump produced empty file"
    exit 1
fi

# Verify gzip integrity
if ! gunzip -t "$TEMP_FILE" 2>/dev/null; then
    log_error "Gzip integrity check failed for: $TEMP_FILE"
    send_telegram "⚠️ Backup FAILED: gzip integrity check failed"
    exit 1
fi

DUMP_SIZE=$(human_size "$TEMP_FILE")
log_info "Dump complete: ${DUMP_SIZE}"

# ── Step 3: Atomic rename + checksum ───────────────────────────────────
mv "$TEMP_FILE" "$FINAL_FILE"
sha256sum "$FINAL_FILE" > "$CHECKSUM_FILE"
log_info "Backup saved: ${FINAL_FILE}"

# ── Step 4: Sync to NAS ────────────────────────────────────────────────
nas_ok=false
for attempt in $(seq 1 "$RSYNC_RETRIES"); do
    log_info "rsync to NAS (attempt ${attempt}/${RSYNC_RETRIES})..."
    if rsync -az -e "ssh ${NAS_SSH_OPTS}" \
        "$FINAL_FILE" "$CHECKSUM_FILE" \
        "${NAS_DEST}/"; then
        nas_ok=true
        log_info "rsync to NAS successful"
        break
    fi
    log_warn "rsync attempt ${attempt} failed"
    if (( attempt < RSYNC_RETRIES )); then
        log_info "Retrying in ${RSYNC_RETRY_DELAY}s..."
        sleep "$RSYNC_RETRY_DELAY"
    fi
done

if [[ "$nas_ok" == "false" ]]; then
    log_error "All rsync attempts to NAS failed — local backup retained"
    send_telegram "⚠️ NAS sync FAILED after ${RSYNC_RETRIES} attempts. Local backup saved: ${FINAL_FILE}"
fi

# ── Step 5: Retention cleanup ──────────────────────────────────────────
cleanup_retention() {
    local dir="$1"
    local is_remote="${2:-false}"

    log_info "Running retention cleanup on: ${dir}"

    local ls_cmd
    if [[ "$is_remote" == "true" ]]; then
        ls_cmd="ssh ${NAS_SSH_OPTS} ${NAS_USER}@${NAS_HOST} ls -1 ${dir}/"
    else
        ls_cmd="ls -1 ${dir}/"
    fi

    local rm_cmd_prefix=""
    if [[ "$is_remote" == "true" ]]; then
        rm_cmd_prefix="ssh ${NAS_SSH_OPTS} ${NAS_USER}@${NAS_HOST} rm -f"
    fi

    local now_epoch
    now_epoch=$(date +%s)

    # List all backup files sorted by name (which includes timestamp)
    local files
    files=$(eval "$ls_cmd" 2>/dev/null | grep -E '^headhunter_[0-9]{8}_[0-9]{6}\.sql\.gz$' | sort) || true

    if [[ -z "$files" ]]; then
        log_info "No backup files found for cleanup"
        return
    fi

    local deleted=0
    while IFS= read -r filename; do
        # Extract date components from filename: headhunter_YYYYMMDD_HHMMSS.sql.gz
        local date_part="${filename#headhunter_}"
        date_part="${date_part%.sql.gz}"
        local file_date="${date_part%%_*}"
        local file_time="${date_part#*_}"
        local file_hour="${file_time:0:2}"
        local file_dow

        # Parse file date
        local file_epoch
        file_epoch=$(date -d "${file_date:0:4}-${file_date:4:2}-${file_date:6:2} ${file_hour}:${file_time:2:2}:${file_time:4:2}" +%s 2>/dev/null) || continue
        file_dow=$(date -d "${file_date:0:4}-${file_date:4:2}-${file_date:6:2}" +%u 2>/dev/null) || continue

        local age_days=$(( (now_epoch - file_epoch) / 86400 ))

        local keep=false

        # Weekly retention: keep Sunday backups (dow=7) for RETENTION_WEEKLY_DAYS
        if (( file_dow == 7 && file_hour == 0 && age_days <= RETENTION_WEEKLY_DAYS )); then
            keep=true
        # Daily retention: keep midnight backups for RETENTION_DAILY_DAYS
        elif (( file_hour == 0 && age_days <= RETENTION_DAILY_DAYS )); then
            keep=true
        # 6-hourly retention: keep all within RETENTION_6H_DAYS
        elif (( age_days <= RETENTION_6H_DAYS )); then
            keep=true
        fi

        if [[ "$keep" == "false" ]]; then
            local file_path="${dir}/${filename}"
            local checksum_path="${file_path}.sha256"
            if [[ "$is_remote" == "true" ]]; then
                eval "$rm_cmd_prefix ${file_path} ${checksum_path}" 2>/dev/null || true
            else
                rm -f "$file_path" "$checksum_path" 2>/dev/null || true
            fi
            log_info "Retention: deleted ${filename} (age: ${age_days}d)"
            (( deleted++ )) || true
        fi
    done <<< "$files"

    log_info "Retention cleanup: ${deleted} file(s) removed"
}

# Clean up local backups
cleanup_retention "$BACKUP_DIR" "false"

# Clean up NAS backups (only if NAS sync was successful)
if [[ "$nas_ok" == "true" ]]; then
    cleanup_retention "$NAS_PATH" "true" || log_warn "NAS retention cleanup failed (non-fatal)"
fi

# ── Step 6: Log rotation ──────────────────────────────────────────────
if [[ -d "$BACKUP_LOG_DIR" ]]; then
    # Compress old logs
    find "$BACKUP_LOG_DIR" -name "*.log" -mtime +"$LOG_COMPRESS_AFTER_DAYS" ! -name "*.gz" -exec gzip {} \; 2>/dev/null || true
    # Delete very old logs
    find "$BACKUP_LOG_DIR" -name "*.log.gz" -mtime +"$LOG_DELETE_AFTER_DAYS" -delete 2>/dev/null || true
fi

# ── Done ────────────────────────────────────────────────────────────────
END_TIME=$(date +%s)
DURATION=$(format_duration $((END_TIME - START_TIME)))

log_info "=== Backup completed in ${DURATION} ==="

summary="💾 Backup OK
• File: ${BACKUP_FILENAME}
• Size: ${DUMP_SIZE}
• Duration: ${DURATION}"
if [[ "$nas_ok" == "true" ]]; then
    summary+=$'\n'"• NAS: synced ✓"
else
    summary+=$'\n'"• NAS: FAILED ✗ (local copy retained)"
fi
send_telegram "$summary"
