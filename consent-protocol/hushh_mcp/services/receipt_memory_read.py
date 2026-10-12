"""Deterministic read of the owner's saved receipt memory.

Receipts canonical data -> encrypted PKM -> Email Agent -> One Chat response.

The browser derives a bounded transaction index from the same canonical rows
that Mail > Receipts shows. The owner saves it into the encrypted
``shopping.receipts_memory`` branch with the owner-confirmed
``gmail_receipt_memory_save_button`` writer. This server never holds the vault
key, so for one typed chat turn the device sends the decrypted index beside the
turn; it is held only as an expiring request secret and is never persisted,
logged, or shown to a model.

This module only validates that index, filters it by a plan the Email planner
already chose, pages it, and renders the page. It reads no mailbox, calls no
model, and writes nothing. A question the planner routes here can therefore
never fall through to an inbox search: the worst outcome is "not ready".

Every number, date, status and identifier in an answer is copied from the index
and formatted here. A missing value is omitted, never filled in.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field, replace
from datetime import UTC, date, datetime, timedelta
from typing import Any, Final, Literal
from zoneinfo import ZoneInfo

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)

RECEIPT_INDEX_SCHEMA: Final = "receipt_canonical_index.v1"
RECEIPT_INDEX_MAX_TRANSACTIONS: Final = 100
# Serialized ceiling for one device-supplied index; admission refuses above it.
RECEIPT_INDEX_MAX_BYTES: Final = 96_000
# A saved index older than this is treated as not ready. It mirrors the
# 7-day freshness the retired receipt-memory artifact already published to the
# app (``stale_after_days``), so the product states one number.
RECEIPT_INDEX_STALE_AFTER_DAYS: Final = 7
# A device clock this far ahead of the server is not a fresh save.
_FUTURE_SKEW = timedelta(days=1)
RECEIPT_PAGE_SIZE: Final = 10
RECEIPT_CURSOR_TTL_SECONDS: Final = 30 * 60

NOT_READY_TEXT: Final = "Your receipt memory is not ready yet. Sync and save your receipts in Mail."
# The generated Action Gateway action that opens Mail > Receipts (/one/gmail).
OPEN_RECEIPTS_ACTION_ID: Final = "route.profile_receipts"

ReceiptStatus = Literal[
    "paid",
    "overdue",
    "refunded",
    "cancelled",
    "trial",
    "delivered",
    "payment_failed",
    "suspended",
    "renewal_due",
]
ReceiptIdentifierKind = Literal["order", "invoice", "receipt", "pnr"]
ReceiptCategory = Literal[
    "Shopping",
    "Food",
    "Travel",
    "Transport",
    "Software & Subscriptions",
    "Cloud & Infra",
    "Bills",
    "Uncategorized",
    "Subscription",
    "Other",
]

# The same labels Mail > Receipts shows (lib/profile/gmail-receipt-presentation.ts).
_STATUS_LABELS: Final[dict[str, str]] = {
    "paid": "Paid",
    "overdue": "Overdue",
    "refunded": "Refunded",
    "cancelled": "Cancelled",
    "trial": "Trial",
    "delivered": "Delivered",
    "payment_failed": "Payment failed",
    "suspended": "Service suspended",
    "renewal_due": "Renewal due",
}
# Lower-case adjectives for a header such as "Found 2 overdue receipts".
_STATUS_ADJECTIVES: Final[dict[str, str]] = {
    "paid": "paid",
    "overdue": "overdue",
    "refunded": "refunded",
    "cancelled": "cancelled",
    "trial": "trial",
    "delivered": "delivered",
    "payment_failed": "failed-payment",
    "suspended": "suspended",
    "renewal_due": "renewal-due",
}
_IDENTIFIER_LABELS: Final[dict[str, str]] = {
    "order": "Order",
    "invoice": "Invoice",
    "receipt": "Receipt",
    "pnr": "PNR",
}
_IDENTIFIER_NOUNS: Final[dict[str, tuple[str, str]]] = {
    "order": ("order", "orders"),
    "invoice": ("invoice", "invoices"),
    "receipt": ("receipt", "receipts"),
    "pnr": ("booking", "bookings"),
}
_CURRENCY_SYMBOLS: Final[dict[str, str]] = {
    "USD": "$",
    "$": "$",
    "INR": "₹",
    "EUR": "€",
    "GBP": "£",
}
# Locale-proof month names; strftime follows the process locale.
_MONTHS: Final = (
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
)

_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]")
# Text that came from an email must not smuggle a link or an address into chat.
_LINK_OR_ADDRESS = re.compile(
    r"https?://|www\.|mailto:|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", re.IGNORECASE
)
# Characters that would turn email-derived text into markdown structure.
_MARKDOWN_SIGNIFICANT = str.maketrans(dict.fromkeys("*_`~[]<>\\|", " "))
_IDENTIFIER_VALUE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._\-/#: ]{0,99}")
# A leading list or heading marker would turn a one-line detail into a nested
# list item or a heading inside the answer.
_LEADING_MARKER = re.compile(r"^(?:[-+•·]+\s*|\d+[.)]\s+|#+\s*)+")
_ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


def _plain(value: object, limit: int, *, clip: bool = False) -> str | None:
    """One-line, link-free, markdown-inert text, or ``None`` when nothing safe remains."""
    if not isinstance(value, str):
        return None
    text = " ".join(_CONTROL.sub(" ", value).translate(_MARKDOWN_SIGNIFICANT).split())
    text = _LEADING_MARKER.sub("", text)
    if not text or _LINK_OR_ADDRESS.search(text):
        return None
    if len(text) <= limit:
        return text
    # A clipped merchant would be a different merchant; only prose may be cut.
    return text[: limit - 1].rstrip() + "…" if clip else None


def _parse_instant(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed


def _aware_utc(value: str) -> datetime | None:
    parsed = _parse_instant(value)
    if parsed is None or parsed.tzinfo is None:
        return None
    return parsed.astimezone(UTC)


class ReceiptIdentifier(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    kind: ReceiptIdentifierKind
    value: str = Field(min_length=1, max_length=100)

    @field_validator("value", mode="after")
    @classmethod
    def _value_is_an_identifier(cls, value: str) -> str:
        cleaned = " ".join(value.split())
        if not _IDENTIFIER_VALUE.fullmatch(cleaned):
            raise ValueError("identifier is not a plain code")
        return cleaned


class ReceiptTransaction(BaseModel):
    """One canonical transaction, exactly the fields Mail > Receipts already derived."""

    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    # Opaque and derived on the device; never a provider message or thread id.
    ref: str = Field(pattern=r"^txn_[0-9a-f]{16,64}$")
    merchant: str | None = Field(default=None, max_length=200)
    amount: float | None = Field(default=None, ge=0, le=1e12)
    currency: str | None = Field(default=None, pattern=r"^(?:[A-Z]{3}|\$)$")
    category: ReceiptCategory | None = None
    status: ReceiptStatus | None = None
    transaction_date: str | None = Field(default=None, max_length=40)
    identifiers: list[ReceiptIdentifier] = Field(default_factory=list, max_length=3)
    detail: str | None = Field(default=None, max_length=400)

    @field_validator("merchant", mode="after")
    @classmethod
    def _merchant_is_plain(cls, value: str | None) -> str | None:
        return None if value is None else _plain(value, 80)

    @field_validator("detail", mode="after")
    @classmethod
    def _detail_is_plain(cls, value: str | None) -> str | None:
        return None if value is None else _plain(value, 120, clip=True)

    @field_validator("transaction_date", mode="after")
    @classmethod
    def _date_is_a_date(cls, value: str | None) -> str | None:
        # An unreadable date is dropped, never guessed: the receipt then simply
        # cannot be placed inside a date window.
        if value is None:
            return None
        text = value.strip()
        if _ISO_DATE.fullmatch(text):
            try:
                date.fromisoformat(text)
            except ValueError:
                return None
            return text
        parsed = _parse_instant(text)
        return text if parsed is not None and parsed.tzinfo is not None else None


class ReceiptMemoryIndex(BaseModel):
    """The device-supplied, bounded index saved in ``shopping.receipts_memory``."""

    model_config = ConfigDict(extra="forbid", strict=True, frozen=True, populate_by_name=True)

    schema_id: Literal["receipt_canonical_index.v1"] = Field(alias="schema")
    generated_at: str = Field(max_length=40)
    total_transactions: int = Field(ge=0, le=100_000)
    truncated: bool
    transactions: list[ReceiptTransaction] = Field(
        default_factory=list, max_length=RECEIPT_INDEX_MAX_TRANSACTIONS
    )

    @field_validator("generated_at", mode="after")
    @classmethod
    def _generated_at_is_an_instant(cls, value: str) -> str:
        if _aware_utc(value) is None:
            raise ValueError("generated_at must be an offset-aware instant")
        return value

    @model_validator(mode="after")
    def _counts_are_consistent(self) -> ReceiptMemoryIndex:
        refs = [item.ref for item in self.transactions]
        if len(set(refs)) != len(refs):
            raise ValueError("duplicate transaction ref")
        if self.total_transactions < len(self.transactions):
            raise ValueError("total_transactions is smaller than the stored index")
        if self.truncated != (self.total_transactions > len(self.transactions)):
            raise ValueError("truncated disagrees with the stored index")
        return self

    @property
    def generated_instant(self) -> datetime:
        instant = _aware_utc(self.generated_at)
        if instant is None:  # pragma: no cover - validated at construction
            raise ValueError("generated_at must be an offset-aware instant")
        return instant


def parse_receipt_index(raw: object) -> ReceiptMemoryIndex | None:
    """Validate a device-supplied index. Anything malformed is absent, never repaired."""
    if isinstance(raw, ReceiptMemoryIndex):
        return raw
    if isinstance(raw, str):
        if len(raw.encode("utf-8")) > RECEIPT_INDEX_MAX_BYTES:
            return None
        try:
            raw = json.loads(raw)
        except ValueError:
            return None
    if not isinstance(raw, dict):
        return None
    transactions = raw.get("transactions")
    if isinstance(transactions, list) and len(transactions) > RECEIPT_INDEX_MAX_TRANSACTIONS:
        return None  # refuse before spending effort serializing an oversized body
    try:
        if (
            len(json.dumps(raw, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
            > RECEIPT_INDEX_MAX_BYTES
        ):
            return None
        return ReceiptMemoryIndex.model_validate(raw)
    except (ValidationError, ValueError, TypeError, RecursionError):
        return None


def index_digest(index: ReceiptMemoryIndex) -> str:
    """Short fingerprint of one saved index, so a cursor cannot outlive a new save."""
    material = "|".join(
        [index.generated_at, str(index.total_transactions), *(t.ref for t in index.transactions)]
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]


MemoryState = Literal["ready", "missing", "empty", "stale"]


def memory_state(index: ReceiptMemoryIndex | None, *, now: datetime) -> MemoryState:
    if index is None:
        return "missing"
    if not index.transactions:
        return "empty"
    generated = index.generated_instant
    current = now.astimezone(UTC)
    if generated > current + _FUTURE_SKEW:
        return "stale"
    if current - generated > timedelta(days=RECEIPT_INDEX_STALE_AFTER_DAYS):
        return "stale"
    return "ready"


@dataclass(frozen=True)
class ReceiptQuery:
    """What the planner asked for. Empty means "no such restriction"."""

    since: date | None = None
    until: date | None = None
    statuses: tuple[str, ...] = ()
    identifier_kinds: tuple[str, ...] = ()
    merchant: str = ""
    window_label: str = ""

    @property
    def is_empty(self) -> bool:
        return not (
            self.since
            or self.until
            or self.statuses
            or self.identifier_kinds
            or self.merchant
            or self.window_label
        )


@dataclass(frozen=True)
class ReceiptPlanFields:
    """The Email planner's receipt fields, as written by the model and not yet trusted."""

    since: str = ""
    until: str = ""
    statuses: tuple[str, ...] = ()
    identifier_kinds: tuple[str, ...] = ()
    merchant: str = ""
    window_label: str = ""
    more: bool = False

    @property
    def has_filters(self) -> bool:
        # The window label is the planner's decoration for the header, not a filter.
        return bool(
            self.since or self.until or self.statuses or self.identifier_kinds or self.merchant
        )


