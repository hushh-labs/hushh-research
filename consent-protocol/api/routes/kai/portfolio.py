# consent-protocol/api/routes/kai/portfolio.py
"""
Kai Portfolio API Route - Portfolio import and analysis endpoints.

Handles:
- File upload (CSV/PDF) for brokerage statements
- Portfolio summary retrieval
- KPI derivation and PKM integration
- SSE streaming for real-time parsing progress

Authentication:
- All endpoints require VAULT_OWNER token (consent-first architecture)
- Token contains user_id, proving both identity and consent
- Firebase is only used for bootstrap (issuing VAULT_OWNER token)
"""

import asyncio
import io
import json
import logging
import math
import re
import time
from collections import Counter
from datetime import datetime, timezone
from typing import Any, AsyncGenerator, Optional

from fastapi import APIRouter, Depends, Form, HTTPException, Query, Request, UploadFile, status
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from api.middleware import require_vault_owner_token
from api.middlewares.observability import get_request_id
from api.routes.kai._streaming import (
    HEARTBEAT_INTERVAL_SECONDS,
    PORTFOLIO_IMPORT_TIMEOUT_SECONDS,
    CanonicalSSEStream,
)
from api.routes.kai.import_run_manager import (
    KaiPortfolioImportRunManager,
    PortfolioImportRunRecord,
)
from hushh_mcp.constants import (
    KAI_LLM_TEMPERATURE,
    KAI_LLM_THINKING_ENABLED,
    KAI_PORTFOLIO_IMPORT_MAX_OUTPUT_TOKENS,
    KAI_PORTFOLIO_IMPORT_THINKING_LEVEL,
)
from hushh_mcp.kai_import import (
    FINANCIAL_STATEMENT_EXTRACT_V2_REQUIRED_KEYS,
    ImportStrictParseError,
    build_financial_analytics_v2,
    build_financial_portfolio_canonical_v2,
    build_holdings_quality_report_v2,
    build_quality_report_v2,
    build_statement_extract_prompt_v2,
    build_timing_payload,
    build_token_counts_payload,
    evaluate_import_quality_gate_v2,
    run_stream_pass_v2,
)
from hushh_mcp.services.personal_knowledge_model_service import get_pkm_service
from hushh_mcp.services.portfolio_import_service import (
    ImportResult,
    get_portfolio_import_service,
)
from hushh_mcp.services.renaissance_service import TIER_WEIGHTS, get_renaissance_service
from hushh_mcp.services.symbol_master_service import get_symbol_master_service

logger = logging.getLogger(__name__)

router = APIRouter()
_IMPORT_RUN_MANAGER = KaiPortfolioImportRunManager()
_PICK_TICKER_RE = re.compile(r"^[A-Z][A-Z0-9.\-]{0,9}$")
_MAX_PROFILE_PICKS = 8
_MAX_IMPORT_FILE_BYTES = 25 * 1024 * 1024
_MAX_IMPORT_FILE_SIZE_MESSAGE = "File too large. Maximum size is 25MB."

_NUMERIC_STRIP_RE = re.compile(r"[$,\s]")
_FILENAME_DATE_RE = re.compile(r"(20\d{2}-\d{2}-\d{2})")
_FILENAME_ACCOUNT_RE = re.compile(r"(?:acct|account|inv|#)?\s*(\d{4,})", flags=re.IGNORECASE)
_HOLDING_KEY_HINTS = frozenset(
    {
        "symbol",
        "symbol_cusip",
        "ticker",
        "cusip",
        "security_id",
        "security",
        "security_description",
        "description",
        "name",
        "quantity",
        "qty",
        "shares",
        "units",
        "market_value",
        "value",
        "current_value",
        "marketvalue",
        "price",
        "price_per_unit",
        "last_price",
        "unit_price",
        "current_price",
        "cost_basis",
        "book_value",
        "asset_class",
        "asset_type",
        "security_type",
    }
)
_POSITIONS_PAGE_KEYWORDS = (
    "holdings",
    "positions",
    "symbol",
    "ticker",
    "cusip",
    "market value",
    "cost basis",
    "unrealized",
    "shares",
    "quantity",
)
_SUMMARY_PAGE_KEYWORDS = (
    "account summary",
    "portfolio summary",
    "allocation",
    "asset allocation",
    "ending value",
    "beginning value",
    "net change",
    "cash balance",
    "income",
)


