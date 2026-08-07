#!/usr/bin/env bash
# Backend deploy step for deploy/backend.cloudbuild.yaml.
#
# WHY THIS IS A FILE AND NOT INLINE YAML
# Cloud Build caps a single build-step arg at 10,000 characters. This body grew past
# that on 2026-07-28 (commit 363a9932d, 9,559 -> 10,569) and every backend deploy has
# failed at submission since, on ALL THREE lanes -- dev, uat and production -- with:
#   INVALID_ARGUMENT: invalid .steps field: build step 2 arg 1 too long (max: 10000)
# gcloud enforces this client-side on the parsed config, so no Cloud Build is ever
# created and there is nothing to read in the build log. Stripping every comment left
# 10,711 -- still over. Moving the body here removes the ceiling permanently.
#
# HOW SUBSTITUTIONS REACH THIS SCRIPT
# Cloud Build substitutes ${_FOO} in the build CONFIG only, never inside a file from the
# source tarball. Every value therefore arrives as a real environment variable, declared
# in the step's `env:` list in the YAML. `${_FOO}` below is an ordinary shell read of
# that env var, which is why this body is byte-identical to the inline version.
#
# Two things depend on those `env:` entries keeping the literal ${_FOO} tokens in the
# YAML, so do NOT collapse them:
#   1. deploy-dev.yml's skew guard greps backend.cloudbuild.yaml for "${_KEY}" and
#      SILENTLY DROPS any substitution it cannot find -- the deploy would then run on
#      template defaults with no error.
#   2. scripts/ci/runtime-contract-check.sh greps the YAML for specific RIA env pairs.
#
# `set -u` is on, so every variable referenced here must appear in that `env:` list.
# consent-protocol/tests/test_pod_image_build_contract.py asserts exactly that, and
# also asserts every step arg stays under the 10,000 limit.

set -euo pipefail
if [[ -z "${_RUNTIME_SERVICE_ACCOUNT}" ]]; then
  echo "_RUNTIME_SERVICE_ACCOUNT is required." >&2
  exit 1
fi
if [[ "${_RUNTIME_SERVICE_ACCOUNT}" != *"@${PROJECT_ID}.iam.gserviceaccount.com" ]]; then
  echo "Runtime service account must belong to ${PROJECT_ID}; got '${_RUNTIME_SERVICE_ACCOUNT}'." >&2
  exit 1
fi
genai_project_id="${_GENAI_PROJECT_ID}"
if [[ -z "${genai_project_id}" ]]; then
  genai_project_id="$PROJECT_ID"
  if [[ "${_DEPLOY_ENV}" == "dev" ]]; then
    genai_project_id="hushh-pda-uat"
  fi
fi
if [[ "${genai_project_id}" != "$PROJECT_ID" && "${_DEPLOY_ENV}" != "dev" ]]; then
  echo "Cross-project managed Vertex is allowed only for the isolated dev lane." >&2
  exit 1
fi
gcloud iam service-accounts describe "${_RUNTIME_SERVICE_ACCOUNT}" \
  --project="$PROJECT_ID" >/dev/null
vertex_api_name="$(gcloud services list --enabled \
  --project="${genai_project_id}" \
  --filter='config.name=aiplatform.googleapis.com' \
  --format='value(config.name)' | head -n 1)"
if [[ "${vertex_api_name}" != "aiplatform.googleapis.com" ]]; then
  echo "Vertex AI API must be enabled in ${genai_project_id}." >&2
  exit 1
fi
runtime_vertex_role="$(gcloud projects get-iam-policy "${genai_project_id}" \
  --flatten='bindings[].members' \
  --filter="bindings.role=roles/aiplatform.user AND bindings.members=serviceAccount:${_RUNTIME_SERVICE_ACCOUNT}" \
  --format='value(bindings.role)' | head -n 1)"
if [[ "${runtime_vertex_role}" != "roles/aiplatform.user" ]]; then
  echo "${_RUNTIME_SERVICE_ACCOUNT} must have roles/aiplatform.user in ${genai_project_id}." >&2
  exit 1
