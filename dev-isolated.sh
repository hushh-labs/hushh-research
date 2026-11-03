#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: ./dev-isolated.sh [--check|--tunnel|--direct|--personal]

Required environment (from an approved isolated deployment receipt):
  HUSHH_ISOLATED_PROJECT    GCP project ID (UAT allows backend-dev-ankit only)
  HUSHH_ISOLATED_REGION     Cloud Run region
  HUSHH_ISOLATED_SERVICE    Dedicated backend service
  HUSHH_ISOLATED_BASELINE   Full known-good baseline commit SHA
  HUSHH_ISOLATED_DIGEST     Expected sha256:<64 hex> backend image digest

The Cloud Run service must have an explicit revision tag iso-<first 12 of HEAD>,
a full deploy-sha revision label matching HEAD, and OTEL_ENABLED=true.

Default: authenticated tunnel on 127.0.0.1:8080 and local Next.js on :3000.
--check: verify Cloud Run metadata only.
--tunnel: run just the authenticated tunnel on :8080.
--direct: run Next.js against the verified HTTPS tag URL (requires direct access).
--personal: use this worktree's personal deployment receipt and localhost:3000.
Override local ports with HUSHH_ISOLATED_PROXY_PORT and HUSHH_ISOLATED_WEB_PORT.
USAGE
}

die() { printf '%s\n' "$*" >&2; exit 1; }

mode="${1:-}"
case "$mode" in
  -h|--help) usage; exit 0 ;;
  ""|--check|--tunnel|--direct|--personal) [[ $# -le 1 ]] || die "Expected one mode." ;;
  *) usage >&2; exit 1 ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$mode" == --personal ]]; then
  receipt="$(git -C "$root" rev-parse --path-format=absolute --git-path hushh-personal-backend)"
  [[ -f "$receipt" ]] || die "Run scripts/deploy-personal-backend.sh from this worktree first."
  IFS=$'\t' read -r receipt_sha HUSHH_ISOLATED_PROJECT HUSHH_ISOLATED_REGION \
    HUSHH_ISOLATED_SERVICE HUSHH_ISOLATED_BASELINE HUSHH_ISOLATED_DIGEST < "$receipt"
  [[ "$(git -C "$root" rev-parse --verify HEAD)" == "$receipt_sha" ]] ||
    die "The personal deploy receipt is for a different HEAD. Deploy this commit first."
  HUSHH_ISOLATED_WEB_PORT=3000
  HUSHH_ISOLATED_TELEMETRY_ENV="sandbox-${HUSHH_ISOLATED_SERVICE#backend-dev-}"
  web_host=localhost
else
  web_host=127.0.0.1
fi
project="${HUSHH_ISOLATED_PROJECT:?Set the dedicated GCP project ID}"
region="${HUSHH_ISOLATED_REGION:?Set the Cloud Run region}"
service="${HUSHH_ISOLATED_SERVICE:?Set the isolated backend service name}"
baseline="${HUSHH_ISOLATED_BASELINE:?Set the known-good baseline SHA}"
digest="${HUSHH_ISOLATED_DIGEST:?Set the image digest from the deployment receipt}"
proxy_port="${HUSHH_ISOLATED_PROXY_PORT:-8080}"
web_port="${HUSHH_ISOLATED_WEB_PORT:-3000}"

case "$project" in
  hushh-pda|hushh-pda-dev) die "Refusing a shared release project: $project" ;;
  hushh-pda-uat)
    [[ "$region/$service" == us-central1/backend-dev-ankit ]] ||
      die "Only backend-dev-ankit can be attached in the UAT project."
    HUSHH_ISOLATED_TELEMETRY_ENV=sandbox-ankit
    ;;
esac
for name in "$project" "$region" "$service"; do
  [[ "$name" =~ ^[a-z][a-z0-9-]*[a-z0-9]$ ]] || die "Use explicit project, region and service IDs."
done
[[ "$baseline" =~ ^[0-9a-f]{40}$ ]] || die "Baseline must be a full commit SHA."
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "Use a sha256 image digest, not a registry tag."
for port in "$proxy_port" "$web_port"; do
  [[ "$port" =~ ^[1-9][0-9]{0,4}$ ]] && ((port <= 65535)) || die "Invalid local port."
done

sha="$(git -C "$root" rev-parse --verify HEAD)"
git -C "$root" merge-base --is-ancestor "$baseline" "$sha" ||
  die "HEAD does not descend from the supplied baseline."
tag="iso-${sha:0:12}"

# Limit CLI output to the provenance and readiness fields. Do not print runtime env.
run_flags=(--project="$project" --region="$region" --quiet)
target="$(gcloud run services describe "$service" "${run_flags[@]}" \
  --format='json(metadata.name,spec.traffic,status.traffic)' |
  python3 -c '
import json, re, sys
service, tag = sys.argv[1:]
obj = json.load(sys.stdin)
def tagged(section):
    matches = [x for x in obj.get(section, {}).get("traffic", []) if x.get("tag") == tag]
    if len(matches) != 1 or matches[0].get("latestRevision") is True:
        sys.exit("Expected a single explicit revision tag in Cloud Run " + section)
    return matches[0]
desired, serving = tagged("spec"), tagged("status")
rev, url = serving.get("revisionName", ""), serving.get("url", "")
if (obj.get("metadata", {}).get("name") != service or not rev.startswith(service + "-")
        or not re.fullmatch(r"[a-z0-9-]+", rev) or desired.get("revisionName") != rev
        or not re.fullmatch(r"https://" + tag + r"---[a-z0-9-]+(?:\.a)?\.run\.app", url)):
    sys.exit("Cloud Run tagged URL does not resolve to the explicitly configured revision.")
