# Private-agent remaining work

[Roadmap](../README.md) · [Current hosting architecture](../../architecture/modules/hosting.md)

The architecture and product requirements have current owners. This section
retains unfinished implementation and future designs; it is not a live deployment ledger.

## Active delivery

- [Normal release transition](normal-release-transition.md): remaining acceptance and controlled delivery.
- [Direct-runtime handoff](owner-pod-direct-runtime-handoff-2026-09-10.md): retained workstream requirements and owner boundaries.
- [Browser completion](browser-completion-plan.md): native models, owner control and installed acceptance.
- [Remaining roadmap](roadmap.md): deferred capabilities and their prerequisites.

## Design contracts

- [Owner co-signature](owner-cosignature.md): proposed additional authority boundary.
- [Standby synchronization](standby-sync.md): proposed multi-cloud recovery behavior.
- [Managed provisioning](pod-autoprovision.md): design and explicit qualification gates.
- [Pod-to-hub information path](pod-hub-data-path.md): transitional design context; use current [runtime composition](../../architecture/views/runtime.md) for implemented boundaries.
- [Device binding](puppy-device-binding-spec-2026-09-10.md): Puppy’s bounded device-side contract.
- [Consent-log flow](consent-log-end-to-end.md), [simulation design](multi-pod-dev-simulation.md) and [security requirements](security-review.md).

Use [operational acceptance](../../operations/acceptance/private-agents.md) for
unresolved installed-owner proof. Old execution narratives and dated fleet snapshots
are retained in Git history rather than presented as current operating instructions.