fi
if [[ "${genai_project_id}" != "$PROJECT_ID" ]]; then
  runtime_service_usage_role="$(gcloud projects get-iam-policy "${genai_project_id}" \
    --flatten='bindings[].members' \
    --filter="bindings.role=roles/serviceusage.serviceUsageConsumer AND bindings.members=serviceAccount:${_RUNTIME_SERVICE_ACCOUNT}" \
    --format='value(bindings.role)' | head -n 1)"
  if [[ "${runtime_service_usage_role}" != "roles/serviceusage.serviceUsageConsumer" ]]; then
    echo "${_RUNTIME_SERVICE_ACCOUNT} must have roles/serviceusage.serviceUsageConsumer in ${genai_project_id}." >&2
    exit 1
  fi
fi
append_optional_secret() {
  local secret_name="$1"
  local env_name="$2"
  if [[ -z "${secret_name}" ]]; then
    return
  fi
  if gcloud secrets describe "${secret_name}" --project="$PROJECT_ID" >/dev/null 2>&1; then
    secrets="${secrets},${env_name}=${secret_name}:latest"
  else
    echo "Skipping optional secret ${secret_name}; not found in project ${PROJECT_ID}."
  fi
}

secrets="APP_SIGNING_KEY=${_APP_SIGNING_KEY_SECRET}:latest,VAULT_DATA_KEY=${_VAULT_DATA_KEY_SECRET}:latest,FIREBASE_ADMIN_CREDENTIALS_JSON=${_FIREBASE_ADMIN_CREDENTIALS_SECRET}:latest,APP_FRONTEND_ORIGIN=${_APP_FRONTEND_ORIGIN_SECRET}:latest,BACKEND_RUNTIME_CONFIG_JSON=${_BACKEND_RUNTIME_CONFIG_JSON_SECRET}:latest,DB_USER=DB_USER:latest,DB_PASSWORD=DB_PASSWORD:latest"
if [[ -n "${_PLAID_CLIENT_ID_SECRET}" ]]; then
  secrets="${secrets},PLAID_CLIENT_ID=${_PLAID_CLIENT_ID_SECRET}:latest"
fi
if [[ -n "${_PLAID_SECRET_SECRET}" ]]; then
  secrets="${secrets},PLAID_SECRET=${_PLAID_SECRET_SECRET}:latest"
fi
if [[ -n "${_PLAID_ACCESS_TOKEN_KEY_SECRET}" ]]; then
  secrets="${secrets},PLAID_ACCESS_TOKEN_KEY=${_PLAID_ACCESS_TOKEN_KEY_SECRET}:latest"
