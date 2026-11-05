#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: dev-personal-backend.sh <source-worktree> [--check|--tunnel]

Download the backend-dev-akshat-receipt artifact to the source worktree's
Git metadata path (git rev-parse --path-format=absolute --git-path hushh-personal-backend).
Check out the exact commit in the receipt. Authenticate gcloud as i-akshat@hush1one.com.

Default: run the authenticated tunnel on 127.0.0.1:8080 and Next.js on localhost:3000.
--check: verify the receipt and deployed revision metadata.
--tunnel: run only the authenticated tunnel.

Next.js also requires HUSHH_SANDBOX_FIREBASE_WEB_CONFIG (path to the
dedicated Firebase web configuration JSON) and GOOGLE_APPLICATION_CREDENTIALS
(path to an ADC profile that impersonates localhost-sandbox-auth in the
dedicated Firebase project).
USAGE
}

die() { printf '%s\n' "$*" >&2; exit 1; }
case "${1:-}" in ""|-h|--help) usage; exit 0 ;; esac
mode="${2:-}"
[[ $# -le 2 && ( -z "$mode" || "$mode" == --check || "$mode" == --tunnel ) ]] ||
  die "Expected a source worktree and an optional --check or --tunnel."

root="$(git -C "$1" rev-parse --show-toplevel)"
receipt="$(git -C "$root" rev-parse --path-format=absolute --git-path hushh-personal-backend)"
[[ -f "$receipt" ]] || die "Download the Akshat deployment receipt to $receipt."
IFS=$'\t' read -r sha project region service baseline digest extra < "$receipt"
auth_project=hushh-akshat-sandbox-auth
account=i-akshat@hush1one.com
[[ "$project/$region/$service" == hushh-pda-uat/us-central1/backend-dev-akshat &&
   "$sha" == 5f4dcb772a66a303fb925f267246bc2e17b0ba9f &&
   "$baseline" == d884959b5b1dc666b01998b24bdd8138be93161e &&
   "$digest" =~ ^sha256:[0-9a-f]{64}$ && -z "$extra" ]] ||
  die "The deployment receipt is outside the approved Akshat sandbox."
[[ "$(git -C "$root" rev-parse HEAD)" == "$sha" ]] ||
  die "The source worktree must be at the commit in the receipt."
git -C "$root" merge-base --is-ancestor "$baseline" "$sha" ||
  die "The source worktree must include the approved baseline. Fetch history if it is shallow."

tag="iso-${sha:0:12}"
flags=(--project="$project" --region="$region" --account="$account" --quiet)
for property in auth/impersonate_service_account auth/access_token_file auth/credential_file_override; do
  value="$(gcloud config get-value "$property" --quiet 2>/dev/null)" ||
    die "Could not verify the effective gcloud authentication configuration."
  [[ -z "$value" ]] || die "Unset gcloud $property and use Akshat's own login."
done
[[ -z "${CLOUDSDK_AUTH_ACCESS_TOKEN:-}" ]] || die "Use Akshat's own gcloud login for the tunnel."
revision="$(gcloud run services describe "$service" "${flags[@]}" \
  --format='json(metadata.labels,metadata.annotations,spec.traffic,status.traffic)' |
  jq -er --arg tag "$tag" '
    select(.metadata.labels["sandbox-owner"] == "akshat" and
      .metadata.annotations["run.googleapis.com/invoker-iam-disabled"] != "true")
    | [.spec.traffic, .status.traffic]
    | map(map(select(.tag == $tag)) | select(length == 1) | .[0] |
          select(.latestRevision != true) | .revisionName)
    | select(length == 2 and .[0] == .[1])
    | .[0] | select(test("^backend-dev-akshat-[a-z0-9-]+$"))
  ')" || die "The private commit tag did not resolve to one explicit revision."

gcloud run revisions describe "$revision" "${flags[@]}" \
  --format='json(metadata.labels,metadata.annotations,spec.serviceAccountName,spec.containers,status.conditions,status.imageDigest)' |
  jq -e --arg sha "$sha" --arg digest "$digest" --arg project "$project" \
    --arg service "$service" --arg auth_project "$auth_project" '
    .metadata.labels["serving.knative.dev/service"] == $service and
    .metadata.labels["deploy-sha"] == $sha and .metadata.labels.env == "sandbox-akshat" and
    .metadata.annotations["run.googleapis.com/cloudsql-instances"] == ($project + ":us-central1:" + $service + "-pg") and
    .spec.serviceAccountName == ($service + "@" + $project + ".iam.gserviceaccount.com") and
    (.status.imageDigest | split("@")[-1]) == $digest and
    any(.status.conditions[]; .type == "Ready" and .status == "True") and
    any(.spec.containers[].env[]; .name == "GOOGLE_CLOUD_PROJECT" and .value == $auth_project)
  ' >/dev/null || die "The running revision did not match the Akshat deployment receipt."
printf 'Verified %s/%s/%s revision=%s commit=%s image=%s\n' "$project" "$region" "$service" "$revision" "$sha" "$digest"

[[ "$mode" != --check ]] || exit 0
tunnel=(gcloud run services proxy "$service" "${flags[@]}" --tag="$tag" --port=8080)
if [[ "$mode" == --tunnel ]]; then
  exec "${tunnel[@]}"
fi

cd "$root/hushh-webapp"
[[ -x node_modules/.bin/next ]] || die "Install frontend dependencies in the source worktree first."
# A fresh source worktree prevents Next from activating a shared environment.
for env_file in .env .env.local .env.development .env.development.local firebase-service-account.json; do
  [[ ! -e "$env_file" ]] || die "Use a clean sandbox worktree without $env_file."
done
adc="${GOOGLE_APPLICATION_CREDENTIALS:?Set the dedicated sandbox ADC profile path}"
impersonation="https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/localhost-sandbox-auth@$auth_project.iam.gserviceaccount.com:generateAccessToken"
jq -e --arg expected "$impersonation" '
  .type == "impersonated_service_account" and .service_account_impersonation_url == $expected
' "$adc" >/dev/null || die "The ADC profile must impersonate the dedicated sandbox account."

config="${HUSHH_SANDBOX_FIREBASE_WEB_CONFIG:?Set the dedicated Firebase web configuration path}"
firebase_fields="$(jq -er --arg project "$auth_project" '
  select(.projectId == $project and .authDomain == ($project + ".firebaseapp.com") and
    (.apiKey | test("^[a-zA-Z0-9_-]+$")) and
    (.messagingSenderId | test("^[0-9]+$")) and
    (.appId | test("^1:[0-9]+:web:[a-f0-9]+$")))
  | [.apiKey, .authDomain, .messagingSenderId, .appId] | @tsv
' "$config")" || die "Unexpected Firebase web configuration."
IFS=$'\t' read -r NEXT_PUBLIC_FIREBASE_API_KEY NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN \
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID NEXT_PUBLIC_FIREBASE_APP_ID <<< "$firebase_fields"
export NEXT_PUBLIC_FIREBASE_API_KEY NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN \
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID NEXT_PUBLIC_FIREBASE_APP_ID
export NEXT_PUBLIC_FIREBASE_PROJECT_ID="$auth_project"
unset FIREBASE_AUTH_EMULATOR_HOST NEXT_PUBLIC_LOCAL_REVIEWER_EMAIL NEXT_PUBLIC_LOCAL_REVIEWER_PASSWORD
export FIREBASE_ADMIN_CREDENTIALS_JSON= FIREBASE_SERVICE_ACCOUNT_JSON=
export NEXT_PUBLIC_GOOGLE_SIGN_IN_CLIENT_ID=
export NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET= NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID=
export NEXT_PUBLIC_OBSERVABILITY_ENABLED=false NEXT_PUBLIC_OBSERVABILITY_LOAD_IN_DEV=false

backend=http://127.0.0.1:8080
export PYTHON_API_URL="$backend" BACKEND_URL="$backend" DEVELOPER_API_URL="$backend"
export NEXT_PUBLIC_BACKEND_URL="$backend" NEXT_PUBLIC_DEVELOPER_API_URL="$backend"
export NEXT_PUBLIC_DEVELOPER_MCP_URL="$backend/mcp/"
export NEXT_PUBLIC_APP_URL=http://localhost:3000 NEXT_PUBLIC_APP_ENV=uat NEXT_DIST_DIR=.next-isolated
unset K_SERVICE K_REVISION GOOGLE_CLOUD_PROJECT NODE_ENV CAPACITOR_BUILD HUSHH_DEPLOY_ENV

exec python3 -c '
import os, signal, socket, subprocess, sys, time

children = []

def stop(*_):
    raise SystemExit(130)

signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGTERM, stop)
try:
    for port in (8080, 3000):
        with socket.socket() as sock:
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                sys.exit(f"Local port {port} is already in use.")
    proxy = subprocess.Popen(sys.argv[1:], start_new_session=True)
    children.append(proxy)
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline and proxy.poll() is None:
        check = subprocess.run(
            ["curl", "-fsS", "--noproxy", "*", "--max-time", "2",
             "-o", "/dev/null", "-w", "%{http_code}", "http://127.0.0.1:8080/health"],
            capture_output=True, check=False)
        if check.returncode == 0 and check.stdout == b"200" and proxy.poll() is None:
            break
        time.sleep(0.4)
    else:
        sys.exit("The pinned backend did not become reachable through the tunnel.")
    web = subprocess.Popen(
        ["npm", "run", "dev", "--", "--hostname", "127.0.0.1", "--port", "3000"],
        start_new_session=True)
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
' "${tunnel[@]}"
