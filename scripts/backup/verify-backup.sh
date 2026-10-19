#!/usr/bin/env bash
# Weekly backup verification script.
# Restores the latest backup to a temporary DB, runs sanity checks, drops it.
#
# Usage: ./verify-backup.sh
#
# Cron entry:
#   0 3 * * 0 /home/yurii/docker/headhunter/scripts/verify-backup.sh >> /home/yurii/backups/headhunter/logs/cron.log 2>&1

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
LOG_FILE="${BACKUP_LOG_DIR}/verify_$(date '+%Y%m%d').log"
VERIFY_DB=""

ensure_dir "$BACKUP_LOG_DIR"

# Cleanup trap: always drop temp DB
cleanup_verify_db() {
    local exit_code=$?
    if [[ -n "$VERIFY_DB" ]]; then
        log_info "Dropping temporary database: ${VERIFY_DB}"
        docker exec "$DB_CONTAINER" \
            psql -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS ${VERIFY_DB};" 2>/dev/null || true
    fi
    trap_exit
    return "$exit_code"
}
trap cleanup_verify_db EXIT

log_info "=== Backup verification started ==="

# ── Pre-flight ──────────────────────────────────────────────────────────
if ! check_container_running "$DB_CONTAINER"; then
    send_telegram "⚠️ Verify FAILED: container '${DB_CONTAINER}' is not running"
    exit 1
fi

# ── Find latest backup ─────────────────────────────────────────────────
find_latest_backup() {
    # Try local first
    local latest
    latest=$(ls -1t "${BACKUP_DIR}"/headhunter_*.sql.gz 2>/dev/null | head -1) || true

    if [[ -n "$latest" ]]; then
        echo "$latest"
        return
    fi

    # Fall back to NAS
    log_info "No local backup found, checking NAS..."
    local nas_latest
    nas_latest=$(ssh ${NAS_SSH_OPTS} "${NAS_USER}@${NAS_HOST}" \
        "ls -1t ${NAS_PATH}/headhunter_*.sql.gz 2>/dev/null | head -1") || true

    if [[ -n "$nas_latest" ]]; then
        # Download from NAS
        local local_copy
        local_copy="${BACKUP_TEMP_DIR}/$(basename "$nas_latest")"
        ensure_dir "$BACKUP_TEMP_DIR"
        log_info "Downloading from NAS: $(basename "$nas_latest")"
        if scp ${NAS_SSH_OPTS} "${NAS_USER}@${NAS_HOST}:${nas_latest}" "$local_copy"; then
            register_temp_file "$local_copy"
            echo "$local_copy"
            return
        fi
    fi

    return 1
}

BACKUP_FILE=$(find_latest_backup) || {
    log_error "No backup files found (local or NAS)"
    send_telegram "🚨 Verify FAILED: no backup files found"
    exit 1
}

log_info "Verifying backup: $(basename "$BACKUP_FILE")"

# ── Verify checksum ────────────────────────────────────────────────────
CHECKSUM_FILE="${BACKUP_FILE}.sha256"
checksum_ok="N/A"
if [[ -f "$CHECKSUM_FILE" ]]; then
    if sha256sum -c "$CHECKSUM_FILE" --quiet 2>/dev/null; then
        checksum_ok="PASS"
        log_info "Checksum verification: PASS"
    else
        checksum_ok="FAIL"
        log_error "Checksum verification: FAIL"
    fi
else
    log_warn "No checksum file found — skipping checksum verification"
fi

# ── Verify gzip integrity ──────────────────────────────────────────────
if ! gunzip -t "$BACKUP_FILE" 2>/dev/null; then
    log_error "Gzip integrity check failed"
    send_telegram "🚨 Verify FAILED: gzip integrity check failed for $(basename "$BACKUP_FILE")"
    exit 1
fi
log_info "Gzip integrity: PASS"

# ── Create temp database and restore ───────────────────────────────────
VERIFY_DB="headhunter_verify_$(date +%s)"
log_info "Creating temporary database: ${VERIFY_DB}"

docker exec "$DB_CONTAINER" \
    psql -U "$DB_USER" -d postgres -c "CREATE DATABASE ${VERIFY_DB};" || {
    log_error "Failed to create temporary database"
    send_telegram "🚨 Verify FAILED: could not create temp database"
    exit 1
}

