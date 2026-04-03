<p align="center">
  <img src="https://img.shields.io/badge/Hushh-Research-5B4BFF?style=for-the-badge" alt="Hushh Research"/>
</p>

<h1 align="center">Hushh Research</h1>

<p align="center">
  <strong>Consent-first personal data agents</strong><br/>
  <em>Your data. Your vault. Your agents.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Next.js-16-black?style=flat-square&logo=next.js&logoColor=white" alt="Next.js 16"/>
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React 19"/>
  <img src="https://img.shields.io/badge/Capacitor-8-1199EE?style=flat-square&logo=capacitor&logoColor=white" alt="Capacitor 8"/>
  <img src="https://img.shields.io/badge/FastAPI-Python_3.13-009688?style=flat-square&logo=fastapi&logoColor=white" alt="FastAPI Python 3.13"/>
  <br/>
  <img src="https://img.shields.io/badge/Firebase-Auth%20%2B%20Messaging-FFCA28?style=flat-square&logo=firebase&logoColor=black" alt="Firebase"/>
  <img src="https://img.shields.io/badge/PostgreSQL-Supabase-336791?style=flat-square&logo=postgresql&logoColor=white" alt="PostgreSQL"/>
  <img src="https://img.shields.io/badge/GSAP-3.14-88CE02?style=flat-square&logo=greensock&logoColor=0b0f19" alt="GSAP"/>
  <a href="https://discord.gg/fd38enfsH5"><img src="https://img.shields.io/badge/Discord-Join%20the%20community-5865F2?style=flat-square&logo=discord&logoColor=white" alt="Discord"/></a>
</p>

## What Hushh Is

**Hushh** is a consent-first platform for personal agents and agent-assisted workflows.

The core trust contract is straightforward:

- the user holds the key boundary
- the backend stores ciphertext and metadata, not plaintext
- access is explicitly scoped
- agents act only within granted consent boundaries

Where the shorthand helps, the trust model can be read as:

- **Secure**: user-private data remains encrypted end to end
- **Scoped**: operations are limited to the granted scope
- **Handled by the user**: the person whose data is being touched authorizes access

This is a protocol-grade model, not privacy language without enforcement:

1. **Identity** decides who is acting.
2. **Vault** defines the encrypted data boundary.
3. **Scoped tokens** define what may be accessed.
4. **Apps and agents** execute only inside that scope.

## Visual Map

```mermaid
flowchart TB
  repo["hushh-research"]
  web["hushh-webapp/<br/>Next.js + Capacitor client"]
  backend["consent-protocol/<br/>FastAPI + consent + PKM + Kai"]
  docs["docs/<br/>architecture, guides, operations, vision"]

  repo --> web
  repo --> backend
  repo --> docs
```

## Core Guarantees

- **Consent + scoped access**: sensitive operations are explicitly authorized and auditable.
- **BYOK**: the user-controlled key boundary stays on the user side.
- **Zero-knowledge**: the backend persists ciphertext and metadata, not plaintext user memory.
- **Tri-flow parity**: web, iOS, and Android stay aligned on visible contracts.

## Monorepo Shape

The contributor mental model should stay small:

- `hushh-webapp/`: Next.js + Capacitor client
- `consent-protocol/`: FastAPI backend, consent protocol, PKM, and agents
- `docs/`: cross-cutting architecture, operations, and product references

The `consent-protocol` subtree relationship still exists, but it is maintainer-only complexity and not part of the normal first-run path.

## Quick Start

```bash
git clone https://github.com/hushh-labs/hushh-research.git
cd hushh-research
./bin/hushh bootstrap
./bin/hushh web --mode uat
```

That is the canonical first-run path:

- local frontend
- deployed UAT backend
- no local backend or Cloud SQL setup required for initial validation

## Canonical Contributor Commands

```bash
./bin/hushh bootstrap
./bin/hushh doctor --mode uat
./bin/hushh web --mode uat
./bin/hushh native ios --mode uat
./bin/hushh native android --mode uat
```

The only supported repo-level command surface is `./bin/hushh`.

## Documentation

- [Getting Started](./docs/guides/getting-started.md)
- [Environment Model](./docs/guides/environment-model.md)
- [Contributing](./contributing.md)
- [Docs Index](./docs/README.md)
- [CLI Reference](./docs/reference/operations/cli.md)
- [Architecture](./docs/reference/architecture/architecture.md)
- [Branch Governance](./docs/reference/operations/branch-governance.md)
- [Vision](./docs/vision/README.md)

## Compatibility Boundaries

Public markdown and contributor-facing copy use **Hushh**.

Some internal identifiers still use legacy compatibility names:

- repo slug
- package and bundle identifiers
- cloud service names
- env keys
- internal plugin and class names

Those are infrastructure details, not the public docs contract.

## Principles

**Keep the integrated backbone where the platform needs it, and keep the contributor surface small, modular, and understandable.**

In practice:

- small public command surface
- modular docs
- self-contained scripts
- minimal contributor cognitive load

Hushh exists to make consented, scoped, zero-knowledge AI straightforward to build and straightforward to reason about.
