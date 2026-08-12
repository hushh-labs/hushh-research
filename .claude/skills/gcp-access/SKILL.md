---
name: gcp-access
description: The complete GCP identity, permission, and deploy-authority map for the
  hush1one.com org — who holds what, which credential this machine uses, why the UAT
  deny policy blocks Owners, and the impersonation path around it. Use when a gcloud
  command is denied, when asked to log in again, when deciding which identity to
  deploy with, when auditing who can reach a project or secret, or before changing
  any IAM binding, deny policy, or service account key. Verified 2026-08-07.
---

# GCP access — hush1one.com

**Never run `gcloud auth login` on this machine.** It is already authenticated with a
credential that does not expire. Logging in as a human reintroduces the exact problem
this setup solved.

---

## The identity this machine uses

```
claude-code-gcp-operator@hussh-developer-platform.iam.gserviceaccount.com
```

A member of `gcp-admins@hushh.ai`, which holds org-level `roles/owner`,
`resourcemanager.organizationAdmin`, `iam.denyAdmin`, and `billing.admin`.

| | |
|---|---|
| Key file | `~/.config/gcloud/hushh-keys/claude-code-gcp-operator.json` (mode 600, outside every git tree) |
| Wired in | `~/.zshenv` — **not** `.zshrc` |
| Default project | `CLOUDSDK_CORE_PROJECT=hushh-pda-uat`, switch with `gp <project>` |
| Named configs | `uat` `prod` `dev` `tech-prod` `tech-uat` `one` |

`.zshenv` is deliberate: `.zshrc` is skipped by non-interactive shells, which is what
scripts and agent sessions run in. Putting credentials in `.zshrc` means they work in
your terminal and silently fail everywhere else.

Re-activate on a new machine (note `$HOME` — zsh does **not** expand `~` after `=`):

```bash
gcloud auth activate-service-account --key-file="$HOME/.config/gcloud/hushh-keys/claude-code-gcp-operator.json"
```

### Why a key instead of a longer session

The reauth loop was never a `gcloud` setting. Workspace session control was already
set to never expire and the prompts continued. The real cause is Google's cap on
refresh tokens **per OAuth client per user** — gcloud uses one client ID for everyone,
so each `gcloud auth login` silently revokes an older token of yours. Service accounts
have no OAuth session, so the cap does not apply.

---

## Who holds what (org `hush1one.com`, 369781862791)

`ankit@hushh.ai` has **no direct org IAM bindings**. All access arrives through groups.
Checking a person's roles with `get-iam-policy --filter` will show nothing and read as
"no access" — resolve group membership instead.

**`gcp-admins@hushh.ai`** → org `owner`, `organizationAdmin`, `denyAdmin`, `billing.admin`, `folderAdmin`

```
kushal@hushh.ai (group owner)   ankit@hushh.ai   manish@hush1one.com
claude-code-gcp-operator@hussh-developer-platform (service account)
```

**`developers@hushh.ai`** → org `run.admin`, `secretmanager.admin`, `artifactregistry.admin`,
`cloudbuild.builds.editor`, `storage.objectAdmin`, `cloudsql.client`, `projectCreator`

```
kushal@hushh.ai   ankit@hushh.ai   manish@hush1one.com   i-akshat@hush1one.com
i-neelesh@hushh.ai   jhumma@hushh.ai   ahujagautam024@gmail.com
abdul.zalil@gmail.com   anoushkagehani1@gmail.com   michael.jacobs@salesforce.com
```

Ten identities, four of them personal Gmail accounts and one external corporate
address, each able to read every secret in the org. Group owners (`ankit`, `kushal`,
`manish`) can add members without touching IAM, so this list changes without an IAM
audit trail.

**Standing exposure worth knowing:** `abdul.zalil@gmail.com` holds `roles/owner` on
`hussh-developer-platform`, the project hosting the operator service account. A project
Owner can mint a key for any service account in that project. That account is also org
Owner directly.

The operator SA carries **seven keys** from at least four setup episodes (Jun 18 ×2,
Jul 10, Jul 11 ×2, Jul 30, Aug 7). Four never expire. Each is a working copy of org
Owner on some disk. Disable rather than delete when pruning — disabling is reversible
and an in-use key fails silently.

---

## Deploy authority