print(rev, url)
' "$service" "$tag")"
read -r revision remote_url <<< "$target"

gcloud run revisions describe "$revision" "${run_flags[@]}" \
  --format='json(metadata.name,metadata.labels,spec.containers,status.conditions,status.imageDigest)' |
  python3 -c '
import json, sys
revision, service, sha, digest, expected_env = sys.argv[1:]
obj = json.load(sys.stdin)
meta, status = obj.get("metadata", {}), obj.get("status", {})
labels = meta.get("labels", {})
containers = obj.get("spec", {}).get("containers", [])
env = {e.get("name"): e.get("value", "") for e in (containers[0].get("env", []) if containers else [])}
checks = {
    "revision identity": meta.get("name") == revision and labels.get("serving.knative.dev/service") == service,
    "full commit SHA": labels.get("deploy-sha") == sha,
    "running image digest": status.get("imageDigest", "").rsplit("@", 1)[-1] == digest,
    "ready revision": any(c.get("type") == "Ready" and c.get("status") == "True"
                          for c in status.get("conditions", [])),
    "trace export configured": env.get("OTEL_ENABLED", "").lower() in {"1", "true", "yes", "on"},
    "sandbox telemetry identity": not expected_env or (
        env.get("HUSHH_TELEMETRY_ENV") == expected_env and labels.get("env") == expected_env
    ),
}
failed = [k for k, v in checks.items() if not v]
if failed:
    sys.exit("Isolated revision verification failed: " + ", ".join(failed))
' "$revision" "$service" "$sha" "$digest" "${HUSHH_ISOLATED_TELEMETRY_ENV:-}"

printf 'Verified %s/%s/%s revision=%s\ncommit=%s image=%s\n' \
  "$project" "$region" "$service" "$revision" "$sha" "$digest"

[[ "$mode" != --check ]] || exit 0
tunnel=(gcloud run services proxy "$service" "${run_flags[@]}" --tag="$tag" --port="$proxy_port")
if [[ "$mode" == --tunnel ]]; then
  exec "${tunnel[@]}"
fi

cd "$root/hushh-webapp"
[[ -x node_modules/.bin/next ]] || die "Install frontend dependencies first."
# Do not activate a shared profile or rewrite .env files. Next loads this
# worktree's existing frontend configuration; these origins take precedence.
if [[ "$mode" == --direct ]]; then
  backend="$remote_url"
else
  [[ "$proxy_port" != "$web_port" ]] || die "Tunnel and frontend ports must differ."
  backend="http://127.0.0.1:$proxy_port"
fi
export PYTHON_API_URL="$backend" BACKEND_URL="$backend" DEVELOPER_API_URL="$backend"
export NEXT_PUBLIC_BACKEND_URL="$backend" NEXT_PUBLIC_DEVELOPER_API_URL="$backend"
export NEXT_PUBLIC_DEVELOPER_MCP_URL="$backend/mcp/"
export NEXT_PUBLIC_APP_URL="http://$web_host:$web_port"
export NEXT_PUBLIC_APP_ENV=uat NEXT_DIST_DIR=.next-isolated
# Keep backend traces on, without sending browser development events to a shared property.
export NEXT_PUBLIC_OBSERVABILITY_LOAD_IN_DEV=false
# The Next backend-origin helper treats this server variable as hosted runtime identity.
# Frontend Firebase project selection remains in NEXT_PUBLIC_FIREBASE_PROJECT_ID.
export K_SERVICE= K_REVISION= GOOGLE_CLOUD_PROJECT=
web=(npm run dev -- --hostname 127.0.0.1 --port "$web_port")

if [[ "$mode" == --direct ]]; then
  [[ "$(curl -fsS --max-time 15 -o /dev/null -w '%{http_code}' "$backend/health")" == 200 ]] ||
    die "Tagged backend is not directly reachable; use the authenticated tunnel."
  exec "${web[@]}"
fi

# Keep the tunnel and web descendants in separate process groups, owned by this session.
exec python3 -c '
import os, signal, socket, subprocess, sys, time
port, web_port = map(int, sys.argv[1:3])
split = sys.argv.index("--", 3)
children = []
def stop(*_):
    raise SystemExit(130)
signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGTERM, stop)
try:
    for local_port in (port, web_port):
        with socket.socket() as sock:
            try:
                sock.bind(("127.0.0.1", local_port))
            except OSError:
                sys.exit(f"Local port {local_port} is already in use.")
    proxy = subprocess.Popen(sys.argv[3:split], start_new_session=True)
    children.append(proxy)
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline and proxy.poll() is None:
        check = subprocess.run(
            ["curl", "-fsS", "--noproxy", "*", "--max-time", "2", "-o", "/dev/null", "-w", "%{http_code}",
             f"http://127.0.0.1:{port}/health"], capture_output=True, check=False)
        if check.returncode == 0 and check.stdout == b"200" and proxy.poll() is None:
            break
        time.sleep(0.4)
    else:
        sys.exit("Verified revision did not become reachable through the Cloud Run proxy.")
    web = subprocess.Popen(sys.argv[split + 1:], start_new_session=True)
    children.append(web)
    while web.poll() is None and proxy.poll() is None:
        time.sleep(0.3)
    sys.exit(web.returncode if web.returncode is not None else 1)
finally:
    for child in reversed(children):
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    for child in reversed(children):
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
' "$proxy_port" "$web_port" "${tunnel[@]}" -- "${web[@]}"
