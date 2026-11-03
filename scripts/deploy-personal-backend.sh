#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

if [[ "${1:-}" == --help ]]; then
  cat <<'HELP'
Usage: ./scripts/deploy-personal-backend.sh [--check]
Builds committed HEAD and creates a tagged revision on an existing private service.
Defaults to backend-dev-ankit in hushh-pda-uat/us-central1.
Requires HUSHH_ISOLATED_BASELINE and
HUSHH_SANDBOX_{ARTIFACT_REPOSITORY,BUILD_ACCOUNT,SOURCE_BUCKET}.
See deploy/README.md for the sandbox provisioning contract.
HELP
  exit 0
fi
[[ $# -eq 0 || ( $# -eq 1 && "$1" == --check ) ]] || exit 2

die() { printf '%s\n' "$*" >&2; exit 1; }
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
project="${HUSHH_ISOLATED_PROJECT:-hushh-pda-uat}"
region="${HUSHH_ISOLATED_REGION:-us-central1}"
service="${HUSHH_ISOLATED_SERVICE:-backend-dev-ankit}"
owner="${HUSHH_SANDBOX_OWNER:-ankit}"
baseline="${HUSHH_ISOLATED_BASELINE:?Set the known-good baseline SHA}"
sql="${HUSHH_SANDBOX_SQL_INSTANCE:-hushh-pda-uat:us-central1:backend-dev-ankit-pg}"
db="${HUSHH_SANDBOX_DB_NAME:-backend_dev_ankit}"
repository="${HUSHH_SANDBOX_ARTIFACT_REPOSITORY:?Set the personal Docker repository name}"
build_account="${HUSHH_SANDBOX_BUILD_ACCOUNT:?Set the dedicated build service account email}"
bucket="${HUSHH_SANDBOX_SOURCE_BUCKET:?Set the preprovisioned staging bucket name}"

case "$project" in
  hushh-pda|hushh-pda-dev) die "Shared release project refused." ;;
  hushh-pda-uat)
    [[ "$region/$service/$owner" == "us-central1/backend-dev-ankit/ankit" &&
       "$sql/$db" == "hushh-pda-uat:us-central1:backend-dev-ankit-pg/backend_dev_ankit" ]] ||
      die "Only the configured personal service and database are allowed in UAT."
    ;;
esac
export HUSHH_ISOLATED_PROJECT="$project" HUSHH_ISOLATED_REGION="$region"
export HUSHH_ISOLATED_SERVICE="$service"
for value in "$project" "$region" "$repository" "$owner"; do
  [[ "$value" =~ ^[a-z][a-z0-9-]{0,29}$ ]] || die "Invalid project, region, repository, or owner slug."
