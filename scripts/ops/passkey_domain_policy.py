"""Exact hosted-domain policy derived from the existing passkey catalog."""

from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

CATALOG = (
    Path(__file__).resolve().parents[2]
    / "hushh-webapp/lib/vault/passkey-domain-aliases.json"
)
LOCAL_RP_IDS = ("localhost", "127.0.0.1")


def related_hosts(host: str) -> tuple[str, ...]:
    aliases = json.loads(CATALOG.read_text())
    return next((tuple(pair) for pair in aliases.values() if host in pair), (host,))


def allowed_rp_ids(host: str) -> str:
    return ",".join(dict.fromkeys((*LOCAL_RP_IDS, *related_hosts(host))))


def cors_with_aliases(host: str, configured: str) -> str:
    origins = [origin.strip() for origin in configured.split(",") if origin.strip()]
    if f"https://{host}" in origins:
        origins.extend(f"https://{alias}" for alias in related_hosts(host))
    return ",".join(dict.fromkeys(origins))


def domain_expectations(origin: str, host: str) -> tuple[set[str], set[str]]:
    hosts = related_hosts(host)
    cors = (
        {f"https://{alias}" for alias in hosts}
        if len(hosts) > 1
        else {origin.rstrip("/")}
    )
    return cors, {"localhost", "127.0.0.1", *hosts}


def runtime_domain_contract(frontend_origin: str, runtime_raw: str) -> dict[str, str]:
    """Validate public CORS/passkey/webhook relationships without returning values."""
    try:
        runtime = json.loads(runtime_raw)
    except json.JSONDecodeError:
        runtime = None
    if not isinstance(runtime, dict):
        return {
            "status": "invalid_runtime_config",
            "cors": "invalid_runtime_config",
            "passkeys": "invalid_runtime_config",
            "plaid_webhook": "invalid_runtime_config",
        }

    origin = urlsplit(frontend_origin)
    host = (origin.hostname or "").lower()
    if not host:
        return {
            "status": "invalid_frontend_origin",
            "cors": "invalid_frontend_origin",
            "passkeys": "invalid_frontend_origin",
            "plaid_webhook": "invalid_frontend_origin",
        }

    cors_values = {
        item.strip().rstrip("/")
        for item in str(runtime.get("cors_allowed_origins") or "").split(",")
        if item.strip()
    }
    expected_cors, expected_passkey_hosts = domain_expectations(frontend_origin, host)
    cors_status = "valid" if expected_cors.issubset(cors_values) else "mismatch"

    passkey_hosts = {
        item.strip().lower()
        for item in str(runtime.get("passkey_allowed_rp_ids") or "").split(",")
        if item.strip()
    }
    passkey_status = "valid" if passkey_hosts == expected_passkey_hosts else "mismatch"

    plaid_url = urlsplit(str(runtime.get("plaid_webhook_url") or "").strip())
    plaid_status = (
        "valid"
        if (
            plaid_url.scheme == origin.scheme
            and plaid_url.netloc == origin.netloc
            and plaid_url.path == "/api/kai/plaid/webhook"
            and not plaid_url.query
            and not plaid_url.fragment
        )
        else "mismatch"
    )
    statuses = (cors_status, passkey_status, plaid_status)
    return {
        "status": "valid"
        if all(status == "valid" for status in statuses)
        else "mismatch",
        "cors": cors_status,
        "passkeys": passkey_status,
        "plaid_webhook": plaid_status,
    }


def expected_oauth_redirect_uri(
    app_frontend_origin: str | None, return_path: str
) -> str | None:
    parsed = urlsplit((app_frontend_origin or "").strip())
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        return None
    origin = urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))
    return f"{origin}{return_path}"
