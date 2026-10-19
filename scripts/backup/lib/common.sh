#!/usr/bin/env bash
# Shared utilities for backup scripts.
# Provides: logging, locking (flock), cleanup traps, helpers.

set -euo pipefail

# ── Logging ─────────────────────────────────────────────────────────────

log_info() {
    local msg
    msg="[$(date '+%Y-%m-%d %H:%M:%S')] [INFO]  $*"
    echo "$msg"
    [[ -n "${LOG_FILE:-}" ]] && echo "$msg" >> "$LOG_FILE"
}

log_error() {
    local msg
    msg="[$(date '+%Y-%m-%d %H:%M:%S')] [ERROR] $*"
    echo "$msg" >&2
    [[ -n "${LOG_FILE:-}" ]] && echo "$msg" >> "$LOG_FILE"
}

log_warn() {
    local msg
    msg="[$(date '+%Y-%m-%d %H:%M:%S')] [WARN]  $*"
    echo "$msg" >&2
    [[ -n "${LOG_FILE:-}" ]] && echo "$msg" >> "$LOG_FILE"
}

# ── Locking (flock-based) ──────────────────────────────────────────────

LOCK_FD=9
_LOCK_ACQUIRED=false

acquire_lock() {
    local lock_file="${1:-$LOCK_FILE}"
    local timeout="${2:-3600}" # 1 hour default

    ensure_dir "$(dirname "$lock_file")"

    # Open file descriptor for flock
    eval "exec ${LOCK_FD}>\"${lock_file}\""

    if ! flock -w "$timeout" "$LOCK_FD"; then
        log_error "Could not acquire lock on ${lock_file} after ${timeout}s — another instance may be running"
        return 1
    fi

    # Write PID for diagnostics (truncate first to avoid leftover bytes)
    truncate -s 0 "$lock_file" 2>/dev/null || true
    echo "$$" >&${LOCK_FD}
    _LOCK_ACQUIRED=true
    log_info "Lock acquired (PID $$)"
}

release_lock() {
    if [[ "$_LOCK_ACQUIRED" == "true" ]]; then
        flock -u "$LOCK_FD" 2>/dev/null || true
        eval "exec ${LOCK_FD}>&-" 2>/dev/null || true
        _LOCK_ACQUIRED=false
        log_info "Lock released"
    fi
}

# ── Cleanup trap ────────────────────────────────────────────────────────

_TEMP_FILES=()

register_temp_file() {
    _TEMP_FILES+=("$1")
}

trap_exit() {
    local exit_code=$?
    # Remove temp files
    for f in "${_TEMP_FILES[@]:-}"; do
        [[ -f "$f" ]] && rm -f "$f" && log_info "Cleaned up temp file: $f"
    done
    # Release lock
    release_lock
    if [[ $exit_code -ne 0 ]]; then
        log_error "Script exited with code $exit_code"
    fi
    return "$exit_code"
}

# ── Helpers ─────────────────────────────────────────────────────────────

ensure_dir() {
    local dir="$1"
    if [[ ! -d "$dir" ]]; then
        mkdir -p "$dir"
        log_info "Created directory: $dir"
    fi
}

check_container_running() {
    local container="$1"
    if ! docker inspect --format='{{.State.Running}}' "$container" 2>/dev/null | grep -q "true"; then
        log_error "Container '$container' is not running"
        return 1
    fi
}

# Calculate file size in human-readable format
human_size() {
    local file="$1"
    if [[ -f "$file" ]]; then
        du -h "$file" | cut -f1
    else
        echo "N/A"
    fi
}

# Seconds to human-readable duration
format_duration() {
    local seconds=$1
    if (( seconds >= 3600 )); then
        printf '%dh %dm %ds' $((seconds/3600)) $((seconds%3600/60)) $((seconds%60))
    elif (( seconds >= 60 )); then
        printf '%dm %ds' $((seconds/60)) $((seconds%60))
    else
        printf '%ds' "$seconds"
    fi
}
