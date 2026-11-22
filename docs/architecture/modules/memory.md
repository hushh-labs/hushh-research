# Memory and PKM

[Modules](README.md) · [Architecture](../README.md) · [Documentation](../../README.md)  
**Status:** `Live` (PKM & Markdown Memory) · `Preview` (Personal Wiki & Autonomous Curation on Dev) · **Intent:** Explanation & module reference

Hussh separates **sovereign personal capital** (structured encrypted PKM domains governed by consent scopes) from **owner-private agent memory** (working context and Personal Wiki pages that help One serve you without automatically exposing your life to external requesters).

## Visual Map

```mermaid
flowchart TB
  subgraph Inputs["Context Sources"]
    chat["Interactive owner chat"]
    bg["Quarantined background prep<br/>(Dev Preview · connector provenance)"]
  end

  subgraph PrivateMemory["Owner-Private Agent Memory (Never Directly Shared)"]
    md["Encrypted Markdown Memory<br/>one_memory (UAT & Prod)"]
    wiki["Encrypted Personal Wiki<br/>one_wiki + hot.md (Dev Preview)"]
  end

  subgraph SovereignPKM["Sovereign PKM Authority (Encrypted Domains)"]
    pkm["Structured PKM Domains<br/>(Explicit Owner Confirmation)"]
    export["Consent-Scoped External Export<br/>(attr.* scopes)"]
  end

  chat --> md
  chat --> wiki
  bg -->|High-signal only · cannot override owner| wiki
  bg -.->|Capital docs stage for unlock| pkm
  md -->|Confirmed projection| pkm
  wiki -->|Confirmed projection| pkm
  pkm -->|Explicit consent token| export
```

## Owner journey

1. **Remember naturally:** Share preferences, commitments, or notes with One, or review quiet connector takeaways tagged with explicit provenance (`from Mail`, `from Calendar`, `from Drive`).
2. **Stay protected from poisoning:** External connector text can never overwrite owner-stated preferences or consent rules, and low-signal noise (newsletters, promos, OTPs) is filtered out.
3. **Control Vault capital:** Financial, tax, or identity records discovered in background prep never silently overwrite the Sovereign Vault; they stage as encrypted 1-tap proposals for your next unlock.
4. **Forget cleanly:** Revoking a fact appends a durable tombstone and triggers provider-memory erasure/rebuild where consented.

## Trust boundary and limits

> [!IMPORTANT]
> **Possessing Memory Is Not Permission to Share It:** Both `one_memory` and `one_wiki` are strictly owner-private (`shareable: "never"`). Only confirmed projections written into structured PKM domains participate in external `attr.*` consent scopes.

- Operational metadata, provider caches, and discovery hints are never durable personal memory.
- In shipped UAT and Production, chat memory is one canonical Markdown document in encrypted `one_memory` (`one.memory.md.v1`, 96,000-character limit). On Dev, the encrypted Personal Wiki (`<prefix>/wiki/v1/`, reserved `one_wiki` namespace, `hot.md <= 8,000` chars) adds cited page/claim recall with per-owner `migration_state` cutover.

## Implementation and operation

- [PKM storage and contracts](../../../consent-protocol/docs/reference/personal-knowledge-model.md)
- [Memory workspace](../memory-workspace.md)
- [Personal Wiki Memory roadmap plan](../../roadmap/personal-wiki-memory-plan.md)

<details>
<summary><strong>For coding agents: memory custody & PKM invariants</strong></summary>

- **Zero-loss upgrades:** Any PKM schema evolution must prove zero-loss migration with historical fixtures and rollback under `pkm-upgrade-rehearsal`.
- **Commit-log isolation:** Pod memory records are sealed with owner AAD; replay must filter strictly by `hushh_id` and respect tombstones in sequence order.
- **Verification:** Run `pod_memory`, `wiki_memory`, and `pkm` pytest suites plus `test_pod_config.py`.

</details>
