"""Import-safe receipt, invoice, deduplication, timezone & security header gene.

A pure bacterial gene: no network calls, no database access, no persistence,
and no secrets. All parsing, deduplication, currency-separated Decimal math,
owner-timezone formatting, and SPF/DKIM/DMARC header analysis run in-RAM on
ephemeral Gmail REST payloads and are discarded after the turn.
"""

from __future__ import annotations

import re
from collections import defaultdict
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# ---------------------------------------------------------------------------
# Timezone formatting
# ---------------------------------------------------------------------------

_TZ_SHORT_NAMES: dict[str, str] = {
    "Asia/Kolkata": "IST",
    "Asia/Calcutta": "IST",
    "UTC": "UTC",
    "Etc/UTC": "UTC",
}


def resolve_owner_zone(timezone_name: str | None) -> tuple[ZoneInfo, str]:
    """Return a valid ZoneInfo and canonical zone name, falling back to UTC."""
    raw = str(timezone_name or "").strip()
    if raw:
        try:
            return ZoneInfo(raw), raw
        except (ZoneInfoNotFoundError, ValueError):
            pass
    return ZoneInfo("UTC"), "UTC"


def format_local_timestamp(
    value: datetime | str | None,
    timezone_name: str | None = "UTC",
) -> tuple[str | None, str | None, str | None]:
    """Convert a UTC/aware datetime or ISO string into owner-local strings.

    Returns ``(iso_local, display_local, date_iso_local)`` where:
    - ``iso_local``: ISO-8601 string with local offset (e.g. ``2026-11-22T22:31:00+05:30``)
    - ``display_local``: clean human timestamp (e.g. ``Nov 22, 2026, 22:31 IST``)
    - ``date_iso_local``: ``YYYY-MM-DD`` in owner's local calendar
    """
    if value is None:
        return None, None, None
    dt: datetime | None = None
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, str) and value.strip():
        try:
            dt = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return value, value, None
    if dt is None:
        return None, None, None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    zone, zone_name = resolve_owner_zone(timezone_name)
    local_dt = dt.astimezone(zone)
    tz_abbr = _TZ_SHORT_NAMES.get(zone_name) or local_dt.tzname() or zone_name
    display = f"{local_dt:%b} {local_dt.day}, {local_dt:%Y}, {local_dt:%H:%M} {tz_abbr}"
    return local_dt.isoformat(), display, local_dt.date().isoformat()


# ---------------------------------------------------------------------------
# Duplicate delivery collapsing (fixes repeated mailing-list/alias deliveries)
# ---------------------------------------------------------------------------

_WHITESPACE_RE = re.compile(r"\s+")
_SUBJECT_PREFIX_RE = re.compile(r"^(?:(?:re|fwd|fw)\s*:\s*)+", re.IGNORECASE)


def _norm_key_text(value: Any) -> str:
    return _WHITESPACE_RE.sub(" ", str(value or "").strip().lower())


def collapse_duplicate_deliveries(
    items: Sequence[Mapping[str, Any]],
) -> tuple[list[int], int]:
    """Return surviving indices after collapsing identical alias/list deliveries.

    Two distinct Gmail messages (even with different ``threadId``s) delivered by
    the same sender with the exact same normalized subject within the same
    minute are collapsed to the first (newest/highest-ranked) occurrence.
    """
    seen: set[tuple[str, str, str]] = set()
    kept_indices: list[int] = []
    collapsed = 0
    for idx, item in enumerate(items):
        sender = _norm_key_text(item.get("sender"))
        subject = _norm_key_text(item.get("subject"))
        received = str(item.get("received_at") or "").strip()
        # Minute-level bucket (YYYY-MM-DDTHH:MM) catches identical mailing-list copies
        # delivered within seconds of each other while keeping genuinely distinct replies.
        minute_bucket = received[:16] if len(received) >= 16 else received
        dedup_key = (sender, subject, minute_bucket)
        if sender and subject and minute_bucket and dedup_key in seen:
            collapsed += 1
            continue
        if sender and subject and minute_bucket:
            seen.add(dedup_key)
        kept_indices.append(idx)
    return kept_indices, collapsed


