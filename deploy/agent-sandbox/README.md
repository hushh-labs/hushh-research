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

## Dev Files schedule delivery

- Use a dedicated Cloud Tasks queue in `hushh-pda-dev/us-central1`. Keep bounded
  retries and preserve the task's target and OIDC settings at the queue level.
- Grant the Dev Hub's runtime service account enqueue access on that queue and
  `iam.serviceAccounts.actAs` on the dedicated worker service account in the same
  project. The worker identity is for the schedule endpoint.
- Set `HUSSH_SANDBOX_TASK_QUEUE` to the full queue resource on the Dev Hub.
  Configure the same `HUSSH_SANDBOX_TASK_WORKER_EMAIL` on the Hub and Edge Gateway.
  Edge passes the worker identity to newly activated Sandbox leases. The Hub
  and Edge use the same `HUSSH_SANDBOX_EDGE_PUBLIC_URL`. The standard Hub deploy
  replaces its environment variables, so include both task settings in the
  approved Dev release configuration and verify them on the serving revision.
- Roll the qualified image into the existing Dev Edge Gateway and warm pool.
  Prove OIDC reaches the Edge with the exact owner URL as its audience, then
  confirm one Files receipt after the original lease has reclaimed. Repeat with
  Session-only lockdown enabled and verify the occurrence pauses.

## Deployment Invariants (FedRAMP High Baseline)

1. Pin `image` to a signed immutable `@sha256:` digest before cluster apply (`sandbox-template.yaml` ships a zero-digest placeholder for repository lint safety).
2. Never place owner tokens, vault keys, or `APP_SIGNING_KEY` inside `SandboxTemplate` or `SandboxWarmPool` (`envVarsInjectionPolicy: Disallowed`).
3. Provision per-user workspaces only via ephemeral `SandboxClaim` (`shutdownPolicy: DeleteForeground`, `ttlSecondsAfterFinished: 0`) rendered by `consent-protocol/hushh_mcp/operons/agent_sandbox/k8s_manifests.py`.