class ReceiptPlanError(ValueError):
    """The planner's receipt fields were malformed; the caller refuses the plan."""


def _plan_date(value: str) -> date | None:
    text = value.strip()
    if not text:
        return None
    if not _ISO_DATE.fullmatch(text):
        raise ReceiptPlanError("date must be YYYY-MM-DD")
    try:
        parsed = date.fromisoformat(text)
    except ValueError as exc:
        raise ReceiptPlanError("date is not a calendar date") from exc
    if parsed.year < 2000:
        raise ReceiptPlanError("date is out of range")
    return parsed


def build_query(plan: ReceiptPlanFields) -> ReceiptQuery:
    """Validate the planner's fields into a query. Never widens or narrows them."""
    since = _plan_date(plan.since)
    until = _plan_date(plan.until)
    if since and until and since > until:
        raise ReceiptPlanError("since is after until")
    statuses = tuple(dict.fromkeys(plan.statuses))
    kinds = tuple(dict.fromkeys(plan.identifier_kinds))
    if any(status not in _STATUS_LABELS for status in statuses):
        raise ReceiptPlanError("unknown status")
    if any(kind not in _IDENTIFIER_LABELS for kind in kinds):
        raise ReceiptPlanError("unknown identifier kind")
    merchant = ""
    if plan.merchant.strip():
        merchant = _plain(plan.merchant, 80) or ""
        if not merchant:
            raise ReceiptPlanError("merchant is not plain text")
    # The label is the planner's own words for the window ("the last 2 months").
    # An unusable label is dropped and the header falls back to the dates.
    label = _plain(plan.window_label, 60, clip=True) or "" if plan.window_label.strip() else ""
    if not (since or until):
        # A time phrase with no dates behind it would claim a window that was
        # never applied. The header then names no time at all.
        label = ""
    return ReceiptQuery(
        since=since,
        until=until,
        statuses=statuses,
        identifier_kinds=kinds,
        merchant=merchant,
        window_label=label,
    )


