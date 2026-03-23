#!/usr/bin/env python3
# ruff: noqa: E402, I001
"""User-scoped finance-root reset + reimport validator (does not touch vault key tables)."""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import os
import sys
from copy import deepcopy
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]
CONSENT_ROOT = REPO_ROOT / "consent-protocol"
PLANS_DIR = REPO_ROOT / "plans"

load_dotenv(CONSENT_ROOT / ".env")

sys.path.insert(0, str(CONSENT_ROOT))

from db.db_client import get_db  # noqa: E402
from hushh_mcp.services.domain_contracts import FINANCIAL_INTENT_MAP  # noqa: E402
from hushh_mcp.services.domain_registry_service import get_domain_registry_service  # noqa: E402
from hushh_mcp.services.personal_knowledge_model_service import (
    get_pkm_service,  # noqa: E402
)
from hushh_mcp.services.portfolio_import_service import (  # noqa: E402
    ImportResult,
    get_portfolio_import_service,
)
from hushh_mcp.types import EncryptedPayload  # noqa: E402
from hushh_mcp.vault.encrypt import decrypt_data, encrypt_data  # noqa: E402

INVESTMENT_HORIZON_CHOICES = {"short_term", "medium_term", "long_term"}
DRAWDOWN_RESPONSE_CHOICES = {"reduce", "stay", "buy_more"}
VOLATILITY_PREFERENCE_CHOICES = {"small", "moderate", "large"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _normalize_base64(value: str) -> str:
    normalized = str(value or "").strip().replace("-", "+").replace("_", "/")
    while len(normalized) % 4 != 0:
        normalized += "="
    return normalized


def _is_hex_like(value: str) -> bool:
    cleaned = str(value or "").strip()
    if not cleaned:
        return False
    if len(cleaned) % 2 != 0:
        return False
    return all(ch in "0123456789abcdefABCDEF" for ch in cleaned)


def _decode_bytes_compat(value: str) -> bytes:
    raw = str(value or "").strip()
    if not raw:
        return b""
    if _is_hex_like(raw) and not any(ch in raw for ch in "+/=_-"):
        return bytes.fromhex(raw)
    try:
        return base64.b64decode(_normalize_base64(raw), validate=False)
    except Exception:
        if _is_hex_like(raw):
            return bytes.fromhex(raw)
        raise


def _derive_wrapper_key(passphrase: str, salt_bytes: bytes) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt_bytes,
        iterations=100000,
    )
    return kdf.derive(passphrase.encode("utf-8"))


def _unwrap_vault_key(passphrase: str, wrapper_row: dict[str, Any]) -> str:
    encrypted = _decode_bytes_compat(str(wrapper_row.get("encrypted_vault_key") or ""))
    salt = _decode_bytes_compat(str(wrapper_row.get("salt") or ""))
    iv = _decode_bytes_compat(str(wrapper_row.get("iv") or ""))
    if not encrypted or not salt or not iv:
        raise RuntimeError("Passphrase wrapper is incomplete (encrypted_vault_key/salt/iv).")
    wrapper_key = _derive_wrapper_key(passphrase, salt)
    vault_key_raw = AESGCM(wrapper_key).decrypt(iv, encrypted, None)
    return vault_key_raw.hex()


def _json_fingerprint(payload: Any) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode(
        "utf-8"
    )
    return hashlib.sha256(encoded).hexdigest()


def _safe_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True, default=str), encoding="utf-8")


def _domain_intent(
    *,
    primary: str,
    secondary: str | None,
    source: str,
    updated_at: str,
    contract_version: int | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "primary": primary,
        "source": source,
        "updated_at": updated_at,
    }
    if secondary:
        payload["secondary"] = secondary
    if contract_version is not None:
        payload["contract_version"] = contract_version
    return payload


def _to_float(value: Any) -> float:
    if isinstance(value, bool) or value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", "").replace("$", "")
    if not text:
        return 0.0
    negative = text.startswith("(") and text.endswith(")")
    cleaned = text.replace("(", "").replace(")", "")
    try:
        parsed = float(cleaned)
    except Exception:
        return 0.0
    return -parsed if negative else parsed