fi
append_optional_secret "${_FINNHUB_API_KEY_SECRET}" "FINNHUB_API_KEY"
append_optional_secret "${_PMP_API_KEY_SECRET}" "PMP_API_KEY"
append_optional_secret "${_NEWSAPI_KEY_SECRET}" "NEWSAPI_KEY"
append_optional_secret "${_GMAIL_OAUTH_CLIENT_ID_SECRET}" "GMAIL_OAUTH_CLIENT_ID"
append_optional_secret "${_GMAIL_OAUTH_CLIENT_SECRET_SECRET}" "GMAIL_OAUTH_CLIENT_SECRET"
append_optional_secret "${_GMAIL_OAUTH_REDIRECT_URI_SECRET}" "GMAIL_OAUTH_REDIRECT_URI"
append_optional_secret "${_GMAIL_OAUTH_TOKEN_KEY_SECRET}" "GMAIL_OAUTH_TOKEN_KEY"
append_optional_secret "${_OPENAI_API_KEY_SECRET}" "OPENAI_API_KEY"
append_optional_secret "${_GOOGLE_MAPS_API_KEY_SECRET}" "GOOGLE_MAPS_API_KEY"
# Literal secret names, not substitutions -- these two are named identically in
# Secret Manager and in the runtime, so main wires them without a substitution.
append_optional_secret ADVISORS_API_KEY ADVISORS_API_KEY
append_optional_secret INSURANCE_AGENTS_API_KEY INSURANCE_AGENTS_API_KEY
append_optional_secret "${_VOICE_RUNTIME_CONFIG_JSON_SECRET}" "VOICE_RUNTIME_CONFIG_JSON"
append_optional_secret "${_OMNIGATEWAY_CLIENT_ID_SECRET}" "OMNIGATEWAY_CLIENT_ID"
append_optional_secret "${_OMNIGATEWAY_CLIENT_SECRET_SECRET}" "OMNIGATEWAY_CLIENT_SECRET"
append_optional_secret "${_HUSHH_DEVELOPER_TOKEN_SECRET}" "HUSHH_DEVELOPER_TOKEN"
append_optional_secret "${_HUSHH_UAT_PHONE_TEST_NUMBERS_SECRET}" "HUSHH_UAT_PHONE_TEST_NUMBERS"
append_optional_secret "${_HUSHH_UAT_PHONE_TEST_CODE_SECRET}" "HUSHH_UAT_PHONE_TEST_CODE"
append_optional_secret "${_HUSHH_UAT_PHONE_TEST_CHALLENGE_SECRET_SECRET}" "HUSHH_UAT_PHONE_TEST_CHALLENGE_SECRET"
append_optional_secret "${_HUSHH_PROD_PHONE_TEST_NUMBERS_SECRET}" "HUSHH_PROD_PHONE_TEST_NUMBERS"
append_optional_secret "${_HUSHH_PROD_PHONE_TEST_CODE_SECRET}" "HUSHH_PROD_PHONE_TEST_CODE"
append_optional_secret "${_HUSHH_PROD_PHONE_TEST_CHALLENGE_SECRET_SECRET}" "HUSHH_PROD_PHONE_TEST_CHALLENGE_SECRET"
append_optional_secret "${_REVIEWER_UID_SECRET}" "REVIEWER_UID"
append_optional_secret "${_REVIEWER_VAULT_PASSPHRASE_SECRET}" "REVIEWER_VAULT_PASSPHRASE"
append_optional_secret "${_RIA_INTELLIGENCE_VERIFY_BASE_URL_SECRET}" "RIA_INTELLIGENCE_VERIFY_BASE_URL"
append_optional_secret "${_RIA_IDENTITY_BASE_URL_SECRET}" "RIA_IDENTITY_BASE_URL"
append_optional_secret "${_RIA_IDENTITY_API_KEY_SECRET}" "RIA_IDENTITY_API_KEY"
append_optional_secret "${_RIA_CLAIM_TEST_NUMBERS_SECRET}" "RIA_CLAIM_TEST_NUMBERS"
append_optional_secret "${_RIA_CLAIM_TEST_CODE_SECRET}" "RIA_CLAIM_TEST_CODE"
append_optional_secret "${_ONE_EMAIL_WATCH_RENEW_TOKEN_SECRET}" "ONE_EMAIL_WATCH_RENEW_TOKEN"
append_optional_secret "${_WALLET_PASS_CERT_PEM_SECRET}" "WALLET_PASS_CERT_PEM"
append_optional_secret "${_WALLET_PASS_KEY_PEM_SECRET}" "WALLET_PASS_KEY_PEM"
append_optional_secret "${_WALLET_PASS_WWDR_PEM_SECRET}" "WALLET_PASS_WWDR_PEM"
append_optional_secret "${_WALLET_API_KEY_SECRET}" "WALLET_API_KEY"

# Runtime identity may differ from deploy identity: the dev environment
# deploys with _DEPLOY_ENV=dev (labels, provenance) but runs with
# ENVIRONMENT=uat so behavior gates replicate UAT exactly.
runtime_environment="${_RUNTIME_ENVIRONMENT}"
if [[ -z "${runtime_environment}" ]]; then
  runtime_environment="${_DEPLOY_ENV}"