@dataclass(frozen=True)
class _Dated:
    transaction: ReceiptTransaction
    local_date: date | None
    sort_key: float


@dataclass(frozen=True)
class ReceiptSelection:
    matches: tuple[_Dated, ...]
    undated_excluded: int = 0
    oldest_stored: date | None = None


def _locate(transaction: ReceiptTransaction, zone: ZoneInfo) -> tuple[date | None, float]:
    """The owner-local calendar date of a transaction and a newest-first sort key."""
    raw = transaction.transaction_date
    if not raw:
        return None, float("-inf")
    if _ISO_DATE.fullmatch(raw):
        day = date.fromisoformat(raw)
        # A calendar date is not an instant: it never shifts with the zone.
        noon = datetime(day.year, day.month, day.day, 12, tzinfo=zone)
        return day, noon.timestamp()
    instant = _aware_utc(raw)
    if instant is None:
        return None, float("-inf")
    return instant.astimezone(zone).date(), instant.timestamp()


def select_receipts(
    index: ReceiptMemoryIndex, query: ReceiptQuery, zone: ZoneInfo
) -> ReceiptSelection:
    located = [(item, *_locate(item, zone)) for item in index.transactions]
    dated_days = [day for _, day, _ in located if day is not None]
    windowed = query.since is not None or query.until is not None
    merchant = query.merchant.casefold()
    matches: list[_Dated] = []
    undated = 0
    for item, day, key in located:
        if query.statuses and item.status not in query.statuses:
            continue
        if query.identifier_kinds and not any(
            identifier.kind in query.identifier_kinds for identifier in item.identifiers
        ):
            continue
        if merchant and merchant not in (item.merchant or "").casefold():
            continue
        if windowed:
            if day is None:
                undated += 1
                continue
            if query.since and day < query.since:
                continue
            if query.until and day > query.until:
                continue
        matches.append(_Dated(item, day, key))
    matches.sort(key=lambda entry: (-entry.sort_key, entry.transaction.ref))
    return ReceiptSelection(
        matches=tuple(matches),
        undated_excluded=undated,
        oldest_stored=min(dated_days) if dated_days else None,
    )


