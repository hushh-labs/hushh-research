#!/usr/bin/env bash
# Source only from validation runners, after prerequisite/selection checks.
# Execute external commands, not shell functions: conditional function calls
# disable errexit inside the function and can accidentally bypass prerequisites.
validation_failures=()
validation_check() {
  local label="$1" result
  shift
  printf '\n== %s ==\n' "$label"
  if command "$@"; then
    return 0
  else
    result=$?
  fi
  validation_record "$label" "$result"
}
validation_record() {
  local label="$1" result="$2"
  [ "$result" -ne 0 ] || return 0
  # Cancellation, timeout and missing executables are infrastructure failures;
  # do not start more work after the runner can no longer execute reliably.
  if [ "$result" -ge 124 ]; then
    printf 'Validation interrupted: %s (exit %s)\n' "$label" "$result" >&2
    exit "$result"
  fi
  validation_failures+=("$label (exit $result)")
}
validation_finish() {
  if [ "${#validation_failures[@]}" -gt 0 ]; then
    printf '\nFailed independent checks (%s):\n' "${#validation_failures[@]}" >&2
    printf '  - %s\n' "${validation_failures[@]}" >&2
    return 1
  fi
}
