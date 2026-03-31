# Hussh Research

> Consent and scoped access for personal AI, built on BYOK and zero-knowledge boundaries.

## What Hussh Is

**Hussh** is a personal-agent platform built around one simple contract:

- the user holds the key
- the server stores ciphertext
- every access path is explicitly scoped
- agents only act inside granted consent boundaries

We use **SSH** as the public metaphor:

- **Secure**: user-private data stays encrypted end to end
- **Scoped**: every operation is limited to the granted scope
- **Handled by the user**: access is authorized by the person whose data is being touched

This is not “privacy as a vibe.” It is a protocol-grade trust model:

1. **Identity** decides who is acting.
2. **Vault** holds encrypted user data.
3. **Scoped tokens** define what can be accessed.
4. **Agents and apps** operate only within that scope.

## Core Guarantees

- **Consent + scoped access**: every sensitive path is token-gated and auditable.
- **BYOK**: the user’s vault key remains on the user side of the boundary.
- **Zero-knowledge**: the backend stores ciphertext and metadata, not plaintext user memory.
- **Tri-flow delivery**: web, iOS, and Android stay contract-aligned.

## Monorepo Shape

The repo is intentionally split into a small public surface and a deeper integrated backbone:

- `hushh-webapp/`: Next.js + Capacitor client
- `consent-protocol/`: FastAPI backend, consent protocol, PKM, and agents
- `docs/`: cross-cutting architecture, operations, and product references

The normal contributor path is monorepo-first. The `consent-protocol` subtree relationship still exists, but it is maintainer-only complexity, not something a new contributor should need to learn on day one.

## Quick Start

```bash
git clone https://github.com/hushh-labs/hushh-research.git
cd hushh-research
npm run bootstrap
npm run web -- --profile=uat-remote
```

That gives you the fastest working path:

- local frontend
- deployed UAT backend
- no local backend or Cloud SQL setup required for first-run validation

## Canonical Contributor Commands

```bash
npm run bootstrap
npm run doctor -- --profile=uat-remote
npm run web -- --profile=uat-remote
npm run native:ios -- --profile=uat-remote
npm run native:android -- --profile=uat-remote
```

`make` remains available for maintainers and compatibility paths, but the public contributor contract is **npm-first**.

## Documentation

- [Getting Started](./docs/guides/getting-started.md)
- [Environment Model](./docs/guides/environment-model.md)
- [Contributing](./contributing.md)
- [Docs Index](./docs/README.md)
- [Branch Governance](./docs/reference/operations/branch-governance.md)
- [Architecture](./docs/reference/architecture/architecture.md)
- [Vision](./docs/vision/README.md)

## Naming Note

Public docs and product copy now use **Hussh** and the **SSH-framed trust model**.

Some internal identifiers still use legacy `Hushh` names for compatibility:

- repo slug
- package and bundle identifiers
- cloud service names
- legacy env keys and internal plugin/class names

Those are infrastructure compatibility details, not the public product language.

## North Star

**Build the eukaryotic backbone only where the platform needs it. Make everything else feel bacterial: small, modular, self-contained, and easy to reuse.**

In practice, that means:

- small public command surface
- modular docs
- self-contained scripts
- minimal contributor cognitive load

Hussh exists to make consented, scoped, zero-knowledge AI feel straightforward to use and straightforward to build on.