def _format_day(day: date, today: date) -> str:
    text = f"{_MONTHS[day.month - 1]} {day.day}"
    return text if day.year == today.year else f"{text}, {day.year}"


def format_amount(amount: float | None, currency: str | None) -> str | None:
    """A real currency string, or ``None`` when either half is missing."""
    if amount is None or not currency:
        return None
    symbol = _CURRENCY_SYMBOLS.get(currency)
    return f"{symbol}{amount:,.2f}" if symbol else f"{amount:,.2f} {currency}"


def _title(transaction: ReceiptTransaction) -> str:
    # The same fallback Mail > Receipts uses: merchant, then a specific category.
    if transaction.merchant:
        return transaction.merchant
    category = transaction.category
    if category == "Subscription":
        return "Software & Subscriptions"
    if category and category not in {"Other", "Uncategorized"}:
        return category
    return "Receipt"


def _identifier_text(transaction: ReceiptTransaction) -> str | None:
    seen: set[tuple[str, str]] = set()
    parts: list[str] = []
    for identifier in transaction.identifiers:
        key = (identifier.kind, identifier.value.casefold())
        if key in seen:
            continue
        seen.add(key)
        parts.append(f"{_IDENTIFIER_LABELS[identifier.kind]} {identifier.value}")
        if len(parts) == 2:
            break
    return ". ".join(parts) + "." if parts else None


