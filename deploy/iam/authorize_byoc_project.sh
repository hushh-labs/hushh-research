#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
#
# Authorize hushh to build a private agent pod INSIDE YOUR OWN GCP PROJECT.
#
# You run this. hushh does not, and cannot -- every command below acts on a project
# only you administer. When it finishes, hushh can create your pod's infrastructure
# and nothing else, using a token that expires in 900 seconds and is minted fresh
# every time.
#
# WHAT THIS DELIBERATELY DOES NOT DO
#
# It never creates a service-account key, and you should never send hushh one. A JSON
# key is a bearer credential with no expiry: whoever holds it is you, until someone
# remembers to revoke it. The whole BYOC design exists to avoid that -- `mint_bootstrap_token`
# in `consent-protocol/hushh_mcp/services/user_gcp_bootstrap.py` has no fallback to a
# stored credential, on purpose. Handing over a key would not be a shortcut to this
# design; it would be the thing this design refuses.
#
# WHAT YOU ARE ACTUALLY GRANTING
#
# One permission: `roles/iam.serviceAccountTokenCreator`, held by ONE named hushh
# identity, on ONE service account in your project. That lets hushh ask Google for a
# short-lived token that acts as that account -- which itself holds only the nine roles
# listed below, and only inside your project.
#
# HOW TO TAKE IT BACK
#
#   gcloud iam service-accounts remove-iam-policy-binding \
#     "one-bootstrap@${PROJECT_ID}.iam.gserviceaccount.com" \
#     --project="${PROJECT_ID}" \
#     --role=roles/iam.serviceAccountTokenCreator \
#     --member="serviceAccount:${HUSHH_CALLER}"
#
# That command ends FUTURE access. Be precise about the window: a token already minted
# lives out its remaining 900 seconds, because Google does not revoke issued access
# tokens. So the honest guarantee is "no new authority, and at most 15 more minutes of
# the old" -- not "instantly nothing".
#
# Nothing else hushh holds survives it, because hushh holds nothing else: there is no
# key to also remember to delete. Your pod and everything it wrote stay yours and keep
# running.
#
# Usage:
#   PROJECT_ID=my-project HUSHH_CALLER=<the identity hushh gives you> \
#     bash deploy/iam/authorize_byoc_project.sh

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-}"
HUSHH_CALLER="${HUSHH_CALLER:-}"
BOOTSTRAP_SA_ID="${BOOTSTRAP_SA_ID:-one-bootstrap}"

if [[ -z "${PROJECT_ID}" ]]; then
  echo "PROJECT_ID is required -- the project YOU own, where your pod will run." >&2
  exit 1
fi

if [[ -z "${HUSHH_CALLER}" ]]; then
  echo "HUSHH_CALLER is required: the single hushh service account you are" >&2
  echo "authorizing, as a bare email. hushh tells you this value; it is not a" >&2
  echo "secret, and it is the only identity that will be able to act." >&2
  exit 1
fi

command -v gcloud >/dev/null 2>&1 || { echo "gcloud is required." >&2; exit 1; }
gcloud projects describe "${PROJECT_ID}" >/dev/null

readonly BOOTSTRAP_SA_EMAIL="${BOOTSTRAP_SA_ID}@${PROJECT_ID}.iam.gserviceaccount.com"

# Mirrors BOOTSTRAP_ROLES in user_gcp_bootstrap.py, in the same order and with the same
# reasons. Read the list honestly: these are ADMIN-class roles. During each 900-second
# window, the borrowed identity could read your bucket's objects (storage.admin) and your
# secret payloads (secretmanager.admin). An earlier version of this file claimed "none of
# them reads your data", which was false and is corrected here rather than quietly
# deleted -- a consent artifact that overstates its own safety is worse than no artifact.
#
# What actually protects you is not the role list. It is two things:
#   1. hushh holds no standing credential. Between windows there is nothing to use.
#   2. Your pod mints and wraps its OWN data-encryption key, and this bootstrap account
#      deliberately does NOT hold cloudkms.encrypter/decrypter on the key that seals it
#      (byoc_key_custody.py). So the bucket's contents are ciphertext hushh cannot read
#      even while holding storage.admin.
# That is a narrower claim than the one it replaces, and unlike it, it is true.
readonly -a BOOTSTRAP_ROLES=(
  "roles/serviceusage.serviceUsageAdmin"    # turn on the APIs the pod needs
  "roles/cloudkms.admin"                    # the per-user key that seals your history
  "roles/storage.admin"                     # the CMEK bucket the pod writes to
  "roles/iam.serviceAccountAdmin"           # the pod's own least-privilege identity
  "roles/run.admin"                         # the pod service itself
  "roles/pubsub.admin"                      # the mail doorbell topic + subscription
  "roles/cloudscheduler.admin"              # re-arm the Gmail watch before it expires
  "roles/resourcemanager.projectIamAdmin"   # bind the pod SA to exactly those resources
  "roles/secretmanager.admin"               # your pod's signing key, inside YOUR project
  "roles/artifactregistry.admin"            # YOUR OWN copy of the pod image; delete at teardown
)