# ---------------------------------------------------------------------------
# Receipt, invoice, refund & inward-remittance structured extraction
# ---------------------------------------------------------------------------

_CURRENCY_SYMBOL_MAP: dict[str, str] = {
    "$": "USD",
    "us$": "USD",
    "usd": "USD",
    "₹": "INR",
    "rs": "INR",
    "rs.": "INR",
    "inr": "INR",
    "€": "EUR",
    "eur": "EUR",
    "£": "GBP",
    "gbp": "GBP",
    "aed": "AED",
    "sgd": "SGD",
    "s$": "SGD",
    "cad": "CAD",
    "c$": "CAD",
    "aud": "AUD",
    "a$": "AUD",
    "¥": "JPY",
    "jpy": "JPY",
}

_AMOUNT_PREFIX_RE = re.compile(
    r"(?<![A-Za-z0-9])"
    r"(?P<cur>US\$|S\$|C\$|A\$|USD|INR|EUR|GBP|AED|SGD|CAD|AUD|JPY|Rs\.?|\$|₹|€|£|¥)"
    r"\s*(?P<num>\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)"
    r"(?:\s*(?P<cur_after>USD|INR|EUR|GBP|AED|SGD|CAD|AUD|JPY)\b)?",
    re.IGNORECASE,
)

_AMOUNT_SUFFIX_RE = re.compile(
    r"(?<![A-Za-z0-9.])"
    r"(?P<num>\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)"
    r"\s*(?P<cur>USD|INR|EUR|GBP|AED|SGD|CAD|AUD|JPY)\b",
    re.IGNORECASE,
)

_TOTAL_LABEL_RE = re.compile(
    r"(?:grand\s+total|total\s+paid|amount\s+paid|total\s+amount|total\s+due|amount\s+due|"
    r"balance\s+due|net\s+payable|you\s+paid|charged|refund\s+amount|refunded|subtotal|total)"
    r"[\s:=#-]{0,8}"
    r"(?P<cur>US\$|S\$|C\$|A\$|USD|INR|EUR|GBP|AED|SGD|CAD|AUD|JPY|Rs\.?|\$|₹|€|£|¥)?\s*"
    r"(?P<num>\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)"
    r"(?:\s*(?P<cur_after>USD|INR|EUR|GBP|AED|SGD|CAD|AUD|JPY)\b)?",
    re.IGNORECASE,
)

_TAX_RE = re.compile(
    r"\b(?:gst|igst|cgst|sgst|vat|sales\s+tax|tax)\b[\s:=#-]{0,12}"
    r"(?P<cur>US\$|USD|INR|EUR|GBP|AED|Rs\.?|\$|₹|€|£)?\s*"
    r"(?P<num>\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?)",
    re.IGNORECASE,
)

_REF_ID_RE = re.compile(
    r"\b(?:receipt|invoice|order|transaction|txn|booking|pnr|reference|ref|bill)"
    r"(?:\s*(?:id|no|num|number))?"
    r"\s*(?:#|:|no\.?|\s)\s*"
    r"(?P<val>[A-Z0-9][A-Z0-9/_-]{3,32})\b",
    re.IGNORECASE,
)

_CARD_LAST4_RE = re.compile(
    r"\b(?:card\s+ending\s+in|ending\s+in|visa|mastercard|amex|rupay|card)\s*(?:x+|\*+|•+)?\s*(\d{4})\b",
    re.IGNORECASE,
)
_UPI_RE = re.compile(r"\b(?:upi|gpay|google\s+pay|phonepe|paytm|bhim)\b", re.IGNORECASE)

_DUE_DATE_RE = re.compile(
    r"\b(?:due\s+(?:date|by|on)|pay\s+by|payment\s+due(?:\s+on|\s+by)?)\s*[:\-]?\s*"
    r"([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}/\d{1,2}/\d{2,4})",
    re.IGNORECASE,
)