fi

require_non_negative_int() {
  local name="$1"
  local value="$2"
  if ! [[ "${value}" =~ ^[0-9]+$ ]]; then
    echo "${name} must be a non-negative integer, got '${value}'." >&2
    exit 1
  fi
}
require_positive_int() {
  local name="$1"
  local value="$2"
  require_non_negative_int "${name}" "${value}"
  if [[ "${value}" -lt 1 ]]; then
    echo "${name} must be at least 1, got '${value}'." >&2
    exit 1
  fi
}
require_non_negative_int "_DB_POOL_MIN_SIZE" "${_DB_POOL_MIN_SIZE}"
require_positive_int "_DB_POOL_MAX_SIZE" "${_DB_POOL_MAX_SIZE}"
require_positive_int "_DB_SQLALCHEMY_POOL_SIZE" "${_DB_SQLALCHEMY_POOL_SIZE}"
require_non_negative_int "_DB_SQLALCHEMY_MAX_OVERFLOW" "${_DB_SQLALCHEMY_MAX_OVERFLOW}"
require_non_negative_int "_CLOUD_RUN_MIN_INSTANCES" "${_CLOUD_RUN_MIN_INSTANCES}"
require_positive_int "_CLOUD_RUN_MAX_INSTANCES" "${_CLOUD_RUN_MAX_INSTANCES}"
if [[ "${_DB_POOL_MAX_SIZE}" -lt "${_DB_POOL_MIN_SIZE}" ]]; then
  echo "_DB_POOL_MAX_SIZE must be greater than or equal to _DB_POOL_MIN_SIZE." >&2
  exit 1
fi
if [[ "${_CLOUD_RUN_MAX_INSTANCES}" -lt "${_CLOUD_RUN_MIN_INSTANCES}" ]]; then
  echo "_CLOUD_RUN_MAX_INSTANCES must be greater than or equal to _CLOUD_RUN_MIN_INSTANCES." >&2
  exit 1
fi

