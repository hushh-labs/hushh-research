# Bacterial Software Architecture

## Visual Context

Canonical visual owner: [Hussh Vision](./README.md). This page defines the
public engineering north star beneath that product and platform vision.

## North Star

Hussh uses a eukaryotic monorepo backbone while maximizing bacterial software
at its edges.

The backbone coordinates the concerns that must remain canonical: identity,
consent, cryptography, persistence, schemas, generated contracts, routing,
audit, and cross-surface compatibility. Inside that backbone, contributors
should prefer small, modular, self-contained capabilities that another project
could understand, test, and reuse without learning the whole repository.

The test is intentionally memorable: could another contributor “yoink” this
bounded capability and gain value without copying half the platform?

## Three Scales

### Gene

A gene is the smallest useful capability:

- one purpose with explicit typed inputs and outputs;
- deterministic or explicit about every side effect;
- import-safe, with no network, model, environment, or mutable-global startup;
- independently testable with a small fixture;
- dependent only on standard libraries or narrow value contracts where practical.

Pure calculations, normalization, parsing, policy, and value objects are strong
gene candidates.

### Operon

An operon is a cohesive group of genes that provides one bounded capability:

- a deliberately small public API;
- explicit ports for storage, providers, clocks, randomness, and model calls;
- adapters replaceable without changing the domain contract;
- no hidden reach into unrelated services or application state;
- focused contract tests plus hermetic tests for its genes.

An operon may depend on the backbone through declared interfaces. It must not
copy or weaken the authority owned by that backbone.

### Organ

An organ coordinates behavior that is intentionally coupled:

- trust, consent, identity, vault, and cryptographic authority;
- durable storage, migrations, and shared schemas;
- generated registries and cross-surface contracts;
- routing, orchestration, streaming, and product-level workflows.

Organs expose stable contracts and compose operons. They are not expected to be
copy-pasteable, but they should keep their leaf capabilities replaceable and
their dependency direction explicit.

## Compatibility-Preserving Retrofit

Working behavior is the baseline. A structural improvement is incomplete if it
breaks an existing output, public import, API, schema, generated artifact,
consent decision, error contract, provider fallback, stream order, or user flow.

Corrective work therefore follows a ratchet:

1. characterize the existing contract before moving it;
2. add the new gene or operon behind the existing entrypoint;
3. preserve old imports and callers with a compatibility facade;
4. migrate one bounded consumer set at a time;
5. compare behavior and performance using the owning subsystem's checks;
6. remove the facade only after callers and compatibility obligations are gone;
7. keep each extraction independently reversible.

Repository fitness checks begin as advisory. After a representative extraction
proves the rule, they block only new violations and regressions against the
accepted baseline. Existing debt is burned down deliberately; it is not hidden
by arbitrary file splitting.

## What This Rule Does Not Mean

- Do not duplicate cryptography, consent, IAM, schemas, persistence rules, or
  generated contracts to make a module look self-contained.
- Do not split cohesive code only to satisfy a line count.
- Do not introduce a second router, agent lattice, skill taxonomy, or source of
  truth.
- Do not trade correctness, security, reliability, or compatibility for a
  portable-looking abstraction.

The goal is a thriving contributor ecology on top of one trustworthy platform:
small enough to reuse, coordinated enough to build complex life.
