# Mail + Drive UAT acceptance

Status: incomplete draft; no feature enabled, merge or deployment authorized by this evidence alone.
Runtime remains in `hushh-pda-uat`; the isolated Drive OAuth project is `hushh-drive-uat`.
Mail/Calendar/Firebase clients and existing grants are unchanged.

## Implemented checkpoints

- PR0: public reasoning removed from generation summaries, AG-UI events/snapshots, history,
  compatibility stream and frontend storage/rendering; internal continuation stays intact.
- PR1/PR2 foundation: additive migration 227, compatible encrypted v2 envelopes, atomic
  owner-bound PKCE claims, verified Google identity/scopes, refresh leases/version fences,
  safe disconnect, native pending credentials and owner finalization. Successful OAuth
  remains `verifying` until authenticated transport health/capability verification exists.
- Existing hosted feature config has four independent default-off flags plus a strict
  internal owner cohort. No registry seed, grant, transport, or feature is enabled.

Focused automated coverage includes a disposable socket-only PostgreSQL cluster (or the
existing explicitly test-only CI PostgreSQL service), real concurrent claim/refresh tests,
stale results, wrong owner, partial consent, rotation, native finalization, revocation fences,
legacy envelopes, cryptographically signed identity fixtures, bounded provider responses,
redacted errors, and route authentication. Synthetic consent is not live-provider proof.

## Required before enabling native authorization

The Google callback is fixed at
`https://api.uat.hushh.ai/api/connectors/oauth/native/callback`.
Its query contains a short-lived authorization code and signed state. Application filters
redact both; Cloud Run generates its own request logs outside those filters.

Inventory **all** applicable log sinks (project, ancestor and custom sinks) before consent.
Record approved routing exclusions for only the secret-bearing callback request records,
while retaining redacted outcome/security telemetry. A narrow filter to review is:

```text
resource.type="cloud_run_revision"
resource.labels.service_name="consent-protocol"
LOG_ID("run.googleapis.com/requests")
httpRequest.requestUrl =~ "^https://[^/]+/api/connectors/oauth/native/callback([?].*)?$"
```

Do not apply a broad service/logging disablement or claim an `_Default` sink change covers
ancestor/custom sinks. Routing exclusions act after ingestion; the accurate claim is
“not retained or routed by verified sinks,” not “never ingested.” Use synthetic callback
values for verification; never place a real code/token in logs or test evidence.
References: [Cloud Run logging](https://docs.cloud.google.com/run/docs/logging),
[Cloud Logging routing](https://docs.cloud.google.com/logging/docs/routing/overview).

The current cleanup is bounded and opportunistic: lifecycle traffic scrubs expired attempt
secrets and deletes workflow rows expired over 24 hours ago. Wire and prove the existing
maintenance/scheduler lane for a hard retention deadline before rollout. Cleanup must not
revoke a provider grant or mutate an active connection.

## Remaining delivery checklist

- [ ] Dedicated Drive web client provisioned; exact callbacks, project isolation and secret
  bindings verified without exposing secret values. Google branding alone is insufficient.
- [ ] Approved synthetic-account consent and authenticated MCP feasibility. Select exactly
  one transport; no fallback after permission/policy/quota/timeout failures.
- [ ] Five canonical Drive reads, policy/catalog verification, invocation authority, bounds,
  external-content isolation, redacted durable projections and late-result suppression.
- [ ] Mail metadata-only delegated reads with stable One conversation identity; unchanged
  receipts, Calendar, Firebase and reviewed Send.
- [ ] Mounted left-drawer Chats/Connections UI with independent Mail/Drive cards; popup
  settlement, encrypted one-use recovery and draft preservation.
- [ ] Native `connectDrive` bridges/coordinators and real iOS/Android test/build artifacts.
- [ ] Chromium/WebKit mounted acceptance at 320/390/768/desktop widths.
- [ ] Callback log-routing and scheduled retention proof before granting access.
- [ ] Required CI/review, final overlap reconciliation, protected merge, green containing main
  SHA with its own Main Post-Merge Smoke Gate, serialized immutable-SHA UAT deployment.
- [ ] Live serving SHA/image/revision/health and authenticated connector acceptance.
- [ ] Internal connection cohort first, reads only after acceptance; redacted monitoring and
  tested feature-disable/revision rollback. No destructive schema rollback.

Drive writes/download UI/voice execution and production deployment remain out of scope.