env_vars=(
  "ENVIRONMENT=${runtime_environment}"
  "HUSHH_DEPLOY_ENV=${_DEPLOY_ENV}"
  "HUSHH_DEPLOY_SOURCE=${_DEPLOY_SOURCE}"
  "HUSHH_DEPLOY_SHA=${_DEPLOY_SHA}"
  "HUSHH_DEPLOY_RUN_ID=${_GITHUB_RUN_ID}"
  "HUSHH_GENAI_AUTH_MODE=vertex_adc"
  "GOOGLE_GENAI_USE_VERTEXAI=true"
  "GOOGLE_CLOUD_PROJECT=${genai_project_id}"
  "GOOGLE_CLOUD_LOCATION=global"
  "HUSHH_VERTEX_LOCATIONS=global,us,eu"
  "CONSENT_API_PUBLIC_ORIGIN=${_CONSENT_API_PUBLIC_ORIGIN}"
  "DB_POOL_MIN_SIZE=${_DB_POOL_MIN_SIZE}"
  "DB_POOL_MAX_SIZE=${_DB_POOL_MAX_SIZE}"
  "DB_SQLALCHEMY_POOL_SIZE=${_DB_SQLALCHEMY_POOL_SIZE}"
  "DB_SQLALCHEMY_MAX_OVERFLOW=${_DB_SQLALCHEMY_MAX_OVERFLOW}"
  "RIA_INTELLIGENCE_CRD_SCRAPER_TIMEOUT_SECONDS=${_RIA_INTELLIGENCE_CRD_SCRAPER_TIMEOUT_SECONDS}"
  "RIA_ONBOARDING_PROVIDER_TIMEOUT_SECONDS=${_RIA_ONBOARDING_PROVIDER_TIMEOUT_SECONDS}"
)
append_optional_env() {
  local env_name="$1"
  local env_value="$2"
  if [[ -n "${env_value}" ]]; then
    env_vars+=("${env_name}=${env_value}")
  fi
}
append_optional_env "ONE_EMAIL_ADDRESS" "${_ONE_EMAIL_ADDRESS}"
append_optional_env "ONE_EMAIL_DELEGATED_USER" "${_ONE_EMAIL_DELEGATED_USER}"
append_optional_env "ONE_EMAIL_PUBSUB_TOPIC" "${_ONE_EMAIL_PUBSUB_TOPIC}"
append_optional_env "ONE_EMAIL_WEBHOOK_AUDIENCE" "${_ONE_EMAIL_WEBHOOK_AUDIENCE}"
append_optional_env "ONE_EMAIL_WEBHOOK_SERVICE_ACCOUNT_EMAIL" "${_ONE_EMAIL_WEBHOOK_SERVICE_ACCOUNT_EMAIL}"
append_optional_env "ONE_EMAIL_WEBHOOK_AUTH_ENABLED" "${_ONE_EMAIL_WEBHOOK_AUTH_ENABLED}"
append_optional_env "ONE_EMAIL_WATCH_RENEW_AUTH_ENABLED" "${_ONE_EMAIL_WATCH_RENEW_AUTH_ENABLED}"
append_optional_env "ONE_EMAIL_KYC_DEFAULT_SCOPE" "${_ONE_EMAIL_KYC_DEFAULT_SCOPE}"
append_optional_env "ONE_EMAIL_KYC_STRICT_CLIENT_ZK_ENABLED" "${_ONE_EMAIL_KYC_STRICT_CLIENT_ZK_ENABLED}"
append_optional_env "ONE_WALLET_CARD_ENABLED" "${_ONE_WALLET_CARD_ENABLED}"
append_optional_env "WALLET_PASS_PROVIDER" "${_WALLET_PASS_PROVIDER}"
append_optional_env "APP_REVIEW_MODE" "${_APP_REVIEW_MODE}"
append_optional_env "HUSHH_PROD_PHONE_TEST_ENABLED" "${_HUSHH_PROD_PHONE_TEST_ENABLED}"
append_optional_env "KAI_ANALYZE_DURABLE_RUN_STORE" "${_KAI_ANALYZE_DURABLE_RUN_STORE}"

# Slim pod image reference, dev only. GcpBackend reads HUSSH_ONE_POD_IMAGE
# (gcp_backend.py) and until now it resolved to empty in every environment,
# so a real provision call had no image to deploy. The URI is recomputed
# rather than passed between steps because Cloud Build steps are separate
# containers with no shared shell state; it is deterministic from the same
# two inputs the build step used, and the conditions are repeated verbatim so
# the env var can never point at an image this build did not push.
pod_image=""
if [[ "${_DEPLOY_ENV}" == "dev" && "${_BUILD_POD_IMAGE}" == "true" ]]; then
  pod_image="gcr.io/$PROJECT_ID/consent-protocol-pod:${_IMAGE_TAG}"
fi
append_optional_env "HUSSH_ONE_POD_IMAGE" "${pod_image}"
# The pod's own runtime identity. Created in hushh-pda-dev holding NO project
# roles: without it Cloud Run would run each pod as the default compute account,
# which carries project Editor. Empty outside dev, so append_optional_env skips it.
pod_sa=""
if [[ "${_DEPLOY_ENV}" == "dev" ]]; then
  pod_sa="hussh-one-pod@${PROJECT_ID}.iam.gserviceaccount.com"
fi
append_optional_env "HUSSH_ONE_POD_SERVICE_ACCOUNT" "${pod_sa}"

