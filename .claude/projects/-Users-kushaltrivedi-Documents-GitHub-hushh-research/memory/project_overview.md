---
name: Hushh Research Project Overview
description: Monorepo structure, tech stack, core product guarantees (BYOK, Consent-First, Zero-Knowledge, Tri-Flow), and directory layout
type: project
---

Hushh Research is a personal-agent platform with four core guarantees: Consent + scoped access, BYOK (user holds the key), Zero-knowledge backend storage, and Tri-flow delivery (web, iOS, Android).

**Why:** Agents should work for the person whose life they touch. Data stays encrypted, consent is a programmable boundary.

**How to apply:** Every code change must respect these four invariants. No bypasses, no implicit access.

## Monorepo Structure
- `hushh-webapp/` — Next.js 16 + React 19 + Capacitor 8 frontend (investor Kai + RIA advisor personas)
- `consent-protocol/` — FastAPI backend (Python 3.13), Google ADK agents, Supabase/PostgreSQL
- `docs/` — Architecture, operations, and reference documentation

## Key Stack
- Frontend: React 19, Next.js 16, Tailwind 4, shadcn/ui + Morphy UX, Zustand, Capacitor 8
- Backend: FastAPI, asyncpg, Google ADK v1.23.0 (Gemini), Firebase Auth, MCP v1.26.0
- Encryption: X25519 + AESGCM + PBKDF2
- Real-time: PostgreSQL NOTIFY + SSE + FCM push

## Architecture (DNA Model)
Backend layers: Agent → Tool → Operon → Service (strict dependency rules)
- Agents orchestrate, enforce consent at entry
- Tools are @hushh_tool decorated, LLM-callable
- Operons hold business logic (PURE/IMPURE)
- Services are the only layer touching the database

## Dual-Persona Model
Users can switch between "investor" (Kai financial analysis) and "ria" (advisor) personas. Each has its own home, workspace, and connection surfaces.

## Command Surface
- `npm run bootstrap` → `npm run web -- --profile=uat-remote`
- Backend: `make local-backend` or `uvicorn server:app`