done
[[ "$service" == "backend-dev-$owner" && "$service" != *- && ${#service} -le 41 ]] ||
  die "The personal service must be named backend-dev-<owner> (41 characters maximum)."
[[ "$sql" == "$project:"* && "$sql" =~ ^[a-z0-9-]+:[a-z0-9-]+:[a-z0-9-]+$ ]] ||
  die "Cloud SQL must be in the dedicated sandbox project."
[[ "$db" =~ ^[a-z][a-z0-9_]*$ ]] || die "Invalid sandbox database name."
[[ "$build_account" == *@${project}.iam.gserviceaccount.com &&
   "${build_account%@*}" =~ ^[a-z][a-z0-9-]+$ ]] || die "Use a sandbox-owned build account."
[[ "$bucket" =~ ^[a-z0-9][a-z0-9-]+$ ]] || die "Use a preprovisioned staging bucket name."
[[ "$baseline" =~ ^[0-9a-f]{40}$ ]] || die "Use a full baseline SHA."
sha="$(git rev-parse --verify HEAD)"
git merge-base --is-ancestor "$baseline" "$sha" || die "HEAD does not descend from the selected baseline."
git grep -q HUSHH_TELEMETRY_ENV "$sha" -- consent-protocol/api/middlewares/observability.py ||
  die "Commit the sandbox telemetry support before deploying this HEAD."
tag="iso-${sha:0:12}"
revision="$service-$tag"
flags=(--project="$project" --region="$region" --quiet)

preflight() {
  gcloud run services get-iam-policy "$service" "${flags[@]}" --format=json |
    python3 -c '
import json, sys
for binding in json.load(sys.stdin).get("bindings", []):
    if set(binding.get("members", [])) & {"allUsers", "allAuthenticatedUsers"}:
        sys.exit("Personal service has a public IAM binding.")
'
  gcloud run services describe "$service" "${flags[@]}" --format=json |
    python3 -c '
import json, re, sys
project, service, owner, sql, db, tag, revision = sys.argv[1:]
obj = json.load(sys.stdin)
meta = obj.get("metadata", {})
template = obj.get("spec", {}).get("template", {})
annotations = template.get("metadata", {}).get("annotations", {})
spec = template.get("spec", {})
containers = spec.get("containers", [])
container = containers[0] if len(containers) == 1 else {}
env = {e["name"]: e.get("value") for e in container.get("env", [])}
secret_refs = [e.get("valueFrom", {}).get("secretKeyRef") for e in container.get("env", [])]
limits = container.get("resources", {}).get("limits", {})
runtime = spec.get("serviceAccountName", "")
checks = {
    "sandbox ownership": meta.get("name") == service
        and meta.get("labels", {}).get("sandbox-owner") == owner,
    "private IAM enforcement": meta.get("annotations", {}).get(
        "run.googleapis.com/invoker-iam-disabled", "false") == "false",
    "sandbox runtime identity": runtime == f"{service}@{project}.iam.gserviceaccount.com",
    "dedicated Cloud SQL": annotations.get("run.googleapis.com/cloudsql-instances") == sql
        and env.get("DB_UNIX_SOCKET") == f"/cloudsql/{sql}" and env.get("DB_NAME") == db,
    "explicit DB credentials": {"DB_USER", "DB_PASSWORD"} <= {
        e["name"] for e in container.get("env", [])
        if e.get("valueFrom", {}).get("secretKeyRef")
    },
    "pinned environment secret versions": all(
        re.fullmatch(r"[1-9][0-9]*", str(ref.get("key", "")))
        for ref in secret_refs if ref is not None),
    "single container and production CPU/memory": len(containers) == 1
        and str(limits.get("cpu")) in {"2", "2000m"} and limits.get("memory") in {"4Gi", "4096Mi"},
    "sandbox frontend origin": env.get("APP_FRONTEND_ORIGIN") == "http://localhost:3000"
        and "http://localhost:3000" in (env.get("CORS_ALLOWED_ORIGINS") or "").split(","),
    "database startup guard": env.get("REQUIRE_DATABASE_ON_STARTUP") == "true",
}
if project == "hushh-pda-uat":
    refs = {entry["name"]: entry.get("valueFrom", {}).get("secretKeyRef", {}).get("name")
            for entry in container.get("env", [])}
    checks["personal UAT database credentials"] = (
        refs.get("DB_USER") == "BACKEND_DEV_ANKIT_DB_USER"
        and refs.get("DB_PASSWORD") == "BACKEND_DEV_ANKIT_DB_PASSWORD"
    )
    checks["personal UAT database capacity"] = (
        container.get("name") == "consent-protocol"
        and annotations.get("autoscaling.knative.dev/maxScale") == "1"
        and env.get("DB_POOL_MAX_SIZE") == "2"
        and env.get("DB_SQLALCHEMY_POOL_SIZE") == "1"
        and env.get("DB_SQLALCHEMY_MAX_OVERFLOW") == "0"
        and env.get("DB_POOL_MIN_SIZE") in {"0", "1", "2"}
    )
failed = [name for name, ok in checks.items() if not ok]
if failed:
    sys.exit("Sandbox preflight failed: " + ", ".join(failed))
for section in ("spec", "status"):
    for target in obj.get(section, {}).get("traffic", []):
        if target.get("tag") == tag and (
            target.get("revisionName") != revision or target.get("latestRevision") is True
        ):
            sys.exit("Personal commit tag conflicts with an existing revision.")
' "$project" "$service" "$owner" "$sql" "$db" "$tag" "$revision"
}

start=$SECONDS
preflight
printf 'Sandbox preflight passed for %s/%s/%s, commit %s\n' "$project" "$region" "$service" "$sha"
[[ "${1:-}" != --check ]] || exit 0
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
# Archive only the two image inputs. Cloud Build receives no working tree files.
git archive --format=tar.gz "$sha" consent-protocol contracts > "$stage/source.tar.gz"
registry="$region-docker.pkg.dev"
image="$registry/$project/$repository/$service"
attempt="$sha-$(python3 -c 'import secrets; print(secrets.token_hex(6))')"
bucket_project="$(gcloud storage buckets describe "gs://$bucket" --project="$project" --raw --format='value(projectNumber)')"
project_number="$(gcloud projects describe "$project" --format='value(projectNumber)')"
[[ -n "$project_number" && "$bucket_project" == "$project_number" ]] ||
  die "The source bucket must belong to the sandbox project."

# Keep a published per-commit revision stable. A retry can reissue its receipt.
existing="$(gcloud run revisions list --service="$service" "${flags[@]}" \
  --filter="metadata.name=$revision" --format='value(metadata.name,status.imageDigest)')"
if [[ -n "$existing" ]]; then
  read -r existing_revision reference <<< "$existing"
  [[ "$existing_revision" == "$revision" && "$reference" == "$image@"* ]] ||
    die "Existing revision does not match the personal image repository."
  digest="${reference##*@}"
else
  gcloud builds submit "$stage/source.tar.gz" --config="$root/deploy/personal-backend-image.cloudbuild.yaml" \
    "${flags[@]}" --service-account="projects/$project/serviceAccounts/$build_account" \
    --gcs-source-staging-dir="gs://$bucket/personal-backend" --suppress-logs \
    --substitutions="_REGISTRY=$registry,_IMAGE=$image,_SOURCE_SHA=$sha,_ATTEMPT=$attempt"
  digest="$(gcloud artifacts docker images describe "$image:$attempt" --project="$project" \
    --format='value(image_summary.digest)')"
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "Could not resolve the immutable image digest."
  preflight
  [[ "$(git rev-parse --verify HEAD)" == "$sha" ]] || die "HEAD changed during build."
  gcloud run services update "$service" "${flags[@]}" --image="$image@$digest" \
    --no-traffic --tag="$tag" --revision-suffix="$tag" \
    --update-labels="deploy-sha=$sha,env=sandbox-$owner" \
    --update-env-vars="OTEL_ENABLED=true,HUSHH_TELEMETRY_ENV=sandbox-$owner"
fi
HUSHH_ISOLATED_DIGEST="$digest" HUSHH_ISOLATED_TELEMETRY_ENV="sandbox-$owner" \
  "$root/dev-isolated.sh" --check
receipt="$(git rev-parse --path-format=absolute --git-path hushh-personal-backend)"
printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$sha" "$project" "$region" "$service" "$baseline" "$digest" > "$stage/receipt"
mv "$stage/receipt" "$receipt"
printf 'Verified revision in %ss. Start web with: npm --prefix hushh-webapp run dev:sandbox\n' "$((SECONDS - start))"