_REFUND_RE = re.compile(
    r"\b(refund(?:ed)?|credit\s+note|cashback\s+credited|reversal|chargeback\s+credit)\b",
    re.IGNORECASE,
)
_INWARD_CREDIT_RE = re.compile(
    r"\b(inward\s+remittance|credited\s+to\s+(?:your\s+)?account|payout\s+(?:sent|received|credited)|"
    r"salary\s+credited|payment\s+received\s+from|direct\s+deposit|wire\s+received|"
    r"in\s+favour\s+of|received\s+into\s+your\s+account)\b",
    re.IGNORECASE,
)
_PENDING_INVOICE_RE = re.compile(
    r"\b(unpaid|payment\s+due|amount\s+due|balance\s+due|past\s+due|overdue|"
    r"invoice\s+due|pay\s+now|pending\s+(?:payment|invoice)|action\s+required.*pay|"
    r"payment\s+failed|failed\s+payment|awaiting\s+payment)\b",
    re.IGNORECASE,
)
_PAID_CONFIRM_RE = re.compile(
    r"\b(paid|payment\s+successful|payment\s+confirmed|receipt\s+(?:#|for|from)|"
    r"thank\s+you\s+for\s+your\s+(?:payment|order|purchase)|order\s+confirmed|"
    r"charged|debited|transaction\s+successful|invoice\s+paid)\b",
    re.IGNORECASE,
)
_STATEMENT_RE = re.compile(
    r"\b(monthly\s+statement|account\s+statement|billing\s+summary|card\s+statement|e-?statement)\b",
    re.IGNORECASE,
)
_FINANCIAL_SIGNAL_RE = re.compile(
    r"\b(receipt|invoice|bill|payment|paid|refund|order|purchase|charge[ds]?|debited|"
    r"credited|remittance|subscription|renewal|booking|ticket|statement|gst|tax|"
    r"amount\s+due|total|transaction|emi|upi|card\s+ending)\b",
    re.IGNORECASE,
)
_NOISE_PROMO_RE = re.compile(
    r"\b(unsubscribe|black\s+friday|%\s*off|flat\s+\d+%|job\s+alert|cibil\s+report|"
    r"share\s+your\s+.*feedback|newsletter|webinar|invitation\s+to\s+connect|"
    r"\[application\]|chief\s+product\s+officer)\b",
    re.IGNORECASE,
)

_CATEGORY_KEYWORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        "travel",
        (
            "uber",
            "ola",
            "lyft",
            "indigo",
            "air india",
            "vistara",
            "makemytrip",
            "airbnb",
            "hotel",
            "flight",
            "irctc",
            "booking.com",
            "expedia",
            "delta",
            "united",
            "emirates",
        ),
    ),
    (
        "food",
        (
            "swiggy",
            "zomato",
            "ubereats",
            "doordash",
            "blinkit",
            "zepto",
            "instamart",
            "starbucks",
            "dominos",
            "mcdonald",
            "restaurant",
            "cafe",
            "dining",
        ),
    ),
    (
        "shopping",
        (
            "amazon",
            "flipkart",
            "myntra",
            "nykaa",
            "apple store",
            "walmart",
            "target",
            "best buy",
            "nike",
            "ikea",
            "ajio",
            "meesho",
            "shopify",
        ),
    ),
    (
        "software",
        (
            "hushh",
            "openai",
            "anthropic",
            "google cloud",
            "google workspace",
            "aws",
            "github",
            "vercel",
            "stripe",
            "figma",
            "notion",
            "slack",
            "zoom",
            "netflix",
            "spotify",
            "youtube",
            "adobe",
            "microsoft",
            "apple.com",
            "icloud",
            "cursor",
            "netlify",
            "cloudflare",
        ),
    ),
    (
        "utilities",
        (
            "electricity",
            "bescom",
            "airtel",
            "jio",
            "vodafone",
            "vi ",
            "act fibernet",
            "broadband",
            "internet",
            "gas",
            "water",
            "mobile recharge",
            "postpaid",
            "insurance",
            "state farm",
            "lic",
        ),
    ),
    (
        "health",
        (
            "pharmacy",
            "apollo",
            "1mg",
            "pharmeasy",
            "hospital",
            "clinic",
            "doctor",
            "lab",
            "diagnostics",
            "practo",
            "health",
            "medical",
        ),
    ),
    (
        "finance",
        (
            "bank",
            "hdfc",
            "icici",
            "sbi",
            "axis",
            "kotak",
            "amex",
            "citibank",
            "chase",
            "paypal",
            "razorpay",
            "cashfree",
            "zerodha",
            "groww",
            "mutual fund",
            "emi",
            "loan",
        ),
    ),
)