# Mirrors REQUIRED_SERVICES. Enabling an API is idempotent and changes nothing else.
readonly -a REQUIRED_SERVICES=(
  
  "serviceusage.googleapis.com"
  "iam.googleapis.com"
  "iamcredentials.googleapis.com"
  "run.googleapis.com"
  "cloudkms.googleapis.com"
  "storage.googleapis.com"
  "pubsub.googleapis.com"
  "cloudscheduler.googleapis.com"
  "aiplatform.googleapis.com"
  "cloudresourcemanager.googleapis.com"
  "secretmanager.googleapis.com"
  "artifactregistry.googleapis.com"
)

echo "Authorizing hushh to build a pod in ${PROJECT_ID}"
echo "  bootstrap account : ${BOOTSTRAP_SA_EMAIL}"
echo "  hushh caller      : ${HUSHH_CALLER}"
echo

# 1. The account hushh will act AS. It lives in your project and you can delete it.
if ! gcloud iam service-accounts describe "${BOOTSTRAP_SA_EMAIL}" \
  --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${BOOTSTRAP_SA_ID}" \
    --project="${PROJECT_ID}" \
    --display-name="hussh Agent One bootstrap" \
    --description="Creates this project's private agent pod. Held by you; hushh only borrows it, 900 seconds at a time."
fi

# 2. The APIs. Seven of ten were off in a real empty project, which made this the
#    actual blocker people kept mistaking for "you need to create a project".
gcloud services enable "${REQUIRED_SERVICES[@]}" --project="${PROJECT_ID}"

# 3. What the bootstrap account may do, inside your project only.
for role in "${BOOTSTRAP_ROLES[@]}"; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --role="${role}" \
    --member="serviceAccount:${BOOTSTRAP_SA_EMAIL}" \
    --condition=None --quiet --format=none
done

# 4. THE grant. One permission, one hushh identity, one account. This is the whole of
#    hushh's access, and the revoke command in the header undoes exactly this line.
gcloud iam service-accounts add-iam-policy-binding "${BOOTSTRAP_SA_EMAIL}" \
  --project="${PROJECT_ID}" \
  --role="roles/iam.serviceAccountTokenCreator" \
  --member="serviceAccount:${HUSHH_CALLER}" \
  --quiet --format=none

# 5. Read it all back. Asking gcloud to bind a role is not evidence the role is bound,
#    and a half-authorized project fails three steps into provisioning with an error
#    that names none of this.
echo
echo "Verifying..."

missing_services="$(
  comm -23 \
    <(printf '%s\n' "${REQUIRED_SERVICES[@]}" | sort) \
    <(gcloud services list --enabled --project="${PROJECT_ID}" \
        --format='value(config.name)' | sort)
)"
if [[ -n "${missing_services}" ]]; then
  echo "These APIs did not enable:" >&2
  echo "${missing_services}" >&2
  exit 1
fi

project_policy="$(gcloud projects get-iam-policy "${PROJECT_ID}" --format=json)"
for role in "${BOOTSTRAP_ROLES[@]}"; do
  if ! echo "${project_policy}" | grep -q "\"${role}\""; then
    echo "Role ${role} is not bound in ${PROJECT_ID}." >&2
    exit 1
  fi
done

if ! gcloud iam service-accounts get-iam-policy "${BOOTSTRAP_SA_EMAIL}" \
  --project="${PROJECT_ID}" --format=json \
  | grep -q "serviceAccount:${HUSHH_CALLER}"; then
  echo "The token-creator grant for ${HUSHH_CALLER} did not land." >&2
  echo "Without it hushh cannot act, and provisioning stops at the substrate step." >&2
  exit 1
fi

# 6. No key exists. Asserted rather than assumed, because the failure mode this whole
#    file argues against is somebody creating one "just to make it work".
key_count="$(
  gcloud iam service-accounts keys list \
    --iam-account="${BOOTSTRAP_SA_EMAIL}" \
    --project="${PROJECT_ID}" \
    --managed-by=user \
    --format='value(name)' | wc -l | tr -d ' '
)"
if [[ "${key_count}" != "0" ]]; then
  echo "WARNING: ${key_count} user-managed key(s) exist on ${BOOTSTRAP_SA_EMAIL}." >&2
  echo "hushh does not need one and will never ask for one. A key is a credential" >&2
  echo "with no expiry; the grant above is a credential that lasts 900 seconds." >&2
  echo "Delete them:" >&2
  echo "  gcloud iam service-accounts keys list --iam-account=${BOOTSTRAP_SA_EMAIL} --managed-by=user" >&2
  echo "  gcloud iam service-accounts keys delete <KEY_ID> --iam-account=${BOOTSTRAP_SA_EMAIL}" >&2
  exit 1
fi

echo
echo "Done. ${PROJECT_ID} is authorized."
echo "  11 APIs enabled, 10 roles bound, 1 token-creator grant to ${HUSHH_CALLER}"
echo "  0 service-account keys exist, which is the point"
echo
echo "Tell hushh your project id. Revoke any time with the command at the top of this file."
