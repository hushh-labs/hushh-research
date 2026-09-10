# Ship iOS to TestFlight

Use this workflow to make one normal UAT-backed TestFlight build available to
the configured internal and external tester groups. It does not create an App
Store version or submit the app for public App Store review.

## Visual Context

Canonical visual owner: [Mobile Guide](../mobile.md). This guide owns the
TestFlight release branch beneath that mobile build-and-release flow: one
UAT-backed archive, automated safety gates, then internal and external beta
distribution without a public App Store submission.

## What testers receive

The workflow uploads one exact build from a green `main` SHA.

- Internal testers receive that build after Apple marks it `VALID`.
- The same build is assigned to the external group and includes the required
  beta-review contact and notes.
- External availability is reported as `pending_apple_beta_review` until Apple
  approves it, then as `active`.

This is a TestFlight-only operation. Assigning a build to an external group is
not a public App Store submission.

## What the workflow proves before upload

`Ship iOS to TestFlight` requires an exact green `main` SHA and a UAT backend
revision with the same provenance. The normal archive job then runs:

```text
UAT configuration and native Firebase materialization
→ One Voice safety, generated-action, and Capacitor plugin checks
→ privacy-manifest, App Intent, archive-asset, and symbol checks
→ verified UAT browser-ASR and intent-ranker pack readiness
→ optional focused iOS App Intent/action smoke tests (full AppTests remain in change-aware CI)
→ optional physical-iPhone capture evidence when requested
→ signed archive and TestFlight upload
→ Apple VALID processing check
→ attach the same build to internal and external groups
```

The physical-device job is an optional evidence lane. Set the dispatch input
`require_hardware: true` for voice or device-sensitive changes when you want the
dedicated self-hosted macOS runner with an attached iOS 17+ iPhone to prove
device capture behavior. It uses UI automation to bootstrap microphone
permission, performs at least 30 repetitions through the production microphone
owner, and accepts only a redacted aggregate result when all of these are true:

- p95 `time_to_capture_ms` is below 300 ms;
- every repetition observes its first frame;
- no initial frames are lost;
- no microphone/session ownership is duplicated.

When `require_hardware` is `false` (the default), the physical job is skipped
and the release summary records `not requested`; the workflow makes no
physical-device claim. If the lane is requested, a missing device, permission,
metric, or result remains a release failure. The One Voice privacy,
generated-action, and Capacitor checks remain required on every run; the
compile-heavy simulator XCTest gate is opt-in through `run_core_tests`.

When the `run_core_tests` dispatch input is `true`, the release simulator step
runs five tests that prove the shipped App Intent surface: the ten-shortcut
registration contract, the generated action catalog, both direct intent-factory
mappings, and the non-mutating destination adapters. The default skips this
compile-heavy duplicate; the change-aware CI workflow continues to run the
complete `AppTests` suite and the targeted UI recovery test.
This keeps the release job focused while preserving broad regression coverage.

## One-time release configuration

GitHub Actions uses GitHub OIDC Workload Identity Federation. Do not create,
upload, or restore a GCP service-account JSON key for this release path.

The `uat` GitHub environment needs these non-secret variables:

| Variable | Purpose |
| --- | --- |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | GitHub OIDC provider resource |
| `GCP_DEPLOY_SERVICE_ACCOUNT` | Federated deployment identity |
| `IOS_VOICE_DEVICE_TIER` | Redacted identifier for the attached iPhone tier; required only when `require_hardware: true` |

The federated identity needs read access to the UAT build contract, App Store
Connect material, model-pack registry, and Firebase configuration in
`hushh-pda-uat`. It must not use a long-lived key file.

Before upload, the workflow fails closed unless Secret Manager contains:

| Secret | Purpose |
| --- | --- |
| `APPSTORE_CONNECT_API_KEY_P8_B64` | Runner-local App Store Connect signing key |
| `APPSTORE_CONNECT_KEY_ID` / `APPSTORE_CONNECT_ISSUER_ID` | App Store Connect identity metadata |
| `APPSTORE_CONNECT_INTERNAL_TESTFLIGHT_GROUP_ID` | Internal beta group |
| `APPSTORE_CONNECT_EXTERNAL_TESTFLIGHT_GROUP_ID` | External beta group |
| `APPSTORE_CONNECT_BETA_REVIEW_CONTACT_JSON` | Required external beta-review contact |
| `APPSTORE_CONNECT_BETA_REVIEW_NOTES` | Required external beta-review notes and What's New text |
| `APPSTORE_CONNECT_PRIVACY_DECLARATION_CONTRACT_VERSION` | Must equal `one-voice-privacy-v1` |
| `APPSTORE_CONNECT_EXPORT_COMPLIANCE_APPROVED` | Must be exactly `true` |
| `APPSTORE_CONNECT_VOICE_PROVIDER_PRIVACY_APPROVED` | Must be exactly `true` |