def _item_lines(entry: _Dated, today: date) -> list[str]:
    transaction = entry.transaction
    meta = [
        format_amount(transaction.amount, transaction.currency),
        _STATUS_LABELS.get(transaction.status or ""),
        _format_day(entry.local_date, today) if entry.local_date else None,
    ]
    head = f"- **{_title(transaction)}**"
    visible = " · ".join(part for part in meta if part)
    if visible:
        head += f" — {visible}"
    detail = transaction.detail
    if detail and not detail.endswith((".", "…", "!", "?")):
        detail += "."
    second = " ".join(part for part in (detail, _identifier_text(transaction)) if part)
    if not second:
        return [head]
    # Two trailing spaces are a Markdown hard break; a bare newline would
    # collapse into the line above in the chat renderer.
    return [f"{head}  ", f"  {second}"]


def _subject(query: ReceiptQuery, plural: bool) -> str:
    kinds = set(query.identifier_kinds)
    if len(kinds) == 1:
        singular, many = _IDENTIFIER_NOUNS[next(iter(kinds))]
    else:
        singular, many = _IDENTIFIER_NOUNS["receipt"]
    noun = many if plural else singular
    adjectives = [_STATUS_ADJECTIVES[status] for status in query.statuses]
    prefix = []
    if query.merchant:
        prefix.append(query.merchant)
    if adjectives:
        prefix.append(" or ".join(adjectives))
    return " ".join([*prefix, noun])


def _scope(query: ReceiptQuery, today: date) -> str:
    if query.window_label:
        return f" {query.window_label}"
    if query.since and query.until:
        return f" from {_format_day(query.since, today)} to {_format_day(query.until, today)}"
    if query.since:
        return f" since {_format_day(query.since, today)}"
    if query.until:
        return f" through {_format_day(query.until, today)}"
    return ""