# The pod -> hub data path (docs/future/personal-agent/POD-HUB-DATA-PATH.md).
# A pod holds no Postgres credential, so it reads the data plane through the
# hub; render_deploy_config passes HUSSH_HUB_BASE_URL down to every pod it
# renders, which means the HUB has to know its own origin. The URL is derived
# rather than hardcoded, using the same stable
# https://{service}-{project_number}.{region}.run.app form deploy-dev.yml
# already uses for DEV_ONE_EMAIL_WEBHOOK_AUDIENCE.
#
# POD_HUB_IDENTITY_AUTH_ENABLED lets the hub accept a pod's Google ID token on
# the internal prompt route. It is DEV-ONLY and must stay that way: every pod
# shares one service account, so the token proves "a hussh pod", not WHICH
# user's pod, and the agent id comes from the pod's own assertion. Dev carries
# synthetic users only. Enabling it anywhere holding real users' holdings would
# let one compromised pod read another user's prompt -- that needs per-pod
# identity from the attested tier (M5) first.
hub_url=""
pod_identity_auth=""
pod_allowed_sa=""
if [[ "${_DEPLOY_ENV}" == "dev" ]]; then
  # Ask Cloud Run for the hub's OWN url rather than reconstructing it. A
  # service's url is stable across revisions, so reading it before this
  # deploy yields the same address the new revision will serve on.
  #
  # An earlier version built this url from the PROJECT_NUMBER built-in
  # substitution, and that dev deploy failed inside `gcloud builds submit`
  # in ~5s with no Cloud Build ever created -- i.e. it was rejected before
  # submission. The exact gcloud error was not recoverable from the run
  # logs, so $PROJECT_NUMBER is the SUSPECT (it was the only substitution
  # introduced) rather than a confirmed cause; the Cloud Build REST API
  # accepts it, which narrows it to gcloud's client-side validation if it
  # is the cause at all. Reading status.url sidesteps the question
  # entirely: it needs no substitution, uses only gcloud (which this step
  # already depends on), and returns the real url instead of an assumed shape.
  hub_url="$(gcloud run services describe "${_BACKEND_SERVICE}" \
    --region="${_REGION}" --format='value(status.url)' 2>/dev/null || true)"
  pod_identity_auth="true"
  pod_allowed_sa="hussh-one-pod@${PROJECT_ID}.iam.gserviceaccount.com"
fi
append_optional_env "HUSSH_HUB_BASE_URL" "${hub_url}"
append_optional_env "POD_HUB_IDENTITY_AUTH_ENABLED" "${pod_identity_auth}"
append_optional_env "POD_HUB_ALLOWED_SERVICE_ACCOUNT" "${pod_allowed_sa}"
# POD_HUB_EXPECTED_AUDIENCE is deliberately NOT set here. runtime_settings falls
# back to HUSSH_HUB_BASE_URL above -- the same variable, normalised the same way,
# that a pod uses to mint its audience. A second copy of one address is a silent
# divergence: change the hub URL, forget the audience, and every pod->hub call
# 401s with nothing in either log saying why.