The `OneVoicePrivacyContract.v1.json`, `OneVoiceModelNotices.json`,
`Info.plist`, `PrivacyInfo.xcprivacy`, and built archive are reconciled before
upload. Model weights are forbidden in the base archive. FluidAudio remains
disabled unless its model notice is legally approved, its verified on-demand
pack is active, and its device benchmark is eligible.

## UAT local-model packs

The TestFlight workflow refuses an unconfigured local voice runtime. Publish
only the browser ASR and intent-ranker packs for the exact merged SHA first:

```bash
gh workflow run publish-one-voice-model-packs.yml --ref main \
  -f environment=uat \
  -f operation=publish
```

That workflow stores immutable artifacts under the SHA in the UAT model bucket
and atomically updates the metadata-only
`HUSHH_LOCAL_RUNTIME_PACK_REGISTRY` Secret Manager registry. Cloud Run reads
the registry through its bounded adapter and issues fresh short-lived signed
URLs per capability request. The registry never stores a bearer URL.

The FluidAudio model is deliberately omitted from this default publication.
After legal approval is recorded in `OneVoiceModelNotices.json`, stage the
reviewed upstream ZIP below `one-voice/fluid-audio-source/` in the selected
environment's model bucket, then dispatch the same workflow with
`include_fluid_audio: true`, that normalized object path, and its reviewed
version. Automation normalizes the upstream `160ms` layout, verifies the
NVIDIA notice, archive checksum, required Core ML files, and provenance
manifest before adding the pack to the registry. A pending notice, malformed
archive, or missing hardware eligibility fails the release path; it cannot
silently enable the provider.

Production model promotion is a separate explicit `production` dispatch after
the UAT gates are proven. It is not implied by this TestFlight upload.

## Run the normal build

Follow the [admin release SOP](../../../.codex/skills/repo-operations/references/admin-release-sop.md)
for branch authority, required review, rollback, and deployment escalation. This
guide adds the TestFlight-specific gates; it does not replace that release
authority contract.

1. Land the reviewed source on `main` and wait for the required post-merge
   checks to pass.
2. Deploy the matching backend to UAT.
3. Publish and activate the matching UAT model packs.
4. If device evidence is desired, verify the self-hosted iPhone runner is
   connected and registered with the `ios-voice-device` label.
5. In GitHub Actions, run **Ship iOS to TestFlight** from `main`. Leave `sha`
   blank for the latest eligible SHA, or supply that exact SHA. Set
   `require_hardware: true` for the optional physical-device evidence lane;
   leave it `false` for the normal release path. Set `run_core_tests: true`
   only when you want the focused simulator App Intent/action gate in this
   release; the default is `false` because the full suite already runs in
   change-aware CI.
6. Use `dry_run: true` only when you want a signed archive without uploading.
   It follows the same `require_hardware` choice.

The run summary reports the source SHA, the physical capture p95 when that lane
was requested (otherwise `not requested`), build number, and whether external
access is active or awaiting Apple beta review. Artifacts are limited to
redacted readiness, distribution, and timing evidence; keys,
review-contact details, signed URLs, audio, transcripts, Vault material, and
model bytes are removed or never uploaded.

## Common failures

| Failure | Meaning and safe response |
| --- | --- |
| No connected iPhone / missing timing result | If `require_hardware: true`, restore the dedicated runner or permission bootstrap and rerun. If physical evidence is not needed, rerun with `require_hardware: false` after the mandatory simulator and native gates pass. |
| UAT backend provenance differs from source SHA | Deploy that exact reviewed SHA to UAT, then restart the release workflow. |
| Local model readiness fails | Publish checksum-verified packs for the same SHA; do not hard-code signed URLs. |
| Missing group, contact, notes, or privacy attestation | Configure the protected UAT release material; the workflow intentionally will not upload. |
| External beta review pending | Internal testers can use the valid build; wait for Apple's beta-review decision for external testers. |
| External beta review rejected | Correct the reviewer-facing issue and dispatch a new build; the workflow fails closed. |
| `App Store Connect ... failed with HTTP 400` after processing | The binary is already uploaded and `VALID`; inspect the endpoint in the step error. The workflow prepares review metadata before group attachment, treats an unsubmitted external review as pending, and never creates a beta-review submission implicitly. |

Public App Store submission remains a separate, explicitly authorized workflow.