def _looks_like_holding_row(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    keys = {str(key).lower() for key in value.keys()}
    if not keys:
        return False

    strong_fields = {
        "market_value",
        "current_value",
        "marketvalue",
        "cost_basis",
        "book_value",
        "unrealized_gain_loss",
        "asset_class",
        "asset_type",
        "security_type",
        "symbol_cusip",
    }
    id_fields = {"symbol", "symbol_cusip", "ticker", "cusip", "security_id", "security"}
    descriptor_fields = {
        "description",
        "name",
        "security_name",
        "holding_name",
        "security_description",
    }
    qty_fields = {"quantity", "qty", "shares", "units"}
    price_fields = {"price", "price_per_unit", "last_price", "unit_price", "current_price"}
    numeric_keys = {
        "market_value",
        "value",
        "current_value",
        "marketvalue",
        "quantity",
        "shares",
        "units",
    }
    transaction_bias_fields = {
        "transaction_type",
        "settle_date",
        "trade_date",
        "amount",
        "net_amount",
    }

    # Guard against transaction rows being misidentified as holdings.
    if keys.intersection(transaction_bias_fields) and not keys.intersection(strong_fields):
        return False

    if keys.intersection(strong_fields) and keys.intersection(id_fields):
        return True
    if (
        keys.intersection(id_fields)
        and keys.intersection(qty_fields)
        and keys.intersection(price_fields)
    ):
        return True
    if keys.intersection(id_fields) and keys.intersection(numeric_keys):
        return True
    if keys.intersection(descriptor_fields) and keys.intersection(
        {"market_value", "value", "current_value", "marketvalue", "quantity", "shares"}
    ):
        return True
    # Some statements only return a security identifier + value fields.
    identifier_keys = {"cusip", "security_id", "security"}
    return bool(keys.intersection(identifier_keys) and keys.intersection(numeric_keys))


def _recursive_find_holdings_lists(
    value: Any,
    *,
    _seen: set[int] | None = None,
) -> list[list[dict[str, Any]]]:
    seen = _seen if _seen is not None else set()
    candidates: list[list[dict[str, Any]]] = []

    if isinstance(value, (list, dict)):
        obj_id = id(value)
        if obj_id in seen:
            return candidates
        seen.add(obj_id)

    if isinstance(value, list):
        rows = [row for row in value if isinstance(row, dict)]
        if rows and any(_looks_like_holding_row(row) for row in rows):
            candidates.append(rows)
        for row in value:
            candidates.extend(_recursive_find_holdings_lists(row, _seen=seen))
        return candidates

    if isinstance(value, dict):
        for nested_value in value.values():
            candidates.extend(_recursive_find_holdings_lists(nested_value, _seen=seen))
    return candidates


def _merge_unique_holding_rows(candidates: list[list[dict[str, Any]]]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    seen_fingerprints: set[str] = set()
    for rows in candidates:
        for row in rows:
            try:
                fingerprint = json.dumps(row, sort_keys=True, default=str)
            except Exception:
                fingerprint = str(sorted((str(k), str(v)) for k, v in row.items()))
            if fingerprint in seen_fingerprints:
                continue
            seen_fingerprints.add(fingerprint)
            merged.append(row)
    return merged


def _extract_holdings_list(parsed_data: dict[str, Any]) -> tuple[list[dict[str, Any]], str]:
    collected_candidates: list[list[dict[str, Any]]] = []
    source_fields: list[str] = []

    detailed_holdings = parsed_data.get("detailed_holdings")
    if isinstance(detailed_holdings, list):
        rows = [row for row in detailed_holdings if isinstance(row, dict)]
        if rows and any(_looks_like_holding_row(row) for row in rows):
            collected_candidates.append(rows)
            source_fields.append("detailed_holdings")

    aliases = (
        "holdings",
        "positions",
        "portfolio_holdings",
        "securities",
    )
    for alias in aliases:
        candidate = parsed_data.get(alias)
        if isinstance(candidate, list):
            rows = [row for row in candidate if isinstance(row, dict)]
            if rows and any(_looks_like_holding_row(row) for row in rows):
                collected_candidates.append(rows)
                source_fields.append(alias)
        if isinstance(candidate, dict):
            nested = (
                candidate.get("items")
                or candidate.get("rows")
                or candidate.get("data")
                or candidate.get("holdings")
                or candidate.get("positions")
                or candidate.get("securities")
            )
            if isinstance(nested, list):
                rows = [row for row in nested if isinstance(row, dict)]
                if rows and any(_looks_like_holding_row(row) for row in rows):
                    collected_candidates.append(rows)
                    source_fields.append(f"{alias}.items")

    recursive_candidates = _recursive_find_holdings_lists(parsed_data)
    if recursive_candidates:
        collected_candidates.extend(recursive_candidates)

    if not collected_candidates:
        return [], "none"

    merged = _merge_unique_holding_rows(collected_candidates)
    if not merged:
        return [], "none"

    if "detailed_holdings" in source_fields:
        return merged, "detailed_holdings"
    if source_fields:
        return merged, source_fields[0]
    return merged, "recursive_scan"


def _build_holdings_preview(
    holdings: list[dict[str, Any]],
    *,
    max_items: Optional[int] = None,
) -> list[dict[str, Any]]:
    preview: list[dict[str, Any]] = []
    rows = holdings
    if isinstance(max_items, int) and max_items > 0:
        rows = holdings[:max_items]

    for holding in rows:
        symbol = holding.get("symbol") or holding.get("symbol_cusip")
        name = (
            holding.get("name") or holding.get("description") or holding.get("security_description")
        )
        preview.append(
            {
                "symbol": str(symbol).strip() if symbol is not None else "",
                "name": str(name).strip() if name is not None else "",
                "market_value": _coerce_optional_number(holding.get("market_value")),
                "quantity": _coerce_optional_number(holding.get("quantity")),
                "asset_type": str(holding.get("asset_type", "")).strip() or None,
            }
        )
    return preview


def _extract_live_holdings_preview_from_text(
    streamed_text: str,
    *,
    max_items: int = 12,
) -> list[dict[str, Any]]:
    """
    Parse streamed JSON text and return relatable holdings preview rows.

    Used by tests and live stream fallback UI when partial payloads are available.
    """
    raw = str(streamed_text or "").strip()
    if not raw:
        return []

    parsed_payload: dict[str, Any] | None = None
    try:
        candidate = json.loads(raw)
        if isinstance(candidate, dict):
            parsed_payload = candidate
    except Exception:
        start = raw.find("{")
        end = raw.rfind("}")
        if start >= 0 and end > start:
            try:
                candidate = json.loads(raw[start : end + 1])
                if isinstance(candidate, dict):
                    parsed_payload = candidate
            except Exception:
                parsed_payload = None

    if not parsed_payload:
        return []

    holdings_rows, _source = _extract_holdings_list(parsed_payload)
    if not holdings_rows:
        return []

    normalized_rows = [
        _normalize_raw_holding_row(row, idx=index)
        for index, row in enumerate(holdings_rows)
        if isinstance(row, dict)
    ]
    valid_rows = [row for row in normalized_rows if _validate_holding_row(row)[0]]
    preview_source = valid_rows or normalized_rows
    return _build_holdings_preview(preview_source, max_items=max_items)


def _phase_progress_bounds(phase: str) -> tuple[float, float]:
    ranges: dict[str, tuple[float, float]] = {
        "extract_full": (3.0, 78.0),
        "normalizing": (78.0, 92.0),
        "validating": (92.0, 99.0),
    }
    return ranges.get(phase, (0.0, 100.0))


def _score_page_keywords(text: str, keywords: tuple[str, ...]) -> float:
    haystack = text.lower()
    score = 0.0
    for keyword in keywords:
        if keyword in haystack:
            score += 1.0
    return score


def _extract_pdf_pass_contexts(content: bytes) -> dict[str, Any]:
    """
    Build deterministic text excerpts for positions and summary passes.
    Falls back to full document bytes when snippet confidence is low.
    """
    try:
        import pdfplumber

        with pdfplumber.open(io.BytesIO(content)) as pdf:
            extracted_pages: list[tuple[int, str, float, float]] = []
            for idx, page in enumerate(pdf.pages[:40]):
                text = (page.extract_text() or "").strip()
                if not text:
                    continue
                positions_score = _score_page_keywords(text, _POSITIONS_PAGE_KEYWORDS)
                summary_score = _score_page_keywords(text, _SUMMARY_PAGE_KEYWORDS)
                extracted_pages.append((idx + 1, text, positions_score, summary_score))

        if not extracted_pages:
            return {
                "positions_text": "",
                "summary_text": "",
                "positions_confidence": 0.0,
                "summary_confidence": 0.0,
                "selected_pages": [],
            }

        positions_pages = sorted(
            extracted_pages,
            key=lambda row: (row[2], len(row[1])),
            reverse=True,
        )[:5]
        summary_pages = sorted(
            extracted_pages,
            key=lambda row: (row[3], len(row[1])),
            reverse=True,
        )[:4]

        def build_text(rows: list[tuple[int, str, float, float]]) -> str:
            chunks: list[str] = []
            for page_num, page_text, _p_score, _s_score in rows:
                compact = re.sub(r"\s+", " ", page_text).strip()
                if compact:
                    chunks.append(f"[Page {page_num}] {compact[:7000]}")
            return "\n\n".join(chunks)[:52000]

        positions_conf = sum(row[2] for row in positions_pages) / max(
            1.0, float(len(positions_pages) * 4.0)
        )
        summary_conf = sum(row[3] for row in summary_pages) / max(
            1.0, float(len(summary_pages) * 4.0)
        )
        selected_pages = sorted({row[0] for row in positions_pages + summary_pages})
        return {
            "positions_text": build_text(positions_pages),
            "summary_text": build_text(summary_pages),
            "positions_confidence": round(max(0.0, min(1.0, positions_conf)), 4),
            "summary_confidence": round(max(0.0, min(1.0, summary_conf)), 4),
            "selected_pages": selected_pages,
        }
    except Exception as context_err:
        logger.warning("[Portfolio Import] PDF context extraction failed: %s", context_err)
        return {
            "positions_text": "",
            "summary_text": "",
            "positions_confidence": 0.0,
            "summary_confidence": 0.0,
            "selected_pages": [],
            "error": str(context_err),
        }


def _compute_positions_coverage(
    *,
    holdings: list[dict[str, Any]],
    total_value: Optional[float],
) -> dict[str, Any]:
    holdings_count = len(holdings)
    holdings_market_value = round(
        sum(_coerce_optional_number(row.get("market_value")) or 0.0 for row in holdings), 2
    )
    statement_total_value = _coerce_optional_number(total_value)
    coverage_pct: Optional[float] = None
    if statement_total_value is not None and statement_total_value > 0:
        coverage_pct = (holdings_market_value / statement_total_value) * 100.0

    placeholder_symbol_count = sum(
        1
        for row in holdings
        if not str(row.get("symbol") or "").strip()
        or str(row.get("symbol") or "").startswith("HOLDING_")
    )
    unknown_name_count = sum(1 for row in holdings if _is_unknown_name(row.get("name")))
    placeholder_ratio = placeholder_symbol_count / holdings_count if holdings_count > 0 else 1.0
    unknown_name_ratio = unknown_name_count / holdings_count if holdings_count > 0 else 1.0

    return {
        "holdings_count": holdings_count,
        "holdings_market_value_sum": holdings_market_value,
        "statement_total_value": statement_total_value,
        "value_coverage_pct": round(coverage_pct, 4) if coverage_pct is not None else None,
        "placeholder_symbol_count": placeholder_symbol_count,
        "placeholder_ratio": round(placeholder_ratio, 4),
        "unknown_name_count": unknown_name_count,
        "unknown_name_ratio": round(unknown_name_ratio, 4),
    }


def _first_present(row: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in row and row.get(key) not in (None, ""):
            return row.get(key)
    return None


def _coerce_optional_number(value: Any) -> Optional[float]:
    """Parse currency-like values to float; return None for blanks/invalid numbers."""
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        num = float(value)
        return num if math.isfinite(num) else None

    text = str(value).strip()
    if not text or text.lower() in {"n/a", "na", "null", "none", "--", "-"}:
        return None

    negative = text.startswith("(") and text.endswith(")")
    if negative:
        text = text[1:-1]
    text = _NUMERIC_STRIP_RE.sub("", text).replace("%", "")
    if negative:
        text = f"-{text}"

    try:
        num = float(text)
        return num if math.isfinite(num) else None
    except ValueError:
        return None


def _coerce_optional_bool(value: Any) -> Optional[bool]:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        if value == 1:
            return True
        if value == 0:
            return False
        return None
    text = str(value).strip().lower()
    if not text:
        return None
    if text in {"true", "yes", "y", "1"}:
        return True
    if text in {"false", "no", "n", "0"}:
        return False
    return None


def _normalize_optional_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text.lower() in {"null", "none", "n/a", "na", "unknown", "-", "--"}:
        return None
    return text


def _is_missing_value(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip() == ""
    if isinstance(value, list):
        return len(value) == 0
    if isinstance(value, dict):
        return len(value) == 0
    return False


def _detect_sparse_sections(parsed_data: dict[str, Any]) -> list[str]:
    sparse_sections: list[str] = []
    account_metadata = (
        parsed_data.get("account_metadata")
        if isinstance(parsed_data.get("account_metadata"), dict)
        else {}
    )
    portfolio_summary = (
        parsed_data.get("portfolio_summary")
        if isinstance(parsed_data.get("portfolio_summary"), dict)
        else {}
    )
    asset_allocation = parsed_data.get("asset_allocation")

    account_required = ("institution_name", "statement_period_start", "statement_period_end")
    account_present = sum(
        1 for key in account_required if not _is_missing_value(account_metadata.get(key))
    )
    if account_present < 2:
        sparse_sections.append("account_metadata")

    summary_present = 0
    if (
        _coerce_optional_number(
            _first_present(
                portfolio_summary,
                "beginning_value",
                "beginning_market_value",
                "start_value",
            )
        )
        is not None
    ):
        summary_present += 1
    if (
        _coerce_optional_number(
            _first_present(
                portfolio_summary,
                "ending_value",
                "ending_market_value",
                "total_market_value",
                "total_value",
            )
        )
        is not None
    ):
        summary_present += 1
    if (
        _coerce_optional_number(
            _first_present(
                portfolio_summary,
                "total_change",
                "total_investment_results",
                "net_change_in_investment_value",
                "investment_gain_loss",
            )
        )
        is not None
    ):
        summary_present += 1
    if summary_present < 2:
        sparse_sections.append("portfolio_summary")

    asset_allocation_has_signal = False
    if isinstance(asset_allocation, list):
        for row in asset_allocation:
            if not isinstance(row, dict):
                continue
            if (
                _coerce_optional_number(_first_present(row, "market_value", "value", "amount"))
                is not None
            ):
                asset_allocation_has_signal = True
                break
            if (
                _coerce_optional_number(_first_present(row, "percentage", "pct", "weight"))
                is not None
            ):
                asset_allocation_has_signal = True
                break
            category = str(
                _first_present(row, "category", "asset_class", "asset_type") or ""
            ).strip()
            if category:
                asset_allocation_has_signal = True
                break
    if not asset_allocation_has_signal:
        sparse_sections.append("asset_allocation")

    if _coerce_optional_number(parsed_data.get("cash_balance")) is None:
        sparse_sections.append("cash_balance")

    recovered_holdings, _source = _extract_holdings_list(parsed_data)
    if len(recovered_holdings) == 0:
        sparse_sections.append("detailed_holdings")

    return sparse_sections


def _canonicalize_structured_portfolio_payload(parsed_data: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(parsed_data, dict):
        return {}

    canonical = dict(parsed_data)

    statement_details = (
        canonical.get("statement_details")
        if isinstance(canonical.get("statement_details"), dict)
        else {}
    )
    account_metadata = (
        canonical.get("account_metadata")
        if isinstance(canonical.get("account_metadata"), dict)
        else {}
    )

    def put_account_field_if_missing(target_key: str, *source_keys: str) -> None:
        if _normalize_optional_text(account_metadata.get(target_key)):
            return
        for source_key in source_keys:
            value = _normalize_optional_text(statement_details.get(source_key))
            if value:
                account_metadata[target_key] = value
                return

    if statement_details:
        put_account_field_if_missing(
            "institution_name",
            "institution_name",
            "financial_institution",
            "brokerage_name",
        )
        put_account_field_if_missing("account_number", "account_number")
        put_account_field_if_missing(
            "account_holder",
            "client_name",
            "account_holder",
            "account_name",
        )
        put_account_field_if_missing(
            "statement_period_start",
            "statement_start_date",
            "start_date",
        )
        put_account_field_if_missing(
            "statement_period_end",
            "statement_end_date",
            "end_date",
        )
        client_address = _normalize_optional_text(statement_details.get("client_address"))
        if client_address and not _normalize_optional_text(
            account_metadata.get("account_holder_address")
        ):
            account_metadata["account_holder_address"] = client_address

    if account_metadata:
        canonical["account_metadata"] = account_metadata

    existing_holdings = canonical.get("detailed_holdings")
    if not isinstance(existing_holdings, list) or len(existing_holdings) == 0:
        portfolio_detail = canonical.get("portfolio_detail")
        if isinstance(portfolio_detail, list):
            mapped_holdings: list[dict[str, Any]] = []
            for row in portfolio_detail:
                if not isinstance(row, dict):
                    continue
                mapped_holdings.append(
                    {
                        "asset_class": _normalize_optional_text(row.get("asset_class")),
                        "asset_type": _normalize_optional_text(row.get("asset_type"))
                        or _normalize_optional_text(row.get("asset_class")),
                        "description": _normalize_optional_text(row.get("security_description"))
                        or _normalize_optional_text(row.get("description")),
                        "name": _normalize_optional_text(row.get("security_description"))
                        or _normalize_optional_text(row.get("name")),
                        "symbol": _normalize_optional_text(row.get("ticker"))
                        or _normalize_optional_text(row.get("symbol")),
                        "symbol_cusip": _normalize_optional_text(row.get("symbol_cusip"))
                        or _normalize_optional_text(row.get("cusip"))
                        or _normalize_optional_text(row.get("security_id")),
                        "quantity": row.get("quantity"),
                        "price": row.get("market_price")
                        if row.get("market_price") is not None
                        else row.get("price"),
                        "market_value": row.get("market_value"),
                        "cost_basis": row.get("cost_basis"),
                        "unrealized_gain_loss": row.get("unrealized_gain_loss"),
                        "unrealized_gain_loss_pct": row.get("percent_of_portfolio")
                        if row.get("percent_of_portfolio") is not None
                        else row.get("unrealized_gain_loss_pct"),
                        "estimated_annual_income": row.get("estimated_annual_income"),
                        "est_yield": row.get("estimated_current_yield")
                        if row.get("estimated_current_yield") is not None
                        else row.get("est_yield"),
                        "sector": _normalize_optional_text(row.get("sector")),
                        "industry": _normalize_optional_text(row.get("industry")),
                        "acquisition_date": _normalize_optional_text(row.get("acquisition_date")),
                    }
                )
            if mapped_holdings:
                canonical["detailed_holdings"] = mapped_holdings

    if not isinstance(canonical.get("activity_and_transactions"), list):
        transactions = canonical.get("transactions")
        if isinstance(transactions, dict):
            flattened_transactions: list[dict[str, Any]] = []
            for group_name, rows in transactions.items():
                if not isinstance(rows, list):
                    continue
                for row in rows:
                    if isinstance(row, dict):
                        flattened_transactions.append({"group": group_name, **row})
            if flattened_transactions:
                canonical["activity_and_transactions"] = flattened_transactions

    if _coerce_optional_number(canonical.get("total_value")) is None:
        portfolio_summary = (
            canonical.get("portfolio_summary")
            if isinstance(canonical.get("portfolio_summary"), dict)
            else {}
        )
        derived_metrics = (
            canonical.get("derived_metrics")
            if isinstance(canonical.get("derived_metrics"), dict)
            else {}
        )
        total_value = _coerce_optional_number(
            _first_present(
                portfolio_summary,
                "ending_value",
                "ending_market_value",
                "end_value",
                "endingMarketValue",
            )
        )
        if total_value is None:
            total_value = _coerce_optional_number(
                _first_present(
                    derived_metrics,
                    "total_assets",
                    "ending_market_value",
                    "portfolio_value",
                )
            )
        if total_value is not None:
            canonical["total_value"] = total_value

    return canonical


def _normalize_portfolio_summary(parsed_data: dict[str, Any]) -> dict[str, Any]:
    summary = (
        parsed_data.get("portfolio_summary")
        if isinstance(parsed_data.get("portfolio_summary"), dict)
        else {}
    )
    income_summary = (
        parsed_data.get("income_summary")
        if isinstance(parsed_data.get("income_summary"), dict)
        else {}
    )
    cash_flow = (
        parsed_data.get("cash_flow") if isinstance(parsed_data.get("cash_flow"), dict) else {}
    )

    beginning_value = _coerce_optional_number(
        _first_present(summary, "beginning_value", "beginning_market_value", "start_value")
    )
    ending_value = _coerce_optional_number(
        _first_present(
            summary,
            "ending_value",
            "ending_market_value",
            "total_market_value",
            "total_value",
        )
    )
    total_change = _coerce_optional_number(
        _first_present(
            summary,
            "change_in_value",
            "change_in_investment_value",
            "total_change",
            "total_investment_results",
            "net_change_in_investment_value",
            "investment_gain_loss",
        )
    )
    if total_change is None and beginning_value is not None and ending_value is not None:
        total_change = ending_value - beginning_value

    net_deposits_withdrawals = _coerce_optional_number(
        _first_present(
            summary,
            "net_deposits_withdrawals",
            "net_deposits_period",
            "net_deposits",
            "net_contributions",
            "net_money_market_activity",
        )
    )
    investment_gain_loss = _coerce_optional_number(
        _first_present(
            summary,
            "investment_gain_loss",
            "net_change_in_investment_value",
            "total_investment_results",
        )
    )
    if investment_gain_loss is None:
        investment_gain_loss = total_change

    total_income_period = _coerce_optional_number(
        _first_present(
            summary,
            "total_income_period",
            "interest_dividends_other_income",
            "income_period",
            "total_income",
            "income",
        )
    )
    if total_income_period is None:
        total_income_period = _coerce_optional_number(
            _first_present(
                income_summary,
                "total_income",
                "income_total",
                "dividends_and_interest_total",
                "total",
            )
        )

    total_income_ytd = _coerce_optional_number(
        _first_present(
            summary,
            "total_income_ytd",
            "income_ytd",
            "year_to_date_income",
            "ytd_total_income",
        )
    )
    if total_income_ytd is None:
        total_income_ytd = _coerce_optional_number(
            _first_present(
                income_summary,
                "total_income_ytd",
                "year_to_date_total_income",
            )
        )
    if total_income_ytd is None:
        total_income_ytd = total_income_period

    total_fees = _coerce_optional_number(
        _first_present(
            summary,
            "total_fees",
            "fees_and_expenses",
            "fees",
            "expenses",
        )
    )
    if total_fees is None:
        total_fees = _coerce_optional_number(_first_present(cash_flow, "fees_paid", "fees"))

    normalized: dict[str, Any] = {}
    if beginning_value is not None:
        normalized["beginning_value"] = beginning_value
    if ending_value is not None:
        normalized["ending_value"] = ending_value
    if total_change is not None:
        normalized["total_change"] = total_change
    if net_deposits_withdrawals is not None:
        normalized["net_deposits_withdrawals"] = net_deposits_withdrawals
    if investment_gain_loss is not None:
        normalized["investment_gain_loss"] = investment_gain_loss
    if total_income_period is not None:
        normalized["total_income_period"] = total_income_period
    if total_income_ytd is not None:
        normalized["total_income_ytd"] = total_income_ytd
    if total_fees is not None:
        normalized["total_fees"] = total_fees

    return normalized


def _bucket_from_holding(row: dict[str, Any]) -> str:
    symbol = str(row.get("symbol") or "").strip().upper()
    name = (
        str(row.get("name") or row.get("description") or row.get("security_description") or "")
        .strip()
        .lower()
    )
    asset_type = str(row.get("asset_type") or "").strip().lower()
    sector = str(row.get("sector") or "").strip().lower()
    hint = f"{symbol} {name} {asset_type} {sector}"
    if _is_cash_equivalent_row(row):
        return "Cash"
    if any(tag in hint for tag in ("bond", "fixed income", "treasury", "municipal", "tax free")):
        return "Fixed Income"
    if any(tag in hint for tag in ("reit", "real estate", "real asset", "gold", "commodity")):
        return "Real Assets"
    if any(tag in hint for tag in ("equity", "stock", "etf", "fund", "growth", "value", "cap")):
        return "Equities"
    return "Other"


def _normalize_asset_allocation_rows(
    asset_allocation: Any,
    *,
    holdings: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    sanitized_rows: list[dict[str, Any]] = []
    if isinstance(asset_allocation, list):
        for row in asset_allocation:
            if not isinstance(row, dict):
                continue
            category = str(
                _first_present(row, "category", "asset_class", "asset_type", "label") or ""
            ).strip()
            market_value = _coerce_optional_number(
                _first_present(row, "market_value", "value", "amount")
            )
            percentage = _coerce_optional_number(_first_present(row, "percentage", "pct", "weight"))
            if not category and market_value is None and percentage is None:
                continue
            normalized_row: dict[str, Any] = {}
            if category:
                normalized_row["category"] = category
            if market_value is not None:
                normalized_row["market_value"] = market_value
            if percentage is not None:
                normalized_row["percentage"] = percentage
            sanitized_rows.append(normalized_row)

    if sanitized_rows:
        return sanitized_rows

    bucket_values: dict[str, float] = {
        "Equities": 0.0,
        "Fixed Income": 0.0,
        "Cash": 0.0,
        "Real Assets": 0.0,
        "Other": 0.0,
    }
    total_market_value = 0.0
    for row in holdings:
        market_value = _coerce_optional_number(row.get("market_value")) or 0.0
        if market_value <= 0:
            continue
        total_market_value += market_value
        bucket_values[_bucket_from_holding(row)] += market_value

    derived_rows: list[dict[str, Any]] = []
    for bucket in ("Equities", "Fixed Income", "Cash", "Real Assets", "Other"):
        value = bucket_values.get(bucket, 0.0)
        if value <= 0:
            continue
        derived_rows.append(
            {
                "category": bucket,
                "market_value": round(value, 2),
                "percentage": round((value / total_market_value) * 100, 2)
                if total_market_value > 0
                else 0.0,
            }
        )
    return derived_rows


def _derive_cash_balance_from_holdings(holdings: list[dict[str, Any]]) -> Optional[float]:
    cash_total = 0.0
    found_cash_row = False
    for row in holdings:
        if not _is_cash_equivalent_row(row):
            continue
        found_cash_row = True
        cash_total += _coerce_optional_number(row.get("market_value")) or 0.0
    if not found_cash_row:
        return None
    return round(cash_total, 2)


def _enrich_account_summary_with_holdings(
    account_summary: dict[str, Any],
    *,
    holdings: list[dict[str, Any]],
    total_value: Optional[float],
) -> dict[str, Any]:
    enriched = dict(account_summary)
    holdings_total = round(
        sum(_coerce_optional_number(row.get("market_value")) or 0.0 for row in holdings), 2
    )
    normalized_total = _coerce_optional_number(total_value)
    if normalized_total is None or normalized_total <= 0:
        normalized_total = holdings_total if holdings_total > 0 else None

    if enriched.get("ending_value") is None and normalized_total is not None:
        enriched["ending_value"] = normalized_total

    derived_cash_balance = _derive_cash_balance_from_holdings(holdings)
    if enriched.get("cash_balance") is None and derived_cash_balance is not None:
        enriched["cash_balance"] = derived_cash_balance

    beginning_value = _coerce_optional_number(enriched.get("beginning_value"))
    ending_value = _coerce_optional_number(enriched.get("ending_value"))
    change_in_value = _coerce_optional_number(enriched.get("change_in_value"))
    if change_in_value is None and beginning_value is not None and ending_value is not None:
        change_in_value = ending_value - beginning_value
        enriched["change_in_value"] = change_in_value
    if beginning_value is None and ending_value is not None and change_in_value is not None:
        enriched["beginning_value"] = ending_value - change_in_value

    if enriched.get("investment_gain_loss") is None and change_in_value is not None:
        enriched["investment_gain_loss"] = change_in_value

    return enriched


def _derive_account_metadata_from_filename(filename: str) -> dict[str, Any]:
    name = str(filename or "").strip()
    if not name:
        return {}
    stem = re.sub(r"\.(pdf|csv)$", "", name, flags=re.IGNORECASE).strip()
    stem = stem.replace("_", " ").replace("  ", " ")

    inferred: dict[str, Any] = {}
    date_match = _FILENAME_DATE_RE.search(stem)
    if date_match:
        inferred["statement_period_end"] = date_match.group(1)

    # Try to infer institution label from the suffix after the first hyphen.
    if " - " in stem:
        rhs = stem.split(" - ", 1)[1].strip()
        if rhs:
            inferred["institution_name"] = rhs
    elif stem:
        inferred["institution_name"] = stem

    acct_match = _FILENAME_ACCOUNT_RE.search(stem)
    if acct_match:
        inferred["account_number"] = acct_match.group(1)

    return inferred


def _reconcile_holding_numeric_fields(
    holding: dict[str, Any], tolerance: float = 0.10
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Apply deterministic market-value-first reconciliation for holding numeric fields."""
    normalized = dict(holding)
    reconciled_fields: list[str] = []
    mismatch_detected = False

    qty = _coerce_optional_number(normalized.get("quantity"))
    price = _coerce_optional_number(normalized.get("price"))
    market_value = _coerce_optional_number(normalized.get("market_value"))
    has_qty = qty is not None and qty != 0.0

    # Fill missing market value when quantity and price are available.
    if market_value is None and has_qty and price is not None:
        qty_value = qty if qty is not None else 0.0
        market_value = qty_value * price
        reconciled_fields.append("market_value")

    # Market value is authoritative: derive/recompute price when possible.
    if has_qty and market_value is not None:
        qty_value = qty if qty is not None else 1.0
        derived_price = market_value / qty_value
        if price is None:
            price = derived_price
            reconciled_fields.append("price")
        elif derived_price != 0:
            rel_delta = abs(price - derived_price) / abs(derived_price)
            if rel_delta > tolerance:
                mismatch_detected = True
                price = derived_price
                reconciled_fields.append("price")

    if qty is not None and price is not None and market_value is not None and market_value != 0:
        expected_market_value = qty * price
        rel_delta = abs(expected_market_value - market_value) / abs(market_value)
        if rel_delta > tolerance:
            mismatch_detected = True

    normalized["quantity"] = qty
    normalized["price"] = price
    normalized["price_per_unit"] = price
    normalized["market_value"] = market_value
    normalized["cost_basis"] = _coerce_optional_number(normalized.get("cost_basis"))
    normalized["unrealized_gain_loss"] = _coerce_optional_number(
        normalized.get("unrealized_gain_loss")
    )
    normalized["unrealized_gain_loss_pct"] = _coerce_optional_number(
        normalized.get("unrealized_gain_loss_pct")
    )
    normalized["estimated_annual_income"] = _coerce_optional_number(
        normalized.get("estimated_annual_income")
    )
    normalized["est_yield"] = _coerce_optional_number(normalized.get("est_yield"))

    return normalized, {
        "reconciled_fields": sorted(set(reconciled_fields)),
        "mismatch_detected": mismatch_detected,
    }


_UNKNOWN_NAMES = {
    "",
    "unknown",
    "n/a",
    "na",
    "none",
    "unnamed",
}
_ACCOUNT_HEADER_HINTS = (
    "individual",
    "traditional ira",
    "education account",
    "tod",
    "joint",
    "account",
)
_CASH_EQUIVALENT_HINTS = (
    "cash",
    "money market",
    "sweep",
    "core position",
)
_TRADE_ACTION_TOKENS = {
    "BUY",
    "SELL",
    "REINVEST",
    "DIVIDEND",
    "INTEREST",
    "TRANSFER",
    "WITHDRAWAL",
    "DEPOSIT",
}
_PLACEHOLDER_SYMBOL_TOKENS = {
    "NULL",
    "NA",
    "NAN",
    "NONE",
    "UNKNOWN",
    "UNAVAILABLE",
}


def _normalize_symbol_token(raw_value: Any) -> str:
    if raw_value is None:
        return ""
    token = re.sub(r"[^A-Za-z0-9]", "", str(raw_value)).upper()
    if token in _PLACEHOLDER_SYMBOL_TOKENS:
        return ""
    return token[:12]


def _is_unknown_name(value: Any) -> bool:
    if value is None:
        return True
    name = str(value).strip().lower()
    return name in _UNKNOWN_NAMES


def _is_non_holding_row(row: dict[str, Any]) -> bool:
    """
    Detect rows that look like account/profile headers instead of holdings.
    """
    name = (
        str(row.get("name") or row.get("description") or row.get("security_description") or "")
        .strip()
        .lower()
    )
    symbol = str(row.get("symbol") or "").strip().lower()

    has_numeric = any(
        _coerce_optional_number(row.get(key)) is not None
        for key in ("quantity", "price", "market_value", "cost_basis")
    )
    if not has_numeric and any(hint in name for hint in _ACCOUNT_HEADER_HINTS):
        return True
    if not has_numeric and symbol == "" and name:
        return True
    return False


def _is_cash_equivalent_row(row: dict[str, Any]) -> bool:
    symbol = str(row.get("symbol") or "").strip().upper()
    if symbol in {"CASH", "MMF", "SWEEP"}:
        return True
    asset_type = str(row.get("asset_type") or "").strip().lower()
    if asset_type in {"cash", "cash_equivalent", "money_market"}:
        return True
    name = (
        str(row.get("name") or row.get("description") or row.get("security_description") or "")
        .strip()
        .lower()
    )
    return any(hint in name for hint in _CASH_EQUIVALENT_HINTS)


def _looks_like_cash_sweep_identifier(
    symbol: str,
    *,
    name: str,
    asset_type: str,
) -> bool:
    normalized_symbol = str(symbol).strip().upper()
    if not normalized_symbol:
        return False
    if normalized_symbol in {"CASH", "MMF", "SWEEP"}:
        return False
    name_lc = str(name).strip().lower()
    asset_lc = str(asset_type).strip().lower()
    if "sweep" in name_lc:
        return True
    if "cash" in name_lc and ("cash" in asset_lc or "sweep" in asset_lc):
        return True
    if "cash" in asset_lc and len(normalized_symbol) > 4:
        return True
    return False


def _compute_holding_confidence(row: dict[str, Any]) -> float:
    """
    Compute a deterministic row confidence score in [0, 1].

    This score is intentionally simple and auditable:
    - Strongly rewards explicit symbols and complete numeric fields.
    - Penalizes synthetic/derived identifiers and reconciliation mismatches.
    """
    score = 0.2
    symbol_quality = str(row.get("symbol_quality") or "").lower().strip()
    if symbol_quality == "provided":
        score += 0.35
    elif symbol_quality == "derived_from_name":
        score += 0.2
    elif symbol_quality == "aggregated":
        score += 0.25
    else:
        score += 0.05

    name = str(row.get("name") or "").strip()
    if not _is_unknown_name(name):
        score += 0.1

    quantity = _coerce_optional_number(row.get("quantity"))
    price = _coerce_optional_number(row.get("price"))
    market_value = _coerce_optional_number(row.get("market_value"))
    if quantity is not None:
        score += 0.1
    if price is not None:
        score += 0.1
    if market_value is not None:
        score += 0.1

    reconciliation = row.get("reconciliation")
    if isinstance(reconciliation, dict) and reconciliation.get("mismatch_detected"):
        score -= 0.15

    if str(row.get("symbol") or "").startswith("HOLDING_"):
        score = min(score, 0.35)

    return max(0.0, min(1.0, round(score, 4)))


def _derive_analyze_eligibility(
    *,
    is_investable: bool,
    is_cash_equivalent: bool,
    security_listing_status: str,
    symbol_kind: str,
    is_sec_common_equity_ticker: bool,
) -> tuple[bool, str]:
    listing_status = str(security_listing_status or "").strip().lower()
    kind = str(symbol_kind or "").strip().lower()

    if is_cash_equivalent or listing_status == "cash_or_sweep":
        return False, "excluded_cash"
    if listing_status == "fixed_income":
        return False, "excluded_fixed_income"
    if listing_status == "non_sec_common_equity":
        return False, "excluded_non_sec_common_equity"
    if not is_investable:
        return False, "excluded_missing_equity_classification"
    if (
        is_sec_common_equity_ticker
        or listing_status == "sec_common_equity"
        or kind == "us_common_equity_ticker"
    ):
        return True, "eligible_sec_common_equity"
    return False, "excluded_missing_equity_classification"


def _normalize_raw_holding_row(row: dict[str, Any], idx: int) -> dict[str, Any]:
    symbol_master = get_symbol_master_service()
    raw_ticker_value = _first_present(row, "symbol", "ticker")
    raw_identifier_value = _first_present(row, "symbol_cusip", "cusip", "security_id", "security")
    normalized_ticker = _normalize_symbol_token(raw_ticker_value)
    normalized_identifier = _normalize_symbol_token(raw_identifier_value)
    if normalized_ticker:
        identifier_type = "ticker"
    elif normalized_identifier:
        identifier_type = "cusip"
    else:
        identifier_type = "derived"
    raw_symbol = _first_present(
        row,
        "symbol",
        "ticker",
        "symbol_cusip",
        "cusip",
        "security_id",
        "security",
    )
    symbol_quality = "provided"
    normalized_symbol = _normalize_symbol_token(raw_symbol)
    raw_name = (
        _normalize_optional_text(
            _first_present(
                row,
                "description",
                "name",
                "security_name",
                "holding_name",
                "security_description",
            )
        )
        or ""
    )
    raw_asset_type = (
        _normalize_optional_text(
            _first_present(
                row,
                "asset_class",
                "asset_type",
                "security_type",
                "type",
            )
        )
        or ""
    )
    raw_symbol_source = (
        (_normalize_optional_text(_first_present(row, "symbol_source")) or "").strip().lower()
    )
    raw_symbol_kind = (
        (_normalize_optional_text(_first_present(row, "symbol_kind")) or "").strip().lower()
    )
    raw_listing_status = (
        (_normalize_optional_text(_first_present(row, "security_listing_status")) or "")
        .strip()
        .lower()
    )
    raw_is_sec_common_equity = _coerce_optional_bool(
        _first_present(row, "is_sec_common_equity_ticker")
    )
    if not normalized_symbol:
        if raw_name:
            fallback = _normalize_symbol_token(raw_name.split()[0])
            normalized_symbol = fallback
            symbol_quality = "derived_from_name" if fallback else "synthetic"
        else:
            symbol_quality = "synthetic"
    if not normalized_symbol and symbol_quality == "synthetic":
        normalized_symbol = f"HOLDING_{idx + 1}"

    # Cash sweep lines often carry internal identifiers (e.g., QACDS).
    # Canonicalize to CASH so market/watchlist layers do not treat them as tradable tickers.
    if _looks_like_cash_sweep_identifier(
        normalized_symbol, name=raw_name, asset_type=raw_asset_type
    ):
        normalized_symbol = "CASH"
        if symbol_quality == "provided":
            symbol_quality = "derived_from_name"

    symbol_classification = symbol_master.classify(
        normalized_symbol,
        name=raw_name,
        asset_type=raw_asset_type,
    )
    if symbol_classification.symbol:
        normalized_symbol = symbol_classification.symbol
    is_cash_equivalent = symbol_classification.trust_tier == "cash_equivalent"
    is_investable = bool(symbol_classification.tradable) and not is_cash_equivalent
    instrument_kind = "equity"
    asset_type_hint = raw_asset_type.lower()
    if is_cash_equivalent:
        instrument_kind = "cash_equivalent"
    elif any(h in asset_type_hint for h in ("bond", "fixed income", "treasury", "municipal")):
        instrument_kind = "fixed_income"
    elif any(
        h in asset_type_hint for h in ("real estate", "reit", "commodity", "gold", "real asset")
    ):
        instrument_kind = "real_asset"
    elif any(h in asset_type_hint for h in ("fund", "etf", "stock", "equity")):
        instrument_kind = "equity"
    elif symbol_classification.tradable and not is_cash_equivalent and identifier_type == "ticker":
        # Treat ticker-like tradable holdings as equity when statement asset_type is missing.
        instrument_kind = "equity"
    elif raw_symbol_kind in {"us_common_equity_ticker", "fund_or_etf_ticker"}:
        instrument_kind = "equity"
    elif raw_is_sec_common_equity is True:
        instrument_kind = "equity"
    else:
        instrument_kind = "other"

    symbol_source = raw_symbol_source
    if symbol_source not in {
        "statement_ticker",
        "statement_cusip",
        "statement_security_id",
        "derived_none",
    }:
        if normalized_ticker:
            symbol_source = "statement_ticker"
        elif normalized_identifier:
            symbol_source = "statement_cusip"
        else:
            symbol_source = "derived_none"

    symbol_kind = raw_symbol_kind
    if symbol_kind not in {
        "us_common_equity_ticker",
        "fund_or_etf_ticker",
        "bond_or_fixed_income_id",
        "cash_identifier",
        "unknown",
    }:
        if is_cash_equivalent:
            symbol_kind = "cash_identifier"
        elif instrument_kind == "fixed_income":
            symbol_kind = "bond_or_fixed_income_id"
        elif instrument_kind in {"equity", "real_asset"} and identifier_type == "ticker":
            symbol_kind = "unknown"
        else:
            symbol_kind = "unknown"

    security_listing_status = raw_listing_status
    if security_listing_status not in {
        "sec_common_equity",
        "non_sec_common_equity",
        "cash_or_sweep",
        "fixed_income",
        "unknown",
    }:
        if is_cash_equivalent:
            security_listing_status = "cash_or_sweep"
        elif instrument_kind == "fixed_income":
            security_listing_status = "fixed_income"
        else:
            security_listing_status = "unknown"

    is_sec_common_equity_ticker = raw_is_sec_common_equity
    if is_sec_common_equity_ticker is None:
        is_sec_common_equity_ticker = (
            security_listing_status == "sec_common_equity"
            or symbol_kind == "us_common_equity_ticker"
        )

    analyze_eligible, analyze_eligible_reason = _derive_analyze_eligibility(
        is_investable=is_investable,
        is_cash_equivalent=is_cash_equivalent,
        security_listing_status=security_listing_status,
        symbol_kind=symbol_kind,
        is_sec_common_equity_ticker=bool(is_sec_common_equity_ticker),
    )

    raw_sector_value = _first_present(row, "sector", "gics_sector", "sector_name")
    raw_sector = _normalize_optional_text(raw_sector_value) or ""
    raw_industry_value = _first_present(row, "industry", "gics_industry", "industry_name")
    raw_industry = _normalize_optional_text(raw_industry_value) or ""
    merged_sector, merged_industry, sector_tags, metadata_confidence = symbol_master.enrich_holding(
        symbol=normalized_symbol,
        sector=raw_sector or None,
        industry=raw_industry or None,
    )
    if symbol_classification.trust_tier == "cash_equivalent":
        merged_sector = merged_sector or "Cash & Cash Equivalents"
        merged_industry = merged_industry or "Cash Management"

    normalized, reconciliation = _reconcile_holding_numeric_fields(
        {
            "symbol": normalized_symbol,
            "symbol_cusip": normalized_identifier or None,
            "identifier_type": identifier_type,
            "symbol_quality": symbol_quality,
            "symbol_trust_tier": symbol_classification.trust_tier,
            "symbol_trust_reason": symbol_classification.reason,
            "tradable": bool(symbol_classification.tradable),
            "instrument_kind": instrument_kind,
            "is_cash_equivalent": is_cash_equivalent,
            "is_investable": is_investable,
            "debate_eligible": is_investable,
            "optimize_eligible": is_investable,
            "analyze_eligible": analyze_eligible,
            "analyze_eligible_reason": analyze_eligible_reason,
            "symbol_source": symbol_source,
            "symbol_kind": symbol_kind,
            "security_listing_status": security_listing_status,
            "is_sec_common_equity_ticker": is_sec_common_equity_ticker,
            "name": raw_name or "Unknown",
            "quantity": _first_present(row, "quantity", "shares", "units", "qty"),
            "price": _first_present(
                row,
                "price",
                "price_per_unit",
                "last_price",
                "unit_price",
                "current_price",
            ),
            "price_per_unit": _first_present(
                row,
                "price",
                "price_per_unit",
                "last_price",
                "unit_price",
                "current_price",
            ),
            "market_value": _first_present(
                row,
                "market_value",
                "current_value",
                "marketValue",
                "value",
                "position_value",
            ),
            "cost_basis": _first_present(
                row,
                "cost_basis",
                "book_value",
                "cost",
                "total_cost",
            ),
            "unrealized_gain_loss": _first_present(
                row,
                "unrealized_gain_loss",
                "gain_loss",
                "unrealized_pnl",
                "pnl",
            ),
            "unrealized_gain_loss_pct": _first_present(
                row,
                "unrealized_gain_loss_pct",
                "gain_loss_pct",
                "unrealized_return_pct",
                "return_pct",
            ),
            "asset_type": raw_asset_type or None,
            "sector": merged_sector,
            "industry": merged_industry,
            "sector_tags": sector_tags,
            "metadata_confidence": metadata_confidence,
            "acquisition_date": _normalize_optional_text(row.get("acquisition_date")),
            "estimated_annual_income": _first_present(
                row,
                "estimated_annual_income",
                "est_annual_income",
                "annual_income",
            ),
            "est_yield": _first_present(row, "est_yield", "yield", "current_yield"),
        }
    )
    if reconciliation["reconciled_fields"] or reconciliation["mismatch_detected"]:
        normalized["reconciliation"] = reconciliation
    normalized["confidence"] = _compute_holding_confidence(normalized)
    normalized["provenance"] = {
        "source": "statement_llm_parse",
        "symbol_quality": symbol_quality,
        "symbol_trust_tier": symbol_classification.trust_tier,
        "symbol_trust_reason": symbol_classification.reason,
        "reconciled_fields": reconciliation.get("reconciled_fields", []),
        "mismatch_detected": bool(reconciliation.get("mismatch_detected")),
    }
    return normalized


def _validate_holding_row(row: dict[str, Any]) -> tuple[bool, str | None]:
    symbol = str(row.get("symbol") or "").strip()
    symbol_quality = str(row.get("symbol_quality") or "").strip().lower()
    symbol_trust_tier = str(row.get("symbol_trust_tier") or "").strip().lower()
    name = str(row.get("name") or "").strip()
    quantity = _coerce_optional_number(row.get("quantity"))
    price = _coerce_optional_number(row.get("price"))
    market_value = _coerce_optional_number(row.get("market_value"))

    if _is_non_holding_row(row):
        return False, "account_header_row"

    if symbol.startswith("HOLDING") or not symbol:
        if symbol_quality == "synthetic":
            return False, "placeholder_symbol"
        if not symbol:
            return False, "missing_symbol"

    if symbol_trust_tier == "action_token" or symbol.upper() in _TRADE_ACTION_TOKENS:
        return False, "trade_action_token"

    if symbol in {"UNKNOWN", "NA", "NONE", "N/A"}:
        return False, "placeholder_symbol"

    if _is_unknown_name(name) and symbol_quality != "provided":
        return False, "unknown_name"

    if _is_unknown_name(name) and (symbol.startswith("HOLDING") or not symbol):
        return False, "unknown_name"

    if quantity is None and price is None and market_value is None:
        return False, "missing_financial_data"

    # Reject impossible rows that still leak through LLM output:
    # quantity=0, price~0, huge market value and no strong symbol.
    if (
        quantity is not None
        and abs(quantity) < 1e-9
        and (price is None or abs(price) < 1e-9)
        and market_value is not None
        and abs(market_value) >= 1.0
        and symbol_quality != "provided"
        and not _is_cash_equivalent_row(row)
    ):
        return False, "zero_qty_zero_price_nonzero_value"

    return True, None


def _aggregate_holdings_by_symbol(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    def derive_position_side(
        quantity: float | None,
        market_value: float | None,
        is_cash_equivalent: bool,
    ) -> str:
        qty_negative = quantity is not None and quantity < 0
        mv_negative = market_value is not None and market_value < 0
        if is_cash_equivalent and mv_negative:
            return "liability"
        if qty_negative or mv_negative:
            return "short"
        return "long"

    grouped: dict[str, dict[str, Any]] = {}
    for row in rows:
        symbol = _normalize_symbol_token(row.get("symbol"))
        if not symbol:
            continue
        existing = grouped.get(symbol)
        if not existing:
            quantity = _coerce_optional_number(row.get("quantity"))
            market_value = _coerce_optional_number(row.get("market_value"))
            is_cash_equivalent = bool(row.get("is_cash_equivalent"))
            position_side = derive_position_side(quantity, market_value, is_cash_equivalent)
            grouped[symbol] = {
                **row,
                "symbol": symbol,
                "lots_count": 1,
                "confidence": _coerce_optional_number(row.get("confidence")) or 0.0,
                "quantity": quantity,
                "market_value": market_value,
                "cost_basis": _coerce_optional_number(row.get("cost_basis")),
                "unrealized_gain_loss": _coerce_optional_number(row.get("unrealized_gain_loss")),
                "provenance": {
                    "source": "statement_llm_parse",
                    "aggregated_from_lots": 1,
                },
                "is_cash_equivalent": is_cash_equivalent,
                "is_investable": bool(row.get("is_investable")),
                "debate_eligible": bool(row.get("debate_eligible")),
                "optimize_eligible": bool(row.get("optimize_eligible")),
                "analyze_eligible": bool(row.get("analyze_eligible")),
                "analyze_eligible_reason": str(
                    row.get("analyze_eligible_reason") or "excluded_missing_equity_classification"
                ),
                "position_side": position_side,
                "is_short_position": position_side == "short",
                "is_liability_position": position_side == "liability",
            }
            continue

        existing["lots_count"] = int(existing.get("lots_count") or 1) + 1
        existing["provenance"] = {
            "source": "statement_llm_parse",
            "aggregated_from_lots": existing["lots_count"],
        }

        incoming_confidence = _coerce_optional_number(row.get("confidence")) or 0.0
        existing_confidence = _coerce_optional_number(existing.get("confidence")) or 0.0
        lot_count_before = max(1, existing["lots_count"] - 1)
        existing["confidence"] = round(
            ((existing_confidence * lot_count_before) + incoming_confidence)
            / existing["lots_count"],
            4,
        )

        for field in ("quantity", "market_value", "cost_basis", "unrealized_gain_loss"):
            current_value = _coerce_optional_number(existing.get(field))
            incoming_value = _coerce_optional_number(row.get(field))
            if incoming_value is None:
                continue
            if current_value is None:
                existing[field] = incoming_value
            else:
                existing[field] = current_value + incoming_value

        existing_quantity = _coerce_optional_number(existing.get("quantity"))
        existing_market_value = _coerce_optional_number(existing.get("market_value"))
        existing_is_cash_equivalent = bool(existing.get("is_cash_equivalent"))
        existing_position_side = derive_position_side(
            existing_quantity,
            existing_market_value,
            existing_is_cash_equivalent,
        )
        existing["position_side"] = existing_position_side
        existing["is_short_position"] = existing_position_side == "short"
        existing["is_liability_position"] = existing_position_side == "liability"

        existing_name = str(existing.get("name") or "").strip()
        incoming_name = str(row.get("name") or "").strip()
        if _is_unknown_name(existing_name) and incoming_name:
            existing["name"] = incoming_name
        if not existing.get("asset_type") and row.get("asset_type"):
            existing["asset_type"] = row.get("asset_type")
        if not existing.get("sector") and row.get("sector"):
            existing["sector"] = row.get("sector")
        if not existing.get("industry") and row.get("industry"):
            existing["industry"] = row.get("industry")
        existing_tags = (
            existing.get("sector_tags") if isinstance(existing.get("sector_tags"), list) else []
        )
        incoming_tags = row.get("sector_tags") if isinstance(row.get("sector_tags"), list) else []
        if incoming_tags:
            deduped_tags: list[str] = []
            for tag in [*existing_tags, *incoming_tags]:
                text = str(tag or "").strip()
                if text and text not in deduped_tags:
                    deduped_tags.append(text)
            existing["sector_tags"] = deduped_tags
        existing_conf = _coerce_optional_number(existing.get("metadata_confidence")) or 0.0
        incoming_conf = _coerce_optional_number(row.get("metadata_confidence")) or 0.0
        existing["metadata_confidence"] = max(existing_conf, incoming_conf)
        if not bool(existing.get("tradable")) and bool(row.get("tradable")):
            existing["tradable"] = True
        existing["is_cash_equivalent"] = bool(existing.get("is_cash_equivalent")) or bool(
            row.get("is_cash_equivalent")
        )
        existing["is_investable"] = bool(existing.get("tradable")) and not bool(
            existing.get("is_cash_equivalent")
        )
        existing["debate_eligible"] = bool(existing.get("is_investable"))
        existing["optimize_eligible"] = bool(existing.get("is_investable"))
        existing["analyze_eligible"] = bool(existing.get("analyze_eligible")) and bool(
            existing.get("is_investable")
        )
        if str(existing.get("analyze_eligible_reason") or "").strip().lower() in {
            "",
            "excluded_missing_equity_classification",
        } and row.get("analyze_eligible_reason"):
            existing["analyze_eligible_reason"] = row.get("analyze_eligible_reason")
        if not existing.get("identifier_type") and row.get("identifier_type"):
            existing["identifier_type"] = row.get("identifier_type")
        if not existing.get("symbol_cusip") and row.get("symbol_cusip"):
            existing["symbol_cusip"] = row.get("symbol_cusip")
        if not existing.get("instrument_kind") and row.get("instrument_kind"):
            existing["instrument_kind"] = row.get("instrument_kind")
        if not existing.get("symbol_source") and row.get("symbol_source"):
            existing["symbol_source"] = row.get("symbol_source")
        if str(existing.get("symbol_kind") or "").strip().lower() in {"", "unknown"} and row.get(
            "symbol_kind"
        ):
            existing["symbol_kind"] = row.get("symbol_kind")
        if str(existing.get("security_listing_status") or "").strip().lower() in {
            "",
            "unknown",
        } and row.get("security_listing_status"):
            existing["security_listing_status"] = row.get("security_listing_status")
        if (
            existing.get("is_sec_common_equity_ticker") is None
            and row.get("is_sec_common_equity_ticker") is not None
        ):
            existing["is_sec_common_equity_ticker"] = bool(row.get("is_sec_common_equity_ticker"))
        if str(existing.get("symbol_trust_tier") or "").lower() in {"", "unknown"}:
            existing["symbol_trust_tier"] = row.get("symbol_trust_tier")
            existing["symbol_trust_reason"] = row.get("symbol_trust_reason")

    aggregated = list(grouped.values())
    for row in aggregated:
        qty = _coerce_optional_number(row.get("quantity"))
        market_value = _coerce_optional_number(row.get("market_value"))
        if qty is not None and abs(qty) > 1e-9 and market_value is not None:
            row["price"] = market_value / qty
            row["price_per_unit"] = row["price"]
        row["is_cash_equivalent"] = bool(row.get("is_cash_equivalent")) or _is_cash_equivalent_row(
            row
        )
        row["is_investable"] = bool(row.get("tradable")) and not bool(row.get("is_cash_equivalent"))
        row["debate_eligible"] = bool(row.get("is_investable"))
        row["optimize_eligible"] = bool(row.get("is_investable"))
        analyze_eligible, analyze_eligible_reason = _derive_analyze_eligibility(
            is_investable=bool(row.get("is_investable")),
            is_cash_equivalent=bool(row.get("is_cash_equivalent")),
            security_listing_status=str(row.get("security_listing_status") or ""),
            symbol_kind=str(row.get("symbol_kind") or ""),
            is_sec_common_equity_ticker=bool(row.get("is_sec_common_equity_ticker")),
        )
        row["analyze_eligible"] = analyze_eligible
        row["analyze_eligible_reason"] = analyze_eligible_reason
        row["symbol_quality"] = "aggregated"
        row["confidence"] = _compute_holding_confidence(row)
    return aggregated


class PortfolioImportResponse(BaseModel):
    """Response from portfolio import endpoint."""

    success: bool
    holdings_count: int = 0
    total_value: float = 0.0
    losers: list[dict] = Field(default_factory=list)
    winners: list[dict] = Field(default_factory=list)
    kpis_stored: list[str] = Field(default_factory=list)
    error: Optional[str] = None
    source: str = "unknown"
    # Comprehensive financial data (LLM-extracted)
    portfolio_data: Optional[dict] = None
    account_info: Optional[dict] = None
    account_summary: Optional[dict] = None
    asset_allocation: Optional[dict] = None
    income_summary: Optional[dict] = None
    realized_gain_loss: Optional[dict] = None
    transactions: Optional[list] = None
    cash_balance: float = 0.0


class PortfolioSummaryResponse(BaseModel):
    """Response for portfolio summary endpoint."""

    user_id: str
    has_portfolio: bool
    holdings_count: Optional[int] = None
    portfolio_value_bucket: Optional[str] = None
    portfolio_risk_bucket: Optional[str] = None
    preference_risk_profile: Optional[str] = None
    losers_count: Optional[int] = None
    winners_count: Optional[int] = None
    total_gain_loss_pct: Optional[float] = None


class DashboardProfilePick(BaseModel):
    """Profile-personalized ticker candidate for dashboard recommendations."""

    symbol: str
    company_name: str
    sector: Optional[str] = None
    tier: Optional[str] = None
    conviction_weight: float = 0.0
    price: Optional[float] = None
    change_percent: Optional[float] = None
    recommendation_bias: Optional[str] = None
    rationale: str
    source_tags: list[str] = Field(default_factory=list)
    degraded: bool = False
    as_of: Optional[str] = None


class DashboardProfilePicksResponse(BaseModel):
    """Response payload for profile-based picks on Kai dashboard."""

    user_id: str
    generated_at: str
    risk_profile: str
    picks: list[DashboardProfilePick] = Field(default_factory=list)
    context: dict[str, Any] = Field(default_factory=dict)


def _now_utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _normalize_symbols_query(raw: Optional[str], *, max_items: int = 20) -> list[str]:
    if not raw:
        return []
    out: list[str] = []
    for part in raw.split(","):
        symbol = str(part or "").strip().upper()
        if not symbol or not _PICK_TICKER_RE.match(symbol):
            continue
        if symbol in out:
            continue
        out.append(symbol)
        if len(out) >= max_items:
            break
    return out


def _normalize_risk_profile(raw: Any) -> str:
    text = str(raw or "").strip().lower()
    if text in {"conservative", "balanced", "aggressive"}:
        return text
    return "balanced"


def _allowed_tiers_for_risk(risk_profile: str) -> tuple[str, ...]:
    if risk_profile == "conservative":
        return ("ACE", "KING")
    if risk_profile == "aggressive":
        return ("KING", "QUEEN", "JACK", "ACE")
    return ("ACE", "KING", "QUEEN")


def _recommendation_bias_from_tier(tier: str) -> str:
    tier_upper = str(tier or "").strip().upper()
    return {
        "ACE": "STRONG_BUY",
        "KING": "BUY",
        "QUEEN": "HOLD_TO_BUY",
        "JACK": "WATCHLIST",
    }.get(tier_upper, "NEUTRAL")


def _candidate_rank(
    *,
    tier: str,
    sector: str,
    dominant_sectors: list[str],
    tier_rank: Optional[int],
) -> tuple[float, int, str]:
    tier_upper = str(tier or "").strip().upper()
    sector_clean = str(sector or "").strip()
    score = float(TIER_WEIGHTS.get(tier_upper, 0.5))
    if dominant_sectors:
        if sector_clean == dominant_sectors[0]:
            score += 0.22
        elif sector_clean in dominant_sectors:
            score += 0.12
    tie_breaker = tier_rank if isinstance(tier_rank, int) else 999_999
    return (score, -tie_breaker, tier_upper)


def _build_pick_rationale(*, tier: str, sector: str, dominant_sector: Optional[str]) -> str:
    tier_upper = str(tier or "").strip().upper() or "UNRANKED"
    if dominant_sector and sector and sector == dominant_sector:
        return (
            f"{tier_upper} tier candidate with sector alignment to your existing portfolio "
            f"({sector})."
        )
    if sector:
        return f"{tier_upper} tier candidate with resilient fundamentals in {sector}."
    return f"{tier_upper} tier candidate from the Renaissance investable universe."


@router.post("/portfolio/import", response_model=PortfolioImportResponse)
async def import_portfolio(
    file: UploadFile,
    user_id: str = Form(..., description="User's ID"),
    token_data: dict = Depends(require_vault_owner_token),
) -> PortfolioImportResponse:
    """
    Import a brokerage statement and analyze the portfolio.

    Accepts CSV or PDF files from major brokerages:
    - Charles Schwab
    - Fidelity
    - Robinhood
    - Generic CSV format

    **Process**:
    1. Parse the file to extract holdings
    2. Derive KPIs (risk bucket, sector allocation, etc.)
    3. Store KPIs in user's PKM
    4. Return summary with losers and winners

    **Authentication**: Requires valid VAULT_OWNER token.
    The token proves both identity (user_id) and consent (vault unlocked).

    **Example Response**:
    ```json
    {
        "success": true,
        "holdings_count": 15,
        "total_value": 125000.00,
        "losers": [
            {"symbol": "NFLX", "name": "Netflix", "gain_loss_pct": -15.5, "gain_loss": -2500.00}
        ],
        "winners": [
            {"symbol": "NVDA", "name": "NVIDIA", "gain_loss_pct": 45.2, "gain_loss": 8500.00}
        ],
        "kpis_stored": ["holdings_count", "portfolio_risk_bucket", "sector_allocation"],
        "source": "schwab"
    }
    ```
    """
    # Verify user_id matches token (consent-first: token contains user_id)
    if token_data["user_id"] != user_id:
        logger.warning(f"User ID mismatch: token={token_data['user_id']}, request={user_id}")
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="User ID does not match token"
        )

    # Validate file
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")

    # Check file size (max 25MB)
    content = await file.read()
    if len(content) > _MAX_IMPORT_FILE_BYTES:
        raise HTTPException(status_code=400, detail=_MAX_IMPORT_FILE_SIZE_MESSAGE)

    # Import portfolio
    service = get_portfolio_import_service()
    result: ImportResult = await service.import_file(
        user_id=user_id,
        file_content=content,
        filename=file.filename,
    )

    if (
        not result.success
        and result.error
        and "does not appear to be a brokerage statement" in result.error.lower()
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "IRRELEVANT_CONTENT",
                "message": result.error,
            },
        )

    return PortfolioImportResponse(
        success=result.success,
        holdings_count=result.holdings_count,
        total_value=result.total_value,
        losers=result.losers,
        winners=result.winners,
        kpis_stored=result.kpis_stored,
        error=result.error,
        source=result.source,
        # Comprehensive financial data
        portfolio_data=result.portfolio_data,
        account_info=result.account_info,
        account_summary=result.account_summary,
        asset_allocation=result.asset_allocation,
        income_summary=result.income_summary,
        realized_gain_loss=result.realized_gain_loss,
        transactions=result.transactions,
        cash_balance=result.cash_balance,
    )


@router.get("/portfolio/summary/{user_id}", response_model=PortfolioSummaryResponse)
async def get_portfolio_summary(
    user_id: str,
    token_data: dict = Depends(require_vault_owner_token),
) -> PortfolioSummaryResponse:
    """
    Get portfolio summary from PKM (without decrypting holdings).

    Returns KPIs derived from the user's imported portfolio.

    **Authentication**: Requires valid VAULT_OWNER token matching user_id.
    """
    # Verify user_id matches token (consent-first: token contains user_id)
    if token_data["user_id"] != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="User ID does not match token"
        )

    # Get portfolio summary from the PKM index (no decryption)
    pkm_service = get_pkm_service()
    index = await pkm_service.get_index_v2(user_id)
    if index is None or "financial" not in index.available_domains:
        return PortfolioSummaryResponse(
            user_id=user_id,
            has_portfolio=False,
        )
    summary = index.domain_summaries.get("financial") or {}
    has_portfolio = summary.get("has_portfolio", False)
    if isinstance(has_portfolio, str):
        has_portfolio = has_portfolio == "true" or has_portfolio == "1"
    holdings_count = summary.get("holdings_count")
    if holdings_count is not None:
        holdings_count = int(holdings_count)
    losers_count = summary.get("losers_count")
    if losers_count is not None:
        losers_count = int(losers_count)
    winners_count = summary.get("winners_count")
    if winners_count is not None:
        winners_count = int(winners_count)
    total_gain_loss_pct = summary.get("total_gain_loss_pct")
    if total_gain_loss_pct is not None:
        total_gain_loss_pct = float(total_gain_loss_pct)
    return PortfolioSummaryResponse(
        user_id=user_id,
        has_portfolio=bool(has_portfolio),
        holdings_count=holdings_count,
        portfolio_value_bucket=summary.get("portfolio_value_bucket"),
        portfolio_risk_bucket=summary.get("portfolio_risk_bucket") or summary.get("risk_bucket"),
        preference_risk_profile=summary.get("risk_profile") or summary.get("profile_risk_profile"),
        losers_count=losers_count,
        winners_count=winners_count,
        total_gain_loss_pct=total_gain_loss_pct,
    )


@router.get("/dashboard/profile-picks/{user_id}", response_model=DashboardProfilePicksResponse)
async def get_dashboard_profile_picks(
    user_id: str,
    symbols: Optional[str] = Query(
        default=None,
        description="Optional comma-separated ticker symbols from current holdings context.",
    ),
    limit: int = Query(default=4, ge=1, le=_MAX_PROFILE_PICKS),
    token_data: dict = Depends(require_vault_owner_token),
) -> DashboardProfilePicksResponse:
    """
    Build profile-based dashboard picks from real user context.

    Source blend:
    - User profile/risk from `pkm_index.domain_summaries.financial`
    - Existing holdings symbols from caller-provided decrypted symbols context
    - Renaissance investable universe tiers
    - Live quote/sector context via `fetch_market_data`

    No synthetic placeholders are returned.
    """
    if token_data["user_id"] != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User ID does not match token",
        )

    requested_symbols = _normalize_symbols_query(symbols)
    requested_limit = max(1, min(int(limit), _MAX_PROFILE_PICKS))
    consent_token = str(token_data.get("token") or "")

    pkm_service = get_pkm_service()
    index = await pkm_service.get_index_v2(user_id)
    domain_summaries = index.domain_summaries if index and index.domain_summaries else {}
    financial_summary = (
        domain_summaries.get("financial")
        if isinstance(domain_summaries.get("financial"), dict)
        else {}
    )
    risk_profile = _normalize_risk_profile(
        financial_summary.get("risk_profile") or financial_summary.get("profile_risk_profile")
    )
    allowed_tiers = _allowed_tiers_for_risk(risk_profile)
    holdings_count = int(
        _coerce_optional_number(
            financial_summary.get("holdings_count")
            or financial_summary.get("attribute_count")
            or financial_summary.get("item_count")
        )
        or 0
    )

    from hushh_mcp.operons.kai.fetchers import fetch_market_data

    holdings_sector_counter: Counter[str] = Counter()
    if requested_symbols:
        sector_sem = asyncio.Semaphore(4)

        async def resolve_holding_sector(symbol: str) -> Optional[str]:
            async with sector_sem:
                try:
                    quote = await fetch_market_data(symbol, user_id, consent_token)
                    sector = str(quote.get("sector") or "").strip()
                    return sector or None
                except Exception as exc:
                    logger.warning(
                        "[Kai Picks] failed to resolve holding sector for %s (%s): %s",
                        symbol,
                        user_id,
                        exc,
                    )
                    return None

        sector_rows = await asyncio.gather(
            *(resolve_holding_sector(symbol) for symbol in requested_symbols)
        )
        for sector in sector_rows:
            if sector:
                holdings_sector_counter[sector] += 1

    dominant_sectors = [sector for sector, _ in holdings_sector_counter.most_common(2)]
    dominant_sector = dominant_sectors[0] if dominant_sectors else None

    renaissance_service = get_renaissance_service()
    tier_results = await asyncio.gather(
        *(renaissance_service.get_by_tier(tier) for tier in allowed_tiers),
        return_exceptions=True,
    )
    owned_symbols = set(requested_symbols)
    candidate_by_symbol: dict[str, Any] = {}
    for tier_value, result in zip(allowed_tiers, tier_results, strict=False):
        if isinstance(result, Exception):
            logger.warning("[Kai Picks] Renaissance tier fetch failed (%s): %s", tier_value, result)
            continue
        for stock in result:
            symbol_key = str(getattr(stock, "ticker", "") or "").strip().upper()
            if not symbol_key or symbol_key in owned_symbols or symbol_key in candidate_by_symbol:
                continue
            candidate_by_symbol[symbol_key] = stock

    ranked_candidates = sorted(
        candidate_by_symbol.values(),
        key=lambda stock: _candidate_rank(
            tier=str(getattr(stock, "tier", "")),
            sector=str(getattr(stock, "sector", "")),
            dominant_sectors=dominant_sectors,
            tier_rank=getattr(stock, "tier_rank", None),
        ),
        reverse=True,
    )
    candidate_pool = ranked_candidates[: max(requested_limit * 3, requested_limit)]

    quote_sem = asyncio.Semaphore(4)

    async def enrich_candidate(stock: Any) -> DashboardProfilePick:
        symbol_value = str(getattr(stock, "ticker", "") or "").strip().upper()
        company_name = str(getattr(stock, "company_name", "") or symbol_value)
        tier_value = str(getattr(stock, "tier", "") or "").strip().upper() or None
        sector_value = str(getattr(stock, "sector", "") or "").strip() or None
        conviction_weight = float(TIER_WEIGHTS.get(tier_value or "", 0.5))
        recommendation_bias = _recommendation_bias_from_tier(tier_value or "")

        quote_payload: dict[str, Any] = {}
        degraded = False
        source_tags = ["Renaissance"]
        async with quote_sem:
            try:
                quote_payload = await fetch_market_data(symbol_value, user_id, consent_token)
                source_name = str(quote_payload.get("source") or "").strip()
                if source_name:
                    source_tags.append(source_name)
            except Exception as exc:
                degraded = True
                source_tags.append("Quote unavailable")
                logger.warning("[Kai Picks] quote fetch failed for %s: %s", symbol_value, exc)

        return DashboardProfilePick(
            symbol=symbol_value,
            company_name=company_name,
            sector=sector_value,
            tier=tier_value,
            conviction_weight=round(conviction_weight, 4),
            price=_coerce_optional_number(quote_payload.get("price")),
            change_percent=_coerce_optional_number(quote_payload.get("change_percent")),
            recommendation_bias=recommendation_bias,
            rationale=_build_pick_rationale(
                tier=tier_value or "UNRANKED",
                sector=sector_value or "",
                dominant_sector=dominant_sector,
            ),
            source_tags=source_tags,
            degraded=degraded,
            as_of=str(quote_payload.get("fetched_at") or _now_utc_iso()),
        )

    enriched = await asyncio.gather(*(enrich_candidate(stock) for stock in candidate_pool))
    picks = enriched[:requested_limit]

    context_payload = {
        "requested_symbol_count": len(requested_symbols),
        "holdings_count_index": holdings_count,
        "dominant_sectors": dominant_sectors,
        "allowed_tiers": list(allowed_tiers),
        "candidate_pool_size": len(candidate_pool),
    }

    return DashboardProfilePicksResponse(
        user_id=user_id,
        generated_at=_now_utc_iso(),
        risk_profile=risk_profile,
        picks=picks,
        context=context_payload,
    )


def _parse_import_cursor(value: Optional[int]) -> int:
    if value is None:
        return 0
    try:
        cursor = int(value)
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail={"code": "IMPORT_RUN_CURSOR_INVALID", "message": "cursor must be an integer"},
        ) from exc
    if cursor < 0:
        raise HTTPException(
            status_code=400,
            detail={"code": "IMPORT_RUN_CURSOR_INVALID", "message": "cursor must be >= 0"},
        )
    return cursor


def _create_import_sse_response(
    generator: AsyncGenerator[dict[str, str], None],
) -> EventSourceResponse:
    async def _instrumented() -> AsyncGenerator[dict[str, str], None]:
        started = time.perf_counter()
        event_count = 0
        saw_terminal = False
        request_id = get_request_id() or "unknown"
        logger.info(
            "stream.lifecycle_start stream=portfolio_import request_id=%s",
            request_id,
        )
        try:
            async for frame in generator:
                event_count += 1
                data = frame.get("data") if isinstance(frame, dict) else None
                if isinstance(data, str) and '"terminal":true' in data.replace(" ", "").lower():
                    saw_terminal = True
                yield frame
        finally:
            duration_ms = round((time.perf_counter() - started) * 1000, 2)
            logger.info(
                "stream.lifecycle_end stream=portfolio_import request_id=%s duration_ms=%s event_count=%s terminal=%s",
                request_id,
                duration_ms,
                event_count,
                saw_terminal,
            )

    return EventSourceResponse(
        _instrumented(),
        ping=15,
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def _infer_instrument_kind_light(
    *,
    symbol: str,
    name: str,
    asset_type: str,
) -> tuple[str, bool]:
    probe = f"{symbol} {name} {asset_type}".lower()
    cash_markers = (
        "cash",
        "sweep",
        "money market",
        "settlement fund",
        "brokerage cash",
    )
    if any(marker in probe for marker in cash_markers):
        return "cash_equivalent", True

    fixed_income_markers = ("bond", "treasury", "municipal", "fixed income", "cd ")
    if any(marker in probe for marker in fixed_income_markers):
        return "fixed_income", False

    real_asset_markers = ("reit", "real estate", "commodity", "gold", "real asset")
    if any(marker in probe for marker in real_asset_markers):
        return "real_asset", False

    if _PICK_TICKER_RE.match(symbol):
        return "equity", False
    return "other", False


def _normalize_import_holding_light(row: dict[str, Any], _idx: int) -> dict[str, Any]:
    raw_symbol = _first_present(
        row,
        "symbol",
        "ticker",
        "symbol_cusip",
        "cusip",
        "security_id",
        "security",
    )
    symbol = _normalize_symbol_token(raw_symbol)
    symbol_from_statement = bool(symbol)

    name = (
        _normalize_optional_text(
            _first_present(
                row,
                "name",
                "description",
                "security_name",
                "holding_name",
                "security_description",
            )
        )
        or "Unknown"
    )
    asset_type = (
        _normalize_optional_text(
            _first_present(row, "asset_type", "asset_class", "security_type", "type")
        )
        or ""
    )

    # Prompt-trust mode does not fabricate symbols from names.
    # Only normalize explicit statement identifiers; derive CASH when clearly implied.
    if not symbol:
        inferred_kind, inferred_cash = _infer_instrument_kind_light(
            symbol="",
            name=name,
            asset_type=asset_type,
        )
        if inferred_cash:
            symbol = "CASH"

    quantity = _coerce_optional_number(_first_present(row, "quantity", "shares", "units", "qty"))
    market_value = _coerce_optional_number(
        _first_present(
            row,
            "market_value",
            "current_value",
            "marketValue",
            "value",
            "position_value",
        )
    )
    price = _coerce_optional_number(
        _first_present(row, "price", "price_per_unit", "last_price", "unit_price", "current_price")
    )
    if market_value is None and quantity is not None and price is not None:
        market_value = quantity * price
    if price is None and quantity not in (None, 0.0) and market_value is not None:
        try:
            price = market_value / quantity
        except Exception:
            price = None

    instrument_kind, is_cash_equivalent = _infer_instrument_kind_light(
        symbol=symbol,
        name=name,
        asset_type=asset_type,
    )
    symbol_kind = "unknown"
    security_listing_status = "unknown"
    if is_cash_equivalent:
        symbol_kind = "cash_identifier"
        security_listing_status = "cash_or_sweep"
    elif instrument_kind == "fixed_income":
        symbol_kind = "bond_or_fixed_income_id"
        security_listing_status = "fixed_income"
    elif _PICK_TICKER_RE.match(symbol):
        if any(token in f"{name} {asset_type}".lower() for token in ("etf", "fund")):
            symbol_kind = "fund_or_etf_ticker"
            security_listing_status = "non_sec_common_equity"
        else:
            symbol_kind = "us_common_equity_ticker"
            security_listing_status = "sec_common_equity"

    is_sec_common_equity_ticker = security_listing_status == "sec_common_equity"
    is_investable = bool(is_sec_common_equity_ticker) and not is_cash_equivalent
    analyze_eligible, analyze_eligible_reason = _derive_analyze_eligibility(
        is_investable=is_investable,
        is_cash_equivalent=is_cash_equivalent,
        security_listing_status=security_listing_status,
        symbol_kind=symbol_kind,
        is_sec_common_equity_ticker=is_sec_common_equity_ticker,
    )

    symbol_quality = (
        "provided" if symbol_from_statement else ("derived_cash" if symbol == "CASH" else "missing")
    )
    symbol_trust_tier = (
        "statement_reported"
        if symbol_from_statement
        else ("statement_derived" if symbol == "CASH" else "unknown")
    )
    confidence = 0.8 if symbol_from_statement else (0.6 if symbol == "CASH" else 0.0)
    qty_negative = quantity is not None and quantity < 0
    mv_negative = market_value is not None and market_value < 0
    if is_cash_equivalent and mv_negative:
        position_side = "liability"
    elif qty_negative or mv_negative:
        position_side = "short"
    else:
        position_side = "long"

    normalized: dict[str, Any] = {
        "symbol": symbol,
        "symbol_cusip": _normalize_symbol_token(
            _first_present(row, "symbol_cusip", "cusip", "security_id", "security")
        )
        or None,
        "name": name,
        "asset_type": asset_type or None,
        "quantity": quantity,
        "price": price,
        "price_per_unit": price,
        "market_value": market_value,
        "cost_basis": _coerce_optional_number(
            _first_present(row, "cost_basis", "book_value", "cost", "total_cost")
        ),
        "unrealized_gain_loss": _coerce_optional_number(
            _first_present(row, "unrealized_gain_loss", "gain_loss", "unrealized_pnl", "pnl")
        ),
        "unrealized_gain_loss_pct": _coerce_optional_number(
            _first_present(row, "unrealized_gain_loss_pct", "gain_loss_pct", "return_pct")
        ),
        "sector": _normalize_optional_text(
            _first_present(row, "sector", "gics_sector", "sector_name")
        ),
        "industry": _normalize_optional_text(
            _first_present(row, "industry", "gics_industry", "industry_name")
        ),
        "instrument_kind": instrument_kind,
        "is_cash_equivalent": is_cash_equivalent,
        "tradable": bool(_PICK_TICKER_RE.match(symbol)) and not is_cash_equivalent,
        "is_investable": is_investable,
        "debate_eligible": is_investable,
        "optimize_eligible": is_investable,
        "analyze_eligible": analyze_eligible,
        "analyze_eligible_reason": analyze_eligible_reason,
        "position_side": position_side,
        "is_short_position": position_side == "short",
        "is_liability_position": position_side == "liability",
        "symbol_source": "statement_ticker" if _PICK_TICKER_RE.match(symbol) else "derived_none",
        "symbol_kind": symbol_kind,
        "security_listing_status": security_listing_status,
        "is_sec_common_equity_ticker": is_sec_common_equity_ticker,
        "symbol_quality": symbol_quality,
        "symbol_trust_tier": symbol_trust_tier,
        "symbol_trust_reason": "statement_import",
        "identifier_type": "ticker" if _PICK_TICKER_RE.match(symbol) else "identifier",
        "confidence": confidence,
        "provenance": {
            "source": "statement_llm_parse",
            "mode": "prompt_first_lightweight",
        },
    }
    return normalized


async def _portfolio_import_stream_generator(
    *,
    request: Any,
    content: bytes,
    filename: str,
    is_csv_upload: bool,
) -> AsyncGenerator[dict[str, str], None]:
    """Generate canonical SSE frames for one portfolio-import run."""
    hard_timeout_seconds = PORTFOLIO_IMPORT_TIMEOUT_SECONDS
    stream = CanonicalSSEStream("portfolio_import")

    from google import genai
    from google.genai import types
    from google.genai.types import HttpOptions

    from hushh_mcp.constants import (
        KAI_PORTFOLIO_IMPORT_ENABLE_THINKING,
        KAI_PORTFOLIO_IMPORT_PRIMARY_MODEL,
    )

    thinking_enabled = KAI_PORTFOLIO_IMPORT_ENABLE_THINKING and KAI_LLM_THINKING_ENABLED
    extraction_model = KAI_PORTFOLIO_IMPORT_PRIMARY_MODEL

    try:
        async with asyncio.timeout(hard_timeout_seconds):
            yield stream.event(
                "stage",
                {
                    "stage": "uploading",
                    "message": "Processing uploaded file...",
                },
            )
            await asyncio.sleep(0.1)

            client = genai.Client(http_options=HttpOptions(api_version="v1"))
            logger.info(
                "SSE: Portfolio import model=%s strict_json=true no_pre_gate=true thinking=%s",
                extraction_model,
                thinking_enabled,
            )

            yield stream.event(
                "stage",
                {
                    "stage": "indexing",
                    "message": "Indexing document structure...",
                },
            )

            full_extract_prompt = build_statement_extract_prompt_v2()
            pdf_context = (
                _extract_pdf_pass_contexts(content)
                if not is_csv_upload
                else {
                    "positions_text": "",
                    "summary_text": "",
                    "positions_confidence": 0.0,
                    "summary_confidence": 0.0,
                    "selected_pages": [],
                }
            )
            run_started_at = time.perf_counter()
            parse_diagnostics: dict[str, Any] = {
                "pass_timings_ms": {},
                "pass_token_counts": {},
                "pass_content_sources": {},
                "pdf_context": pdf_context,
            }

            yield stream.event(
                "stage",
                {
                    "stage": "scanning",
                    "message": "Submitting statement for extraction...",
                    "phase": "extract_full",
                },
            )

            full_context_parts = [
                str(pdf_context.get("positions_text") or "").strip(),
                str(pdf_context.get("summary_text") or "").strip(),
            ]
            full_context_excerpt = "\n\n".join(part for part in full_context_parts if part)
            full_context_confidence = float(
                max(
                    float(pdf_context.get("positions_confidence") or 0.0),
                    float(pdf_context.get("summary_confidence") or 0.0),
                )
            )

            extract_full_result: dict[str, Any] = {}
            async for frame in run_stream_pass_v2(
                request=request,
                stream=stream,
                client=client,
                types_module=types,
                phase="extract_full",
                model_name=extraction_model,
                prompt=full_extract_prompt,
                context_excerpt=full_context_excerpt,
                context_confidence=full_context_confidence,
                stage_message="Extracting portfolio statement data...",
                progress_message="Streaming extraction",
                include_holdings_preview=True,
                result_store=extract_full_result,
                content=content,
                is_csv_upload=is_csv_upload,
                temperature=KAI_LLM_TEMPERATURE,
                max_output_tokens=KAI_PORTFOLIO_IMPORT_MAX_OUTPUT_TOKENS,
                thinking_enabled=thinking_enabled,
                thinking_level_raw=KAI_PORTFOLIO_IMPORT_THINKING_LEVEL,
                heartbeat_interval_seconds=HEARTBEAT_INTERVAL_SECONDS,
                required_keys=FINANCIAL_STATEMENT_EXTRACT_V2_REQUIRED_KEYS,
            ):
                yield frame

            if extract_full_result.get("client_disconnected"):
                logger.info("[Portfolio Import] Client disconnected during extraction")
                return

            parsed_data = (
                extract_full_result.get("parsed")
                if isinstance(extract_full_result.get("parsed"), dict)
                else {}
            )
            parse_diagnostics["extract_full_pass_parse"] = extract_full_result.get(
                "parse_diagnostics", {}
            )
            parse_diagnostics["pass_timings_ms"]["extract_full_ms"] = extract_full_result.get(
                "elapsed_ms"
            )
            parse_diagnostics["pass_token_counts"]["extract_full"] = {
                "chunks": extract_full_result.get("chunk_count", 0),
                "thoughts": 0,
            }
            parse_diagnostics["pass_content_sources"]["extract_full"] = extract_full_result.get(
                "source"
            )

            detailed_holdings_raw = parsed_data.get("detailed_holdings")
            detailed_holdings = (
                detailed_holdings_raw if isinstance(detailed_holdings_raw, list) else []
            )
            if len(detailed_holdings) == 0:
                yield stream.event(
                    "error",
                    {
                        "code": "IMPORT_NO_HOLDINGS",
                        "message": (
                            "We could not identify holdings from this statement. "
                            "Please upload a brokerage PDF/CSV with positions."
                        ),
                        "diagnostics": parse_diagnostics,
                    },
                    terminal=True,
                )
                return

            yield stream.event(
                "stage",
                {
                    "stage": "normalizing",
                    "phase": "normalizing",
                    "message": "Consolidating confirmed holdings...",
                    "progress_pct": _phase_progress_bounds("normalizing")[0],
                },
            )

            normalized_holdings: list[dict[str, Any]] = []
            parsed_total = len(detailed_holdings)
            for idx, raw_row in enumerate(detailed_holdings):
                if await request.is_disconnected():
                    logger.info("[Portfolio Import] Client disconnected during normalization")
                    return
                if not isinstance(raw_row, dict):
                    continue
                normalized_holdings.append(_normalize_import_holding_light(raw_row, idx))
                if parsed_total <= 12 or (idx + 1) == parsed_total or (idx + 1) % 6 == 0:
                    yield stream.event(
                        "progress",
                        {
                            "phase": "normalizing",
                            "message": f"Confirmed {idx + 1} of {parsed_total} holdings",
                            "holdings_extracted": idx + 1,
                            "holdings_total": parsed_total,
                            "holdings_raw_count": parsed_total,
                            "holdings_preview": _build_holdings_preview(
                                _aggregate_holdings_by_symbol(normalized_holdings), max_items=40
                            ),
                            "progress_pct": _phase_progress_bounds("normalizing")[0]
                            + min(
                                _phase_progress_bounds("normalizing")[1]
                                - _phase_progress_bounds("normalizing")[0],
                                ((idx + 1) / max(parsed_total, 1))
                                * (
                                    _phase_progress_bounds("normalizing")[1]
                                    - _phase_progress_bounds("normalizing")[0]
                                ),
                            ),
                        },
                    )

            yield stream.event(
                "stage",
                {
                    "stage": "validating",
                    "phase": "validating",
                    "message": "Validating holdings quality...",
                    "progress_pct": _phase_progress_bounds("validating")[0],
                },
            )

            raw_count = len(normalized_holdings)
            validated_holdings = list(normalized_holdings)
            dropped_reasons: Counter[str] = Counter()
            holdings = _aggregate_holdings_by_symbol(validated_holdings)
            duplicate_symbol_lot_count = max(0, len(validated_holdings) - len(holdings))
            unknown_name_count = sum(1 for row in holdings if _is_unknown_name(row.get("name")))
            placeholder_symbol_count = sum(
                1 for row in holdings if str(row.get("symbol") or "").startswith("HOLDING_")
            )
            zero_qty_zero_price_nonzero_value_count = 0
            account_header_row_count = 0

            statement_details = (
                parsed_data.get("statement_details")
                if isinstance(parsed_data.get("statement_details"), dict)
                else {}
            )
            portfolio_summary = _normalize_portfolio_summary(parsed_data)

            account_info = {
                "holder_name": statement_details.get("account_name"),
                "account_number": statement_details.get("account_number"),
                "account_type": None,
                "brokerage_name": statement_details.get("institution_name"),
                "institution_name": statement_details.get("institution_name"),
                "statement_period_start": statement_details.get("statement_period_start"),
                "statement_period_end": statement_details.get("statement_period_end"),
            }
            account_summary = {
                "beginning_value": _coerce_optional_number(
                    portfolio_summary.get("beginning_value")
                ),
                "ending_value": _coerce_optional_number(portfolio_summary.get("ending_value")),
                "change_in_value": _coerce_optional_number(
                    _first_present(portfolio_summary, "change_in_value", "total_change")
                ),
                "cash_balance": _coerce_optional_number(parsed_data.get("cash_balance")),
                "net_deposits_withdrawals": _coerce_optional_number(
                    portfolio_summary.get("net_deposits_withdrawals")
                ),
                "investment_gain_loss": _coerce_optional_number(
                    portfolio_summary.get("investment_gain_loss")
                ),
                "total_income_period": _coerce_optional_number(
                    _first_present(
                        portfolio_summary,
                        "total_income_period",
                        "estimated_annual_income",
                    )
                ),
                "total_income_ytd": _coerce_optional_number(
                    portfolio_summary.get("total_income_ytd")
                ),
                "total_fees": _coerce_optional_number(portfolio_summary.get("total_fees")),
            }

            total_value = _coerce_optional_number(parsed_data.get("total_value")) or 0.0
            if not total_value and account_summary.get("ending_value"):
                total_value = account_summary["ending_value"] or 0.0
            if not total_value and holdings:
                total_value = sum(
                    _coerce_optional_number(h.get("market_value")) or 0 for h in holdings
                )
            cash_balance = _coerce_optional_number(parsed_data.get("cash_balance"))
            if cash_balance is None:
                cash_balance = round(
                    sum(
                        _coerce_optional_number(row.get("market_value")) or 0.0
                        for row in holdings
                        if bool(row.get("is_cash_equivalent"))
                    ),
                    2,
                )
                if cash_balance <= 0:
                    cash_balance = None
            if account_summary.get("cash_balance") is None:
                account_summary["cash_balance"] = cash_balance
            account_summary = _enrich_account_summary_with_holdings(
                account_summary,
                holdings=holdings,
                total_value=total_value,
            )
            ending_value_from_summary = _coerce_optional_number(account_summary.get("ending_value"))
            if (not total_value) and ending_value_from_summary is not None:
                total_value = ending_value_from_summary

            rows_with_symbol = sum(
                1
                for row in normalized_holdings
                if str(row.get("symbol") or "").strip()
                and not str(row.get("symbol") or "").startswith("HOLDING_")
            )
            rows_with_market_value = sum(
                1
                for row in normalized_holdings
                if _coerce_optional_number(row.get("market_value")) is not None
            )
            rows_with_symbol_pct = (rows_with_symbol / raw_count) if raw_count > 0 else 0.0
            rows_with_market_value_pct = (
                (rows_with_market_value / raw_count) if raw_count > 0 else 0.0
            )
            core_keys_present = all(
                key in parsed_data for key in FINANCIAL_STATEMENT_EXTRACT_V2_REQUIRED_KEYS
            )
            parse_diagnostics["core_keys_present"] = core_keys_present
            parse_diagnostics["rows_with_symbol_pct"] = rows_with_symbol_pct
            parse_diagnostics["rows_with_market_value_pct"] = rows_with_market_value_pct
            parse_diagnostics["positions_coverage"] = {
                "rows_with_symbol_pct": round(rows_with_symbol_pct * 100.0, 2),
                "rows_with_market_value_pct": round(rows_with_market_value_pct * 100.0, 2),
            }
            parse_diagnostics["pass_timings_ms"]["total_ms"] = int(
                (time.perf_counter() - run_started_at) * 1000
            )
            parse_diagnostics["combined_stream"] = {
                "response_chars": len(str(extract_full_result.get("text") or "")),
                "chunk_count": int(extract_full_result.get("chunk_count") or 0),
                "thought_count": 0,
            }

            quality_report = build_holdings_quality_report_v2(
                raw_count=raw_count,
                validated_count=len(validated_holdings),
                aggregated_count=len(holdings),
                dropped_reasons=dropped_reasons,
                reconciled_count=0,
                mismatch_count=0,
                parse_diagnostics=parse_diagnostics,
                unknown_name_count=unknown_name_count,
                placeholder_symbol_count=placeholder_symbol_count,
                zero_qty_zero_price_nonzero_value_count=zero_qty_zero_price_nonzero_value_count,
                account_header_row_count=account_header_row_count,
                duplicate_symbol_lot_count=duplicate_symbol_lot_count,
                average_confidence=(
                    round(
                        sum(
                            _coerce_optional_number(row.get("confidence")) or 0.0
                            for row in holdings
                        )
                        / max(len(holdings), 1),
                        4,
                    )
                    if holdings
                    else 0.0
                ),
            )
            quality_gate_allows_continue, quality_gate = evaluate_import_quality_gate_v2(
                holdings=validated_holdings,
                placeholder_symbol_count=placeholder_symbol_count,
                account_header_row_count=account_header_row_count,
                expected_total_value=total_value,
                core_keys_present=core_keys_present,
                rows_with_symbol_pct=rows_with_symbol_pct,
                rows_with_market_value_pct=rows_with_market_value_pct,
            )
            quality_report["quality_gate"] = quality_gate
            quality_report_v2 = build_quality_report_v2(
                quality_report=quality_report,
                quality_gate=quality_gate,
                holdings=holdings,
            )

            yield stream.event(
                "progress",
                {
                    "phase": "validating",
                    "message": (
                        f"Validated {len(validated_holdings)} holdings and consolidated into {len(holdings)} positions"
                    ),
                    "holdings_extracted": len(validated_holdings),
                    "holdings_total": parsed_total,
                    "holdings_raw_count": raw_count,
                    "holdings_validated_count": len(validated_holdings),
                    "holdings_aggregated_count": len(holdings),
                    "holdings_dropped_reasons": dict(dropped_reasons),
                    "holdings_preview": _build_holdings_preview(holdings, max_items=40),
                    "progress_pct": 98,
                    "quality_gate": quality_gate,
                },
            )

            parse_fallback_used = False
            if not quality_gate_allows_continue:
                yield stream.event(
                    "aborted",
                    {
                        "code": "IMPORT_NO_HOLDINGS",
                        "reason": "quality_gate_failed_no_holdings",
                        "message": (
                            "We could not confirm holdings from this statement. "
                            "Please retry with a clearer brokerage export."
                        ),
                        "quality_gate": quality_gate,
                        "quality_report_v2": quality_report_v2,
                    },
                    terminal=True,
                )
                return

            raw_extract_v2 = {
                "statement_details": statement_details,
                "portfolio_summary": portfolio_summary,
                "detailed_holdings": detailed_holdings,
                "cash_balance": cash_balance,
                "total_value": total_value,
                # Compatibility defaults for existing consumers.
                "account_metadata": {},
                "asset_allocation": [],
                "portfolio_detail": {},
                "transactions": {},
                "reconciliation_summary": {},
                "investment_objective": {},
                "management_contacts": {},
                "derived_metrics": {},
                "income_summary": {},
                "realized_gain_loss": {},
                "cash_flow": {},
                "cash_management": {},
                "projections_and_mrd": {},
                "historical_values": [],
                "ytd_metrics": {},
                "legal_and_disclosures": {},
            }
            portfolio_data_v2 = build_financial_portfolio_canonical_v2(
                raw_extract_v2=raw_extract_v2,
                account_info=account_info,
                account_summary=account_summary,
                holdings=holdings,
                asset_allocation=[],
                total_value=total_value,
                cash_balance=cash_balance,
                quality_report_v2=quality_report_v2,
            )
            portfolio_data_v2.update(
                {
                    "statement_details": raw_extract_v2.get("statement_details"),
                    "management_contacts": raw_extract_v2.get("management_contacts"),
                    "investment_objective": raw_extract_v2.get("investment_objective"),
                    "portfolio_detail": raw_extract_v2.get("portfolio_detail"),
                    "transactions": raw_extract_v2.get("transactions"),
                    "reconciliation_summary": raw_extract_v2.get("reconciliation_summary"),
                    "derived_metrics": raw_extract_v2.get("derived_metrics"),
                    "income_summary": raw_extract_v2.get("income_summary"),
                    "realized_gain_loss": raw_extract_v2.get("realized_gain_loss"),
                    "cash_flow": raw_extract_v2.get("cash_flow"),
                    "cash_management": raw_extract_v2.get("cash_management"),
                    "projections_and_mrd": raw_extract_v2.get("projections_and_mrd"),
                    "historical_values": raw_extract_v2.get("historical_values"),
                    "ytd_metrics": raw_extract_v2.get("ytd_metrics"),
                    "legal_and_disclosures": raw_extract_v2.get("legal_and_disclosures"),
                    "parse_fallback": parse_fallback_used,
                    "kpis": {
                        "holdings_count": len(holdings),
                        "total_value": total_value,
                    },
                }
            )
            analytics_v2 = build_financial_analytics_v2(
                canonical_portfolio_v2=portfolio_data_v2,
                raw_extract_v2=raw_extract_v2,
            )

            coverage_metrics_payload = (
                parse_diagnostics.get("positions_coverage")
                if isinstance(parse_diagnostics.get("positions_coverage"), dict)
                else {}
            )
            logger.info(
                "SSE: Portfolio V2 ready - holdings=%s total_value=%s",
                len(holdings),
                total_value,
            )

            yield stream.event(
                "complete",
                {
                    "portfolio_data_v2": portfolio_data_v2,
                    "raw_extract_v2": raw_extract_v2,
                    "analytics_v2": analytics_v2,
                    "quality_report_v2": quality_report_v2,
                    "timings_ms": build_timing_payload(diagnostics=parse_diagnostics),
                    "token_counts": build_token_counts_payload(diagnostics=parse_diagnostics),
                    "coverage_metrics": coverage_metrics_payload,
                    "success": True,
                    "parse_fallback": parse_fallback_used,
                    "quality_gate": quality_gate,
                    "thought_count": 0,
                    "holdings_raw_count": raw_count,
                    "holdings_validated_count": len(validated_holdings),
                    "holdings_aggregated_count": len(holdings),
                    "holdings_dropped_reasons": dict(dropped_reasons),
                    "diagnostics": parse_diagnostics,
                },
                terminal=True,
            )

    except ImportStrictParseError as exc:
        logger.warning("[Portfolio Import] Strict parse error (%s): %s", exc.code, exc)
        investor_message = (
            "We couldn't read this statement format yet. "
            "Please re-export the brokerage PDF/CSV and try again."
        )
        yield stream.event(
            "error",
            {
                "code": exc.code,
                "message": investor_message,
            },
            terminal=True,
        )
    except Exception as exc:
        logger.error("SSE streaming error: %s", exc, exc_info=True)
        yield stream.event(
            "error",
            {
                "code": "IMPORT_STREAM_FAILED",
                "message": "Import could not be completed right now. Please retry.",
            },
            terminal=True,
        )


def _portfolio_import_stream_factory(
    run: PortfolioImportRunRecord,
    background_request: Any,
) -> AsyncGenerator[dict[str, str], None]:
    return _portfolio_import_stream_generator(
        request=background_request,
        content=run.content,
        filename=run.filename,
        is_csv_upload=run.is_csv_upload,
    )


@router.post("/portfolio/import/run/start")
async def start_portfolio_import_run(
    file: UploadFile,
    user_id: str = Form(..., description="User's ID"),
    token_data: dict = Depends(require_vault_owner_token),
):
    if token_data["user_id"] != user_id:
        logger.warning("User ID mismatch: token=%s, request=%s", token_data["user_id"], user_id)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="User ID does not match token"
        )

    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")

    filename_lower = file.filename.lower()
    content_type = (file.content_type or "").lower()
    is_csv_upload = filename_lower.endswith(".csv") or "csv" in content_type
    is_pdf_upload = filename_lower.endswith(".pdf") or "pdf" in content_type
    if not (is_pdf_upload or is_csv_upload):
        raise HTTPException(
            status_code=400,
            detail="Invalid file type. Please upload a PDF or CSV statement.",
        )

    content = await file.read()
    if len(content) > _MAX_IMPORT_FILE_BYTES:
        raise HTTPException(status_code=400, detail=_MAX_IMPORT_FILE_SIZE_MESSAGE)

    state, run = await _IMPORT_RUN_MANAGER.start_or_get_active(
        user_id=user_id,
        filename=file.filename,
        content=content,
        is_csv_upload=is_csv_upload,
        generator_factory=_portfolio_import_stream_factory,
    )
    if state == "active":
        raise HTTPException(
            status_code=409,
            detail={
                "code": "IMPORT_RUN_ALREADY_ACTIVE",
                "message": "A portfolio import run is already active for this user.",
                "active_run": run.to_public_dict(),
            },
        )

    return {"run": run.to_public_dict()}


@router.get("/portfolio/import/run/active")
async def get_active_portfolio_import_run(
    user_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    if token_data["user_id"] != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="User ID does not match token"
        )
    run = await _IMPORT_RUN_MANAGER.get_active(user_id=user_id)
    return {"run": run.to_public_dict() if run else None}


@router.get("/portfolio/import/run/{run_id}/stream")
async def stream_portfolio_import_run(
    request: Request,
    run_id: str,
    user_id: str,
    cursor: Optional[int] = 0,
    token_data: dict = Depends(require_vault_owner_token),
):
    if token_data["user_id"] != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="User ID does not match token"
        )

    run = await _IMPORT_RUN_MANAGER.get_run(run_id)
    if run is None or run.user_id != user_id:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "IMPORT_RUN_NOT_FOUND",
                "message": "No import run found for requested run_id.",
                "run_id": run_id,
            },
        )

    start_cursor = _parse_import_cursor(cursor)
    if start_cursor > run.latest_cursor:
        raise HTTPException(
            status_code=410,
            detail={
                "code": "IMPORT_RUN_RESUME_EXPIRED",
                "message": "Requested cursor is beyond buffered events.",
                "run_id": run.run_id,
                "latest_cursor": run.latest_cursor,
            },
        )

    return _create_import_sse_response(
        _IMPORT_RUN_MANAGER.stream_run_events(
            run=run,
            start_cursor=start_cursor,
            request=request,
        )
    )


@router.post("/portfolio/import/run/{run_id}/cancel")
async def cancel_portfolio_import_run(
    run_id: str,
    user_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    if token_data["user_id"] != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="User ID does not match token"
        )
    run = await _IMPORT_RUN_MANAGER.cancel_run(run_id=run_id, user_id=user_id)
    if run is None:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "IMPORT_RUN_NOT_FOUND",
                "message": "No import run found for requested run_id.",
                "run_id": run_id,
            },
        )
    return {"run": run.to_public_dict()}


@router.post("/portfolio/import/stream")
async def import_portfolio_stream(
    request: Request,
    file: UploadFile,
    user_id: str = Form(..., description="User's ID"),
    token_data: dict = Depends(require_vault_owner_token),
):
    """Backward-compatible import stream endpoint.

    Starts a resumable background import run and streams its events from cursor 0.
    """
    if token_data["user_id"] != user_id:
        logger.warning("User ID mismatch: token=%s, request=%s", token_data["user_id"], user_id)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="User ID does not match token"
        )

    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")

    filename_lower = file.filename.lower()
    content_type = (file.content_type or "").lower()
    is_csv_upload = filename_lower.endswith(".csv") or "csv" in content_type
    is_pdf_upload = filename_lower.endswith(".pdf") or "pdf" in content_type
    if not (is_pdf_upload or is_csv_upload):
        raise HTTPException(
            status_code=400,
            detail="Invalid file type. Please upload a PDF or CSV statement.",
        )

    content = await file.read()
    if len(content) > _MAX_IMPORT_FILE_BYTES:
        raise HTTPException(status_code=400, detail=_MAX_IMPORT_FILE_SIZE_MESSAGE)

    state, run = await _IMPORT_RUN_MANAGER.start_or_get_active(
        user_id=user_id,
        filename=file.filename,
        content=content,
        is_csv_upload=is_csv_upload,
        generator_factory=_portfolio_import_stream_factory,
    )
    if state == "active":
        logger.info("[Portfolio Import] Reusing active run %s for user %s", run.run_id, user_id)

    return _create_import_sse_response(
        _IMPORT_RUN_MANAGER.stream_run_events(
            run=run,
            start_cursor=0,
            request=request,
        )
    )
