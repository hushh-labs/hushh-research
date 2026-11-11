#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
#
# One-time owner setup for the pre-merge readiness exam's probe-only identity.
# Run once per managed Azure account (also for a standby account before a switch):
#
#   deploy/iam/setup_readiness_exam_identity.sh <account name from managed_azure_accounts>
#
# Requires `az login` as an admin of the account's Entra tenant and the resource,
# and `gh auth login` as a repository admin. Idempotent. It proves the identity is
# probe-only BEFORE granting anything, then proves the exact result and rolls back
# the credential and role this run granted if that proof fails. It creates no secret: GitHub OIDC
# tokens are exchanged for Entra tokens.

set -euo pipefail

readonly REPOSITORY="hushh-labs/hushh-research"
readonly ENVIRONMENT="readiness-exam"
readonly SUBJECT="repo:${REPOSITORY}:environment:${ENVIRONMENT}"
readonly ISSUER="https://token.actions.githubusercontent.com"
readonly AUDIENCE="api://AzureADTokenExchange"
readonly ROLE="Cognitive Services OpenAI User"
readonly CREDENTIAL_NAME="github-readiness-exam"
readonly CONFIG="consent-protocol/config/managed-ai-runtime.json"
readonly EXACT_CREDENTIAL="[?name=='$CREDENTIAL_NAME' && issuer=='$ISSUER' && subject=='$SUBJECT' && length(audiences) == \`1\` && audiences[0]=='$AUDIENCE']"

account_name="${1:?usage: $0 <managed Azure account name>}"
cd "$(git rev-parse --show-toplevel)"

read -r tenant_id runtime_client_id resource_name < <(python3 - "$CONFIG" "$account_name" <<'PY'
import json, sys
from urllib.parse import urlsplit
accounts = json.load(open(sys.argv[1]))["managed_azure_accounts"]["accounts"]
account = accounts[sys.argv[2]]
host = urlsplit(account["primary_endpoint"]).hostname
print(account["tenant_id"], account["client_id"], host.split(".")[0])
PY
)

fail() { echo "Readiness exam identity setup refused: $*" >&2; exit 1; }
[[ "$(az account show --query tenantId -o tsv)" == "$tenant_id" ]] \
  || fail "sign in to the account's tenant first: az login --tenant $tenant_id"
admin_id="$(az ad signed-in-user show --query id -o tsv)"

