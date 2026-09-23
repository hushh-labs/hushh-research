#!/usr/bin/env python3
"""Retire server-held Plaid custody: disconnect every stored Item at Plaid, then delete it.

Plaid access tokens now live sealed in each person's vault (see
api/routes/kai/plaid_vault.py). The old server-held connections in
kai_plaid_items and kai_funding_plaid_items are disconnected at Plaid with
/item/remove and their rows deleted; people re-link through the vault flow.
Run this before migration 239 drops the tables.

Dry run (default) reads counts only and makes no Plaid call and no write:
    python3 scripts/ops/plaid_server_custody_retire.py

Execute (both confirmations must match what the dry run printed):
    python3 scripts/ops/plaid_server_custody_retire.py --execute \
        --confirm-env uat --confirm-db <database_fingerprint>

Safety rails, all checked before any database or Plaid access:
- ENVIRONMENT must equal --confirm-env, and the database target's fingerprint
  must equal --confirm-db (so a UAT label cannot run against production).
- On uat and production the Plaid client must be production Plaid.

Per row: a token minted in a different Plaid environment than the client is
never sent and never deleted (counted as environment_mismatch). ITEM_NOT_FOUND
means the Item is already gone; INVALID_ACCESS_TOKEN counts as gone only when
the token's environment matches the client. Any other failure keeps the row.

Regulated funding records (transfers, trade intents and events, consent
records) are never deleted here: a funding Item they reference is revoked at
Plaid and marked 'removed', and migration 239 refuses to run while such
records exist, pending an explicit retention decision.

Idempotent: a rerun only retries rows a previous run kept. Processor tokens
(kai_funding_ach_relationships) have no Plaid remove endpoint of their own;
/item/remove on the parent Item invalidates them.

Output is counts only, plus Plaid error_code counts. Tokens, Item ids, and
user ids are never printed or logged.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import os
import sys
from collections import Counter
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hushh_mcp.integrations.plaid import (  # noqa: E402
    PlaidApiError,
    PlaidHttpClient,
    PlaidRuntimeConfig,
)
from hushh_mcp.runtime_settings import (  # noqa: E402
    get_app_runtime_settings,
    get_optional_funding_secret_encryption_key,
    get_optional_plaid_access_token_key,
)

PORTFOLIO_TABLE = "kai_plaid_items"
FUNDING_TABLE = "kai_funding_plaid_items"
PROCESSOR_TABLE = "kai_funding_ach_relationships"

# Regulated funding records: counted, never deleted by this script.
REGULATED_FUNDING_TABLES = (
    "kai_funding_transfers",
    "kai_funding_trade_intents",
    "kai_funding_trade_events",
    "kai_funding_consent_records",
)

_TOKEN_ENVIRONMENTS = ("sandbox", "development", "production")
_PRODUCTION_PLAID_REQUIRED = frozenset({"uat", "production"})

_ALPACA_BASE_URLS = {
    "sandbox": "https://broker-api.sandbox.alpaca.markets",
    "production": "https://broker-api.alpaca.markets",
}

PlaidPost = Callable[[str, dict[str, Any], str | None], Awaitable[dict[str, Any]]]


class RetirementRefused(RuntimeError):
    """Raised before any database or Plaid access when execution is not allowed."""


def token_environment(access_token: str) -> str | None:
    """Plaid access tokens start with access-<environment>-."""
    for environment in _TOKEN_ENVIRONMENTS:
        if access_token.startswith(f"access-{environment}-"):
            return environment
    return None


def database_target() -> dict[str, str]:
    """Non-secret description of the database the runtime would open, plus a fingerprint."""
    parts = {
        "cloudsql_instance": _clean_text(os.getenv("CLOUDSQL_INSTANCE_CONNECTION_NAME")),
        "host": _clean_text(os.getenv("DB_HOST")),
        "port": _clean_text(os.getenv("DB_PORT"), default="5432"),
        "unix_socket": _clean_text(os.getenv("DB_UNIX_SOCKET")),
        "name": _clean_text(os.getenv("DB_NAME"), default="postgres"),
    }
    canonical = "|".join(f"{key}={parts[key]}" for key in sorted(parts))
    parts["fingerprint"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:12]
    return parts


def _clean_text(value: Any, *, default: str = "") -> str:
    if not isinstance(value, str):
        return default
    text = value.strip()
    return text or default


def _first_non_empty(*values: Any) -> str:
    for value in values:
        text = _clean_text(value)
        if text:
            return text
    return ""


# ---------------------------------------------------------------------------
# Key resolution and decryption, copied from the retired services so the
# stored envelopes decrypt exactly as they were written.
# ---------------------------------------------------------------------------


def _key_from_configured(configured: str) -> bytes | None:
    if not configured:
        return None
    try:
        decoded = base64.urlsafe_b64decode(configured.encode("utf-8"))
        if len(decoded) in {16, 24, 32}:
            return decoded
    except Exception:  # noqa: BLE001, S110 - mirrors the retired services exactly
        pass
    if len(configured.encode("utf-8")) in {16, 24, 32}:
        return configured.encode("utf-8")
    return None


def resolve_portfolio_key(config: PlaidRuntimeConfig) -> bytes:
    """plaid_portfolio_service.PlaidPortfolioService._resolve_encryption_key."""
    key = _key_from_configured(_clean_text(get_optional_plaid_access_token_key()))
    if key is not None:
        return key
    return hashlib.sha256(
        f"{config.client_id}::{config.secret}::{config.environment}".encode("utf-8")
    ).digest()


def _alpaca_auth_header() -> str:
    """integrations.alpaca.config._normalize_auth_header over the same env names."""
    token = _first_non_empty(
        os.getenv("ALPACA_BROKER_AUTH_TOKEN"),
        os.getenv("BROKER_TOKEN"),
        os.getenv("ALPACA_AUTH_TOKEN"),
    )
    if token:
        lowered = token.lower()
        if lowered.startswith("basic ") or lowered.startswith("bearer "):
            return token
        return f"Basic {token}"
    key_id = _first_non_empty(
        os.getenv("ALPACA_BROKER_KEY_ID"),
        os.getenv("APCA_API_KEY_ID"),
        os.getenv("ALPACA_API_KEY"),
        os.getenv("ALPACA_KEY_ID"),
    )
    secret = _first_non_empty(
        os.getenv("ALPACA_BROKER_SECRET"),
        os.getenv("APCA_API_SECRET_KEY"),
        os.getenv("ALPACA_API_SECRET"),
        os.getenv("ALPACA_SECRET_KEY"),
        os.getenv("ALPACA_API_SECRET_KEY"),
    )
    if not key_id or not secret:
        return ""
    encoded = base64.b64encode(f"{key_id}:{secret}".encode("utf-8")).decode("utf-8")
    return f"Basic {encoded}"


def _alpaca_base_url() -> str:
    environment = _clean_text(
        os.getenv("ALPACA_ENV") or os.getenv("ALPACA_BROKER_ENV"), default="sandbox"
    ).lower()
    explicit = _clean_text(os.getenv("ALPACA_BROKER_BASE_URL") or os.getenv("BROKER_API_BASE"))
    mapped = _ALPACA_BASE_URLS.get(environment, _ALPACA_BASE_URLS["sandbox"])
    return (explicit or mapped).rstrip("/")


def resolve_funding_key(config: PlaidRuntimeConfig) -> bytes:
    """broker_funding_service.BrokerFundingService._resolve_secret_encryption_key."""
    configured = _clean_text(
        get_optional_funding_secret_encryption_key() or get_optional_plaid_access_token_key()
    )
    key = _key_from_configured(configured)
    if key is not None:
        return key
    return hashlib.sha256(
        (
            f"{config.client_id}::{config.secret}::{_alpaca_auth_header()}::{_alpaca_base_url()}"
        ).encode("utf-8")
    ).digest()


def decrypt_envelope(row: dict[str, Any], key: bytes) -> str:
    ciphertext = _clean_text(row.get("access_token_ciphertext"))
    iv = _clean_text(row.get("access_token_iv"))
    tag = _clean_text(row.get("access_token_tag"))
    if not ciphertext or not iv or not tag:
        raise ValueError("stored token envelope is incomplete")
    plaintext = AESGCM(key).decrypt(
        base64.urlsafe_b64decode(iv.encode("utf-8")),
        base64.urlsafe_b64decode(ciphertext.encode("utf-8"))
        + base64.urlsafe_b64decode(tag.encode("utf-8")),
        None,
    )
    return plaintext.decode("utf-8")


# ---------------------------------------------------------------------------
# Database access
# ---------------------------------------------------------------------------


def _table_present(db: Any, table: str) -> bool:
    result = db.execute_raw("SELECT to_regclass(:name) IS NOT NULL AS present", {"name": table})
    return bool(result.data and result.data[0].get("present"))


def _count(db: Any, sql: str) -> int:
    result = db.execute_raw(sql)
    return int(result.data[0]["n"]) if result.data else 0


def inventory(db: Any) -> dict[str, Any]:
    counts: dict[str, Any] = {}
    for table in (PORTFOLIO_TABLE, FUNDING_TABLE):
        if not _table_present(db, table):
            counts[table] = {"present": False, "rows": 0, "live": 0}
            continue
        counts[table] = {
            "present": True,
            "rows": _count(db, f"SELECT COUNT(*) AS n FROM {table}"),  # noqa: S608
            "live": _count(
                db,
                f"SELECT COUNT(*) AS n FROM {table} "  # noqa: S608
                "WHERE COALESCE(status, 'active') <> 'removed'",
            ),
        }
    for table in REGULATED_FUNDING_TABLES:
        counts[table] = {
            "present": _table_present(db, table),
            "rows": _count(db, f"SELECT COUNT(*) AS n FROM {table}")  # noqa: S608
            if _table_present(db, table)
            else 0,
        }
    if _table_present(db, PROCESSOR_TABLE):
        counts[PROCESSOR_TABLE] = {
            "present": True,
            "processor_tokens": _count(
                db,
                f"SELECT COUNT(*) AS n FROM {PROCESSOR_TABLE} "  # noqa: S608
                "WHERE processor_token_ciphertext IS NOT NULL",
            ),
        }
    else:
        counts[PROCESSOR_TABLE] = {"present": False, "processor_tokens": 0}
    return counts


def _item_rows(db: Any, table: str) -> list[dict[str, Any]]:
    result = db.execute_raw(
        f"""
        SELECT item_id, access_token_ciphertext, access_token_iv, access_token_tag,
               plaid_env, COALESCE(status, 'active') AS status
        FROM {table}
        ORDER BY item_id
        """  # noqa: S608
    )
    return list(result.data or [])


def _delete_portfolio_item(db: Any, item_id: str) -> None:
    # kai_plaid_refresh_runs cascades; kai_plaid_link_sessions is SET NULL.
    db.execute_raw(f"DELETE FROM {PORTFOLIO_TABLE} WHERE item_id = :item_id", {"item_id": item_id})


def _funding_item_has_regulated_records(db: Any, item_id: str) -> bool:
    result = db.execute_raw(
        """
        SELECT
          EXISTS (SELECT 1 FROM kai_funding_trade_intents WHERE funding_item_id = :item_id)
          OR EXISTS (
            SELECT 1 FROM kai_funding_transfers
            WHERE item_id = :item_id
               OR relationship_id IN (
                 SELECT relationship_id FROM kai_funding_ach_relationships WHERE item_id = :item_id
               )
          ) AS has_records
        """,
        {"item_id": item_id},
    )
    return bool(result.data and result.data[0].get("has_records"))


def _delete_funding_item(db: Any, item_id: str) -> str:
    # Transfers and trade intents are regulated records and reference the Item
    # with ON DELETE RESTRICT. They are never deleted here: the revoked Item is
    # marked 'removed' and kept until a retention decision is made.
    params = {"item_id": item_id}
    if _funding_item_has_regulated_records(db, item_id):
        db.execute_raw(
            f"UPDATE {FUNDING_TABLE} SET status = 'removed' WHERE item_id = :item_id", params
        )
        return "marked_removed"
    db.execute_raw(f"DELETE FROM {PROCESSOR_TABLE} WHERE item_id = :item_id", params)
    db.execute_raw(f"DELETE FROM {FUNDING_TABLE} WHERE item_id = :item_id", params)
    return "deleted"


def _delete_portfolio_item_row(db: Any, item_id: str) -> str:
    _delete_portfolio_item(db, item_id)
    return "deleted"


# ---------------------------------------------------------------------------
# Retirement
# ---------------------------------------------------------------------------


def _default_plaid_post(config: PlaidRuntimeConfig) -> PlaidPost:
    # One client in one Plaid environment. Tokens from another environment are
    # filtered out before this is called, never re-routed.
    client = PlaidHttpClient(config)

    async def _post(path: str, payload: dict[str, Any], _environment: str | None):
        return await client.post(path, payload)

    return _post


async def _retire_table(
    db: Any,
    *,
    table: str,
    key: bytes,
    plaid_post: PlaidPost,
    plaid_environment: str,
    delete_row: Callable[[Any, str], str],
) -> dict[str, Any]:
    outcome: dict[str, Any] = {
        "already_removed_rows_deleted": 0,
        "removed_at_plaid": 0,
        "already_gone_at_plaid": 0,
        "environment_mismatch_kept": 0,
        "failed_kept": 0,
        "rows_deleted": 0,
        "rows_marked_removed": 0,
        "plaid_error_codes": Counter(),
        "local_error_types": Counter(),
    }
    for row in _item_rows(db, table):
        item_id = _clean_text(row.get("item_id"))
        if not item_id:
            outcome["failed_kept"] += 1
            outcome["local_error_types"]["missing_item_id"] += 1
            continue
        if _clean_text(row.get("status")).lower() != "removed":
            try:
                access_token = decrypt_envelope(row, key)
            except Exception as exc:  # noqa: BLE001 - counted per type, row kept for retry
                outcome["failed_kept"] += 1
                outcome["local_error_types"][type(exc).__name__] += 1
                continue
            token_env = token_environment(access_token)
            if token_env != plaid_environment:
                # Another environment's Plaid would answer INVALID_ACCESS_TOKEN
                # for a live Item; deleting on that would orphan it.
                outcome["environment_mismatch_kept"] += 1
                continue
            try:
                await plaid_post("/item/remove", {"access_token": access_token}, None)
                outcome["removed_at_plaid"] += 1
            except PlaidApiError as exc:
                code = _clean_text(exc.error_code, default="UNKNOWN")
                outcome["plaid_error_codes"][code] += 1
                if code not in {"ITEM_NOT_FOUND", "INVALID_ACCESS_TOKEN"}:
                    outcome["failed_kept"] += 1
                    continue
                outcome["already_gone_at_plaid"] += 1
            except Exception as exc:  # noqa: BLE001 - counted per type, row kept for retry
                outcome["failed_kept"] += 1
                outcome["local_error_types"][type(exc).__name__] += 1
                continue
        else:
            outcome["already_removed_rows_deleted"] += 1
        try:
            action = delete_row(db, item_id)
        except Exception as exc:  # noqa: BLE001 - driver messages can carry bound ids
            outcome["failed_kept"] += 1
            outcome["local_error_types"][f"delete:{type(exc).__name__}"] += 1
            continue
        if action == "marked_removed":
            outcome["rows_marked_removed"] += 1
        else:
            outcome["rows_deleted"] += 1
    outcome["plaid_error_codes"] = dict(outcome["plaid_error_codes"])
    outcome["local_error_types"] = dict(outcome["local_error_types"])
    return outcome


def _key_status() -> dict[str, bool]:
    return {
        "PLAID_ACCESS_TOKEN_KEY_set": bool(_clean_text(get_optional_plaid_access_token_key())),
        "FUNDING_SECRET_ENCRYPTION_KEY_set": bool(
            _clean_text(get_optional_funding_secret_encryption_key())
        ),
    }


def _token_environment_counts(db: Any, table: str, key: bytes) -> dict[str, int]:
    """Dry-run view of which Plaid environment each live token belongs to (counts only)."""
    counts: Counter[str] = Counter()
    for row in _item_rows(db, table):
        if _clean_text(row.get("status")).lower() == "removed":
            continue
        try:
            counts[token_environment(decrypt_envelope(row, key)) or "unrecognized"] += 1
        except Exception:  # noqa: BLE001 - counted, never printed
            counts["undecryptable"] += 1
    return dict(counts)


async def run(
    *,
    execute: bool,
    confirm_env: str | None,
    confirm_db: str | None = None,
    db: Any = None,
    plaid_post: PlaidPost | None = None,
    config: PlaidRuntimeConfig | None = None,
) -> dict[str, Any]:
    environment = get_app_runtime_settings().environment
    plaid_config = config or PlaidRuntimeConfig.from_env()
    target = database_target()
    if execute:
        if not confirm_env:
            raise RetirementRefused("--execute requires --confirm-env <ENVIRONMENT>.")
        if confirm_env.strip().lower() != environment:
            raise RetirementRefused(
                f"--confirm-env {confirm_env.strip()!r} does not match the configured "
                f"ENVIRONMENT {environment!r}."
            )
        if _clean_text(confirm_db) != target["fingerprint"]:
            raise RetirementRefused(
                "--confirm-db must equal the database_fingerprint the dry run printed "
                f"for this target ({target['fingerprint']})."
            )
        if environment in _PRODUCTION_PLAID_REQUIRED and plaid_config.environment != "production":
            raise RetirementRefused(
                f"ENVIRONMENT {environment!r} holds production Plaid Items, but the Plaid "
                f"client is {plaid_config.environment!r}. Set PLAID_ENV=production."
            )
        if plaid_post is None and not plaid_config.configured:
            raise RetirementRefused("Plaid is not configured (PLAID_CLIENT_ID / PLAID_SECRET).")

    if db is None:
        from db.db_client import get_db

        db = get_db()

    report: dict[str, Any] = {
        "mode": "execute" if execute else "dry_run",
        "environment": environment,
        "database_target": {k: v for k, v in target.items() if k != "fingerprint"},
        "database_fingerprint": target["fingerprint"],
        "plaid_environment": plaid_config.environment,
        "plaid_configured": plaid_config.configured,
        "keys": _key_status(),
        "before": inventory(db),
    }
    if not execute:
        token_envs: dict[str, Any] = {}
        if report["before"][PORTFOLIO_TABLE]["present"]:
            token_envs[PORTFOLIO_TABLE] = _token_environment_counts(
                db, PORTFOLIO_TABLE, resolve_portfolio_key(plaid_config)
            )
        if report["before"][FUNDING_TABLE]["present"]:
            token_envs[FUNDING_TABLE] = _token_environment_counts(
                db, FUNDING_TABLE, resolve_funding_key(plaid_config)
            )
        report["live_token_environments"] = token_envs
        return report

    post = plaid_post or _default_plaid_post(plaid_config)
    results: dict[str, Any] = {}
    if report["before"][PORTFOLIO_TABLE]["present"]:
        results[PORTFOLIO_TABLE] = await _retire_table(
            db,
            table=PORTFOLIO_TABLE,
            key=resolve_portfolio_key(plaid_config),
            plaid_post=post,
            plaid_environment=plaid_config.environment,
            delete_row=_delete_portfolio_item_row,
        )
    if report["before"][FUNDING_TABLE]["present"]:
        results[FUNDING_TABLE] = await _retire_table(
            db,
            table=FUNDING_TABLE,
            key=resolve_funding_key(plaid_config),
            plaid_post=post,
            plaid_environment=plaid_config.environment,
            delete_row=_delete_funding_item,
        )
    report["results"] = results
    report["after"] = inventory(db)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Disconnect at Plaid and delete rows. Without it, counts only.",
    )
    parser.add_argument(
        "--confirm-env",
        default=None,
        help="Required with --execute; must equal the configured ENVIRONMENT.",
    )
    parser.add_argument(
        "--confirm-db",
        default=None,
        help="Required with --execute; the database_fingerprint the dry run printed.",
    )
    args = parser.parse_args(argv)
    try:
        report = asyncio.run(
            run(execute=args.execute, confirm_env=args.confirm_env, confirm_db=args.confirm_db)
        )
    except RetirementRefused as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(report, indent=2, sort_keys=True))
    failed = sum(
        item.get("failed_kept", 0) + item.get("environment_mismatch_kept", 0)
        for item in report.get("results", {}).values()
    )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