def _coverage_notes(
    index: ReceiptMemoryIndex, query: ReceiptQuery, selection: ReceiptSelection
) -> list[str]:
    notes: list[str] = []
    if selection.undated_excluded:
        count = selection.undated_excluded
        noun = "receipt has" if count == 1 else "receipts have"
        notes.append(f"{count} saved {noun} no date, so I couldn't place it in that window.")
    reaches_older = selection.oldest_stored is not None and (
        query.since is None or query.since < selection.oldest_stored
    )
    if index.truncated and reaches_older:
        notes.append(
            f"Your receipt memory holds your newest {len(index.transactions)} receipts, "
            "so older ones may be missing."
        )
    return notes


@dataclass(frozen=True)
class ReceiptCursor:
    """Where a receipts list stopped, so "show more" continues the same list."""

    index: str
    next_offset: int
    expires_at: int
    query: ReceiptQuery


def encode_cursor(
    *, index: ReceiptMemoryIndex, next_offset: int, query: ReceiptQuery, now: datetime
) -> str:
    payload = {
        "v": 1,
        "idx": index_digest(index),
        "next": next_offset,
        "exp": int(now.timestamp()) + RECEIPT_CURSOR_TTL_SECONDS,
        "since": query.since.isoformat() if query.since else "",
        "until": query.until.isoformat() if query.until else "",
        "statuses": list(query.statuses),
        "kinds": list(query.identifier_kinds),
        "merchant": query.merchant,
        "label": query.window_label,
    }
    return json.dumps(payload, separators=(",", ":"), sort_keys=True)


def decode_cursor(raw: object, *, index: ReceiptMemoryIndex, now: datetime) -> ReceiptCursor | None:
    """The saved list position, or ``None`` when it is absent, expired or for another save."""
    if not isinstance(raw, str) or not raw.strip() or len(raw) > 2048:
        return None
    try:
        data = json.loads(raw)
        if (
            not isinstance(data, dict)
            or data.get("v") != 1
            or data.get("idx") != index_digest(index)
            or type(data.get("next")) is not int
            or data["next"] < 1
            or type(data.get("exp")) is not int
            or data["exp"] <= int(now.timestamp())
        ):
            return None
        query = build_query(
            ReceiptPlanFields(
                since=str(data.get("since") or ""),
                until=str(data.get("until") or ""),
                statuses=tuple(str(item) for item in data.get("statuses") or ()),
                identifier_kinds=tuple(str(item) for item in data.get("kinds") or ()),
                merchant=str(data.get("merchant") or ""),
                window_label=str(data.get("label") or ""),
            )
        )
    except (ValueError, TypeError, KeyError):
        return None
    return ReceiptCursor(
        index=str(data["idx"]),
        next_offset=int(data["next"]),
        expires_at=int(data["exp"]),
        query=query,
    )


CursorAction = Literal["set", "clear", "keep"]


@dataclass(frozen=True)
class ReceiptReadOutcome:
    text: str
    status: Literal["ok", "input_required"]
    # Absent, never zeroed, when no read happened (see ``_result`` in the caller).
    coverage: dict[str, Any] | None = None
    cursor_action: CursorAction = "clear"
    cursor: str | None = None
    has_more: bool = False
    # Ask One to open Mail > Receipts through the generated gateway action.
    propose_open_receipts: bool = False
    drift: tuple[str, ...] = field(default_factory=tuple)


def _not_ready(state: MemoryState) -> ReceiptReadOutcome:
    return ReceiptReadOutcome(
        text=NOT_READY_TEXT,
        status="input_required",
        cursor_action="clear",
        propose_open_receipts=True,
        drift=(f"receipt_memory_{state}",),
    )