echo "1. GitHub environment $ENVIRONMENT: main only, no secrets"
gh api -X PUT "repos/$REPOSITORY/environments/$ENVIRONMENT" --input - >/dev/null <<'JSON'
{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
JSON
if ! gh api "repos/$REPOSITORY/environments/$ENVIRONMENT/deployment-branch-policies" \
  --jq '.branch_policies[] | select(.type == "branch") | .name' | grep -qx main; then
  gh api -X POST "repos/$REPOSITORY/environments/$ENVIRONMENT/deployment-branch-policies" \
    -f name=main -f type=branch >/dev/null
fi
policies="$(gh api "repos/$REPOSITORY/environments/$ENVIRONMENT/deployment-branch-policies" \
  --jq '[.branch_policies[] | "\(.type):\(.name)"] | sort | join(",")')"
[[ "$policies" == "branch:main" ]] || fail "environment $ENVIRONMENT must admit exactly main; found: $policies"

echo "2. Azure OpenAI resource $resource_name"
resource_id="$(az cognitiveservices account list \
  --query "[?properties.customSubDomainName=='$resource_name'].id | [0]" -o tsv)"
[[ -n "$resource_id" ]] || fail "Azure OpenAI resource $resource_name was not found in this subscription"
# The id names the account and its group; the endpoint's subdomain may differ.
resource_group="$(cut -d/ -f5 <<<"$resource_id")"
resource_account="$(cut -d/ -f9 <<<"$resource_id")"
[[ -n "$resource_group" && -n "$resource_account" ]] \
  || fail "could not read the resource group and name from $resource_id"

display_name="hussh-readiness-exam-probe-${account_name}"
echo "3. Probe-only Entra app $display_name"
matches="$(az ad app list --filter "displayName eq '$display_name'" --query 'length(@)' -o tsv)"
[[ "$matches" == "0" || "$matches" == "1" ]] || fail "more than one app is named $display_name"
app_id="$(az ad app list --filter "displayName eq '$display_name'" --query '[0].appId' -o tsv)"
if [[ -z "$app_id" ]]; then
  app_id="$(az ad app create --display-name "$display_name" \
    --sign-in-audience AzureADMyOrg --query appId -o tsv)"
fi
[[ "$app_id" != "$runtime_client_id" ]] || fail "the probe app must never be the runtime app"
sp_id="$(az ad sp list --filter "appId eq '$app_id'" --query '[0].id' -o tsv)"
if [[ -z "$sp_id" ]]; then
  sp_id="$(az ad sp create --id "$app_id" --query id -o tsv)"
fi

echo "4. Prove the identity is probe-only before granting anything"
# Every read is a plain assignment, so a failed lookup stops the script instead of
# reading as "nothing found" (bash ignores errexit inside for lists and [[ ]]).
count_of() {
  local value
  value="$("$@")" || fail "could not read: ${*:1:4}"
  [[ "$value" =~ ^[0-9]+$ ]] || fail "could not read a count: ${*:1:4}"
  printf '%s\n' "$value"
}
graph_count() {
  count_of az rest --method GET --url "https://graph.microsoft.com/v1.0/servicePrincipals/$sp_id/$1" \
    --query 'length(value)' -o tsv
}
all_roles() {
  local total=0 count subscription subscriptions
  subscriptions="$(az account list --query '[].id' -o tsv)" || fail "could not list subscriptions"
  [[ -n "$subscriptions" ]] || fail "no subscription is visible to this admin"
  for subscription in $subscriptions; do
    count="$(count_of az role assignment list --subscription "$subscription" \
      --assignee-object-id "$sp_id" --all --include-groups --query 'length(@)' -o tsv)" || return 1
    total=$((total + count))
  done
  printf '%s\n' "$total"
}
exact_role() {
  count_of az role assignment list --assignee-object-id "$sp_id" --scope "$resource_id" --role "$ROLE" \
    --query "length([?scope=='$resource_id'])" -o tsv
}
# Nobody but this admin may own the app or its principal, or they could add a
# secret or another trusted subject later. A reused app must already be exact.
app_owners="$(az ad app owner list --id "$app_id" --query '[].id' -o tsv)"
sp_owners="$(az ad sp owner list --id "$sp_id" --query '[].id' -o tsv)"
while read -r owner; do
  [[ -z "$owner" || "$owner" == "$admin_id" ]] || fail "the app or its principal has another owner ($owner)"
done <<<"$app_owners"$'\n'"$sp_owners"
app_extras="$(count_of az ad app show --id "$app_id" \
  --query 'sum([length(passwordCredentials), length(keyCredentials), length(requiredResourceAccess)])' -o tsv)"
(( app_extras == 0 )) || fail "the app must hold no secret, certificate or requested API permission"
sp_extras="$(count_of az ad sp show --id "$sp_id" \
  --query 'sum([length(passwordCredentials), length(keyCredentials)])' -o tsv)"
(( sp_extras == 0 )) || fail "the service principal must hold no secret or certificate"
granted="$(graph_count appRoleAssignments)"
delegated="$(graph_count oauth2PermissionGrants)"
memberships="$(graph_count transitiveMemberOf)"
(( granted + delegated + memberships == 0 )) \
  || fail "the principal holds a granted permission or a group or directory role membership"
existing_credentials="$(count_of az ad app federated-credential list --id "$app_id" --query 'length(@)' -o tsv)"
exact_credentials="$(count_of az ad app federated-credential list --id "$app_id" --query "length($EXACT_CREDENTIAL)" -o tsv)"
(( existing_credentials == 0 || (existing_credentials == 1 && exact_credentials == 1) )) \
  || fail "the app already trusts another subject"
existing_roles="$(all_roles)"
exact_roles="$(exact_role)"
(( existing_roles == 0 || (existing_roles == 1 && exact_roles == 1) )) \
  || fail "the principal already holds another role assignment, in any subscription or through a group"

echo "5. Trust $SUBJECT and grant $ROLE on $resource_name only (inference; no keys)"
created_credential="" created_role=""
rollback() {
  local incomplete=""
  if [[ -n "$created_role" ]] && ! az role assignment delete --ids "$created_role" >/dev/null; then
    incomplete+=" role:$created_role"
  fi
  if [[ -n "$created_credential" ]] \
    && ! az ad app federated-credential delete --id "$app_id" --federated-credential-id "$CREDENTIAL_NAME" >/dev/null; then
    incomplete+=" credential:$CREDENTIAL_NAME"
  fi
  if [[ -n "$incomplete" ]]; then
    echo "Rollback incomplete; still granted:$incomplete. Remove it by hand before retrying." >&2
    exit 3
  fi
}
if (( existing_credentials == 0 )); then
  az ad app federated-credential create --id "$app_id" --parameters "$(cat <<JSON
{"name": "$CREDENTIAL_NAME", "issuer": "$ISSUER", "subject": "$SUBJECT", "audiences": ["$AUDIENCE"]}
JSON
)" >/dev/null
  created_credential=1
fi
if (( existing_roles == 0 )); then
  created_role="$(az role assignment create --assignee-object-id "$sp_id" \
    --assignee-principal-type ServicePrincipal --role "$ROLE" --scope "$resource_id" --query id -o tsv)" \
    || { rollback; fail "the role assignment could not be created"; }
fi

echo "6. Prove the exact result"
final_credentials="$(count_of az ad app federated-credential list --id "$app_id" --query 'length(@)' -o tsv)" \
  || { rollback; fail "could not read the trusted subjects back"; }
final_exact="$(count_of az ad app federated-credential list --id "$app_id" --query "length($EXACT_CREDENTIAL)" -o tsv)" \
  || { rollback; fail "could not read the trusted subject back"; }
(( final_credentials == 1 && final_exact == 1 )) || { rollback; fail "expected exactly one trusted subject, $SUBJECT"; }
final_roles="$(all_roles)" || { rollback; fail "could not read the role assignments back"; }
final_exact_role="$(exact_role)" || { rollback; fail "could not read the role assignment back"; }
(( final_roles == 1 && final_exact_role == 1 )) \
  || { rollback; fail "expected exactly one role assignment, $ROLE on $resource_name"; }

echo "7. Network: GitHub-hosted runners must reach the resource"
az cognitiveservices account show --name "$resource_account" --resource-group "$resource_group" \
  --query '{publicNetworkAccess:properties.publicNetworkAccess, defaultAction:properties.networkAcls.defaultAction, disableLocalAuth:properties.disableLocalAuth}' -o json

echo
echo "Probe-only identity ready: $app_id. Next, in order:"
echo "  1. Set managed_azure_accounts.accounts.${account_name}.readiness_exam_client_id to $app_id"
echo "     in $CONFIG, commit it and merge it to main."
echo "  2. python3 scripts/ci/verify-deployment-environment-governance.py --surface readiness-exam"
echo "  3. Run the exam's controls from main (.agents/skills/repo-operations/references/managed-provider-readiness.md)."