def _normalize_pct(value: Any) -> float:
    pct = _to_float(value)
    if pct <= 1.0 and pct >= 0.0:
        pct *= 100.0
    return max(0.0, min(100.0, pct))


def _derive_risk_bucket(
    holdings: list[dict[str, Any]],
    asset_allocation: dict[str, Any],
    *,
    total_value: float,
    cash_balance: float,
) -> str:
    equities_pct = _normalize_pct(
        asset_allocation.get("equities_pct")
        or asset_allocation.get("equities_percent")
        or asset_allocation.get("equities_value")
    )
    cash_pct = _normalize_pct(
        asset_allocation.get("cash_pct")
        or asset_allocation.get("cash_percent")
        or asset_allocation.get("cash_value")
    )
    if equities_pct == 0.0 and total_value > 0:
        equities_value = sum(_to_float(h.get("market_value")) for h in holdings)
        equities_pct = (equities_value / total_value) * 100.0
    if cash_pct == 0.0 and total_value > 0 and cash_balance > 0:
        cash_pct = (cash_balance / total_value) * 100.0

    if equities_pct >= 75.0:
        return "aggressive"
    if equities_pct <= 45.0 or cash_pct >= 30.0:
        return "conservative"
    return "balanced"


def _build_financial_skeleton(now_iso: str) -> tuple[dict[str, Any], dict[str, Any]]:
    financial_domain = {
        "schema_version": 3,
        "domain_intent": _domain_intent(
            primary="financial",
            secondary=None,
            source="domain_registry_prepopulate",
            updated_at=now_iso,
            contract_version=1,
        ),
        "portfolio": {
            "domain_intent": _domain_intent(
                primary="financial",
                secondary="portfolio",
                source="domain_registry_prepopulate",
                updated_at=now_iso,
            ),
            "holdings": [],
            "updated_at": now_iso,
        },
        "profile": {
            "domain_intent": _domain_intent(
                primary="financial",
                secondary="profile",
                source="domain_registry_prepopulate",
                updated_at=now_iso,
            ),
            "updated_at": now_iso,
        },
        "documents": {
            "schema_version": 1,
            "domain_intent": _domain_intent(
                primary="financial",
                secondary="documents",
                source="domain_registry_prepopulate",
                updated_at=now_iso,
            ),
            "statements": [],
            "updated_at": now_iso,
        },
        "analysis_history": {
            "domain_intent": _domain_intent(
                primary="financial",
                secondary="analysis_history",
                source="domain_registry_prepopulate",
                updated_at=now_iso,
            ),
            "updated_at": now_iso,
        },
        "runtime": {
            "domain_intent": _domain_intent(
                primary="financial",
                secondary="runtime",
                source="domain_registry_prepopulate",
                updated_at=now_iso,
            ),
            "updated_at": now_iso,
        },
        "analysis": {
            "domain_intent": _domain_intent(
                primary="financial",
                secondary="analysis",
                source="domain_registry_prepopulate",
                updated_at=now_iso,
            ),
            "decisions": {},
            "updated_at": now_iso,
        },
        "updated_at": now_iso,
    }
    summary = {
        "has_portfolio": False,
        "holdings_count": 0,
        "documents_count": 0,
        "profile_completed": False,
        "analysis_total_analyses": 0,
        "analysis_tickers_analyzed": [],
        "domain_contract_version": 1,
        "intent_map": list(FINANCIAL_INTENT_MAP),
        "last_updated": now_iso,
    }
    return financial_domain, summary


def _risk_profile_for_score(score: int) -> str:
    if score <= 2:
        return "conservative"
    if score <= 4:
        return "balanced"
    return "aggressive"


