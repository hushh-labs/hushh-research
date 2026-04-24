#!/usr/bin/env python3
"""End-to-end diagnostic for the Plaid -> Alpaca funding -> trading pipeline.

Run from consent-protocol/:
    python scripts/test_funding_e2e_diagnostic.py

This script validates each step of the funding flow and separates
configuration, DNS/transport reachability, and credential/auth failures.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import socket
import sys
import traceback
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from dotenv import load_dotenv

# Add project root to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


# --------------------------------------------------------------------
# Utilities
# --------------------------------------------------------------------

PASS = "\033[92mPASS\033[0m"
FAIL = "\033[91mFAIL\033[0m"
WARN = "\033[93mWARN\033[0m"
INFO = "\033[94mINFO\033[0m"
HEADER = "\033[1;36m"
RESET = "\033[0m"

results: list[dict] = []


def section(title: str) -> None:
    print(f"\n{HEADER}{'=' * 60}{RESET}")
    print(f"{HEADER}  {title}{RESET}")
    print(f"{HEADER}{'=' * 60}{RESET}")


def check(name: str, passed: bool, detail: str = "") -> bool:
    status = PASS if passed else FAIL
    print(f"  {status}  {name}")
    if detail:
        print(f"         {detail}")
    results.append({"name": name, "passed": passed, "detail": detail})
    return passed


def warn_check(name: str, detail: str = "") -> None:
    print(f"  {WARN}  {name}")
    if detail:
        print(f"         {detail}")
    results.append({"name": name, "passed": True, "detail": f"WARNING: {detail}"})


def info(msg: str) -> None:
    print(f"  {INFO}  {msg}")


def _mask_value(value: str, *, prefix: int = 8) -> str:
    text = value.strip()
    if not text:
        return "EMPTY"
    if len(text) <= prefix:
        return "*" * len(text)
    return f"{text[:prefix]}..."


def _plaid_targets_real_bank_host(value: str) -> bool:
    return value.strip().lower() in {
        "production",
        "prod",
        "live",
        "trial",
        "limited_production",
        "limited-production",
    }


def _alpaca_targets_live_host(value: str) -> bool:
    return value.strip().lower() in {"production", "prod", "live"}


def _resolve_host(host: str) -> tuple[bool, str]:
    try:
        return True, socket.gethostbyname(host)
    except Exception as exc:
        return False, f"{exc.__class__.__name__}: {exc}"


async def _probe_https(url: str) -> tuple[bool, str]:
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(10.0, connect=5.0),
            follow_redirects=True,
        ) as client:
            response = await client.get(url)
        return True, f"status={response.status_code}"
    except Exception as exc:
        return False, f"{exc.__class__.__name__}: {exc}"


def _alpaca_auth_mode_from_env() -> str:
    if _clean_env("ALPACA_BROKER_AUTH_TOKEN", "BROKER_TOKEN", "ALPACA_AUTH_TOKEN"):
        return "static_token"
    if _clean_env("ALPACA_BROKER_CLIENT_ID") and _clean_env("ALPACA_BROKER_CLIENT_SECRET"):
        return "client_credentials"
    if _clean_env("ALPACA_BROKER_KEY_ID", "APCA_API_KEY_ID", "ALPACA_API_KEY") and _clean_env(
        "ALPACA_BROKER_SECRET",
        "APCA_API_SECRET_KEY",
        "ALPACA_API_SECRET",
    ):
        return "legacy_basic"
    return "none"


def _clean_env(*keys: str) -> str:
    for key in keys:
        value = os.getenv(key, "").strip()
        if value:
            return value
    return ""


def _print_account_summary(response_payload: dict | list) -> None:
    if isinstance(response_payload, list):
        account_count = len(response_payload)
        check("broker_api_call_ok", True, f"Found {account_count} account(s) in response")
        if account_count > 0 and isinstance(response_payload[0], dict):
            first_account = response_payload[0]
            info(f"First account ID: {first_account.get('id', 'N/A')}")
            info(f"Account status: {first_account.get('status', 'N/A')}")
        return

    if isinstance(response_payload, dict):
        accounts = response_payload.get("accounts", response_payload.get("data", []))
        count_detail = len(accounts) if isinstance(accounts, list) else "N/A"
        check("broker_api_call_ok", True, f"Response type: dict, accounts count: {count_detail}")
        return

    check("broker_api_call_ok", True, f"Response type: {type(response_payload).__name__}")


# --------------------------------------------------------------------
# Step 1: Configuration Readiness
# --------------------------------------------------------------------


def test_configuration() -> None:
    section("Step 1: Configuration Readiness")

    plaid_client_id = _clean_env("PLAID_CLIENT_ID")
    plaid_secret = _clean_env("PLAID_SECRET")
    plaid_env = _clean_env("PLAID_ENV") or "sandbox"
    normalized_plaid_env = "production" if _plaid_targets_real_bank_host(plaid_env) or plaid_env.lower() == "development" else "sandbox"
    plaid_base_url = (
        "https://production.plaid.com"
        if normalized_plaid_env == "production"
        else "https://sandbox.plaid.com"
    )

    check("PLAID_CLIENT_ID is set", bool(plaid_client_id), f"Value: {_mask_value(plaid_client_id)}")
    check("PLAID_SECRET is set", bool(plaid_secret), f"Length: {len(plaid_secret)} chars")
    check(
        "PLAID_ENV targets real-bank host",
        normalized_plaid_env == "production",
        f"Raw value: {plaid_env}, normalized host: {normalized_plaid_env}",
    )
    info(f"Plaid base URL: {plaid_base_url}")

    alpaca_env = _clean_env("ALPACA_ENV", "ALPACA_BROKER_ENV") or "sandbox"
    broker_auth_mode = _alpaca_auth_mode_from_env()
    normalized_alpaca_env = "live" if _alpaca_targets_live_host(alpaca_env) else "sandbox"
    alpaca_base_url = (
        "https://broker-api.alpaca.markets"
        if normalized_alpaca_env == "live"
        else "https://broker-api.sandbox.alpaca.markets"
    )

    check(
        "Alpaca broker auth mode configured",
        broker_auth_mode != "none",
        f"Mode: {broker_auth_mode}",
    )
    if broker_auth_mode == "client_credentials":
        broker_client_id = _clean_env("ALPACA_BROKER_CLIENT_ID")
        broker_client_secret = _clean_env("ALPACA_BROKER_CLIENT_SECRET")
        check("ALPACA_BROKER_CLIENT_ID is set", True, f"Value: {_mask_value(broker_client_id)}")
        check(
            "ALPACA_BROKER_CLIENT_SECRET is set",
            True,
            f"Length: {len(broker_client_secret)} chars",
        )
    elif broker_auth_mode == "legacy_basic":
        broker_key_id = _clean_env("ALPACA_BROKER_KEY_ID", "APCA_API_KEY_ID", "ALPACA_API_KEY")
        broker_secret = _clean_env(
            "ALPACA_BROKER_SECRET",
            "APCA_API_SECRET_KEY",
            "ALPACA_API_SECRET",
        )
        check("ALPACA_BROKER_KEY_ID is set", True, f"Value: {_mask_value(broker_key_id)}")
        check("ALPACA_BROKER_SECRET is set", True, f"Length: {len(broker_secret)} chars")
    elif broker_auth_mode == "static_token":
        broker_token = _clean_env("ALPACA_BROKER_AUTH_TOKEN", "BROKER_TOKEN", "ALPACA_AUTH_TOKEN")
        check("ALPACA_BROKER_AUTH_TOKEN is set", True, f"Value: {_mask_value(broker_token)}")

    check(
        "ALPACA_ENV targets live broker host",
        normalized_alpaca_env == "live",
        f"Raw value: {alpaca_env}, normalized host: {normalized_alpaca_env}",
    )
    info(f"Alpaca Broker base URL: {alpaca_base_url}")

    connect_client_id = _clean_env("ALPACA_CONNECT_CLIENT_ID")
    connect_client_secret = _clean_env("ALPACA_CONNECT_CLIENT_SECRET")
    connect_redirect_uri = _clean_env("ALPACA_CONNECT_REDIRECT_URI")
    check(
        "ALPACA_CONNECT_CLIENT_ID is set",
        bool(connect_client_id),
        f"Value: {_mask_value(connect_client_id, prefix=12)}",
    )
    check(
        "ALPACA_CONNECT_CLIENT_SECRET is set",
        bool(connect_client_secret),
        f"Length: {len(connect_client_secret)} chars",
    )
    if connect_redirect_uri:
        check("ALPACA_CONNECT_REDIRECT_URI is set", True, f"Value: {connect_redirect_uri}")
        if connect_redirect_uri.startswith("https://localhost"):
            warn_check(
                "Alpaca Connect redirect uses https://localhost",
                "This can work only if the Alpaca app explicitly allows it. Use a public HTTPS origin for production validation.",
            )
    else:
        check("ALPACA_CONNECT_REDIRECT_URI is set", False, "EMPTY - Alpaca OAuth will fail")

    funding_key = _clean_env("FUNDING_SECRET_ENCRYPTION_KEY")
    plaid_token_key = _clean_env("PLAID_TOKEN_ENCRYPTION_KEY")
    has_encryption_key = bool(funding_key or plaid_token_key)
    check(
        "Encryption key is set",
        has_encryption_key,
        "FUNDING_SECRET_ENCRYPTION_KEY="
        f"{'set' if funding_key else 'empty'}, PLAID_TOKEN_ENCRYPTION_KEY="
        f"{'set' if plaid_token_key else 'empty'}",
    )

    plaid_redirect_uri = _clean_env("PLAID_REDIRECT_URI")
    if plaid_redirect_uri:
        info(f"Plaid redirect URI: {plaid_redirect_uri}")
        if normalized_plaid_env == "production" and plaid_redirect_uri.startswith("http://"):
            warn_check(
                "Plaid production requires HTTPS redirect URI",
                f"Current: {plaid_redirect_uri} - production Plaid will reject HTTP redirects.",
            )


# --------------------------------------------------------------------
# Step 2: Plaid API Connectivity
# --------------------------------------------------------------------


async def test_plaid_connectivity() -> None:
    section("Step 2: Plaid API Connectivity")

    try:
        from hushh_mcp.integrations.plaid import PlaidHttpClient, PlaidRuntimeConfig

        config = PlaidRuntimeConfig.from_env()
        check(
            "PlaidRuntimeConfig.configured",
            config.configured,
            f"env={config.environment}, base_url={config.base_url}",
        )

        parsed = urlsplit(config.base_url)
        host_resolution_ok, host_resolution_detail = _resolve_host(parsed.netloc)
        check("plaid_host_resolution_ok", host_resolution_ok, host_resolution_detail)

        plaid_http_ok, plaid_http_detail = await _probe_https(config.base_url)
        check("plaid_http_reachable", plaid_http_ok, plaid_http_detail)

        if not config.configured:
            check("plaid_auth_ok", False, "Skipping - not configured")
            return

        client = PlaidHttpClient(config)
        info("Testing Plaid /link/token/create endpoint...")
        try:
            response = await client.post(
                "/link/token/create",
                {
                    "client_name": config.client_name,
                    "user": {"client_user_id": "diagnostic_test_user"},
                    "country_codes": list(config.country_codes),
                    "language": config.language,
                    "products": ["auth"],
                    "account_filters": {
                        "depository": {
                            "account_subtypes": ["checking", "savings"],
                        },
                    },
                },
            )
            link_token = str(response.get("link_token") or "")
            expiration = str(response.get("expiration") or "")
            check(
                "plaid_auth_ok",
                bool(link_token),
                f"link_token={_mask_value(link_token, prefix=20)}, expires={expiration}",
            )
        except Exception as exc:
            detail = str(exc)
            check("plaid_auth_ok", False, detail)
            if "INVALID_API_KEYS" in detail or "INVALID_CREDENTIALS" in detail:
                warn_check(
                    "Plaid credential mismatch",
                    f"Check the Plaid dashboard secret for host {config.base_url}.",
                )

    except ImportError as exc:
        check("Plaid integration module import", False, str(exc))
    except Exception as exc:
        check("Plaid connectivity test", False, f"{exc.__class__.__name__}: {exc}")


# --------------------------------------------------------------------
# Step 3: Alpaca Broker API Connectivity
# --------------------------------------------------------------------


async def test_alpaca_connectivity() -> None:
    section("Step 3: Alpaca Broker API Connectivity")

    try:
        from hushh_mcp.integrations.alpaca import AlpacaBrokerHttpClient, AlpacaBrokerRuntimeConfig

        config = AlpacaBrokerRuntimeConfig.from_env()
        check(
            "AlpacaBrokerRuntimeConfig.configured",
            config.configured,
            f"env={config.environment}, base_url={config.base_url}, auth_mode={config.auth_strategy}",
        )

        if not config.configured:
            check("broker_token_exchange_ok", False, "Skipping - not configured")
            check("broker_api_call_ok", False, "Skipping - not configured")
            return

        if config.auth_strategy == "authx_client_credentials":
            info("Testing Alpaca AuthX client_credentials token exchange...")
            try:
                async with httpx.AsyncClient(
                    timeout=httpx.Timeout(10.0, connect=5.0),
                ) as client:
                    token_response = await client.post(
                        str(config.authx_token_url),
                        data={
                            "grant_type": "client_credentials",
                            "client_id": str(config.authx_client_id),
                            "client_secret": str(config.authx_client_secret),
                        },
                        headers={"Content-Type": "application/x-www-form-urlencoded"},
                    )
                token_payload = token_response.json()
                access_token = str(token_payload.get("access_token") or "")
                check(
                    "broker_token_exchange_ok",
                    token_response.status_code < 400 and bool(access_token),
                    "status="
                    f"{token_response.status_code}, token_type={token_payload.get('token_type')}, "
                    f"expires_in={token_payload.get('expires_in')}",
                )
                if not access_token:
                    check("broker_api_call_ok", False, "Skipping - token exchange failed")
                    return

                auth_header = f"{token_payload.get('token_type', 'Bearer')} {access_token}"
                async with httpx.AsyncClient(
                    base_url=config.base_url,
                    timeout=httpx.Timeout(10.0, connect=5.0),
                ) as client:
                    response = await client.get(
                        "/v1/accounts",
                        params={"query": "", "limit": "1"},
                        headers={"Authorization": auth_header, "Accept": "application/json"},
                    )
                if response.is_error:
                    detail = response.text or f"HTTP {response.status_code}"
                    check("broker_api_call_ok", False, detail)
                    return
                _print_account_summary(response.json())
                return
            except Exception as exc:
                check("broker_token_exchange_ok", False, str(exc))
                check("broker_api_call_ok", False, "Skipping - token exchange failed")
                return

        check(
            "broker_token_exchange_ok",
            True,
            f"Auth mode {config.auth_strategy} does not require token exchange.",
        )
        client = AlpacaBrokerHttpClient(config)
        info("Testing Alpaca Broker /v1/accounts endpoint...")
        try:
            response = await client.get("/v1/accounts", params={"query": "", "limit": "1"})
            _print_account_summary(response)
        except Exception as exc:
            error_msg = str(exc)
            check("broker_api_call_ok", False, error_msg)
            if "401" in error_msg or "403" in error_msg:
                warn_check(
                    "Alpaca Broker API authentication failed",
                    "Check the configured Broker auth mode and credentials for this environment.",
                )

    except ImportError as exc:
        check("Alpaca integration module import", False, str(exc))
    except Exception as exc:
        check("Alpaca connectivity test", False, f"{exc.__class__.__name__}: {exc}")


# --------------------------------------------------------------------
# Step 4: Alpaca Connect OAuth Configuration
# --------------------------------------------------------------------


def test_alpaca_connect_config() -> None:
    section("Step 4: Alpaca Connect OAuth Configuration")

    try:
        from hushh_mcp.services.broker_funding_service import BrokerFundingService

        service = BrokerFundingService()
        config = service._alpaca_connect_config()

        check(
            "Alpaca Connect fully configured",
            config.get("configured", False),
            f"Missing: {config.get('missing_required', [])}",
        )
        info(f"Authorize URL: {config.get('authorize_url', 'N/A')}")
        info(f"Token URL: {config.get('token_url', 'N/A')}")
        info(f"Redirect URI: {config.get('redirect_uri', 'N/A')}")
        info(f"Scopes: {config.get('scopes', [])}")
        info(f"OAuth env: {config.get('oauth_env', 'N/A')}")
        info(f"Session TTL: {config.get('ttl_seconds', 'N/A')}s")

    except Exception as exc:
        check("Alpaca Connect config check", False, f"{exc.__class__.__name__}: {exc}")


# --------------------------------------------------------------------
# Step 5: Encryption Key Round-Trip
# --------------------------------------------------------------------


def test_encryption_roundtrip() -> None:
    section("Step 5: Encryption Key Round-Trip (AES-256-GCM)")

    try:
        from hushh_mcp.services.broker_funding_service import BrokerFundingService

        service = BrokerFundingService()
        test_plaintext = "processor-test-token-abc123"
        info(f"Encrypting test payload: '{test_plaintext}'")

        envelope = service._encrypt_secret(test_plaintext)
        check(
            "Encryption succeeded",
            all(k in envelope for k in ("ciphertext", "iv", "tag", "algorithm")),
            f"Algorithm: {envelope.get('algorithm', 'N/A')}, IV length: {len(envelope.get('iv', ''))}",
        )

        decrypted = service._decrypt_secret(
            ciphertext=envelope["ciphertext"],
            iv=envelope["iv"],
            tag=envelope["tag"],
        )
        check(
            "Decryption round-trip matches",
            decrypted == test_plaintext,
            f"Decrypted: '{decrypted}'",
        )

    except Exception as exc:
        check("Encryption round-trip", False, f"{exc.__class__.__name__}: {exc}")
        traceback.print_exc()


# --------------------------------------------------------------------
# Step 6: Database Funding Tables
# --------------------------------------------------------------------


def test_database_tables() -> None:
    section("Step 6: Database Funding Tables")

    required_tables = [
        "kai_funding_brokerage_accounts",
        "kai_funding_plaid_items",
        "kai_funding_plaid_accounts",
        "kai_funding_consent_records",
        "kai_funding_ach_relationships",
        "kai_funding_transfers",
        "kai_funding_transfer_events",
        "kai_funding_webhook_events",
        "kai_funding_reconciliation_runs",
        "kai_funding_support_escalations",
        "kai_funding_alpaca_connect_sessions",
        "kai_funding_trade_intents",
        "kai_funding_trade_events",
        "kai_funding_plaid_link_sessions",
    ]

    try:
        from db.db_client import get_db

        db = get_db()
        info("Database connection established")

        query_failed_due_to_local_connectivity = False
        for table in required_tables:
            try:
                result = db.execute_raw(
                    "SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_name = :table_name",
                    {"table_name": table},
                )
                exists = result.data[0]["cnt"] > 0 if result.data else False
                detail = "exists" if exists else "MISSING - run db/migrate.py"
                check(f"Table {table}", exists, detail)
            except Exception as exc:
                message = str(exc)
                if "127.0.0.1" in message and "6543" in message and "Connection refused" in message:
                    warn_check(
                        "Database table checks skipped",
                        "Local backend database tunnel is unavailable. Start the backend with "
                        "`./bin/hushh terminal backend --mode local --reload` or "
                        "`bash scripts/runtime/run_backend_local.sh local --reload` so the "
                        "Cloud SQL proxy binds `127.0.0.1:6543`.",
                    )
                    query_failed_due_to_local_connectivity = True
                    break
                check(f"Table {table}", False, f"Query failed: {exc}")

        if query_failed_due_to_local_connectivity:
            for table in required_tables:
                info(f"  (skipped) {table}")

    except Exception as exc:
        warn_check(
            "Database connection failed",
            f"{exc.__class__.__name__}: {exc}. "
            "This is expected if Cloud SQL Proxy is not running. "
            "Start it with: cloud-sql-proxy hushh-pda-uat:us-central1:hushh-uat-pg --port=6543",
        )
        for table in required_tables:
            info(f"  (skipped) {table}")


# --------------------------------------------------------------------
# Step 7: Funding Service Readiness Summary
# --------------------------------------------------------------------


def test_funding_service_readiness() -> None:
    section("Step 7: Funding Service Readiness Summary")

    try:
        from hushh_mcp.services.broker_funding_service import BrokerFundingService

        service = BrokerFundingService()
        status = service.configuration_status()

        for key, value in status.items():
            if isinstance(value, bool):
                if value:
                    check(key, True, "")
                else:
                    check(key, False, "NOT READY")
            else:
                info(f"{key}: {value}")

    except Exception as exc:
        check("Funding service readiness", False, f"{exc.__class__.__name__}: {exc}")


# --------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------


def print_summary() -> None:
    section("AUDIT SUMMARY")

    passed = sum(1 for result in results if result["passed"])
    failed = sum(1 for result in results if not result["passed"])
    total = len(results)

    print(f"\n  Total checks: {total}")
    print(f"  {PASS}: {passed}")
    print(f"  {FAIL}: {failed}")

    if failed > 0:
        print(f"\n  {FAIL} Failed checks:")
        for result in results:
            if not result["passed"]:
                print(f"     - {result['name']}: {result['detail']}")

    print()
    if failed == 0:
        print(f"  {HEADER}All checks passed. The funding pipeline is ready for testing.{RESET}")
    else:
        print(f"  {HEADER}{failed} check(s) need attention before end-to-end testing.{RESET}")
    print()


# --------------------------------------------------------------------
# Main
# --------------------------------------------------------------------


async def main() -> None:
    print(f"\n{HEADER}{'=' * 60}{RESET}")
    print(f"{HEADER}  Kai Funding Pipeline - End-to-End Diagnostic{RESET}")
    print(f"{HEADER}  Plaid -> Alpaca ACH -> Transfer -> Trade{RESET}")
    print(f"{HEADER}{'=' * 60}{RESET}")

    test_configuration()
    await test_plaid_connectivity()
    await test_alpaca_connectivity()
    test_alpaca_connect_config()
    test_encryption_roundtrip()
    test_database_tables()
    test_funding_service_readiness()
    print_summary()


if __name__ == "__main__":
    asyncio.run(main())