_BAD_REF_WORDS = frozenset(
    {
        "YOUR",
        "THE",
        "FOR",
        "FROM",
        "WITH",
        "THAT",
        "THIS",
        "DATE",
        "PAID",
        "TOTAL",
        "RECEIPT",
        "INVOICE",
        "ORDER",
        "SUMMARY",
        "DETAILS",
        "CONFIRMATION",
        "NOTIFICATION",
        "PAYMENT",
        "PENDING",
        "STATUS",
        "HERE",
        "BELOW",
        "ATTACHED",
    }
)


def _normalize_currency(raw: str | None) -> str | None:
    if not raw:
        return None
    return _CURRENCY_SYMBOL_MAP.get(raw.strip().lower())


def _parse_decimal(raw: str) -> Decimal | None:
    cleaned = raw.replace(",", "").strip()
    try:
        val = Decimal(cleaned)
    except (InvalidOperation, ValueError):
        return None
    if not val.is_finite() or val < Decimal("0") or val > Decimal("1000000000"):
        return None
    return val.quantize(Decimal("0.01"))


def _extract_primary_amount(text: str) -> tuple[Decimal | None, str | None, str | None]:
    """Extract the most authoritative (amount, currency, quote) from email text."""
    # 1. Prefer explicitly labelled totals ("Total paid: $1.00", "Amount due: ₹1,200")
    for match in _TOTAL_LABEL_RE.finditer(text):
        cur = _normalize_currency(match.group("cur") or match.group("cur_after"))
        if not cur:
            continue
        amt = _parse_decimal(match.group("num"))
        if amt is not None and amt > Decimal("0"):
            return amt, cur, match.group(0).strip()[:80]

    # 2. Prefix currency matches ("$1.00 USD", "₹499", "INR 6,97,112.02")
    prefix_hits: list[tuple[Decimal, str, str]] = []
    for match in _AMOUNT_PREFIX_RE.finditer(text):
        cur = _normalize_currency(match.group("cur_after") or match.group("cur"))
        amt = _parse_decimal(match.group("num"))
        if cur and amt is not None and amt > Decimal("0"):
            prefix_hits.append((amt, cur, match.group(0).strip()[:80]))
    if prefix_hits:
        return prefix_hits[0]

    # 3. Suffix currency matches ("1.00 USD", "500 INR")
    for match in _AMOUNT_SUFFIX_RE.finditer(text):
        cur = _normalize_currency(match.group("cur"))
        amt = _parse_decimal(match.group("num"))
        if cur and amt is not None and amt > Decimal("0"):
            return amt, cur, match.group(0).strip()[:80]

    return None, None, None


def _infer_merchant(sender: str, subject: str) -> str:
    cleaned_sender = re.sub(r"\s*<[^>]+>", "", str(sender or "")).strip().strip("\"'")
    if cleaned_sender and "@" in cleaned_sender:
        domain = cleaned_sender.split("@", 1)[-1].split(">")[0].strip().lower()
        parts = [
            p
            for p in domain.split(".")
            if p
            not in {
                "mail",
                "email",
                "noreply",
                "no-reply",
                "billing",
                "receipts",
                "support",
                "info",
                "notifications",
                "com",
                "co",
                "in",
                "org",
                "net",
                "io",
            }
        ]
        if parts:
            return parts[0] if "." in parts[0] else domain
    if cleaned_sender and cleaned_sender.lower() not in {
        "noreply",
        "no-reply",
        "billing",
        "receipts",
        "support",
        "notifications",
    }:
        return cleaned_sender[:80]
    sub = _SUBJECT_PREFIX_RE.sub("", str(subject or "")).strip()
    return sub[:60] or "Unknown merchant"


