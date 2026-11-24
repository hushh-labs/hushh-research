# Implementation Plans and Design Specs

[Roadmap](../README.md) · [Current Architecture](../../architecture/README.md) · [Documentation Guideline](../../development/documentation.md)

**Status:** Active-Only Door | **Intent:** Explanation | **Audience:** Contributors and Coding Agents

This directory holds only **actively unshipped** implementation plans and design specifications. Under Hussh's **Zero-Archive Rule**, once a feature ships, its unique durable invariants, schemas, and recovery procedures are distilled into the owning Architecture, Development, or Operations page and the temporary dated plan is deleted. Git history preserves every prior revision.

> [!NOTE]
> **Where retired implementation plans moved:** All 16 historical plans and specs from July through October 2026 have been distilled into their canonical current-state owners below and removed from the active tree.

## Canonical Current-State Owners

| Capability | Canonical Current Owner |
| --- | --- |
| Wallet Profile Apple Wallet pass & `/c/[token]` | [Wallet Profile Card Contract](../../architecture/one/wallet-profile-card.md) |
| Personal Gmail read, send reconciliation & reliability | [One Email Knowledge Graph](../../architecture/one/one-email-knowledge-graph.md) |
| Google Calendar read, FreeBusy, Voice & invitations | [One Calendar Knowledge Graph](../../architecture/one/one-calendar-knowledge-graph.md) |
| Google Drive sharing, request pricing & owner payout | [Drive Connection and Sharing Memory](../../architecture/one/drive-connection-and-sharing-memory.md) |
| Trusted Connections, circles & location sharing | [Sharing Module](../../architecture/modules/sharing.md) · [Connections Module](../../architecture/modules/connections.md) |
| One Agent hierarchy, voice & tool-loop parity | [One Module](../../architecture/modules/one.md) · [One Agent Hierarchy](../../architecture/one/one-agent-hierarchy.md) |

## Active Subdirectories

- [Active Implementation Plans](plans/README.md)
- [Active Design Specs](specs/README.md)
