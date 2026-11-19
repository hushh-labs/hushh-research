<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Hushh -->

# Portable Agent Sandbox Kubernetes Baseline

Reference Kubernetes manifests for Hussh One's single-use per-user microVM pool
(`agents.x-k8s.io/v1alpha1`, tracked in `#9744`).

## Portability Targets

- **GKE Assured Workloads:** set `runtimeClassName: gke-sandbox` (gVisor) or `kata` when Kata nodes are provisioned.
- **AWS GovCloud EKS / Azure Gov AKS:** use `runtimeClassName: kata` (Kata microVM).
- **Network Fencing:** apply `sandbox-network-policy.yaml` so sandbox pods only accept traffic from `hussh-consent-hub` on TCP `8080` and only reach `sentinel-egress-proxy` on TCP `3128`.

## Deployment Invariants (FedRAMP High Baseline)

1. Pin `image` to a Cosign-signed immutable `@sha256:` digest before cluster apply (`sandbox-template.yaml` ships a zero-digest placeholder for CI/lint safety).
2. Never place owner tokens, vault keys, or `APP_SIGNING_KEY` inside `SandboxTemplate` or `SandboxWarmPool`.
3. Provision per-user workspaces only via ephemeral `SandboxClaim` (`reclaimPolicy: Delete`) rendered by the backend lease manager (`consent-protocol/hushh_mcp/operons/agent_sandbox/k8s_manifests.py`).
