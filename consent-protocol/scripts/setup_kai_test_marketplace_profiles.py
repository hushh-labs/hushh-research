#!/usr/bin/env python3
"""
Set up the Kai test user with both investor and RIA marketplace profiles.

This ensures the Kai test user appears in the marketplace for both personas,
allowing manual testing of the connection flow where the same user acts as
both investor and RIA.

Usage:
    python scripts/setup_kai_test_marketplace_profiles.py
"""

from __future__ import annotations

import json
import os
import sys
import time
from typing import Any

import jwt
import requests
from dotenv import dotenv_values

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROTOCOL_DIR = os.path.dirname(SCRIPT_DIR)
WEBAPP_DIR = os.path.join(os.path.dirname(PROTOCOL_DIR), "hushh-webapp")

DEFAULT_BACKEND_URL = "http://localhost:8000"
DEFAULT_PROTOCOL_ENV = os.path.join(PROTOCOL_DIR, ".env")
DEFAULT_WEBAPP_ENV = os.path.join(WEBAPP_DIR, ".env.local")


def _require(config: dict[str, str | None], key: str) -> str:
    value = str(config.get(key) or os.getenv(key) or "").strip()
    if not value:
        raise RuntimeError(f"Missing required config: {key}")
    return value


def log(msg: str) -> None:
    print(f"[setup-profiles] {msg}")


def authenticate(
    config: dict[str, str | None], backend_url: str, timeout: int = 30
) -> dict[str, str]:
    """Authenticate as the Kai test user and return auth headers."""
    user_id = _require(config, "KAI_TEST_USER_ID")
    firebase_auth_sa = json.loads(_require(config, "FIREBASE_AUTH_SERVICE_ACCOUNT_JSON"))
    firebase_api_key = _require(config, "NEXT_PUBLIC_AUTH_FIREBASE_API_KEY")

    now = int(time.time())
    custom_token = jwt.encode(
        {
            "iss": firebase_auth_sa["client_email"],
            "sub": firebase_auth_sa["client_email"],
            "aud": "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
            "uid": user_id,
            "iat": now,
            "exp": now + 3600,
        },
        firebase_auth_sa["private_key"],
        algorithm="RS256",
    )
    response = requests.post(
        f"https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key={firebase_api_key}",
        json={"token": custom_token, "returnSecureToken": True},
        timeout=timeout,
    )
    if response.status_code != 200:
        raise RuntimeError(f"Firebase auth failed: {response.text[:500]}")

    id_token = response.json()["idToken"]
    log(f"Authenticated as user_id={user_id}")
    return {"Authorization": f"Bearer {id_token}"}