def _build_onboarding_profile(
    *,
    now_iso: str,
    investment_horizon: str | None,
    drawdown_response: str | None,
    volatility_preference: str | None,
    onboarding_completed: bool,
    onboarding_skipped: bool,
) -> tuple[dict[str, Any], dict[str, Any]]:
    has_complete_answers = bool(investment_horizon and drawdown_response and volatility_preference)
    if (
        any([investment_horizon, drawdown_response, volatility_preference])
        and not has_complete_answers
    ):
        raise RuntimeError(
            "Onboarding profile must provide all three answers together: "
            "investment_horizon, drawdown_response, volatility_preference."
        )
    if has_complete_answers and onboarding_skipped:
        raise RuntimeError(
            "onboarding_skipped cannot be true when onboarding answers are provided."
        )

    risk_score: int | None = None
    risk_profile: str | None = None
    if has_complete_answers:
        risk_score = (
            {"short_term": 0, "medium_term": 1, "long_term": 2}[investment_horizon]
            + {"reduce": 0, "stay": 1, "buy_more": 2}[drawdown_response]
            + {"small": 0, "moderate": 1, "large": 2}[volatility_preference]
        )
        risk_profile = _risk_profile_for_score(risk_score)

    completed = onboarding_completed or onboarding_skipped or has_complete_answers
    completed_at = now_iso if completed else None
    selected_at = now_iso if has_complete_answers else None

    profile_payload = {
        "schema_version": 2,
        "onboarding": {
            "completed": completed,
            "completed_at": completed_at,
            "skipped_preferences": bool(onboarding_skipped),
            "nav_tour_completed_at": None,
            "nav_tour_skipped_at": None,
            "version": 2,
        },
        "preferences": {
            "investment_horizon": investment_horizon if has_complete_answers else None,
            "investment_horizon_selected_at": selected_at,
            "investment_horizon_anchor_at": selected_at,
            "drawdown_response": drawdown_response if has_complete_answers else None,
            "drawdown_response_selected_at": selected_at,
            "volatility_preference": volatility_preference if has_complete_answers else None,
            "volatility_preference_selected_at": selected_at,
            "risk_score": risk_score,
            "risk_profile": risk_profile,
            "risk_profile_selected_at": selected_at,
        },
        "updated_at": now_iso,
        "domain_intent": _domain_intent(
            primary="financial",
            secondary="profile",
            source="onboarding_sync",
            updated_at=now_iso,
        ),
    }

    profile_summary = {
        "profile_completed": completed,
        "profile_skipped_preferences": bool(onboarding_skipped),
        "risk_profile": risk_profile,
        "risk_score": risk_score,
        "has_investment_horizon": bool(investment_horizon),
        "has_drawdown_response": bool(drawdown_response),
        "has_volatility_preference": bool(volatility_preference),
    }
    return profile_payload, profile_summary


def _as_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return deepcopy(value)
    if is_dataclass(value):
        return asdict(value)
    return {}