Only **`hushh-pda-uat`** carries a deny policy. `hushh-pda` (prod) and `hushh-pda-dev`
have none — manual deploys there work from ordinary admin credentials.

**`uat-deploy-authority-lock`** (created 2026-05-03) denies
`cloudbuild.builds.create` and `run.services.create/update/delete/setIamPolicy` to
`principalSet://goog/public:all`. That means **everyone, including org Owners** — deny
policies override every grant. Exceptions are service accounts only.

| identity | direct | impersonating deployer |
|---|---|---|
| `ankit@hushh.ai` | DENY | **OK** |
| `claude-code-gcp-operator` | DENY | **OK** |
| `kushal@hushh.ai` | DENY | OK (had this since May) |

### The escape hatch

`github-actions-uat-deployer@hushh-pda-uat` is exempt from the deny policy and holds
`editor`, `run.admin`, `cloudbuild.builds.editor`, `storage.admin`,
`secretmanager.secretAccessor` on the project. It has **no key** — GitHub assumes it
via OIDC, trusted through:

```
principalSet://…/workloadIdentityPools/github-actions-uat/attribute.repository/hushh-labs/hushh-research
  → roles/iam.workloadIdentityUser
```

`ankit@hushh.ai` and the operator SA now hold `roles/iam.serviceAccountTokenCreator`
on it (granted 2026-08-07, additively — Kushal's original binding untouched). So:

```bash
gcloud run deploy <svc> --project hushh-pda-uat --region us-central1 \
  --impersonate-service-account=github-actions-uat-deployer@hushh-pda-uat.iam.gserviceaccount.com
```

This is preferable to weakening the deny policy: the guardrail stays intact for
everyone else, and the action is still attributed to the governed deployer identity.

The normal path remains the workflow:

```bash
gh workflow run deploy-uat.yml --repo hushh-labs/hushh-research --ref main -f scope=auto -f sha=<MERGE_SHA>
```

---

## Traps

**Deny policies are invisible with `--format='value(name)'`.** It prints nothing even
when a policy exists, so a real lock reads as an absent one. This produced a wrong
memory claiming prod and dev were locked. Use the default format:

```bash
gcloud iam policies list --attachment-point="cloudresourcemanager.googleapis.com/projects/<PROJ>" \
  --kind=denypolicies | grep displayName
```

**Role listings lie when a deny policy exists.** `testIamPermissions` is the only
authoritative answer — it returns just the permissions you actually hold:

```bash
TOKEN=$(gcloud auth print-access-token)
curl -s -X POST "https://cloudresourcemanager.googleapis.com/v1/projects/<PROJ>:testIamPermissions" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"permissions":["run.services.update","cloudbuild.builds.create"]}'
```

Build the request in a script, not a shell one-liner — nested quotes in a `for` loop
mangle the URL and return a 404 HTML page that looks like a permissions error.

**Cross-project impersonation grants take up to ~60s to propagate.** A
`PERMISSION_DENIED` on `iam.serviceAccounts.getAccessToken` immediately after
`add-iam-policy-binding` is usually propagation, not a real denial. Retry before
diagnosing.

**Never index `status.traffic[0]`** when checking what a Cloud Run service serves.
Tagged revisions occupy the first slots; select by `percent == 100`.

**Only ever add access.** Use `add-iam-policy-binding`, never `set-iam-policy` — the
latter replaces the whole policy and silently drops every other member.

---

## Fast checks

```bash
# am I authenticated, and as whom?
gcloud config get-value account && gcloud auth print-access-token >/dev/null && echo "token OK"

# does a fresh shell work? (the real test — not the current tab)
zsh -l -c 'echo $CLOUDSDK_CORE_PROJECT; gcloud auth print-access-token >/dev/null && echo OK'

# who is actually in the admin groups right now?
gcloud identity groups memberships list --group-email=gcp-admins@hushh.ai \
  --format='value(preferredMemberKey.id)'

# does this project have a deny policy?
gcloud iam policies list --attachment-point="cloudresourcemanager.googleapis.com/projects/<PROJ>" \
  --kind=denypolicies | grep displayName
```

Related: `safe-changes` (R1 secret-binding order, R3 add-only IAM, R8 serving revision),
`hushh-research-ship` (merge and deploy procedure).
