"""Receipt-memory projection, artifact caching, and PKM candidate mapping.

This module derives a compact shopping-memory snapshot from normalized Gmail
receipt rows without storing raw email payloads in PKM.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import statistics
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from db.db_client import DatabaseExecutionError, get_db

logger = logging.getLogger(__name__)

RECEIPT_MEMORY_ARTIFACT_VERSION = 1
RECEIPT_MEMORY_DETERMINISTIC_SCHEMA_VERSION = 1
RECEIPT_MEMORY_ENRICHMENT_SCHEMA_VERSION = 1
RECEIPT_MEMORY_INFERENCE_WINDOW_DAYS = 365
RECEIPT_MEMORY_HIGHLIGHTS_WINDOW_DAYS = 90
RECEIPT_MEMORY_STALE_AFTER_DAYS = 7
RECEIPT_MEMORY_CLASSIFICATION_CONFIDENCE_FLOOR = 0.5
RECEIPT_MEMORY_MAX_MERCHANTS = 12
RECEIPT_MEMORY_MAX_PATTERNS = 8
RECEIPT_MEMORY_MAX_HIGHLIGHTS = 8
RECEIPT_MEMORY_MAX_SIGNALS = 8
RECEIPT_MEMORY_MAX_SUMMARY_HIGHLIGHTS = 6
RECEIPT_MEMORY_MAX_SUMMARY_CHARS = 600

_SUFFIX_TOKENS = {
    "co",
    "com",
    "company",
    "corp",
    "corporation",
    "inc",
    "llc",
    "ltd",
    "mktp",
    "marketplace",
    "payments",
    "payment",
    "store",
}
_WORD_SPLIT_RE = re.compile(r"[^a-z0-9]+")

_CANONICAL_MERCHANT_RULES: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\bamazon\b|\bamzn\b", re.I), "Amazon"),
    (re.compile(r"\bapple\b|itunes|app\s*store|icloud", re.I), "Apple"),
    (re.compile(r"\buber\b", re.I), "Uber"),
    (re.compile(r"\blyft\b", re.I), "Lyft"),
    (re.compile(r"\bnetflix\b", re.I), "Netflix"),
    (re.compile(r"\bspotify\b", re.I), "Spotify"),
    (re.compile(r"\bswiggy\b", re.I), "Swiggy"),
    (re.compile(r"\bzomato\b", re.I), "Zomato"),
    (re.compile(r"\bpaypal\b", re.I), "PayPal"),
    (re.compile(r"\btarget\b", re.I), "Target"),
    (re.compile(r"\bwalmart\b", re.I), "Walmart"),
)


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _clean_text(value: Any, default: str = "") -> str:
    if not isinstance(value, str):
        return default
    text = value.strip()
    return text or default


def _safe_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        parsed = float(value)
    except Exception:
        return None
    if parsed != parsed:
        return None
    return parsed


def _safe_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except Exception:
        return None


def _parse_dt(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)
    text = _clean_text(value)
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except Exception:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except Exception:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _json_dumps(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _sha256_json(value: Any) -> str:
    return _sha256_text(_json_dumps(value))


def _clip_text(value: str, max_chars: int) -> str:
    text = " ".join(_clean_text(value).split())
    if len(text) <= max_chars:
        return text
    return text[: max(0, max_chars - 1)].rstrip() + "…"


def _dedupe_strings(values: list[str], limit: int | None = None) -> list[str]:
    seen: set[str] = set()
    items: list[str] = []
    for value in values:
        normalized = _clean_text(value)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        items.append(normalized)
        if limit is not None and len(items) >= limit:
            break
    return items


def _merchant_id_from_label(label: str) -> str:
    slug = "_".join(
        token
        for token in _WORD_SPLIT_RE.split(label.lower())
        if token and token not in _SUFFIX_TOKENS
    )
    return slug or "unknown_merchant"


def _email_domain_root(email: str | None) -> str | None:
    text = _clean_text(email)
    if "@" not in text:
        return None
    host = text.split("@", 1)[1].strip().lower()
    if not host:
        return None
    parts = [part for part in host.split(".") if part]
    if len(parts) >= 2:
        return parts[-2]
    return parts[0] if parts else None


def _canonicalize_merchant(row: dict[str, Any]) -> tuple[str, str]:
    raw_candidates = [
        _clean_text(row.get("merchant_name")),
        _clean_text(row.get("from_name")),
        _email_domain_root(row.get("from_email")),
    ]
    source = next((value for value in raw_candidates if value), "Unknown merchant")
    normalized = source.lower()

    for pattern, label in _CANONICAL_MERCHANT_RULES:
        if pattern.search(normalized):
            return _merchant_id_from_label(label), label

    tokens = [
        token
        for token in _WORD_SPLIT_RE.split(normalized)
        if token and token not in _SUFFIX_TOKENS and not token.isdigit()
    ]
    if not tokens:
        label = source.strip() or "Unknown merchant"
        return _merchant_id_from_label(label), label
    label = " ".join(tokens[:3]).title()
    return _merchant_id_from_label(label), label


def _is_recent_enough(receipt_at: datetime | None, *, window_days: int) -> bool:
    if receipt_at is None:
        return False
    return receipt_at >= (_utcnow() - timedelta(days=window_days))


def _median(values: list[float]) -> float | None:
    cleaned = [value for value in values if isinstance(value, (int, float))]
    if not cleaned:
        return None
    return float(statistics.median(cleaned))


def _top_currency_summary(rows: list[dict[str, Any]]) -> tuple[str | None, float | None]:
    totals: dict[str, float] = {}
    for row in rows:
        amount = _safe_float(row.get("amount"))
        currency = _clean_text(row.get("currency")).upper()
        if amount is None or not currency:
            continue
        totals[currency] = totals.get(currency, 0.0) + amount
    if not totals:
        return None, None
    currency, total_amount = max(totals.items(), key=lambda item: (item[1], item[0]))
    return currency, round(total_amount, 2)


def _format_pattern_label(merchant_label: str, cadence: str) -> str:
    if cadence == "monthly":
        return f"Shows a monthly purchase pattern with {merchant_label}"
    if cadence == "quarterly":
        return f"Shows a quarterly purchase pattern with {merchant_label}"
    if cadence == "biweekly":
        return f"Shows a biweekly purchase pattern with {merchant_label}"
    return f"Shows a weekly purchase pattern with {merchant_label}"


def _format_dt_iso(value: datetime | None) -> str | None:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z") if value else None


def _is_missing_receipt_memory_artifact_table_error(error: Exception) -> bool:
    if not isinstance(error, DatabaseExecutionError):
        return False
    details = str(error.details or "")
    return "kai_receipt_memory_artifacts" in details and (
        "does not exist" in details or "UndefinedTable" in details
    )


class ReceiptMemoryProjectionService:
    """Deterministic receipt-memory projection builder."""

    DETERMINISTIC_CONFIG_VERSION = "receipt_memory_v1"

    def __init__(self) -> None:
        self._db = get_db()

    @property
    def db(self):
        return self._db

    async def build_projection(
        self,
        *,
        user_id: str,
        inference_window_days: int = RECEIPT_MEMORY_INFERENCE_WINDOW_DAYS,
        highlights_window_days: int = RECEIPT_MEMORY_HIGHLIGHTS_WINDOW_DAYS,
    ) -> dict[str, Any]:
        rows = self._fetch_receipts(
            user_id=user_id,
            inference_window_days=inference_window_days,
        )
        watermark = self._build_source_watermark(
            rows=rows,
            inference_window_days=inference_window_days,
            highlights_window_days=highlights_window_days,
        )
        merchant_groups = self._group_by_merchant(rows)
        merchant_affinity = self._build_merchant_affinity(merchant_groups)
        purchase_patterns = self._build_purchase_patterns(merchant_groups)
        recent_highlights = self._build_recent_highlights(
            rows=rows,
            merchant_groups=merchant_groups,
            purchase_patterns=purchase_patterns,
            highlights_window_days=highlights_window_days,
        )
        inferred_preferences = self._build_inferred_preferences(
            merchant_affinity=merchant_affinity,
            purchase_patterns=purchase_patterns,
            recent_highlights=recent_highlights,
        )

        projection = {
            "schema_version": RECEIPT_MEMORY_DETERMINISTIC_SCHEMA_VERSION,
            "source": {
                "kind": "gmail_receipts",
                "inference_window_days": inference_window_days,
                "highlights_window_days": highlights_window_days,
                "generated_at": _format_dt_iso(_utcnow()),
                "canonicalization_version": "merchant_canonicalization_v1",
                "heuristic_version": self.DETERMINISTIC_CONFIG_VERSION,
                "source_watermark": watermark["source_watermark"],
                "source_watermark_hash": watermark["source_watermark_hash"],
            },
            "observed_facts": {
                "merchant_affinity": merchant_affinity[:RECEIPT_MEMORY_MAX_MERCHANTS],
                "purchase_patterns": purchase_patterns[:RECEIPT_MEMORY_MAX_PATTERNS],
                "recent_highlights": recent_highlights[:RECEIPT_MEMORY_MAX_HIGHLIGHTS],
            },
            "inferred_preferences": inferred_preferences[:RECEIPT_MEMORY_MAX_SIGNALS],
            "budget_stats": {
                "merchant_count": min(len(merchant_affinity), RECEIPT_MEMORY_MAX_MERCHANTS),
                "pattern_count": min(len(purchase_patterns), RECEIPT_MEMORY_MAX_PATTERNS),
                "highlight_count": min(len(recent_highlights), RECEIPT_MEMORY_MAX_HIGHLIGHTS),
                "signal_count": min(len(inferred_preferences), RECEIPT_MEMORY_MAX_SIGNALS),
                "eligible_receipt_count": len(rows),
            },
        }
        projection["source"]["projection_hash"] = _sha256_json(projection)
        return projection

    def _fetch_receipts(
        self,
        *,
        user_id: str,
        inference_window_days: int,
    ) -> list[dict[str, Any]]:
        threshold = _utcnow() - timedelta(days=inference_window_days)
        result = self.db.execute_raw(
            """
            SELECT
                id,
                gmail_message_id,
                from_name,
                from_email,
                merchant_name,
                currency,
                amount,
                receipt_date,
                gmail_internal_date,
                classification_confidence,
                created_at,
                updated_at
            FROM kai_gmail_receipts
            WHERE user_id = :user_id
              AND COALESCE(receipt_date, gmail_internal_date, created_at) >= :threshold
              AND COALESCE(merchant_name, from_name, from_email) IS NOT NULL
              AND COALESCE(classification_confidence, 0) >= :confidence_floor
            ORDER BY COALESCE(receipt_date, gmail_internal_date, created_at) DESC, id DESC
            """,
            {
                "user_id": user_id,
                "threshold": threshold,
                "confidence_floor": RECEIPT_MEMORY_CLASSIFICATION_CONFIDENCE_FLOOR,
            },
        )
        rows: list[dict[str, Any]] = []
        for row in result.data or []:
            receipt_at = (
                _parse_dt(row.get("receipt_date"))
                or _parse_dt(row.get("gmail_internal_date"))
                or _parse_dt(row.get("created_at"))
            )
            if receipt_at is None:
                continue
            merchant_id, merchant_label = _canonicalize_merchant(row)
            rows.append(
                {
                    **row,
                    "receipt_at": receipt_at,
                    "merchant_id": merchant_id,
                    "merchant_label": merchant_label,
                    "amount": _safe_float(row.get("amount")),
                    "classification_confidence": _safe_float(row.get("classification_confidence"))
                    or 0.0,
                }
            )
        return rows

    def _build_source_watermark(
        self,
        *,
        rows: list[dict[str, Any]],
        inference_window_days: int,
        highlights_window_days: int,
    ) -> dict[str, Any]:
        latest_row = rows[0] if rows else {}
        latest_updated_at = _format_dt_iso(_parse_dt(latest_row.get("updated_at")))
        latest_receipt_at = _format_dt_iso(latest_row.get("receipt_at"))
        source_watermark = {
            "eligible_receipt_count": len(rows),
            "latest_receipt_updated_at": latest_updated_at,
            "latest_receipt_id": _safe_int(latest_row.get("id")),
            "latest_receipt_date": latest_receipt_at,
            "deterministic_config_version": self.DETERMINISTIC_CONFIG_VERSION,
            "inference_window_days": inference_window_days,
            "highlights_window_days": highlights_window_days,
        }
        return {
            "source_watermark": source_watermark,
            "source_watermark_hash": _sha256_json(source_watermark),
        }

    def _group_by_merchant(self, rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
        grouped: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            grouped.setdefault(str(row["merchant_id"]), []).append(row)
        return grouped

    def _build_merchant_affinity(
        self,
        merchant_groups: dict[str, list[dict[str, Any]]],
    ) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        now = _utcnow()
        for merchant_id, rows in merchant_groups.items():
            sorted_rows = sorted(rows, key=lambda row: row["receipt_at"], reverse=True)
            last_purchase_at = sorted_rows[0]["receipt_at"]
            active_months = {
                row["receipt_at"].astimezone(UTC).strftime("%Y-%m") for row in sorted_rows
            }
            receipt_count = len(sorted_rows)
            count_score = min(1.0, receipt_count / 6.0)
            active_month_score = min(1.0, len(active_months) / 4.0)
            days_since_last = max(0.0, (now - last_purchase_at).total_seconds() / 86400.0)
            recency_score = max(0.0, 1.0 - (days_since_last / 365.0))
            affinity_score = round(
                min(
                    0.99, (0.5 * count_score) + (0.25 * active_month_score) + (0.25 * recency_score)
                ),
                4,
            )
            primary_currency, primary_amount = _top_currency_summary(sorted_rows)
            items.append(
                {
                    "merchant_id": merchant_id,
                    "merchant_label": sorted_rows[0]["merchant_label"],
                    "receipt_count_365d": receipt_count,
                    "active_month_count_365d": len(active_months),
                    "last_purchase_at": _format_dt_iso(last_purchase_at),
                    "affinity_score": affinity_score,
                    "primary_currency": primary_currency,
                    "primary_currency_total_amount": primary_amount,
                    "fact_id": f"merchant:{merchant_id}",
                }
            )
        return sorted(
            items,
            key=lambda item: (
                float(item.get("affinity_score") or 0),
                int(item.get("receipt_count_365d") or 0),
                str(item.get("last_purchase_at") or ""),
            ),
            reverse=True,
        )

    def _build_purchase_patterns(
        self,
        merchant_groups: dict[str, list[dict[str, Any]]],
    ) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        now = _utcnow()
        cadence_windows = {
            "weekly": (5, 9),
            "biweekly": (10, 18),
            "monthly": (25, 35),
            "quarterly": (80, 100),
        }
        for merchant_id, rows in merchant_groups.items():
            unique_dates = sorted(
                {
                    row["receipt_at"].astimezone(UTC).date().isoformat(): row["receipt_at"]
                    for row in rows
                }.values()
            )
            if len(unique_dates) < 3:
                continue
            deltas = [
                max(1, int((right - left).total_seconds() // 86400))
                for left, right in zip(unique_dates, unique_dates[1:], strict=False)
                if right > left
            ]
            if len(deltas) < 2:
                continue
            best_bucket: str | None = None
            best_hits = 0
            best_mean = 0.0
            for bucket, (lower, upper) in cadence_windows.items():
                matches = [delta for delta in deltas if lower <= delta <= upper]
                if len(matches) > best_hits:
                    best_bucket = bucket
                    best_hits = len(matches)
                    best_mean = float(sum(matches) / len(matches)) if matches else 0.0
            if not best_bucket or best_hits < 2:
                continue
            ratio = best_hits / max(1, len(deltas))
            recency_days = (now - unique_dates[-1]).total_seconds() / 86400.0
            recency_score = 1.0 if recency_days <= 60 else 0.75 if recency_days <= 180 else 0.5
            confidence = round(
                min(0.99, ratio * min(1.0, len(unique_dates) / 4.0) * recency_score),
                4,
            )
            if confidence < 0.55:
                continue
            merchant_label = rows[0]["merchant_label"]
            pattern_id = _sha256_text(f"{merchant_id}:{best_bucket}:{len(unique_dates)}")[:16]
            items.append(
                {
                    "pattern_id": f"pattern:{pattern_id}",
                    "merchant_id": merchant_id,
                    "merchant_label": merchant_label,
                    "cadence": best_bucket,
                    "occurrence_count": len(unique_dates),
                    "mean_interval_days": round(best_mean, 1),
                    "confidence": confidence,
                    "first_observed_at": _format_dt_iso(unique_dates[0]),
                    "last_observed_at": _format_dt_iso(unique_dates[-1]),
                    "fact_id": f"pattern:{pattern_id}",
                }
            )
        return sorted(
            items,
            key=lambda item: (
                float(item.get("confidence") or 0),
                int(item.get("occurrence_count") or 0),
                str(item.get("last_observed_at") or ""),
            ),
            reverse=True,
        )

    def _build_recent_highlights(
        self,
        *,
        rows: list[dict[str, Any]],
        merchant_groups: dict[str, list[dict[str, Any]]],
        purchase_patterns: list[dict[str, Any]],
        highlights_window_days: int,
    ) -> list[dict[str, Any]]:
        pattern_by_merchant = {str(item["merchant_id"]): item for item in purchase_patterns}
        highlight_rows: list[tuple[float, dict[str, Any]]] = []
        now = _utcnow()
        for row in rows:
            receipt_at = row["receipt_at"]
            if not _is_recent_enough(receipt_at, window_days=highlights_window_days):
                continue
            merchant_rows = sorted(
                merchant_groups.get(str(row["merchant_id"]), []),
                key=lambda item: item["receipt_at"],
            )
            amount = row.get("amount")
            reason_code: str | None = None
            score = 0.0
            if isinstance(amount, float) and amount >= 250:
                reason_code = "high_value"
                score = min(1.0, amount / 500.0)
            median_amount = _median(
                [
                    float(item["amount"])
                    for item in merchant_rows
                    if isinstance(item.get("amount"), float)
                ]
            )
            if (
                not reason_code
                and isinstance(amount, float)
                and median_amount
                and amount >= max(50.0, median_amount * 1.8)
            ):
                reason_code = "unusually_large_for_merchant"
                score = min(0.95, amount / max(median_amount, 1.0) / 3.0)
            if not reason_code and merchant_rows and merchant_rows[0]["id"] == row["id"]:
                reason_code = "new_merchant"
                score = 0.8
            if not reason_code:
                previous_rows = [item for item in merchant_rows if item["receipt_at"] < receipt_at]
                if previous_rows:
                    gap_days = (
                        receipt_at - previous_rows[-1]["receipt_at"]
                    ).total_seconds() / 86400.0
                    if gap_days >= 90:
                        reason_code = "returned_after_gap"
                        score = min(0.85, gap_days / 180.0)
            if not reason_code and row["merchant_id"] in pattern_by_merchant:
                reason_code = "recurring_charge_detected"
                score = float(pattern_by_merchant[row["merchant_id"]]["confidence"] or 0.65)
            if not reason_code:
                continue
            highlight_id = f"highlight:{row['id']}"
            highlight_rows.append(
                (
                    score,
                    {
                        "highlight_id": highlight_id,
                        "merchant_id": row["merchant_id"],
                        "merchant_label": row["merchant_label"],
                        "purchased_at": _format_dt_iso(receipt_at),
                        "amount": round(amount, 2) if isinstance(amount, float) else None,
                        "currency": _clean_text(row.get("currency")).upper() or None,
                        "reason_code": reason_code,
                        "fact_id": highlight_id,
                        "score": round(score, 4),
                        "days_since_purchase": round(
                            max(0.0, (now - receipt_at).total_seconds() / 86400.0), 1
                        ),
                    },
                )
            )
        ordered = [
            item for _, item in sorted(highlight_rows, key=lambda pair: pair[0], reverse=True)
        ]
        deduped: list[dict[str, Any]] = []
        seen: set[str] = set()
        for item in ordered:
            key = str(item["highlight_id"])
            if key in seen:
                continue
            seen.add(key)
            deduped.append(item)
            if len(deduped) >= RECEIPT_MEMORY_MAX_HIGHLIGHTS:
                break
        return deduped

    def _build_inferred_preferences(
        self,
        *,
        merchant_affinity: list[dict[str, Any]],
        purchase_patterns: list[dict[str, Any]],
        recent_highlights: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        signals: list[dict[str, Any]] = []
        for merchant in merchant_affinity[:RECEIPT_MEMORY_MAX_SIGNALS]:
            if int(merchant.get("receipt_count_365d") or 0) < 3:
                continue
            score = float(merchant.get("affinity_score") or 0.0)
            if score < 0.55:
                continue
            merchant_id = str(merchant["merchant_id"])
            signals.append(
                {
                    "signal_id": f"signal:merchant_loyalty:{merchant_id}",
                    "signal_type": "merchant_loyalty",
                    "label": f"Frequently returns to {merchant['merchant_label']}",
                    "confidence": score,
                    "supporting_fact_ids": [merchant["fact_id"]],
                }
            )
        for pattern in purchase_patterns[:RECEIPT_MEMORY_MAX_SIGNALS]:
            confidence = float(pattern.get("confidence") or 0.0)
            if confidence < 0.6:
                continue
            signals.append(
                {
                    "signal_id": f"signal:recurring_preference:{pattern['pattern_id']}",
                    "signal_type": "recurring_preference",
                    "label": _format_pattern_label(
                        str(pattern["merchant_label"]),
                        str(pattern["cadence"]),
                    ),
                    "confidence": confidence,
                    "supporting_fact_ids": [pattern["fact_id"]],
                }
            )
        if len(recent_highlights) >= 3:
            support_ids = [item["fact_id"] for item in recent_highlights[:3]]
            signals.append(
                {
                    "signal_id": "signal:shopping_habit:steady_recent_activity",
                    "signal_type": "shopping_habit",
                    "label": "Maintains steady recent purchase activity across multiple receipts",
                    "confidence": min(
                        0.9,
                        0.55 + (0.08 * min(4, len(recent_highlights))),
                    ),
                    "supporting_fact_ids": support_ids,
                }
            )
        deduped: list[dict[str, Any]] = []
        seen: set[str] = set()
        for item in signals:
            signal_id = str(item["signal_id"])
            if signal_id in seen:
                continue
            seen.add(signal_id)
            deduped.append(item)
            if len(deduped) >= RECEIPT_MEMORY_MAX_SIGNALS:
                break
        return deduped


class ReceiptMemoryEnrichmentService:
    """Optional LLM enrichment over deterministic projection only."""

    def _enabled(self) -> bool:
        raw = _clean_text(os.getenv("KAI_RECEIPT_MEMORY_LLM_ENABLED"), "true").lower()
        return raw not in {"0", "false", "off", "disabled", "no"}

    def _model(self) -> str:
        return _clean_text(os.getenv("KAI_RECEIPT_MEMORY_LLM_MODEL"), "gemini-2.5-flash-lite")

    def enrichment_cache_key(self) -> str:
        if not self._enabled():
            return "deterministic-only"
        api_key = _clean_text(os.getenv("GOOGLE_API_KEY"))
        if not api_key:
            return "deterministic-only"
        return f"gemini:{self._model()}:v{RECEIPT_MEMORY_ENRICHMENT_SCHEMA_VERSION}"

    async def enrich(self, projection: dict[str, Any]) -> dict[str, Any] | None:
        if self.enrichment_cache_key() == "deterministic-only":
            return None
        try:
            from google import genai  # type: ignore
            from google.genai import types as genai_types  # type: ignore
        except Exception:
            return None

        api_key = _clean_text(os.getenv("GOOGLE_API_KEY"))
        if not api_key:
            return None

        digest = {
            "merchant_affinity": projection.get("observed_facts", {}).get("merchant_affinity", [])[
                :6
            ],
            "purchase_patterns": projection.get("observed_facts", {}).get("purchase_patterns", [])[
                :4
            ],
            "recent_highlights": projection.get("observed_facts", {}).get("recent_highlights", [])[
                :6
            ],
            "inferred_preferences": projection.get("inferred_preferences", [])[:6],
            "budget_stats": projection.get("budget_stats", {}),
        }
        prompt = (
            "You summarize shopping memory from deterministic receipt signals. "
            "Use ONLY the facts in the JSON payload. Do not invent merchants, patterns, or amounts. "
            "Return ONLY JSON with keys: readable_summary{text:string,highlights:string[]}, "
            "signal_language:[{signal_id:string,human_label:string,rationale:string}]. "
            f"Payload: {_json_dumps(digest)}"
        )

        try:
            client = genai.Client(api_key=api_key)
            response = await client.aio.models.generate_content(
                model=self._model(),
                contents=prompt,
                config=genai_types.GenerateContentConfig(temperature=0),
            )
            text = _clean_text(getattr(response, "text", ""))
            if not text:
                return None
            start = text.find("{")
            end = text.rfind("}")
            if start < 0 or end <= start:
                return None
            parsed = json.loads(text[start : end + 1])
            if not isinstance(parsed, dict):
                return None
            readable_summary = _json_object(parsed.get("readable_summary"))
            summary_text = _clip_text(
                _clean_text(readable_summary.get("text")),
                RECEIPT_MEMORY_MAX_SUMMARY_CHARS,
            )
            highlights = _dedupe_strings(
                [
                    _clip_text(str(item), 120)
                    for item in (readable_summary.get("highlights") or [])
                    if isinstance(item, str)
                ],
                limit=RECEIPT_MEMORY_MAX_SUMMARY_HIGHLIGHTS,
            )
            if not summary_text:
                return None
            signal_language: list[dict[str, Any]] = []
            for item in parsed.get("signal_language") or []:
                if not isinstance(item, dict):
                    continue
                signal_id = _clean_text(item.get("signal_id"))
                if not signal_id:
                    continue
                signal_language.append(
                    {
                        "signal_id": signal_id,
                        "human_label": _clip_text(_clean_text(item.get("human_label")), 120),
                        "rationale": _clip_text(_clean_text(item.get("rationale")), 160),
                    }
                )
            enrichment = {
                "schema_version": RECEIPT_MEMORY_ENRICHMENT_SCHEMA_VERSION,
                "based_on_projection_hash": projection.get("source", {}).get("projection_hash"),
                "model": self._model(),
                "generated_at": _format_dt_iso(_utcnow()),
                "readable_summary": {
                    "text": summary_text,
                    "highlights": highlights,
                },
                "signal_language": signal_language,
                "validation": {
                    "introduced_unknown_fact_ids": [],
                    "dropped_fact_ids": [],
                },
            }
            return enrichment
        except Exception as exc:
            logger.warning("receipt_memory.enrichment_failed reason=%s", exc)
            return None


class ReceiptMemoryPkmMapper:
    """Builds the final compact PKM subtree."""

    def build_candidate_payload(
        self,
        *,
        projection: dict[str, Any],
        enrichment: dict[str, Any] | None,
        artifact_id: str,
    ) -> dict[str, Any]:
        summary_text, highlights = self._resolve_summary(
            projection=projection, enrichment=enrichment
        )
        observed = projection.get("observed_facts", {})
        signals = projection.get("inferred_preferences", [])
        receipts_memory = {
            "schema_version": 1,
            "readable_summary": {
                "text": summary_text,
                "highlights": highlights[:RECEIPT_MEMORY_MAX_SUMMARY_HIGHLIGHTS],
                "updated_at": _format_dt_iso(_utcnow()),
                "source_label": "Gmail receipts",
            },
            "observed_facts": {
                "merchant_affinity": [
                    {
                        "merchant_id": item.get("merchant_id"),
                        "merchant_label": item.get("merchant_label"),
                        "affinity_score": item.get("affinity_score"),
                        "receipt_count_365d": item.get("receipt_count_365d"),
                        "last_purchase_at": item.get("last_purchase_at"),
                        "top_currency": item.get("primary_currency"),
                    }
                    for item in (observed.get("merchant_affinity") or [])[
                        :RECEIPT_MEMORY_MAX_MERCHANTS
                    ]
                ],
                "purchase_patterns": [
                    {
                        "pattern_id": item.get("pattern_id"),
                        "merchant_label": item.get("merchant_label"),
                        "cadence": item.get("cadence"),
                        "occurrence_count": item.get("occurrence_count"),
                        "last_observed_at": item.get("last_observed_at"),
                        "confidence": item.get("confidence"),
                    }
                    for item in (observed.get("purchase_patterns") or [])[
                        :RECEIPT_MEMORY_MAX_PATTERNS
                    ]
                ],
                "recent_highlights": [
                    {
                        "merchant_label": item.get("merchant_label"),
                        "purchased_at": item.get("purchased_at"),
                        "amount": item.get("amount"),
                        "currency": item.get("currency"),
                        "reason_code": item.get("reason_code"),
                    }
                    for item in (observed.get("recent_highlights") or [])[
                        :RECEIPT_MEMORY_MAX_HIGHLIGHTS
                    ]
                ],
            },
            "inferred_preferences": {
                "preference_signals": [
                    {
                        "signal_id": item.get("signal_id"),
                        "label": item.get("label"),
                        "confidence": item.get("confidence"),
                        "basis_codes": list(item.get("supporting_fact_ids") or [])[:4],
                    }
                    for item in signals[:RECEIPT_MEMORY_MAX_SIGNALS]
                ]
            },
            "provenance": {
                "source_kind": "gmail_receipts",
                "artifact_id": artifact_id,
                "deterministic_projection_hash": projection.get("source", {}).get(
                    "projection_hash"
                ),
                "enrichment_hash": _sha256_json(enrichment) if enrichment else None,
                "inference_window_days": projection.get("source", {}).get("inference_window_days"),
                "highlights_window_days": projection.get("source", {}).get(
                    "highlights_window_days"
                ),
                "receipt_count_used": projection.get("budget_stats", {}).get(
                    "eligible_receipt_count"
                ),
                "latest_receipt_updated_at": projection.get("source", {})
                .get("source_watermark", {})
                .get("latest_receipt_updated_at"),
                "imported_at": _format_dt_iso(_utcnow()),
            },
        }
        self._apply_budget(receipts_memory)
        return {"receipts_memory": receipts_memory}

    def _resolve_summary(
        self,
        *,
        projection: dict[str, Any],
        enrichment: dict[str, Any] | None,
    ) -> tuple[str, list[str]]:
        if enrichment:
            readable_summary = _json_object(enrichment.get("readable_summary"))
            text = _clip_text(
                _clean_text(readable_summary.get("text")),
                RECEIPT_MEMORY_MAX_SUMMARY_CHARS,
            )
            highlights = _dedupe_strings(
                [
                    _clip_text(str(item), 120)
                    for item in (readable_summary.get("highlights") or [])
                    if isinstance(item, str)
                ],
                limit=RECEIPT_MEMORY_MAX_SUMMARY_HIGHLIGHTS,
            )
            if text:
                return text, highlights

        merchants = projection.get("observed_facts", {}).get("merchant_affinity", [])[:2]
        patterns = projection.get("observed_facts", {}).get("purchase_patterns", [])[:2]
        highlights = projection.get("observed_facts", {}).get("recent_highlights", [])[:3]
        merchant_names = [
            str(item.get("merchant_label")) for item in merchants if item.get("merchant_label")
        ]
        pattern_names = [
            str(item.get("merchant_label")) for item in patterns if item.get("merchant_label")
        ]

        if merchant_names:
            text = (
                f"Kai sees the strongest receipt memory around {', '.join(merchant_names[:2])} "
                f"from the last {RECEIPT_MEMORY_INFERENCE_WINDOW_DAYS} days."
            )
        else:
            text = (
                f"Kai built a compact receipt-memory snapshot from your stored Gmail receipts "
                f"across the last {RECEIPT_MEMORY_INFERENCE_WINDOW_DAYS} days."
            )
        fallback_highlights: list[str] = []
        if merchant_names:
            fallback_highlights.append(f"Top merchants: {', '.join(merchant_names[:3])}")
        if pattern_names:
            fallback_highlights.append(f"Recurring patterns: {', '.join(pattern_names[:2])}")
        if highlights:
            fallback_highlights.append(
                f"Recent notable activity: {', '.join(str(item.get('merchant_label')) for item in highlights if item.get('merchant_label'))}"
            )
        return _clip_text(text, RECEIPT_MEMORY_MAX_SUMMARY_CHARS), _dedupe_strings(
            fallback_highlights,
            limit=RECEIPT_MEMORY_MAX_SUMMARY_HIGHLIGHTS,
        )

    def _apply_budget(self, receipts_memory: dict[str, Any]) -> None:
        summary = _json_object(receipts_memory.get("readable_summary"))
        summary["text"] = _clip_text(
            _clean_text(summary.get("text")),
            RECEIPT_MEMORY_MAX_SUMMARY_CHARS,
        )
        summary["highlights"] = _dedupe_strings(
            [str(item) for item in summary.get("highlights") or [] if isinstance(item, str)],
            limit=RECEIPT_MEMORY_MAX_SUMMARY_HIGHLIGHTS,
        )
        receipts_memory["readable_summary"] = summary

        observed = _json_object(receipts_memory.get("observed_facts"))
        observed["merchant_affinity"] = list(observed.get("merchant_affinity") or [])[
            :RECEIPT_MEMORY_MAX_MERCHANTS
        ]
        observed["purchase_patterns"] = list(observed.get("purchase_patterns") or [])[
            :RECEIPT_MEMORY_MAX_PATTERNS
        ]
        observed["recent_highlights"] = list(observed.get("recent_highlights") or [])[
            :RECEIPT_MEMORY_MAX_HIGHLIGHTS
        ]
        receipts_memory["observed_facts"] = observed

        inferred = _json_object(receipts_memory.get("inferred_preferences"))
        inferred["preference_signals"] = list(inferred.get("preference_signals") or [])[
            :RECEIPT_MEMORY_MAX_SIGNALS
        ]
        receipts_memory["inferred_preferences"] = inferred


class ReceiptMemoryArtifactService:
    """Persistence and cache reuse for preview artifacts."""

    def __init__(self) -> None:
        self._db = get_db()
        self._cache_persistence_available = True

    @property
    def db(self):
        return self._db

    def _mark_cache_unavailable(self, error: Exception) -> None:
        if self._cache_persistence_available:
            logger.warning(
                "receipt_memory.artifact_cache_unavailable reason=%s",
                error,
            )
        self._cache_persistence_available = False

    def _build_ephemeral_artifact(
        self,
        *,
        artifact_id: str,
        user_id: str,
        source_watermark_hash: str,
        source_watermark: dict[str, Any],
        inference_window_days: int,
        highlights_window_days: int,
        enrichment_cache_key: str,
        deterministic_projection: dict[str, Any],
        enrichment: dict[str, Any] | None,
        candidate_pkm_payload: dict[str, Any],
        debug_stats: dict[str, Any],
    ) -> dict[str, Any]:
        created_at = _utcnow()
        return {
            "artifact_id": artifact_id,
            "user_id": user_id,
            "source_kind": "gmail_receipts",
            "artifact_version": RECEIPT_MEMORY_ARTIFACT_VERSION,
            "status": "ready",
            "inference_window_days": inference_window_days,
            "highlights_window_days": highlights_window_days,
            "source_watermark_hash": source_watermark_hash,
            "source_watermark": source_watermark,
            "deterministic_schema_version": RECEIPT_MEMORY_DETERMINISTIC_SCHEMA_VERSION,
            "enrichment_schema_version": RECEIPT_MEMORY_ENRICHMENT_SCHEMA_VERSION
            if enrichment
            else None,
            "enrichment_cache_key": enrichment_cache_key,
            "deterministic_projection_hash": _sha256_json(deterministic_projection),
            "enrichment_hash": _sha256_json(enrichment) if enrichment else None,
            "candidate_pkm_payload_hash": _sha256_json(candidate_pkm_payload),
            "deterministic_projection": deterministic_projection,
            "enrichment": enrichment,
            "candidate_pkm_payload": candidate_pkm_payload,
            "debug_stats": debug_stats,
            "created_at": _format_dt_iso(created_at),
            "updated_at": _format_dt_iso(created_at),
            "freshness": self._freshness_payload(created_at),
            "persisted_pkm_data_version": None,
            "persisted_at": None,
            "cache_persisted": False,
        }

    def get_cached_artifact(
        self,
        *,
        user_id: str,
        source_watermark_hash: str,
        inference_window_days: int,
        highlights_window_days: int,
        deterministic_schema_version: int,
        enrichment_cache_key: str,
    ) -> dict[str, Any] | None:
        if not self._cache_persistence_available:
            return None
        try:
            rowset = self.db.execute_raw(
                """
                SELECT *
                FROM kai_receipt_memory_artifacts
                WHERE user_id = :user_id
                  AND source_watermark_hash = :source_watermark_hash
                  AND inference_window_days = :inference_window_days
                  AND highlights_window_days = :highlights_window_days
                  AND deterministic_schema_version = :deterministic_schema_version
                  AND enrichment_cache_key = :enrichment_cache_key
                ORDER BY created_at DESC
                LIMIT 1
                """,
                {
                    "user_id": user_id,
                    "source_watermark_hash": source_watermark_hash,
                    "inference_window_days": inference_window_days,
                    "highlights_window_days": highlights_window_days,
                    "deterministic_schema_version": deterministic_schema_version,
                    "enrichment_cache_key": enrichment_cache_key,
                },
            ).data
        except Exception as exc:
            if _is_missing_receipt_memory_artifact_table_error(exc):
                self._mark_cache_unavailable(exc)
                return None
            raise
        if not rowset:
            return None
        return self._serialize_row(rowset[0])

    def get_artifact(self, *, artifact_id: str, user_id: str) -> dict[str, Any] | None:
        if not self._cache_persistence_available:
            return None
        try:
            rowset = self.db.execute_raw(
                """
                SELECT *
                FROM kai_receipt_memory_artifacts
                WHERE artifact_id = :artifact_id
                  AND user_id = :user_id
                LIMIT 1
                """,
                {
                    "artifact_id": artifact_id,
                    "user_id": user_id,
                },
            ).data
        except Exception as exc:
            if _is_missing_receipt_memory_artifact_table_error(exc):
                self._mark_cache_unavailable(exc)
                return None
            raise
        if not rowset:
            return None
        return self._serialize_row(rowset[0])

    def create_artifact(
        self,
        *,
        artifact_id: str,
        user_id: str,
        source_watermark_hash: str,
        source_watermark: dict[str, Any],
        inference_window_days: int,
        highlights_window_days: int,
        enrichment_cache_key: str,
        deterministic_projection: dict[str, Any],
        enrichment: dict[str, Any] | None,
        candidate_pkm_payload: dict[str, Any],
        debug_stats: dict[str, Any],
    ) -> dict[str, Any]:
        deterministic_projection_hash = _sha256_json(deterministic_projection)
        enrichment_hash = _sha256_json(enrichment) if enrichment else None
        candidate_pkm_payload_hash = _sha256_json(candidate_pkm_payload)
        if not self._cache_persistence_available:
            return self._build_ephemeral_artifact(
                artifact_id=artifact_id,
                user_id=user_id,
                source_watermark_hash=source_watermark_hash,
                source_watermark=source_watermark,
                inference_window_days=inference_window_days,
                highlights_window_days=highlights_window_days,
                enrichment_cache_key=enrichment_cache_key,
                deterministic_projection=deterministic_projection,
                enrichment=enrichment,
                candidate_pkm_payload=candidate_pkm_payload,
                debug_stats=debug_stats,
            )
        try:
            self.db.execute_raw(
                """
                INSERT INTO kai_receipt_memory_artifacts (
                    artifact_id,
                    user_id,
                    source_kind,
                    artifact_version,
                    status,
                    deterministic_schema_version,
                    enrichment_schema_version,
                    enrichment_cache_key,
                    inference_window_days,
                    highlights_window_days,
                    source_watermark_hash,
                    source_watermark_json,
                    deterministic_projection_hash,
                    enrichment_hash,
                    candidate_pkm_payload_hash,
                    deterministic_projection_json,
                    enrichment_json,
                    candidate_pkm_payload_json,
                    debug_stats_json,
                    created_at,
                    updated_at
                ) VALUES (
                    :artifact_id,
                    :user_id,
                    'gmail_receipts',
                    :artifact_version,
                    'ready',
                    :deterministic_schema_version,
                    :enrichment_schema_version,
                    :enrichment_cache_key,
                    :inference_window_days,
                    :highlights_window_days,
                    :source_watermark_hash,
                    CAST(:source_watermark_json AS jsonb),
                    :deterministic_projection_hash,
                    :enrichment_hash,
                    :candidate_pkm_payload_hash,
                    CAST(:deterministic_projection_json AS jsonb),
                    CAST(:enrichment_json AS jsonb),
                    CAST(:candidate_pkm_payload_json AS jsonb),
                    CAST(:debug_stats_json AS jsonb),
                    NOW(),
                    NOW()
                )
                """,
                {
                    "artifact_id": artifact_id,
                    "user_id": user_id,
                    "artifact_version": RECEIPT_MEMORY_ARTIFACT_VERSION,
                    "deterministic_schema_version": RECEIPT_MEMORY_DETERMINISTIC_SCHEMA_VERSION,
                    "enrichment_schema_version": RECEIPT_MEMORY_ENRICHMENT_SCHEMA_VERSION
                    if enrichment
                    else None,
                    "enrichment_cache_key": enrichment_cache_key,
                    "inference_window_days": inference_window_days,
                    "highlights_window_days": highlights_window_days,
                    "source_watermark_hash": source_watermark_hash,
                    "source_watermark_json": _json_dumps(source_watermark),
                    "deterministic_projection_hash": deterministic_projection_hash,
                    "enrichment_hash": enrichment_hash,
                    "candidate_pkm_payload_hash": candidate_pkm_payload_hash,
                    "deterministic_projection_json": _json_dumps(deterministic_projection),
                    "enrichment_json": _json_dumps(enrichment) if enrichment else "null",
                    "candidate_pkm_payload_json": _json_dumps(candidate_pkm_payload),
                    "debug_stats_json": _json_dumps(debug_stats),
                },
            )
        except Exception as exc:
            if _is_missing_receipt_memory_artifact_table_error(exc):
                self._mark_cache_unavailable(exc)
                return self._build_ephemeral_artifact(
                    artifact_id=artifact_id,
                    user_id=user_id,
                    source_watermark_hash=source_watermark_hash,
                    source_watermark=source_watermark,
                    inference_window_days=inference_window_days,
                    highlights_window_days=highlights_window_days,
                    enrichment_cache_key=enrichment_cache_key,
                    deterministic_projection=deterministic_projection,
                    enrichment=enrichment,
                    candidate_pkm_payload=candidate_pkm_payload,
                    debug_stats=debug_stats,
                )
            raise

        artifact = self.get_artifact(artifact_id=artifact_id, user_id=user_id)
        if artifact is None:
            raise RuntimeError("Failed to load receipt-memory artifact after insert.")
        return artifact

    def _serialize_row(self, row: dict[str, Any]) -> dict[str, Any]:
        created_at = _parse_dt(row.get("created_at"))
        freshness = self._freshness_payload(created_at)
        deterministic_projection = _json_object(row.get("deterministic_projection_json"))
        enrichment_raw = row.get("enrichment_json")
        enrichment = (
            _json_object(enrichment_raw)
            if enrichment_raw is not None and enrichment_raw != "null"
            else None
        )
        artifact = {
            "artifact_id": _clean_text(row.get("artifact_id")),
            "user_id": _clean_text(row.get("user_id")),
            "source_kind": _clean_text(row.get("source_kind"), "gmail_receipts"),
            "artifact_version": _safe_int(row.get("artifact_version"))
            or RECEIPT_MEMORY_ARTIFACT_VERSION,
            "status": _clean_text(row.get("status"), "ready"),
            "inference_window_days": _safe_int(row.get("inference_window_days"))
            or RECEIPT_MEMORY_INFERENCE_WINDOW_DAYS,
            "highlights_window_days": _safe_int(row.get("highlights_window_days"))
            or RECEIPT_MEMORY_HIGHLIGHTS_WINDOW_DAYS,
            "source_watermark_hash": _clean_text(row.get("source_watermark_hash")),
            "source_watermark": _json_object(row.get("source_watermark_json")),
            "deterministic_schema_version": _safe_int(row.get("deterministic_schema_version"))
            or RECEIPT_MEMORY_DETERMINISTIC_SCHEMA_VERSION,
            "enrichment_schema_version": _safe_int(row.get("enrichment_schema_version")),
            "enrichment_cache_key": _clean_text(row.get("enrichment_cache_key")),
            "deterministic_projection_hash": _clean_text(row.get("deterministic_projection_hash")),
            "enrichment_hash": _clean_text(row.get("enrichment_hash")) or None,
            "candidate_pkm_payload_hash": _clean_text(row.get("candidate_pkm_payload_hash")),
            "deterministic_projection": deterministic_projection,
            "enrichment": enrichment,
            "candidate_pkm_payload": _json_object(row.get("candidate_pkm_payload_json")),
            "debug_stats": _json_object(row.get("debug_stats_json")),
            "created_at": _format_dt_iso(created_at),
            "updated_at": _format_dt_iso(_parse_dt(row.get("updated_at"))),
            "freshness": freshness,
            "persisted_pkm_data_version": _safe_int(row.get("persisted_pkm_data_version")),
            "persisted_at": _format_dt_iso(_parse_dt(row.get("persisted_at"))),
            "cache_persisted": True,
        }
        return artifact

    def _freshness_payload(self, created_at: datetime | None) -> dict[str, Any]:
        if created_at is None:
            return {
                "status": "stale",
                "is_stale": True,
                "stale_after_days": RECEIPT_MEMORY_STALE_AFTER_DAYS,
                "reason": "missing_created_at",
            }
        age = _utcnow() - created_at
        is_stale = age > timedelta(days=RECEIPT_MEMORY_STALE_AFTER_DAYS)
        return {
            "status": "stale" if is_stale else "fresh",
            "is_stale": is_stale,
            "stale_after_days": RECEIPT_MEMORY_STALE_AFTER_DAYS,
            "age_days": round(age.total_seconds() / 86400.0, 2),
            "reason": "older_than_stale_threshold" if is_stale else "watermark_current",
        }


class ReceiptMemoryPreviewService:
    """Facade that orchestrates projection, cache reuse, enrichment, and PKM mapping."""

    def __init__(self) -> None:
        self.projection_service = ReceiptMemoryProjectionService()
        self.artifact_service = ReceiptMemoryArtifactService()
        self.enrichment_service = ReceiptMemoryEnrichmentService()
        self.pkm_mapper = ReceiptMemoryPkmMapper()

    async def build_preview(
        self,
        *,
        user_id: str,
        force_refresh: bool = False,
    ) -> dict[str, Any]:
        projection = await self.projection_service.build_projection(user_id=user_id)
        source = _json_object(projection.get("source"))
        watermark_hash = _clean_text(source.get("source_watermark_hash"))
        inference_window_days = int(
            source.get("inference_window_days") or RECEIPT_MEMORY_INFERENCE_WINDOW_DAYS
        )
        highlights_window_days = int(
            source.get("highlights_window_days") or RECEIPT_MEMORY_HIGHLIGHTS_WINDOW_DAYS
        )
        enrichment_cache_key = self.enrichment_service.enrichment_cache_key()
        if not force_refresh and watermark_hash:
            cached = self.artifact_service.get_cached_artifact(
                user_id=user_id,
                source_watermark_hash=watermark_hash,
                inference_window_days=inference_window_days,
                highlights_window_days=highlights_window_days,
                deterministic_schema_version=RECEIPT_MEMORY_DETERMINISTIC_SCHEMA_VERSION,
                enrichment_cache_key=enrichment_cache_key,
            )
            if cached is not None:
                return cached

        enrichment: dict[str, Any] | None = None
        try:
            enrichment = await self.enrichment_service.enrich(projection)
        except Exception as exc:
            logger.warning("receipt_memory.preview_enrichment_failed reason=%s", exc)
            enrichment = None

        provisional_artifact_id = f"receipt_memory_{uuid.uuid4().hex}"
        candidate_pkm_payload = self.pkm_mapper.build_candidate_payload(
            projection=projection,
            enrichment=enrichment,
            artifact_id=provisional_artifact_id,
        )
        debug_stats = {
            "eligible_receipt_count": projection.get("budget_stats", {}).get(
                "eligible_receipt_count", 0
            ),
            "filtered_receipt_count": projection.get("budget_stats", {}).get(
                "eligible_receipt_count", 0
            ),
            "llm_input_token_budget_estimate": len(
                _json_dumps(
                    {
                        "merchant_affinity": projection.get("observed_facts", {}).get(
                            "merchant_affinity", []
                        )[:6],
                        "purchase_patterns": projection.get("observed_facts", {}).get(
                            "purchase_patterns", []
                        )[:4],
                        "recent_highlights": projection.get("observed_facts", {}).get(
                            "recent_highlights", []
                        )[:6],
                        "inferred_preferences": projection.get("inferred_preferences", [])[:6],
                    }
                )
            )
            // 4,
            "enrichment_mode": "llm" if enrichment else "deterministic_fallback",
        }

        artifact = self.artifact_service.create_artifact(
            artifact_id=provisional_artifact_id,
            user_id=user_id,
            source_watermark_hash=watermark_hash,
            source_watermark=_json_object(source.get("source_watermark")),
            inference_window_days=inference_window_days,
            highlights_window_days=highlights_window_days,
            enrichment_cache_key=enrichment_cache_key,
            deterministic_projection=projection,
            enrichment=enrichment,
            candidate_pkm_payload=candidate_pkm_payload,
            debug_stats=debug_stats,
        )
        # Rebuild payload with persisted artifact id so PKM provenance points to the stored artifact.
        artifact_id = artifact["artifact_id"]
        updated_candidate_payload = self.pkm_mapper.build_candidate_payload(
            projection=projection,
            enrichment=enrichment,
            artifact_id=artifact_id,
        )
        if (
            artifact.get("cache_persisted", True)
            and _sha256_json(updated_candidate_payload) != artifact["candidate_pkm_payload_hash"]
        ):
            self.artifact_service.db.execute_raw(
                """
                UPDATE kai_receipt_memory_artifacts
                SET candidate_pkm_payload_hash = :candidate_pkm_payload_hash,
                    candidate_pkm_payload_json = CAST(:candidate_pkm_payload_json AS jsonb),
                    updated_at = NOW()
                WHERE artifact_id = :artifact_id
                """,
                {
                    "artifact_id": artifact_id,
                    "candidate_pkm_payload_hash": _sha256_json(updated_candidate_payload),
                    "candidate_pkm_payload_json": _json_dumps(updated_candidate_payload),
                },
            )
            artifact = (
                self.artifact_service.get_artifact(artifact_id=artifact_id, user_id=user_id)
                or artifact
            )
        return artifact

    def get_artifact(self, *, artifact_id: str, user_id: str) -> dict[str, Any] | None:
        return self.artifact_service.get_artifact(artifact_id=artifact_id, user_id=user_id)


_receipt_memory_preview_service: ReceiptMemoryPreviewService | None = None


def get_receipt_memory_preview_service() -> ReceiptMemoryPreviewService:
    global _receipt_memory_preview_service
    if _receipt_memory_preview_service is None:
        _receipt_memory_preview_service = ReceiptMemoryPreviewService()
    return _receipt_memory_preview_service
