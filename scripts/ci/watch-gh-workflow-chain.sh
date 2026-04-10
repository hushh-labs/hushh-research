#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  watch-gh-workflow-chain.sh --run-id <id> [options]

Options:
  --run-id <id>                 GitHub Actions run id to watch.
  --follow-workflow <name>      After the initial run succeeds, wait for a downstream workflow
                                with the same head SHA and watch that run to terminal state.
  --poll-seconds <seconds>      Poll interval. Default: 15
  --wait-seconds <seconds>      Max wait for downstream workflow appearance. Default: 1800
  --daemonize                   Start the watcher in the background and print PID/log file.
  --log-file <path>             Explicit log file path when using --daemonize.
  --repo <owner/name>           Override GH repo target.
  --help                        Show this help.
EOF
}

RUN_ID=""
FOLLOW_WORKFLOW=""
POLL_SECONDS=15
WAIT_SECONDS=1800
DAEMONIZE=0
LOG_FILE=""
REPO="${GITHUB_REPOSITORY:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id)
      RUN_ID="${2:-}"
      shift 2
      ;;
    --follow-workflow)
      FOLLOW_WORKFLOW="${2:-}"
      shift 2
      ;;
    --poll-seconds)
      POLL_SECONDS="${2:-}"
      shift 2
      ;;
    --wait-seconds)
      WAIT_SECONDS="${2:-}"
      shift 2
      ;;
    --daemonize)
      DAEMONIZE=1
      shift
      ;;
    --log-file)
      LOG_FILE="${2:-}"
      shift 2
      ;;
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$RUN_ID" ]]; then
  echo "--run-id is required" >&2
  usage >&2
  exit 2
fi

for cmd in gh jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 2
  fi
done

gh_cmd() {
  if [[ -n "$REPO" ]]; then
    gh -R "$REPO" "$@"
  else
    gh "$@"
  fi
}

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

log() {
  printf '[%s] %s\n' "$(timestamp)" "$*"
}

if [[ "$DAEMONIZE" -eq 1 ]]; then
  mkdir -p tmp/devops-watch
  if [[ -z "$LOG_FILE" ]]; then
    LOG_FILE="tmp/devops-watch/watch-${RUN_ID}-$(date +%Y%m%d-%H%M%S).log"
  fi

  child_args=(--run-id "$RUN_ID" --poll-seconds "$POLL_SECONDS" --wait-seconds "$WAIT_SECONDS")
  if [[ -n "$FOLLOW_WORKFLOW" ]]; then
    child_args+=(--follow-workflow "$FOLLOW_WORKFLOW")
  fi
  if [[ -n "$REPO" ]]; then
    child_args+=(--repo "$REPO")
  fi

  nohup "$0" "${child_args[@]}" >"$LOG_FILE" 2>&1 &
  PID=$!
  echo "pid=$PID"
  echo "log=$LOG_FILE"
  exit 0
fi

WATCH_RESULT_CONCLUSION=""
WATCH_RESULT_SHA=""
WATCH_RESULT_WORKFLOW=""

watch_run() {
  local run_id="$1"
  local last_snapshot=""

  while true; do
    local json
    json="$(gh_cmd run view "$run_id" --json workflowName,headSha,status,conclusion,jobs,url 2>/dev/null)"

    local workflow_name
    workflow_name="$(jq -r '.workflowName' <<<"$json")"
    local head_sha
    head_sha="$(jq -r '.headSha' <<<"$json")"
    local status
    status="$(jq -r '.status' <<<"$json")"
    local conclusion
    conclusion="$(jq -r '.conclusion // ""' <<<"$json")"
    local url
    url="$(jq -r '.url' <<<"$json")"
    local active_job
    active_job="$(jq -r '[.jobs[]? | select(.status=="in_progress") | .name][0] // ""' <<<"$json")"
    local active_step
    active_step="$(jq -r '[.jobs[]? | select(.status=="in_progress") | .steps[]? | select(.status=="in_progress") | .name][0] // ""' <<<"$json")"
    local snapshot="${status}|${conclusion}|${active_job}|${active_step}"

    if [[ "$snapshot" != "$last_snapshot" ]]; then
      if [[ -n "$active_job" || -n "$active_step" ]]; then
        log "run=$run_id workflow=\"$workflow_name\" status=$status conclusion=${conclusion:-pending} job=\"${active_job:-}\" step=\"${active_step:-}\" sha=$head_sha url=$url"
      else
        log "run=$run_id workflow=\"$workflow_name\" status=$status conclusion=${conclusion:-pending} sha=$head_sha url=$url"
      fi
      last_snapshot="$snapshot"
    fi

    if [[ "$status" == "completed" ]]; then
      WATCH_RESULT_CONCLUSION="$conclusion"
      WATCH_RESULT_SHA="$head_sha"
      WATCH_RESULT_WORKFLOW="$workflow_name"

      if [[ "$conclusion" != "success" && "$conclusion" != "skipped" ]]; then
        local failed_step
        failed_step="$(jq -r '
          [
            .jobs[]?
            | select(.conclusion=="failure" or .conclusion=="cancelled" or .conclusion=="timed_out")
            | .name as $job
            | (
                [.steps[]? | select(.conclusion=="failure" or .conclusion=="cancelled" or .conclusion=="timed_out") | "job=\"" + $job + "\" step=\"" + .name + "\""][0]
                // ("job=\"" + $job + "\"")
              )
          ][0] // ""
        ' <<<"$json")"
        if [[ -n "$failed_step" ]]; then
          log "terminal failure for run=$run_id workflow=\"$workflow_name\" conclusion=$conclusion $failed_step"
        else
          log "terminal failure for run=$run_id workflow=\"$workflow_name\" conclusion=$conclusion"
        fi
        return 1
      fi

      log "terminal success for run=$run_id workflow=\"$workflow_name\" conclusion=$conclusion"
      return 0
    fi

    sleep "$POLL_SECONDS"
  done
}

wait_for_downstream_workflow() {
  local workflow_name="$1"
  local head_sha="$2"
  local deadline=$(( $(date +%s) + WAIT_SECONDS ))
  local last_seen=""

  log "waiting for downstream workflow=\"$workflow_name\" sha=$head_sha"

  while true; do
    local found_json
    found_json="$(gh_cmd run list --workflow "$workflow_name" --limit 20 --json databaseId,headSha,status,conclusion,createdAt,url \
      | jq -c --arg sha "$head_sha" '[.[] | select(.headSha == $sha)] | sort_by(.createdAt) | last // empty')"

    if [[ -n "$found_json" ]]; then
      local downstream_run_id
      downstream_run_id="$(jq -r '.databaseId' <<<"$found_json")"
      if [[ "$downstream_run_id" != "$last_seen" ]]; then
        log "downstream workflow=\"$workflow_name\" detected run=$downstream_run_id"
        last_seen="$downstream_run_id"
      fi
      watch_run "$downstream_run_id"
      return $?
    fi

    if (( $(date +%s) >= deadline )); then
      log "timed out waiting for downstream workflow=\"$workflow_name\" sha=$head_sha"
      return 1
    fi

    sleep "$POLL_SECONDS"
  done
}

watch_run "$RUN_ID"

if [[ -n "$FOLLOW_WORKFLOW" && "$WATCH_RESULT_CONCLUSION" == "success" ]]; then
  wait_for_downstream_workflow "$FOLLOW_WORKFLOW" "$WATCH_RESULT_SHA"
fi