def api(
    method: str,
    backend_url: str,
    path: str,
    headers: dict[str, str],
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Make an API request and return JSON response."""
    url = f"{backend_url.rstrip('/')}{path}"
    merged_headers = {**headers}
    if payload is not None:
        merged_headers["Content-Type"] = "application/json"
    resp = requests.request(method, url, headers=merged_headers, json=payload, timeout=30)
    body = (
        resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
    )
    if resp.status_code >= 400:
        log(f"  {method} {path} -> {resp.status_code}: {json.dumps(body, indent=2)[:500]}")
    return body


def _enrich_investor_marketplace_profile(config: dict[str, str | None]) -> None:
    """Update investor marketplace profile with rich metadata directly in DB."""
    import asyncio

    import asyncpg

    user_id = _require(config, "KAI_TEST_USER_ID")
    db_host = str(config.get("DB_HOST") or "127.0.0.1").strip()
    db_port = int(config.get("DB_PORT") or "6543")
    db_name = str(config.get("DB_NAME") or "postgres").strip()
    db_user = str(config.get("DB_USER") or "postgres").strip()
    db_password = str(config.get("DB_PASSWORD") or "").strip()

    async def _run() -> None:
        conn = await asyncpg.connect(
            host=db_host,
            port=db_port,
            database=db_name,
            user=db_user,
            password=db_password,
        )
        try:
            await conn.execute(
                """
                UPDATE marketplace_public_profiles
                SET
                  display_name = $2,
                  headline = $3,
                  location_hint = $4,
                  strategy_summary = $5,
                  updated_at = NOW()
                WHERE user_id = $1
                  AND profile_type = 'investor'
                """,
                user_id,
                "Kai Test Investor",
                "Diversified portfolio with growth and value exposure",
                "San Francisco, CA",
                "Balanced allocation across tech, healthcare, and financial sectors with quality bias and moderate risk tolerance.",
            )
            log(
                "  Investor marketplace profile enriched with display name, headline, location, strategy."
            )
        finally:
            await conn.close()

    asyncio.run(_run())


def main() -> int:
    protocol_cfg = dotenv_values(DEFAULT_PROTOCOL_ENV)
    web_cfg = dotenv_values(DEFAULT_WEBAPP_ENV)
    config = {**protocol_cfg, **web_cfg}
    backend_url = DEFAULT_BACKEND_URL

    # Check backend is reachable
    try:
        health = requests.get(f"{backend_url}/health", timeout=5)
        log(f"Backend health: {health.status_code}")
    except Exception as e:
        log(f"Backend not reachable at {backend_url}: {e}")
        return 1

    auth_headers = authenticate(config, backend_url)

    # ─── Step 1: Ensure investor marketplace opt-in ───
    log("Step 1: Enabling investor marketplace opt-in...")
    opt_in_result = api(
        "POST", backend_url, "/api/iam/marketplace/opt-in", auth_headers, {"enabled": True}
    )
    log(f"  investor_marketplace_opt_in={opt_in_result.get('investor_marketplace_opt_in')}")

    # ─── Step 2: Update investor marketplace profile with friendly metadata ───
    log("Step 2: Enriching investor marketplace profile via DB...")
    _enrich_investor_marketplace_profile(config)

    # ─── Step 3: Ensure RIA profile via dev-activate ───
    log("Step 3: Checking RIA onboarding status...")
    ria_status = api("GET", backend_url, "/api/ria/onboarding/status", auth_headers)
    verification_status = str(ria_status.get("verification_status") or "")
    log(f"  Current RIA verification_status={verification_status}")

    if verification_status not in {"active", "finra_verified", "bypassed"}:
        log("  Activating RIA profile via dev-activate...")
        ria_activate = api(
            "POST",
            backend_url,
            "/api/ria/onboarding/dev-activate",
            auth_headers,
            {
                "display_name": "Kai Advisory Partners",
                "requested_capabilities": ["advisory"],
                "individual_legal_name": "Kai Test Advisor",
                "individual_crd": "7654321",
                "advisory_firm_legal_name": "Kai Advisory Partners LLC",
                "advisory_firm_iapd_number": "801-99999",
                "bio": "Full-service advisory practice focused on high-conviction quality compounders and tax-aware portfolio management.",
                "strategy": "Long-term quality compounders with disciplined position sizing and downside protection through diversification.",
            },
        )
        log(f"  RIA activation: verification_status={ria_activate.get('verification_status')}")
    else:
        log("  RIA profile already active, skipping activation.")

    # ─── Step 4: Set RIA marketplace discoverability ───
    log("Step 4: Enabling RIA marketplace discoverability...")
    ria_discover = api(
        "POST",
        backend_url,
        "/api/ria/marketplace/discoverability",
        auth_headers,
        {
            "enabled": True,
            "headline": "High-conviction quality investing for long-term wealth building",
            "strategy_summary": "Concentrated portfolio of durable compounders across technology, healthcare, and financial services with risk-adjusted sizing.",
        },
    )
    log(f"  RIA discoverability result: {json.dumps(ria_discover, indent=2)[:300]}")

    # ─── Step 5: Verify profiles appear in marketplace ───
    log("Step 5: Verifying marketplace visibility...")

    ria_search = api("GET", backend_url, "/api/marketplace/rias?limit=20", auth_headers)
    rias_found = ria_search if isinstance(ria_search, list) else ria_search.get("items", ria_search)
    if isinstance(rias_found, list):
        kai_ria = [r for r in rias_found if r.get("display_name", "").startswith("Kai")]
        log(f"  RIA marketplace entries (Kai-related): {len(kai_ria)}")
        for r in kai_ria:
            log(f"    - {r.get('display_name')} ({r.get('verification_status')})")
    else:
        log(f"  RIA search response: {json.dumps(rias_found, indent=2)[:300]}")

    investor_search = api("GET", backend_url, "/api/marketplace/investors?limit=20", auth_headers)
    investors_found = (
        investor_search
        if isinstance(investor_search, list)
        else investor_search.get("items", investor_search)
    )
    if isinstance(investors_found, list):
        kai_inv = [i for i in investors_found if i.get("display_name", "").startswith("Kai")]
        log(f"  Investor marketplace entries (Kai-related): {len(kai_inv)}")
        for i in kai_inv:
            log(f"    - {i.get('display_name')} ({i.get('location_hint', 'no location')})")
    else:
        log(f"  Investor search response: {json.dumps(investors_found, indent=2)[:300]}")

    # ─── Step 6: Verify persona state ───
    log("Step 6: Checking persona state...")
    persona = api("GET", backend_url, "/api/iam/persona-state", auth_headers)
    log(f"  personas={persona.get('personas')}")
    log(f"  active_persona={persona.get('active_persona')}")
    log(f"  ria_switch_available={persona.get('ria_switch_available')}")
    log(f"  investor_marketplace_opt_in={persona.get('investor_marketplace_opt_in')}")
    log(f"  iam_schema_ready={persona.get('iam_schema_ready')}")

    log("Done. Kai test user now has both investor and RIA marketplace profiles.")
    log("You can:")
    log(
        "  1. Open http://localhost:3000/marketplace to browse as investor (see 'Kai Advisory Partners')"
    )
    log("  2. Switch to RIA persona to browse as advisor (see 'Kai Test Investor')")
    log("  3. Send a connection request and accept it from the other persona")
    log("  4. View the portfolio explorer at /marketplace/connections/{connectionId}/portfolio")

    return 0


if __name__ == "__main__":
    sys.exit(main())