def _infer_category(merchant: str, subject: str, snippet: str) -> str:
    haystack = f"{merchant} {subject} {snippet}".lower()
    for category, keywords in _CATEGORY_KEYWORDS:
        if any(kw in haystack for kw in keywords):
            return category
    return "other"


def _extract_reference_id(text: str) -> str | None:
    for match in _REF_ID_RE.finditer(text):
        candidate = match.group("val").strip(".,;:()[]{}")
        if len(candidate) < 4 or candidate.upper() in _BAD_REF_WORDS:
            continue
        if not any(ch.isdigit() for ch in candidate):
            continue
        return candidate[:40]
    # Also catch `#1950-0550` style Stripe/Hushh receipt numbers directly
    hash_match = re.search(r"#([0-9]{3,6}-[0-9]{3,6})\b", text)
    if hash_match:
        return hash_match.group(1)
    return None


def _extract_payment_method(text: str) -> str | None:
    card = _CARD_LAST4_RE.search(text)
    if card:
        return f"Card ending in {card.group(1)}"
    upi = _UPI_RE.search(text)
    if upi:
        return upi.group(0).upper() if len(upi.group(0)) <= 4 else upi.group(0).title()
    return None


def _has_parseable_attachment(attachments: Sequence[Any]) -> bool:
    for att in attachments:
        if isinstance(att, Mapping):
            name = str(att.get("filename") or "").lower()
            mime = str(att.get("mime_type") or "").lower()
        else:
            name = str(att or "").lower()
            mime = ""
        if name.endswith((".pdf", ".csv")) or mime in {
            "application/pdf",
            "text/csv",
            "application/csv",
        }:
            return True
    return False


def extract_receipt_record(
    item: Mapping[str, Any],
    *,
    ordinal: int,
    timezone_name: str = "UTC",
) -> dict[str, Any] | None:
    """Classify and extract a structured receipt/invoice record from one email.

    Returns ``None`` if the email is clearly promotional/non-financial noise.
    """
    subject = str(item.get("subject") or "")
    sender = str(item.get("sender") or "")
    snippet = str(item.get("snippet") or "")
    body = str(item.get("body") or "")
    attachments = list(item.get("attachments") or [])
    combined = "\n".join(part for part in (subject, snippet, body[:6000]) if part)
    header_plus_snippet = f"{subject}\n{snippet}"

    has_financial = bool(_FINANCIAL_SIGNAL_RE.search(combined))
    amount, currency, amount_quote = _extract_primary_amount(combined)
    has_pdf_csv = _has_parseable_attachment(attachments)

    if not has_financial and amount is None:
        return None
    if _NOISE_PROMO_RE.search(header_plus_snippet) and amount is None and not has_pdf_csv:
        return None

    # Classify kind accurately — inward credits & refunds must NEVER inflate spend!
    is_inward = bool(_INWARD_CREDIT_RE.search(combined))
    is_refund = bool(_REFUND_RE.search(header_plus_snippet)) or (
        bool(_REFUND_RE.search(combined)) and not is_inward and "refund" in combined.lower()[:500]
    )
    is_paid = bool(_PAID_CONFIRM_RE.search(combined))
    is_pending = bool(_PENDING_INVOICE_RE.search(combined))
    is_statement = bool(_STATEMENT_RE.search(header_plus_snippet))

    if is_inward:
        kind = "inward_credit"
    elif is_refund:
        kind = "refund"
    elif is_pending and not is_paid:
        kind = "pending_invoice"
    elif is_statement and not is_paid:
        kind = "statement"
    elif is_paid or amount is not None:
        kind = "paid_receipt"
    else:
        kind = "order_update"

    tax_amount: Decimal | None = None
    tax_currency: str | None = None
    tax_match = _TAX_RE.search(combined)
    if tax_match:
        parsed_tax = _parse_decimal(tax_match.group("num"))
        if parsed_tax is not None and parsed_tax > Decimal("0"):
            tax_amount = parsed_tax
            tax_currency = _normalize_currency(tax_match.group("cur")) or currency

    due_match = _DUE_DATE_RE.search(combined)
    due_date = due_match.group(1).strip() if due_match else None

    merchant = _infer_merchant(sender, subject)
    category = _infer_category(merchant, subject, snippet)
    ref_id = _extract_reference_id(combined)
    payment_method = _extract_payment_method(combined)

    iso_local, display_local, date_local = format_local_timestamp(
        item.get("received_at"), timezone_name
    )

    needs_body_hydration = not body and (
        amount is None or kind in {"pending_invoice", "order_update"} or (is_pending and is_paid)
    )
    unresolved_attachment = amount is None and has_pdf_csv

    record: dict[str, Any] = {
        "source_ref": f"mail:{ordinal}",
        "ordinal": ordinal,
        "kind": kind,
        "merchant": merchant,
        "sender": sender,
        "subject": subject,
        "category": category,
        "received_at": iso_local or item.get("received_at"),
        "received_at_local": display_local or item.get("received_at_local"),
        "date_local": date_local,
        "month_local": date_local[:7] if date_local else None,
        "amount": str(amount) if amount is not None else None,
        "currency": currency,
        "amount_quote": amount_quote,
        "reference_id": ref_id,
        "payment_method": payment_method,
        "due_date": due_date,
        "tax_amount": str(tax_amount) if tax_amount is not None else None,
        "tax_currency": tax_currency,
        "attachments": attachments,
        "needs_body_hydration": needs_body_hydration,
        "unresolved_attachment": unresolved_attachment,
    }
    return record