def _as_list_of_dict(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    rows: list[dict[str, Any]] = []
    for row in value:
        if isinstance(row, dict):
            rows.append(deepcopy(row))
        elif is_dataclass(row):
            rows.append(asdict(row))
    return rows


def _build_financial_from_import(
    import_result: ImportResult,
    now_iso: str,
    *,
    profile_payload: dict[str, Any],
    profile_summary: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    portfolio_data = _as_dict(import_result.portfolio_data)
    account_info = _as_dict(import_result.account_info)
    account_summary = _as_dict(import_result.account_summary)
    asset_allocation = _as_dict(import_result.asset_allocation)
    income_summary = _as_dict(import_result.income_summary)
    realized_gain_loss = _as_dict(import_result.realized_gain_loss)
    transactions = _as_list_of_dict(import_result.transactions)

    holdings = _as_list_of_dict(portfolio_data.get("holdings"))
    if not holdings:
        holdings = _as_list_of_dict(portfolio_data.get("detailed_holdings"))
    holdings = [row for row in holdings if isinstance(row, dict)]

    total_value = _to_float(
        account_summary.get("ending_value")
        or portfolio_data.get("total_value")
        or import_result.total_value
    )
    if total_value <= 0:
        total_value = sum(_to_float(row.get("market_value")) for row in holdings)
    cash_balance = _to_float(import_result.cash_balance)

    risk_bucket = _derive_risk_bucket(
        holdings,
        asset_allocation,
        total_value=total_value,
        cash_balance=cash_balance,
    )

    winners_count = sum(1 for row in holdings if _to_float(row.get("unrealized_gain_loss")) > 0)
    losers_count = sum(1 for row in holdings if _to_float(row.get("unrealized_gain_loss")) < 0)
    total_cost_basis = sum(_to_float(row.get("cost_basis")) for row in holdings)
    total_gain_loss = sum(_to_float(row.get("unrealized_gain_loss")) for row in holdings)
    total_gain_loss_pct = (
        (total_gain_loss / total_cost_basis * 100.0) if total_cost_basis > 0 else 0.0
    )

    holdings_summary = [
        {
            "symbol": str(row.get("symbol") or "").upper(),
            "name": row.get("name"),
            "quantity": _to_float(row.get("quantity")),
            "current_price": _to_float(row.get("price_per_unit") or row.get("price")),
        }
        for row in holdings
        if str(row.get("symbol") or "").strip()
    ]

    snapshot = {
        "id": f"stmt_{int(datetime.now(tz=timezone.utc).timestamp() * 1000)}",
        "imported_at": now_iso,
        "domain_intent": _domain_intent(
            primary="financial",
            secondary="documents",
            source="kai_import_llm",
            updated_at=now_iso,
        ),
        "source": {
            "brokerage": account_info.get("brokerage"),
            "statement_period_start": account_info.get("statement_period_start"),
            "statement_period_end": account_info.get("statement_period_end"),
            "account_type": account_info.get("account_type"),
        },
        "account_info": account_info,
        "account_summary": account_summary,
        "holdings": holdings,
        "transactions": transactions,
        "asset_allocation": asset_allocation,
        "income_summary": income_summary,
        "realized_gain_loss": realized_gain_loss,
        "cash_balance": cash_balance,
        "quality_report": _as_dict(portfolio_data.get("quality_report")),
    }

    documents_domain = {
        "schema_version": 1,
        "domain_intent": _domain_intent(
            primary="financial",
            secondary="documents",
            source="kai_import_llm",
            updated_at=now_iso,
        ),
        "statements": [snapshot],
        "updated_at": now_iso,
    }

    portfolio_payload = {
        "account_info": account_info,
        "account_summary": account_summary,
        "holdings": holdings,
        "transactions": transactions,
        "asset_allocation": asset_allocation,
        "income_summary": income_summary,
        "realized_gain_loss": realized_gain_loss,
        "cash_balance": cash_balance,
        "total_value": total_value,
        "domain_intent": _domain_intent(
            primary="financial",
            secondary="portfolio",
            source="kai_import_llm",
            updated_at=now_iso,
        ),
        "updated_at": now_iso,
    }

    financial_domain = {
        # Compatibility mirror for current readers while contract is finance-root.
        **portfolio_payload,
        "schema_version": 3,
        "domain_intent": _domain_intent(
            primary="financial",
            secondary=None,
            source="domain_registry_prepopulate",
            updated_at=now_iso,
            contract_version=1,
        ),
        "portfolio": portfolio_payload,
        "documents": documents_domain,
        "profile": {
            **profile_payload,
            "domain_intent": _domain_intent(
                primary="financial",
                secondary="profile",
                source="onboarding_sync",
                updated_at=now_iso,
            ),
            "updated_at": now_iso,
        },
        "analysis_history": {
            "domain_intent": _domain_intent(
                primary="financial",
                secondary="analysis_history",
                source="domain_registry_prepopulate",
                updated_at=now_iso,
            ),
            "updated_at": now_iso,
        },
        "runtime": {
            "domain_intent": _domain_intent(
                primary="financial",
                secondary="runtime",
                source="domain_registry_prepopulate",
                updated_at=now_iso,
            ),
            "updated_at": now_iso,
        },
        "analysis": {
            "domain_intent": _domain_intent(
                primary="financial",
                secondary="analysis",
                source="domain_registry_prepopulate",
                updated_at=now_iso,
            ),
            "decisions": {},
            "updated_at": now_iso,
        },
        "updated_at": now_iso,
    }

    summary = {
        "intent_source": "kai_import_llm",
        "has_portfolio": bool(holdings),
        "holdings_count": len(holdings),
        "holdings": holdings_summary,
        "portfolio_total_value": round(total_value, 2),
        "portfolio_risk_bucket": risk_bucket,
        "risk_bucket": risk_bucket,
        "winners_count": winners_count,
        "losers_count": losers_count,
        "total_gain_loss_pct": round(total_gain_loss_pct, 4),
        **profile_summary,
        "documents_count": len(documents_domain["statements"]),
        "last_statement_end": account_info.get("statement_period_end"),
        "last_brokerage": account_info.get("brokerage"),
        "analysis_total_analyses": 0,
        "analysis_tickers_analyzed": [],
        "analysis_last_updated": now_iso,
        "domain_contract_version": 1,
        "intent_map": list(FINANCIAL_INTENT_MAP),
        "last_updated": now_iso,
    }
    return financial_domain, summary


def _decrypt_pkm_blob(blob_row: dict[str, Any] | None, vault_key_hex: str) -> dict[str, Any]:
    if not blob_row:
        return {}
    payload = EncryptedPayload(
        ciphertext=str(blob_row.get("encrypted_data_ciphertext") or "").strip(),
        iv=str(blob_row.get("encrypted_data_iv") or "").strip(),
        tag=str(blob_row.get("encrypted_data_tag") or "").strip(),
        encoding="base64",
        algorithm="aes-256-gcm",
    )
    decrypted = decrypt_data(payload, vault_key_hex)
    parsed = json.loads(decrypted)
    return parsed if isinstance(parsed, dict) else {}


def _build_artifact_name(prefix: str, user_id: str, suffix: str) -> Path:
    return PLANS_DIR / f"{prefix}-{user_id}.{suffix}"


async def _run(args: argparse.Namespace) -> None:
    user_id = str(args.user_id or "").strip()
    passphrase = str(args.passphrase or "").strip()
    pdf_path_raw = str(args.pdf_path or "").strip()
    if not user_id:
        raise RuntimeError("Missing user id. Set --user-id or KAI_TEST_USER_ID.")
    if not passphrase:
        raise RuntimeError("Missing passphrase. Set --passphrase or KAI_TEST_PASSPHRASE.")
    if not pdf_path_raw:
        raise RuntimeError("Missing PDF path. Set --pdf-path or KAI_TEST_BROKERAGE_PDF_PATH.")

    pdf_path = Path(pdf_path_raw)
    if not pdf_path.is_absolute():
        pdf_path = REPO_ROOT / pdf_path
    if not pdf_path.exists():
        raise RuntimeError(f"Brokerage PDF not found: {pdf_path}")
    if (
        args.onboarding_investment_horizon
        and args.onboarding_investment_horizon not in INVESTMENT_HORIZON_CHOICES
    ):
        raise RuntimeError(
            f"Invalid onboarding investment horizon: {args.onboarding_investment_horizon}"
        )
    if (
        args.onboarding_drawdown_response
        and args.onboarding_drawdown_response not in DRAWDOWN_RESPONSE_CHOICES
    ):
        raise RuntimeError(
            f"Invalid onboarding drawdown response: {args.onboarding_drawdown_response}"
        )
    if (
        args.onboarding_volatility_preference
        and args.onboarding_volatility_preference not in VOLATILITY_PREFERENCE_CHOICES
    ):
        raise RuntimeError(
            f"Invalid onboarding volatility preference: {args.onboarding_volatility_preference}"
        )

    db = get_db()
    pkm_service = get_pkm_service()
    domain_registry = get_domain_registry_service()

    now_iso = _now_iso()
    print(f"[reset] user={user_id}")
    print(f"[reset] pdf={pdf_path}")

    # 1) Capture vault key/wrapper snapshots (must remain unchanged).
    vault_keys_before = (
        db.table("vault_keys").select("*").eq("user_id", user_id).execute().data or []
    )
    wrappers_before = (
        db.table("vault_key_wrappers")
        .select("*")
        .eq("user_id", user_id)
        .order("method")
        .execute()
        .data
        or []
    )
    if not wrappers_before:
        raise RuntimeError("No vault wrappers found for this user.")
    passphrase_wrapper = next(
        (row for row in wrappers_before if str(row.get("method") or "").strip() == "passphrase"),
        None,
    )
    if not passphrase_wrapper:
        raise RuntimeError("No passphrase wrapper found for this user.")

    vault_snapshot_before = {
        "vault_keys": vault_keys_before,
        "vault_key_wrappers": wrappers_before,
        "fingerprint": _json_fingerprint(
            {
                "vault_keys": vault_keys_before,
                "vault_key_wrappers": wrappers_before,
            }
        ),
    }

    # 2) Unwrap vault key from passphrase wrapper.
    vault_key_hex = _unwrap_vault_key(passphrase, passphrase_wrapper)
    if len(vault_key_hex) != 64:
        raise RuntimeError("Derived vault key has invalid length.")
    print("[reset] passphrase wrapper decrypted successfully.")

    # 3) Backup pre-reset PKM.
    pre_blob_row = db.table("pkm_data").select("*").eq("user_id", user_id).execute().data
    pre_blob_row = pre_blob_row[0] if pre_blob_row else None
    pre_index_row = db.table("pkm_index").select("*").eq("user_id", user_id).execute().data
    pre_index_row = pre_index_row[0] if pre_index_row else None
    pre_decrypted_blob = _decrypt_pkm_blob(pre_blob_row, vault_key_hex) if pre_blob_row else {}

    pre_artifact = {
        "extracted_at_utc": now_iso,
        "user_id": user_id,
        "sources": [
            "vault_keys",
            "vault_key_wrappers",
            "pkm_data",
            "pkm_index",
        ],
        "vault_snapshot": vault_snapshot_before,
        "pkm_index_pre": pre_index_row,
        "pkm_blob_pre_decrypted": pre_decrypted_blob,
    }
    pre_path = _build_artifact_name("kai-finance-reset-pre", user_id, "json")
    _safe_write_json(pre_path, pre_artifact)
    print(f"[reset] wrote pre artifact: {pre_path}")

    # 4) Reset only PKM rows for target user.
    db.table("pkm_data").delete().eq("user_id", user_id).execute()
    db.table("pkm_index").delete().eq("user_id", user_id).execute()
    print("[reset] cleared pkm_data + pkm_index for user.")

    await domain_registry.ensure_canonical_domains()

    # 5) Prepopulate finance skeleton.
    skeleton_financial, skeleton_summary = _build_financial_skeleton(now_iso)
    skeleton_blob = {"financial": skeleton_financial}
    skeleton_encrypted = encrypt_data(json.dumps(skeleton_blob), vault_key_hex)
    skeleton_ok = await pkm_service.store_domain_data(
        user_id=user_id,
        domain="financial",
        encrypted_blob={
            "ciphertext": skeleton_encrypted.ciphertext,
            "iv": skeleton_encrypted.iv,
            "tag": skeleton_encrypted.tag,
            "algorithm": skeleton_encrypted.algorithm,
        },
        summary=skeleton_summary,
    )
    if not skeleton_ok:
        raise RuntimeError("Failed to prepopulate financial skeleton.")
    print("[reset] financial skeleton stored.")

    # 6) Run import pipeline on real brokerage statement.
    import_service = get_portfolio_import_service()
    import_result = await import_service.import_file(
        user_id=user_id,
        file_content=pdf_path.read_bytes(),
        filename=pdf_path.name,
    )
    if not import_result.success:
        raise RuntimeError(f"Portfolio import failed: {import_result.error}")
    print(f"[reset] import succeeded (holdings={import_result.holdings_count}).")

    # 7) Build canonical financial domain and persist encrypted blob.
    import_now_iso = _now_iso()
    profile_payload, profile_summary = _build_onboarding_profile(
        now_iso=import_now_iso,
        investment_horizon=args.onboarding_investment_horizon,
        drawdown_response=args.onboarding_drawdown_response,
        volatility_preference=args.onboarding_volatility_preference,
        onboarding_completed=bool(args.onboarding_completed),
        onboarding_skipped=bool(args.onboarding_skipped),
    )
    financial_domain, financial_summary = _build_financial_from_import(
        import_result,
        import_now_iso,
        profile_payload=profile_payload,
        profile_summary=profile_summary,
    )
    full_blob = {"financial": financial_domain}
    encrypted_blob = encrypt_data(json.dumps(full_blob), vault_key_hex)
    stored_ok = await pkm_service.store_domain_data(
        user_id=user_id,
        domain="financial",
        encrypted_blob={
            "ciphertext": encrypted_blob.ciphertext,
            "iv": encrypted_blob.iv,
            "tag": encrypted_blob.tag,
            "algorithm": encrypted_blob.algorithm,
        },
        summary=financial_summary,
    )
    if not stored_ok:
        raise RuntimeError("Failed to store imported financial domain.")
    await pkm_service.reconcile_user_index_domains(user_id)
    print("[reset] imported financial domain stored and reconciled.")

    # 8) Post verification.
    post_blob_row = db.table("pkm_data").select("*").eq("user_id", user_id).execute().data or []
    post_blob_row = post_blob_row[0] if post_blob_row else None
    post_index_row = db.table("pkm_index").select("*").eq("user_id", user_id).execute().data or []
    post_index_row = post_index_row[0] if post_index_row else None
    post_blob = _decrypt_pkm_blob(post_blob_row, vault_key_hex) if post_blob_row else {}

    top_level_domains = sorted(post_blob.keys())
    if top_level_domains != ["financial"]:
        raise RuntimeError(f"Post-reset blob has non-canonical top-level keys: {top_level_domains}")
    available_domains = sorted(
        [
            str(d).strip().lower()
            for d in ((post_index_row or {}).get("available_domains") or [])
            if str(d).strip()
        ]
    )
    if available_domains != ["financial"]:
        raise RuntimeError(
            f"Post-reset index has unexpected available_domains: {available_domains}"
        )

    financial_summary_row = (post_index_row or {}).get("domain_summaries", {}).get("financial", {})
    financial_summary_row = financial_summary_row if isinstance(financial_summary_row, dict) else {}

    # 9) Verify vault key rows unchanged.
    vault_keys_after = (
        db.table("vault_keys").select("*").eq("user_id", user_id).execute().data or []
    )
    wrappers_after = (
        db.table("vault_key_wrappers")
        .select("*")
        .eq("user_id", user_id)
        .order("method")
        .execute()
        .data
        or []
    )
    vault_snapshot_after = {
        "vault_keys": vault_keys_after,
        "vault_key_wrappers": wrappers_after,
        "fingerprint": _json_fingerprint(
            {
                "vault_keys": vault_keys_after,
                "vault_key_wrappers": wrappers_after,
            }
        ),
    }
    if vault_snapshot_before["fingerprint"] != vault_snapshot_after["fingerprint"]:
        raise RuntimeError("Vault key tables changed during reset. Aborting.")

    # 10) Write artifacts.
    extracted_at = _now_iso()
    post_artifact = {
        "extracted_at_utc": extracted_at,
        "user_id": user_id,
        "pdf_source": str(pdf_path),
        "sources": [
            "vault_keys",
            "vault_key_wrappers",
            "pkm_data",
            "pkm_index",
            "portfolio_import_service.import_file",
        ],
        "pkm_index_post": post_index_row,
        "pkm_blob_post_decrypted": post_blob,
        "financial_summary_post": financial_summary_row,
        "top_level_domains": top_level_domains,
        "available_domains": available_domains,
        "vault_snapshot_after": vault_snapshot_after,
        "validations": {
            "vault_tables_unchanged": True,
            "top_level_finance_only": top_level_domains == ["financial"],
            "available_domains_finance_only": available_domains == ["financial"],
            "import_success": import_result.success,
            "holdings_count": import_result.holdings_count,
        },
    }
    post_path = _build_artifact_name("kai-finance-reset-post", user_id, "json")
    _safe_write_json(post_path, post_artifact)

    # Keep canonical PKM dump artifact aligned with existing plan files.
    canonical_dump_path = _build_artifact_name("kai-figma-PKM", user_id, "json")
    _safe_write_json(canonical_dump_path, post_blob)

    report_lines = [
        f"# Finance-Root Reset Report ({user_id})",
        "",
        f"- Executed at (UTC): `{extracted_at}`",
        f"- Source PDF: `{pdf_path}`",
        "- Reset scope: `pkm_data` + `pkm_index` for this user only",
        "- Vault key tables touched: `No` (fingerprint verified unchanged)",
        "- Onboarding profile source: `onboarding_sync`",
        "",
        "## Validation",
        f"- Top-level domains in decrypted blob: `{top_level_domains}`",
        f"- `available_domains`: `{available_domains}`",
        f"- Imported holdings count: `{import_result.holdings_count}`",
        f"- Financial summary holdings_count: `{financial_summary_row.get('holdings_count')}`",
        f"- Financial summary portfolio_risk_bucket: `{financial_summary_row.get('portfolio_risk_bucket') or financial_summary_row.get('risk_bucket')}`",
        "",
        "## Artifacts",
        f"- `{pre_path}`",
        f"- `{post_path}`",
        f"- `{canonical_dump_path}`",
    ]
    report_path = _build_artifact_name("kai-finance-reset-report", user_id, "md")
    report_path.write_text("\n".join(report_lines) + "\n", encoding="utf-8")

    print(f"[reset] wrote post artifact: {post_path}")
    print(f"[reset] wrote PKM dump: {canonical_dump_path}")
    print(f"[reset] wrote report: {report_path}")
    print("[reset] complete.")


def _default(value: str, env_key: str) -> str:
    return str(value or os.getenv(env_key, "")).strip()


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Reset one user's PKM to finance-root and reimport brokerage data.",
    )
    parser.add_argument(
        "--user-id",
        default=_default("", "KAI_TEST_USER_ID"),
        help="Target user id (default: KAI_TEST_USER_ID env).",
    )
    parser.add_argument(
        "--passphrase",
        default=_default("", "KAI_TEST_PASSPHRASE"),
        help="Passphrase for wrapper unlock (default: KAI_TEST_PASSPHRASE env).",
    )
    parser.add_argument(
        "--pdf-path",
        default=_default("", "KAI_TEST_BROKERAGE_PDF_PATH"),
        help="Brokerage statement path (default: KAI_TEST_BROKERAGE_PDF_PATH env).",
    )
    parser.add_argument(
        "--onboarding-investment-horizon",
        default=_default("", "KAI_TEST_ONBOARDING_INVESTMENT_HORIZON") or None,
        help="Optional onboarding answer: short_term|medium_term|long_term.",
    )
    parser.add_argument(
        "--onboarding-drawdown-response",
        default=_default("", "KAI_TEST_ONBOARDING_DRAWDOWN_RESPONSE") or None,
        help="Optional onboarding answer: reduce|stay|buy_more.",
    )
    parser.add_argument(
        "--onboarding-volatility-preference",
        default=_default("", "KAI_TEST_ONBOARDING_VOLATILITY_PREFERENCE") or None,
        help="Optional onboarding answer: small|moderate|large.",
    )
    parser.add_argument(
        "--onboarding-completed",
        action="store_true",
        help="Mark onboarding completed even if answers are absent.",
    )
    parser.add_argument(
        "--onboarding-skipped",
        action="store_true",
        help="Mark onboarding completed with skipped preferences.",
    )
    return parser


def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()
    asyncio.run(_run(args))


if __name__ == "__main__":
    main()
