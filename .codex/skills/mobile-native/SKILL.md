---
name: mobile-native
description: Use when the request is broadly about iOS, Android, Capacitor plugins, or native parity and the correct mobile specialist skill is not yet clear.
---

# Hushh Mobile Native Skill

## Purpose and Trigger

- Primary scope: `mobile-native-intake`
- Trigger on broad native requests across iOS, Android, Capacitor plugins, parity, and device-specific runtime behavior.
- Avoid overlap with `frontend`, `backend`, and `repo-context`.

## Coverage and Ownership

- Role: `owner`
- Owner family: `mobile-native`

Owned repo surfaces:

1. `hushh-webapp/ios`
2. `hushh-webapp/android`

Non-owned surfaces:

1. `frontend`
2. `backend`
3. `docs-governance`

## Do Use

1. Broad native intake before the correct spoke is clear.
2. Mobile parity, plugin registration, native runtime behavior, and release-readiness questions.
3. Choosing whether work belongs to plugin contracts or parity audit specialists.

## Do Not Use

1. Pure web-only frontend work.
2. Backend-only or trust-only work without a native surface.
3. Broad repo mapping before the domain itself is known.

## Read First

1. `docs/reference/mobile/README.md`
2. `docs/guides/new-feature.md`
3. `hushh-webapp/ios/App/CapApp-SPM/README.md`

## Workflow

1. Decide whether the task is plugin-contract work or parity/audit work.
2. Keep native registration and service-layer contracts aligned across web, iOS, and Android.
3. Route trust and consent boundary questions into `security-audit` when native is only one part of the problem.

## Handoff Rules

1. Route plugin implementation and registration work to `mobile-plugin-contracts`.
2. Route parity, release-readiness, and native audit work to `mobile-parity-audit`.
3. If the request is broad repo mapping, start with `repo-context`.
4. If the task becomes broad web-frontend work, route it to `frontend`.

## Required Checks

```bash
cd hushh-webapp && npm run typecheck
cd hushh-webapp && npm run cap:build
```