def aggregate_receipt_scan(
    records: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """Deterministically deduplicate transactions and compute multi-currency totals."""
    dedup_seen: dict[tuple[str, str, str, str], str] = {}
    unique_records: list[dict[str, Any]] = []
    duplicates: list[dict[str, Any]] = []

    for rec in records:
        item = dict(rec)
        amt = item.get("amount")
        cur = item.get("currency")
        merchant_key = _norm_key_text(item.get("merchant"))
        ref_id = _norm_key_text(item.get("reference_id"))
        day = str(item.get("date_local") or "")
        kind = str(item.get("kind") or "")
        # Deduplicate exact same transaction (same ref_id + amount + currency + kind,
        # OR same merchant + amount + currency + kind + exact same day when subject matches).
        tx_key: tuple[str, str, str, str] | None = None
        if amt and cur and ref_id:
            tx_key = (kind, cur, str(amt), f"ref:{ref_id}")
        elif amt and cur and merchant_key and day:
            subj_norm = _SUBJECT_PREFIX_RE.sub("", _norm_key_text(item.get("subject")))
            tx_key = (kind, cur, str(amt), f"{merchant_key}|{day}|{subj_norm[:60]}")

        if tx_key and tx_key in dedup_seen:
            duplicates.append(
                {
                    "source_ref": item.get("source_ref"),
                    "duplicate_of": dedup_seen[tx_key],
                    "merchant": item.get("merchant"),
                    "amount": amt,
                    "currency": cur,
                    "reference_id": item.get("reference_id"),
                }
            )
            continue
        if tx_key:
            dedup_seen[tx_key] = str(item.get("source_ref") or "")
        unique_records.append(item)

    totals_by_currency: dict[str, dict[str, Any]] = {}
    merchant_spend: dict[tuple[str, str], Decimal] = defaultdict(lambda: Decimal("0.00"))
    merchant_counts: dict[tuple[str, str], int] = defaultdict(int)
    month_spend: dict[tuple[str, str], Decimal] = defaultdict(lambda: Decimal("0.00"))
    category_spend: dict[tuple[str, str], Decimal] = defaultdict(lambda: Decimal("0.00"))

    paid_items: list[dict[str, Any]] = []
    refund_items: list[dict[str, Any]] = []
    pending_invoices: list[dict[str, Any]] = []
    inward_credits: list[dict[str, Any]] = []
    other_items: list[dict[str, Any]] = []
    unresolved_attachments: list[dict[str, Any]] = []

    def _bucket(cur: str) -> dict[str, Any]:
        if cur not in totals_by_currency:
            totals_by_currency[cur] = {
                "gross_spend": Decimal("0.00"),
                "refunds": Decimal("0.00"),
                "net_spend": Decimal("0.00"),
                "pending_invoices_total": Decimal("0.00"),
                "inward_credits_excluded": Decimal("0.00"),
                "paid_count": 0,
                "refund_count": 0,
                "pending_invoice_count": 0,
                "inward_credit_count": 0,
            }
        return totals_by_currency[cur]

    for item in unique_records:
        kind = item["kind"]
        amt = _parse_decimal(str(item["amount"])) if item.get("amount") else None
        cur = str(item.get("currency") or "")
        if item.get("unresolved_attachment"):
            unresolved_attachments.append(
                {
                    "source_ref": item["source_ref"],
                    "ordinal": item["ordinal"],
                    "merchant": item["merchant"],
                    "subject": item["subject"],
                    "attachments": item["attachments"],
                }
            )

        if kind == "paid_receipt":
            paid_items.append(item)
            if amt is not None and cur:
                b = _bucket(cur)
                b["gross_spend"] += amt
                b["paid_count"] += 1
                merchant_spend[(item["merchant"], cur)] += amt
                merchant_counts[(item["merchant"], cur)] += 1
                if item.get("month_local"):
                    month_spend[(str(item["month_local"]), cur)] += amt
                category_spend[(item["category"], cur)] += amt
        elif kind == "refund":
            refund_items.append(item)
            if amt is not None and cur:
                b = _bucket(cur)
                b["refunds"] += amt
                b["refund_count"] += 1
                merchant_spend[(item["merchant"], cur)] -= amt
                if item.get("month_local"):
                    month_spend[(str(item["month_local"]), cur)] -= amt
                category_spend[(item["category"], cur)] -= amt
        elif kind == "pending_invoice":
            pending_invoices.append(item)
            if amt is not None and cur:
                b = _bucket(cur)
                b["pending_invoices_total"] += amt
                b["pending_invoice_count"] += 1
        elif kind == "inward_credit":
            inward_credits.append(item)
            if amt is not None and cur:
                b = _bucket(cur)
                b["inward_credits_excluded"] += amt
                b["inward_credit_count"] += 1
        else:
            other_items.append(item)

    formatted_totals: dict[str, dict[str, Any]] = {}
    for cur, b in sorted(totals_by_currency.items()):
        net = b["gross_spend"] - b["refunds"]
        formatted_totals[cur] = {
            "gross_spend": str(b["gross_spend"].quantize(Decimal("0.01"))),
            "refunds": str(b["refunds"].quantize(Decimal("0.01"))),
            "net_spend": str(net.quantize(Decimal("0.01"))),
            "pending_invoices_total": str(b["pending_invoices_total"].quantize(Decimal("0.01"))),
            "inward_credits_excluded": str(b["inward_credits_excluded"].quantize(Decimal("0.01"))),
            "paid_count": b["paid_count"],
            "refund_count": b["refund_count"],
            "pending_invoice_count": b["pending_invoice_count"],
            "inward_credit_count": b["inward_credit_count"],
        }

    by_merchant = [
        {
            "merchant": merchant,
            "currency": cur,
            "net_spend": str(total.quantize(Decimal("0.01"))),
            "count": merchant_counts[(merchant, cur)],
        }
        for (merchant, cur), total in sorted(
            merchant_spend.items(), key=lambda kv: kv[1], reverse=True
        )
    ]
    by_month = [
        {"month": month, "currency": cur, "net_spend": str(total.quantize(Decimal("0.01")))}
        for (month, cur), total in sorted(month_spend.items(), key=lambda kv: kv[0], reverse=True)
    ]
    by_category = [
        {"category": cat, "currency": cur, "net_spend": str(total.quantize(Decimal("0.01")))}
        for (cat, cur), total in sorted(category_spend.items(), key=lambda kv: kv[1], reverse=True)
    ]

    return {
        "totals_by_currency": formatted_totals,
        "receipt_count": len(paid_items) + len(refund_items),
        "paid_count": len(paid_items),
        "refund_count": len(refund_items),
        "pending_invoice_count": len(pending_invoices),
        "inward_credit_count": len(inward_credits),
        "duplicate_transactions_collapsed": len(duplicates),
        "duplicates": duplicates[:15],
        "by_merchant": by_merchant[:25],
        "by_month": by_month[:18],
        "by_category": by_category[:15],
        "pending_invoices": pending_invoices[:25],
        "inward_credits": inward_credits[:15],
        "unresolved_attachments": unresolved_attachments[:20],
        "items": unique_records,
    }


# ---------------------------------------------------------------------------
# Security, Auth & Encryption header analysis (SPF / DKIM / DMARC / S/MIME / TLS)
# ---------------------------------------------------------------------------

_AUTH_VERDICT_RE = re.compile(r"\b(spf|dkim|dmarc)\s*=\s*([a-z0-9_-]+)", re.IGNORECASE)
_EMAIL_ADDR_RE = re.compile(r"([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})")


def _domain_of(header_val: str) -> str:
    match = _EMAIL_ADDR_RE.search(str(header_val or ""))
    if not match:
        return ""
    return match.group(1).split("@", 1)[-1].lower()


def parse_auth_and_security_headers(
    headers: Mapping[str, str],
    *,
    received_headers: Sequence[str] = (),
) -> dict[str, Any]:
    """Parse SPF/DKIM/DMARC, Reply-To/Return-Path mismatches, TLS & S/MIME signals."""
    lower = {k.lower(): v for k, v in headers.items()}
    auth_raw = lower.get("authentication-results", "") or lower.get(
        "arc-authentication-results", ""
    )
    verdicts: dict[str, str] = {}
    for proto, status in _AUTH_VERDICT_RE.findall(auth_raw):
        verdicts.setdefault(proto.lower(), status.lower())
    if "spf" not in verdicts and lower.get("received-spf"):
        first_word = lower["received-spf"].strip().split()[0].lower()
        verdicts["spf"] = first_word

    from_domain = _domain_of(lower.get("from", ""))
    reply_to_domain = _domain_of(lower.get("reply-to", ""))
    return_path_domain = _domain_of(lower.get("return-path", ""))

    warnings: list[str] = []
    for proto in ("spf", "dkim", "dmarc"):
        if verdicts.get(proto) in {"fail", "softfail", "permerror", "temperror"}:
            warnings.append(f"{proto.upper()} check returned '{verdicts[proto]}'")
    if reply_to_domain and from_domain and reply_to_domain != from_domain:
        warnings.append(
            f"Reply-To domain ({reply_to_domain}) differs from From domain ({from_domain})"
        )

    content_type = lower.get("content-type", "").lower()
    smime_signed = "multipart/signed" in content_type or "pkcs7-signature" in content_type
    smime_encrypted = "pkcs7-mime" in content_type or "application/x-pkcs7-mime" in content_type
    tls_hops = sum(1 for hop in received_headers if "tls" in hop.lower() or "esmtps" in hop.lower())

    return {
        "spf": verdicts.get("spf", "unknown"),
        "dkim": verdicts.get("dkim", "unknown"),
        "dmarc": verdicts.get("dmarc", "unknown"),
        "from_domain": from_domain or None,
        "reply_to_domain": reply_to_domain or None,
        "return_path_domain": return_path_domain or None,
        "tls_encrypted_hops": tls_hops,
        "smime_signed": smime_signed,
        "smime_encrypted": smime_encrypted,
        "has_list_unsubscribe": bool(lower.get("list-unsubscribe")),
        "list_unsubscribe": (lower.get("list-unsubscribe") or "")[:300] or None,
        "risk_warnings": warnings,
    }
