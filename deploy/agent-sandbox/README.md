<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Hushh -->

# Portable Agent Sandbox Kubernetes Baseline

Reference Kubernetes manifests and cluster reconciliation script for Hussh One's
single-use per-user sandbox pool (`extensions.agents.x-k8s.io/v1beta1`, tracked
in `#9744`).

## Portability Targets

- **GKE Autopilot / Assured Workloads:** `runtimeClassName: gvisor` is verified live on `hussh-one-sandbox-dev` (`us-central1` Autopilot); `microvm` (`kata-clh` Cloud Hypervisor hardware microVMs) is supported where Autopilot/Standard microVM node pools are enabled.
- **AWS GovCloud EKS / Azure Gov AKS:** use `runtimeClassName: kata` (Kata microVM).
- **Network Fencing:** `sandbox-network-policy.yaml` restricts sandbox pods strictly to `hussh-consent-hub` on TCP `8080` and `sentinel-egress-proxy` on TCP `3128`, while `sentinel-egress-proxy.yaml` isolates the proxy control port (`8081`) strictly to `hussh-consent-hub`.

## Reconciler (Plan-First, No Terraform)

Per Hussh's [deployment standard](../../docs/architecture/deployment-standard.md),
Dev cluster setup uses explicit declarative manifests and gcloud reconcilers
rather than Terraform state files:

- Plan only (default): `./deploy/agent-sandbox/reconcile_dev_gke_sandbox.sh`
- Apply Dev Autopilot sandbox infrastructure and warm pool: `./deploy/agent-sandbox/reconcile_dev_gke_sandbox.sh --apply`
- Drain warm pool back to zero standby cost: `./deploy/agent-sandbox/reconcile_dev_gke_sandbox.sh --scale-zero`

## Deployment Invariants (FedRAMP High Baseline)

1. Pin `image` to a signed immutable `@sha256:` digest before cluster apply (`sandbox-template.yaml` ships a zero-digest placeholder for repository lint safety).
2. Never place owner tokens, vault keys, or `APP_SIGNING_KEY` inside `SandboxTemplate` or `SandboxWarmPool` (`envVarsInjectionPolicy: Disallowed`).
3. Provision per-user workspaces only via ephemeral `SandboxClaim` (`shutdownPolicy: DeleteForeground`, `ttlSecondsAfterFinished: 0`) rendered by `consent-protocol/hushh_mcp/operons/agent_sandbox/k8s_manifests.py`.

## Private Mail browser OAuth on UAT

Google’s dedicated web client uses the authorized JavaScript origin `https://uat.one.hussh.ai`. The hub reads the public `GOOGLE_UAT_MAIL_WEB_CLIENT_ID` for the existing consent transition. The sandbox exchanges and refreshes Google grants through a separate container listening on loopback. Only that container receives the confidential client secret. The owner-facing process receives the public ID.

After publishing and selecting the signed UAT pod digest containing `mail_web_exchange`, run `python3 scripts/deploy/enable-uat-private-mail-browser.py --image "$SIGNED_UAT_POD_IMAGE"` with the UAT GKE context. The command checks the running template and asks the API server to validate the patch. Add `--apply` to sync the two UAT Secret Manager values into the namespaced Kubernetes Secret and update the template for newly created sandboxes. Existing leases can expire normally. To roll back, restore the prior template through the same sandbox release process.

Verify an unlocked owner can open Google from Mail, cancel without adding a mailbox, grant access, see the verified address, and read mail after the initial access token expires. A frontend deployment alone does not activate the private-agent image or template.