# The personal-agent (per-user pod) env block. DEV ONLY.
#
# Before this, `grep PERSONAL_AGENT deploy/ scripts/deploy/` returned nothing: the
# flags existed in runtime_settings and defaulted OFF, so the whole provisioning
# path was unreachable in every environment. A validated AI key left the registry
# row at `pending` and no code, log line or alert said so.
#
# Each flag is separately revocable, and each is off outside dev by construction
# (empty => append_optional_env skips it => runtime_settings default applies).
personal_agent_enabled=""
personal_agent_backend=""
personal_agent_autoprovision=""
gcp_backend_live=""
pod_signing_key_secret=""
pod_invoker_member=""
pod_turn_enabled=""
dev_simulation_enabled=""
dev_phone_test_numbers=""
if [[ "${_DEPLOY_ENV}" == "dev" ]]; then
  # The simulation opt-in. hussh-managed pods are the SIMULATION tier under
  # docs/reference/architecture/private-agent-north-star.md, so GcpBackend now
  # calls require_simulation_permitted() before any live create and REFUSES when
  # this is unset. It is a second, independent switch on top of the deploy lane
  # precisely so a container that lost its lane cannot infer permission -- the
  # guard denies on absence rather than defaulting to "development".
  #
  # Without this line the dev pod path stops working entirely, which is the whole
  # reason it is set here in the same change that added the guard.
  dev_simulation_enabled="true"
  # The simulation phone allowlist, pinned in git rather than held as a secret:
  # these are reserved fictitious numbers (+1 555 0100-0199), they identify no
  # one, and an auditable allowlist is worth more than a hidden one. The backend
  # REFUSES any entry outside that block, so this cannot quietly grow to include
  # a real person.
  #
  # The CODE is deliberately NOT set here. Until an operator supplies
  # HUSHH_DEV_PHONE_TEST_CODE the lane is dark, because _phone_test_enabled()
  # needs both. Numbers without a code is the correct fail-closed default.
  dev_phone_test_numbers="+15550100,+15550101,+15550102,+15550103,+15550104"
  personal_agent_enabled="true"
  personal_agent_backend="gcp"
  # Creating a pod is a BILLABLE act, which is why this is a separate switch from
  # the feature flag: turning the surface on and turning on automatic compute
  # creation are different decisions and stay separately revocable.
  personal_agent_autoprovision="true"
  # Without this GcpBackend stays in plan mode -- it returns a rendered config and
  # never calls Cloud Run, which reads as success at every layer above it.
  gcp_backend_live="true"
  # A pod-ONLY signing key. Never the hub's: with HMAC the ability to verify is the
  # ability to forge, so the hub's key in every pod would make each pod a universal
  # forger of consent, grants and audit entries. See gcp_backend.py for the full note.
  pod_signing_key_secret="HUSSH_POD_DEV_SIGNING_KEY"
  # Who may invoke a pod. `set_invoker_binding` reads this; unset, it logs and skips,
  # and the pod is invokable by nobody -- the key pull returns None and the registry
  # row parks in `connecting` forever. The hub's own runtime identity is the only
  # caller: pods are `internal` ingress with no allUsers binding, and non-
  # targetability is the property that makes a zero-role pod uninteresting to reach.
  # Guarded: an empty substitution would render the literal "serviceAccount:",
  # which is non-empty enough to be SET and malformed enough to make every
  # setIamPolicy call fail at provision time -- the one path nobody exercises
  # locally. Unset is the honest state; the client logs and skips.
  if [[ -n "${_RUNTIME_SERVICE_ACCOUNT}" ]]; then
    pod_invoker_member="serviceAccount:${_RUNTIME_SERVICE_ACCOUNT}"
  fi
  # The pod actually runs Agent One. Off => POST /api/one/pod/turn 404s.
  pod_turn_enabled="true"
fi
append_optional_env "PERSONAL_AGENT_ENABLED" "${personal_agent_enabled}"
append_optional_env "PERSONAL_AGENT_BACKEND" "${personal_agent_backend}"
append_optional_env "PERSONAL_AGENT_AUTOPROVISION_ENABLED" "${personal_agent_autoprovision}"
append_optional_env "HUSSH_GCP_BACKEND_LIVE" "${gcp_backend_live}"
append_optional_env "HUSSH_POD_SIGNING_KEY_SECRET" "${pod_signing_key_secret}"
append_optional_env "HUSSH_POD_INVOKER_MEMBER" "${pod_invoker_member}"
append_optional_env "HUSSH_POD_TURN_ENABLED" "${pod_turn_enabled}"
append_optional_env "HUSHH_DEV_SIMULATION_ENABLED" "${dev_simulation_enabled}"
append_optional_env "HUSHH_DEV_PHONE_TEST_NUMBERS" "${dev_phone_test_numbers}"

# Join with '|' (not ',') so env VALUES may themselves contain commas.
# Paired with gcloud's alternate-delimiter syntax on --set-env-vars below.
env_var_string="$(IFS='|'; echo "${env_vars[*]}")"
deploy_labels="managed-by=hushh-github-actions,deploy-env=${_DEPLOY_ENV},deploy-source=${_DEPLOY_SOURCE},deploy-sha=${_DEPLOY_SHA},github-run-id=${_GITHUB_RUN_ID}"

