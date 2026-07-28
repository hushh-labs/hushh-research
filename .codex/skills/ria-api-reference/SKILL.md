---
name: ria-api-reference
description: Use when working on hussh Research RIA, CRD scraping, or financial verification API integration so Codex reads the canonical RIA Intelligence API docs before changing routes, proxies, tests, or docs.
---

# Hussh RIA API Reference Skill

## Purpose and Trigger

- Primary scope: `ria-api-reference`
- Trigger on hussh Research RIA, CRD scraping, BrokerCheck, IAPD, financial-verification, or `/api/ria/...` facade work.
- Avoid overlap with `backend-api-contracts` for general API work and `docs-governance` for documentation-home decisions.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `backend`

Owned repo surfaces:

1. `docs/reference/architecture/crd-scraping-api.md`
2. `consent-protocol/api/routes/crd_scraper.py`
3. `consent-protocol/hushh_mcp/services/crd_scrape_proxy_service.py`
4. `consent-protocol/tests/test_crd_scraper_routes.py`

Non-owned surfaces:

1. `backend`
2. `backend-api-contracts`
3. `docs-governance`

## Do Use

1. RIA, CRD scraping, and financial-professional verification route or proxy changes in hussh Research.
2. Work that must align `/api/ria/...` facade behavior with the standalone hussh RIA Intelligence API.
3. RIA API docs, tests, env references, or endpoint examples that depend on the provider contract.

## Do Not Use

1. Do not build a second BrokerCheck/IAPD scraper inside hussh Research.
2. Do not treat chat history, memory, or stale examples as the API contract when provider docs are available.
3. Do not use this for unrelated RIA marketplace, onboarding, analytics, or relationship-sharing work.

## Read First

1. `docs/reference/architecture/crd-scraping-api.md`
2. `docs/reference/architecture/api-contracts.md`
3. `consent-protocol/api/routes/crd_scraper.py`
4. `consent-protocol/hushh_mcp/services/crd_scrape_proxy_service.py`

## Workflow

1. Classify the user's RIA/API claim before changing code: `already_exists`, `partially_exists`, `missing`, `future_state_only`, `wrong_direction`, or `needs_verification`.
2. Treat the standalone `hushh-ria-intelligence-api` repository as the canonical contract for `/v1/crd-scrape-jobs` and `/v1/financial-verification-jobs`. Its docs are not vendored here, so confirm the provider contract against that repository (or a maintainer) rather than inferring it from this facade; never guess a provider payload.
3. Then inspect the hussh Research facade docs, route, proxy service, and tests listed in owned surfaces.
4. Keep hussh Research simple: forward to the provider, preserve payloads, record provider errors clearly, and avoid adding scraper logic here.
5. Keep official regulatory sources labeled as regulatory truth and open-web enrichment labeled separately, matching the provider docs.

## Handoff Rules

1. If the request is still broad or ambiguous, route it back to `backend`.
2. If the task changes generic route contracts outside `/api/ria/...`, use `backend-api-contracts`.
3. If the task is only docs placement or consolidation, use `docs-governance`.

## Required Checks

```bash
python3 .codex/skills/codex-skill-authoring/scripts/skill_lint.py
cd consent-protocol && PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 uv run pytest --noconftest tests/test_crd_scraper_routes.py -q
```