log_info "Restoring backup into ${VERIFY_DB}..."
if ! gunzip -c "$BACKUP_FILE" | docker exec -i "$DB_CONTAINER" \
    psql -U "$DB_USER" -d "$VERIFY_DB" --quiet 2>/dev/null; then
    log_error "Restore failed"
    send_telegram "🚨 Verify FAILED: restore into temp DB failed"
    exit 1
fi
log_info "Restore complete"

# ── Sanity checks ──────────────────────────────────────────────────────
run_query() {
    local query="$1"
    docker exec "$DB_CONTAINER" \
        psql -U "$DB_USER" -d "$VERIFY_DB" -t -A -c "$query" 2>/dev/null
}

all_passed=true
declare -A results

# Table row counts.
# A missing table (ERROR) means the restore is broken, so it always fails.
# An empty table fails only where prod is expected to hold data; audit_log,
# alerted_rounds (pruned after 48h) and bot_session can legitimately be empty.
REQUIRED_NONEMPTY=" pgmigrations hunters victims "
for table in pgmigrations hunters victims audit_log alerted_rounds bot_session; do
    count=$(run_query "SELECT COUNT(*) FROM ${table};") || count="ERROR"
    results["${table}_count"]="$count"
    if [[ "$count" == "ERROR" ]]; then
        all_passed=false
        log_error "Table '${table}' is missing or unreadable"
    elif [[ "$count" == "0" && "$REQUIRED_NONEMPTY" == *" ${table} "* ]]; then
        all_passed=false
        log_error "Table '${table}' has 0 rows (expected > 0)"
    fi
    log_info "Table '${table}': ${count} rows"
done

# Victims whose hunter row is gone. The FK makes this impossible in a healthy
# DB, so a non-zero count means constraints were not restored.
orphaned=$(run_query "SELECT COUNT(*) FROM victims v LEFT JOIN hunters h ON v.hunter_telegram_id = h.telegram_id WHERE h.telegram_id IS NULL;") || orphaned="ERROR"
results["orphaned_victims"]="$orphaned"
if [[ "$orphaned" != "0" ]]; then
    all_passed=false
    log_error "Orphaned victims: ${orphaned}"
fi

active_hunters=$(run_query "SELECT COUNT(*) FROM hunters WHERE status = 'active';") || active_hunters="ERROR"
results["active_hunters"]="$active_hunters"
if [[ "$active_hunters" == "0" ]]; then
    log_warn "No active hunters in backup"
fi

# ── Build report ────────────────────────────────────────────────────────
backup_size=$(human_size "$BACKUP_FILE")
backup_name=$(basename "$BACKUP_FILE")

if [[ "$all_passed" == "true" ]]; then
    status_icon="✅"
    status_text="PASSED"
else
    status_icon="🚨"
    status_text="FAILED"
fi

report="${status_icon} Verify ${status_text}
• Backup: ${backup_name}
• Size: ${backup_size}
• Checksum: ${checksum_ok}
• Gzip: PASS

<b>Table counts:</b>
• migrations: ${results[pgmigrations_count]}
• hunters: ${results[hunters_count]} (active: ${results[active_hunters]})
• victims: ${results[victims_count]}
• audit_log: ${results[audit_log_count]}
• alerted_rounds: ${results[alerted_rounds_count]}
• bot_session: ${results[bot_session_count]}

<b>Integrity:</b>
• Orphaned victims: ${results[orphaned_victims]}"

log_info "=== Verification ${status_text} ==="
send_telegram "$report"

# ── On failure: test previous backups ──────────────────────────────────
if [[ "$all_passed" == "false" ]]; then
    log_info "Checking previous backups for last known good..."
    prev_backups=$(ls -1t "${BACKUP_DIR}"/headhunter_*.sql.gz 2>/dev/null | tail -n +2 | head -2) || true
    if [[ -n "$prev_backups" ]]; then
        while IFS= read -r prev_file; do
            if gunzip -t "$prev_file" 2>/dev/null; then
                log_info "Previous backup OK: $(basename "$prev_file")"
                send_telegram "ℹ️ Last known good backup: $(basename "$prev_file")"
                break
            fi
        done <<< "$prev_backups"
    fi
fi

if [[ "$all_passed" == "true" ]]; then exit 0; else exit 1; fi
