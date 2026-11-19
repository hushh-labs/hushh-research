# Floci Multi-Cloud Wire Verification & CI Profile Calibration

Use this reference when selecting backend/multi-cloud tests, auditing storage or KMS/BYOC adapters, or calibrating CI validation profiles under `quality-contracts`. Canonical architecture and runtime guardrails live in `docs/development/quality/floci-multicloud-wire-verification.md`.

## Tier-1.5 Selection Rule (No Mocked Cloud Wire Stubs)

1. **Tier 1 (`<1s` unit):** Pure in-process domain rules, schema checks, and state transitions.
2. **Tier 1.5 (`<100ms` Floci loopback wire):** Required whenever code touches HTTP/SDK wire protocols across AWS (`boto3` S3/KMS/STS/IAM/ECS), GCP (GCS JSON/upload + Cloud KMS v1), Azure (Blob `2023-11-03` + Key Vault `7.4` + MSI), or Hussh-Hosted `PrefixTokenObjectStore` (`pod_capability_broker.py`).
3. **Reject `MagicMock` wire stubs** when asserting `If-None-Match: *` / `If-Match` / `ifGenerationMatch` CAS conflicts, KMS `EncryptionContext` / `additionalAuthenticatedData` AAD binding, `AccessDenied` vs confirmed `gone` (`404`/`INACTIVE`), or prefix-token expiry/escape (`401`/`403`). Exercise unmocked SDK/HTTP clients against `consent-protocol/tests/floci_wire_harness.py`.
4. **Tier 2 (Live cloud qualification):** Required before claiming live cloud readiness, IAM policy acceptance, direct pod ingress, or provider-side erasure receipts.

## Harness Context Managers (`consent-protocol/tests/floci_wire_harness.py`)

- `floci_aws_wire_environment()` — resolves `FLOCI_ENDPOINT_URL` → `floci` binary (`HUSHH_PREFER_FLOCI_BINARY=1`) → deterministic loopback S3/KMS/STS/IAM/ECS server (`set_bucket_forbidden`, `set_kms_key_disabled`).
- `floci_gcp_wire_environment()` — resolves `FLOCI_GCP_ENDPOINT_URL` → `floci-gcp` binary → loopback GCS JSON/upload + Cloud KMS v1 server.
- `floci_azure_wire_environment()` — resolves `FLOCI_AZ_ENDPOINT_URL` → `floci-az` binary → loopback Azure Blob + Key Vault + MSI server.
- `floci_prefix_gateway_environment(secret=...)` — loopback capability-prefix gateway (`FLOCI_PREFIX_ALLOW_LOOPBACK_HTTP=1`, `advance_clock`) verifying `PodCapabilityBroker` tokens and ETag CAS.

## Non-Negotiable Security & Qualification Guardrails

1. **Loopback & Environment Fence:** `pod_emulator_endpoints.py` (`PodEmulatorEndpointError`) and `aws_setup_plan.py` (`AwsFlociGateRefused`) unconditionally refuse any Floci/emulator env override in `uat`, `staging`, `prod`, or `production`, and reject non-loopback `http://` origins or URLs carrying credentials, paths, queries, or fragments.
2. **Unqualified Provider Fence:** While `PROVIDER_CAPABILITY_REGISTRY["user_aws"].sandbox_capability.execution_qualified` is `False`, live `user_aws` readiness/adapter calls without loopback `FLOCI_ENDPOINT_URL` fail closed with `AwsFlociGateRefused`.
3. **Never Claim Cloud Qualification from Tier 1.5:** Passing Floci wire tests never flips `execution_qualified = True` and never closes live owner-pod acceptance gates (`#5507`, `#28`, `#47`).

## Authoritative Floci Wire Suite Bundle

```bash
cd consent-protocol && ./.venv/bin/python -m pytest \
  tests/test_floci_aws_wire_conformance.py \
  tests/test_floci_gcp_azure_wire_conformance.py \
  tests/test_provider_capability_registry_and_aws_parity.py \
  tests/test_pod_capability_broker.py \
  tests/test_pod_activation_and_upgrade_clearance.py \
  tests/services/test_wiki_phase5_floci_conformance.py \
  tests/services/test_pod_workspace_9511.py -q
```

## CI Validation Profile Calibration

CI validation profiles preserve security and source-authority baselines without defaulting every incremental PR to full frontend + protocol suites:

- `focused`: always-run authority checks plus regression owners selected from the exact changed-file inventory.
- `release`: core release-authority owners plus affected regression owners.
- `diagnostic`: full historical check set, including optional hygiene and app-browser diagnostics.

Treat missing or unknown changed-file metadata conservatively. App-browser checks run only as explicit diagnostics, whereas One Browser authority contracts remain required when affected. Run engine-specific diagnostics locally when that contract changes and native checks only when native source or contracts change. Supply verified changed-file inventories to the focused owner; report secondary diagnostics truthfully (an unrun check is never a pass) and keep core release proof blocking under `docs/operations/releases/ci.md#managed-provider-readiness-policy`.
