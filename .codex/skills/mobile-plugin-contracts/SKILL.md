---
name: mobile-plugin-contracts
description: Use when implementing or reviewing Capacitor plugin contracts, native plugin registration, or platform bridge alignment across iOS and Android.
---

# Hushh Mobile Plugin Contracts Skill

## Purpose and Trigger

- Primary scope: `mobile-plugin-contracts`
- Trigger on Capacitor plugin contracts, native plugin registration, platform bridge alignment, and service-to-plugin interface work.
- Avoid overlap with `mobile-parity-audit` and `frontend-architecture`.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `mobile-native`

Owned repo surfaces:

1. `hushh-webapp/lib/capacitor`
2. `hushh-webapp/ios/App/App/Plugins`
3. `hushh-webapp/android/app/src/main`

Non-owned surfaces:

1. `mobile-native`
2. `frontend`
3. `backend`

## Do Use

1. Creating or updating native plugins and their TypeScript bridge contracts.
2. Plugin registration and method-name alignment across iOS, Android, and service-layer callers.
3. Reviewing plugin boundary drift between native and web paths.

## Do Not Use

1. Broad native parity or release-readiness work.
2. Broad frontend or backend intake.
3. Cross-domain repo mapping.

## Read First

1. `docs/guides/new-feature.md`
2. `hushh-webapp/ios/App/App/MyViewController.swift`
3. `hushh-webapp/android/app/src/main/AndroidManifest.xml`

## Workflow

1. Verify the TypeScript bridge, plugin registration, and native implementation paths first.
2. Keep plugin method names and service-layer contracts aligned across platforms.
3. Treat service-layer native/web branching as part of the same contract, not a follow-up.

## Handoff Rules

1. If the request is still broad or ambiguous, route it back to `mobile-native`.
2. If the task is parity or release-readiness rather than plugin contracts, use `mobile-parity-audit`.
3. If the work becomes broad web-frontend or backend architecture, route to `frontend` or `backend`.

## Required Checks

```bash
cd hushh-webapp && npm run typecheck
cd hushh-webapp && npm run cap:build
```