def read_receipt_memory(
    *,
    index_raw: object,
    plan: ReceiptPlanFields,
    cursor_raw: object,
    zone: ZoneInfo,
    now: datetime,
) -> ReceiptReadOutcome:
    """Answer a planned receipts question from the saved index, or say it is not ready."""
    index = parse_receipt_index(index_raw)
    state = memory_state(index, now=now)
    if index is None or state != "ready":
        return _not_ready(state)
    today = now.astimezone(zone).date()

    offset = 0
    if plan.more:
        if plan.has_filters:
            return ReceiptReadOutcome(
                text=(
                    "Tell me which receipts you'd like, for example "
                    "“show my receipts from the last 2 months”."
                ),
                status="input_required",
                cursor_action="keep",
            )
        cursor = decode_cursor(cursor_raw, index=index, now=now)
        if cursor is None:
            return ReceiptReadOutcome(
                text=(
                    "I don't have an earlier receipts list to continue. "
                    "Ask for your receipts and I'll start from the newest."
                ),
                status="input_required",
                cursor_action="clear",
            )
        query, offset = cursor.query, cursor.next_offset
    else:
        query = build_query(plan)

    selection = select_receipts(index, query, zone)
    total = len(selection.matches)
    notes = _coverage_notes(index, query, selection)
    coverage: dict[str, Any] = {
        "operation": "read_receipts",
        "source": "receipt_memory",
        "unit": "receipts",
        "matched": total,
        "offset": offset,
        "returned": 0,
        "plan_source": "planner",
        "memory_generated_at": index.generated_at,
        "memory_truncated": index.truncated,
    }

    if total == 0:
        text = f"I don't see any {_subject(query, True)}{_scope(query, today)} in your saved receipt memory."
        return ReceiptReadOutcome(
            text="\n\n".join([text, *notes]),
            status="ok",
            coverage=coverage,
            cursor_action="clear",
        )
    if offset >= total:
        return ReceiptReadOutcome(
            text="That's everything in your saved receipt memory for this list.",
            status="ok",
            coverage=coverage,
            cursor_action="clear",
        )

    page = selection.matches[offset : offset + RECEIPT_PAGE_SIZE]
    end = offset + len(page)
    has_more = end < total
    coverage["returned"] = len(page)

    # Name a merchant filter the way the merchant's own receipts spell it, so a
    # lower-case "myntra" in the request still reads "Myntra" in the answer.
    spelled = {
        entry.transaction.merchant for entry in selection.matches if entry.transaction.merchant
    }
    heading = (
        replace(query, merchant=next(iter(spelled)))
        if query.merchant and len(spelled) == 1
        else query
    )
    subject = _subject(heading, total != 1)
    scope = _scope(query, today)
    if offset:
        header = f"Showing {offset + 1}–{end} of {total} {subject}{scope}:"
    elif has_more:
        header = f"Found {total} {subject}{scope}. Here are the newest {len(page)}:"
    else:
        header = f"Found {total} {subject}{scope}:"

    blocks: list[str] = [header]
    for entry in page:
        blocks.append("\n".join(_item_lines(entry, today)))
    if has_more:
        blocks.append(f"Say “show more” for the next {min(RECEIPT_PAGE_SIZE, total - end)}.")
    blocks.extend(notes)

    cursor_text = (
        encode_cursor(index=index, next_offset=end, query=query, now=now) if has_more else None
    )
    return ReceiptReadOutcome(
        text="\n\n".join(blocks),
        status="ok",
        coverage=coverage,
        cursor_action="set" if cursor_text else "clear",
        cursor=cursor_text,
        has_more=has_more,
    )


__all__ = [
    "NOT_READY_TEXT",
    "OPEN_RECEIPTS_ACTION_ID",
    "RECEIPT_CURSOR_TTL_SECONDS",
    "RECEIPT_INDEX_MAX_BYTES",
    "RECEIPT_INDEX_MAX_TRANSACTIONS",
    "RECEIPT_INDEX_SCHEMA",
    "RECEIPT_INDEX_STALE_AFTER_DAYS",
    "RECEIPT_PAGE_SIZE",
    "ReceiptCursor",
    "ReceiptIdentifier",
    "ReceiptMemoryIndex",
    "ReceiptPlanError",
    "ReceiptPlanFields",
    "ReceiptQuery",
    "ReceiptReadOutcome",
    "ReceiptSelection",
    "ReceiptTransaction",
    "build_query",
    "decode_cursor",
    "encode_cursor",
    "format_amount",
    "index_digest",
    "memory_state",
    "parse_receipt_index",
    "read_receipt_memory",
    "select_receipts",
]