# Timeout 3600s: WebSocket voice sessions (/api/one/adk/live) are
# long-lived HTTP requests on Cloud Run; the previous 300s hard-killed
# any voice conversation at 5 minutes. Session affinity is best-effort
# per Google's WebSocket guidance; reconnects still re-mint a relay
# ticket, and cross-instance nonce single-use is Postgres-backed
# (migration 084). Billing note: instances with open WebSockets stay
# active for the connection's lifetime.
cmd=(
  gcloud run deploy "${_BACKEND_SERVICE}"
  "--image=gcr.io/$PROJECT_ID/consent-protocol:${_IMAGE_TAG}"
  "--region=${_REGION}"
  "--platform=managed"
  "--service-account=${_RUNTIME_SERVICE_ACCOUNT}"
  "--allow-unauthenticated"
  "--port=8080"
  "--memory=1Gi"
  "--cpu=1"
  "--timeout=3600"
  "--session-affinity"
  # Service-level limits bound aggregate database fan-out across traffic
  # splits. Revision min=0 prevents no-traffic/retired revisions from
  # pinning their own warm database pools.
  "--max=${_CLOUD_RUN_MAX_INSTANCES}"
  "--min=${_CLOUD_RUN_MIN_INSTANCES}"
  "--max-instances=${_CLOUD_RUN_MAX_INSTANCES}"
  "--min-instances=0"
  "--labels=${deploy_labels}"
  # An EXPLICIT HTTP startup probe, on every lane.
  #
  # Cloud Run's default startup probe is a TCP connect, and gunicorn's master
  # binds :8080 before forking. A revision whose workers die on import therefore
  # passes the probe and is reported Ready + ContainerHealthy while returning 503
  # to every request -- observed on a hub revision in hushh-pda-dev on 2026-08-04,
  # and previously on a pod, which is why render_deploy_config already sets one.
  # Anything reading the Ready condition (deploy gates, uptime checks, the
  # reconcile loop) inherits that lie, so the probe is fixed at the source.
  #
  # 10s x 24 = 240s, which is the same window Cloud Run already allowed for the
  # default probe -- so a revision that starts as fast as it does today cannot
  # newly fail a deploy. What changes is that "started" now means "served /health"
  # rather than "opened a socket".
  "--startup-probe=httpGet.path=/health,periodSeconds=10,failureThreshold=24,timeoutSeconds=5"
  "--set-env-vars=^|^${env_var_string}"
  "--set-secrets=${secrets}"
)

# CPU allocated outside requests, DEV ONLY. Correctness, not performance.
#
# The hub runs work that outlives the response that started it: personal-agent
# provisioning is `loop.create_task` around a `wait_ready` poll that can run 150s
# after the HTTP response has been returned. Cloud Run's default throttles an
# instance's CPU to near zero the moment no request is in flight, so that task
# does not merely run slowly -- it makes almost no progress, the registry row
# strands at `provisioning`, and nothing reports a fault.
#
# Scoped to dev because this switches Cloud Run from request-based to
# instance-based billing, which is a cost decision on the shared uat/prod lanes
# and needs founder sign-off rather than a silent default.
#
# WORTH KNOWING: the same exposure already applies in uat and prod to the consent
# NOTIFY->FCM listener, the Gmail watch-renewal loop and the revocation sweep --
# all of them background loops on a throttled instance. This flag is the fix for
# that class; it is being taken here only where the cost is trivial.
if [[ "${_DEPLOY_ENV}" == "dev" ]]; then
  cmd+=("--no-cpu-throttling")
fi

if [[ "${_CLOUD_RUN_NO_TRAFFIC}" == "true" ]]; then
  cmd+=("--no-traffic")
fi

if [[ -n "${_CLOUDSQL_INSTANCES}" ]]; then
  cmd+=("--add-cloudsql-instances=${_CLOUDSQL_INSTANCES}")
fi

"${cmd[@]}"
