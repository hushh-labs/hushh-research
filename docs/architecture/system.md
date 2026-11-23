# How Private Agent One works

[Architecture](README.md) · [Product principles](../product/principles/README.md)

The clients provide one experience across web, iOS and Android. The control plane
coordinates identity, consent, placement and releases. One executes through the
selected runtime, calling bounded specialist tools rather than granting a model
unrestricted access to accounts or storage.

## Visual Map

```mermaid
flowchart TB
  client["Web and native clients"]
  localCache["Encrypted IndexedDB Replica<br/>0ms - 150ms Passive Reads"]
  control["Control plane: identity, consent, placement, releases"]
  edge["Stateless TLS Edge Gateway<br/>sub-2s Self-Heal & 12h Session"]
  private["Unified Single-Owner Runtime<br/>Confidential Sandbox (GCP Dev) · BYOC (GCP/Azure) · Local Puppy"]
  model["Verified model connection"]
  pkm["One Encrypted Per-Owner Namespace<br/>PKM, Wiki, Chat, Files, Goals"]
  storage["Owner encrypted storage and recovery"]
  sentinel["Sentinel Egress Proxy + HMAC Audit"]
  services["Consented connected services"]
  client --> control
  client --> localCache
  localCache <--> pkm
  client <-->|Admitted 12h session| edge
  edge --> private
  control -->|Signed coordination| private
  private --> model
  control --> pkm
  private -->|Scoped hub requests| control
  private --> storage
  private --> sentinel
  sentinel --> services
```

## Responsibilities

| Component | Owns | Does not establish |
| --- | --- | --- |
| App and native shell | Interaction, local unlock, `0ms - 150ms` (`<100ms` target) encrypted IndexedDB read replica (`hushh-owner-ui-cache`), approved encryption, review | Authority merely because a control is visible |
| Control plane | Identity, placement, consent, grants, operations and releases | Permission to read every owner's plaintext |
| Unified single-owner runtime | One and specialists across Hussh Confidential Sandbox (Google Cloud default, Dev Preview), BYOC, and Local Puppy behind the Edge Gateway (`<2s` termination heal, compacted checkpoints, 12h `pst1.` sessions) | New authority from a model's request |
| PKM and export services | Encrypted memory, scope metadata and consented exports | General plaintext model access |
| Owner storage | Qualified recovery and Files custody | A working backup without verified restoration |
| Delivery tooling | Exact-source validation and explicit releases | Automatic deployment when source merges |

## A turn through the system

The client establishes its owner and current account authority and unlocks information when required. Passive UI reads (Chats sidebar, Rolling Main Chat, Files, and Personal Wiki) render immediately in `0ms - 150ms` (`<100ms` target) from the device's owner-scoped encrypted IndexedDB replica (`hushh-owner-ui-cache`) across reload and idle lock without blocking behind a waking sandbox. Active turns route over 12-hour `pst1.` placement-bound sessions through the stateless TLS Edge Gateway while sandboxes pre-warm silently in the background. One uses its existing ADK tree to select a specialist or tool. That tool validates the operation's consent, owner binding and current state. Consequential effects require the applicable review; uncertain outcomes are reconciled rather than replayed.

The [runtime view](views/runtime.md) details composition. The
[information boundaries](views/information-boundary.md) distinguish encrypted
memory, operational metadata and provider processing. The
[deployment view](views/deployment.md) explains cloud placement.

## Source and availability

The current root agent is One; Kai is its finance specialist. Some implementation
identifiers retain Kai-era names for compatibility. These names do not define a
second top-level product.

Dev cutover lanes retire `Hussh Shared` into `Hussh Confidential Sandbox` (Google Cloud default, Dev Preview) alongside `Bring Your Own Cloud` (GCP/Azure) and `Local Puppy`, while UAT and Production retain existing `Shared` and `BYOC` separation until Phase 4 acceptance ([#9744](https://github.com/hushh-labs/hushh-research/issues/9744)). Missing placement is not Shared. Browser and Puppy require their own installed acceptance. Read [capability availability](../product/capabilities.md) before interpreting a source diagram as a deployment promise. Related tracking issues: [#9744](https://github.com/hushh-labs/hushh-research/issues/9744) · [#9511](https://github.com/hushh-labs/hushh-research/issues/9511) · [#9736](https://github.com/hushh-labs/hushh-research/issues/9736) · [#9517](https://github.com/hushh-labs/hushh-research/issues/9517) · [#9370](https://github.com/hushh-labs/hushh-research/issues/9370) · [#5507](https://github.com/hushh-labs/hushh-research/issues/5507).
