"""Bounded evidence for the Receipts "One noticed" reasoning.

Pure and import-safe. Turns already-read Gmail messages into small, numbered
evidence items: exact money, dates, order and transaction references, and the
billing rhythm are computed here by ordinary code. The model is only asked to
judge what the evidence means; it never does arithmetic and never sees a raw
provider identifier. Every string that came from mail is untrusted data.
"""

from __future__ import annotations

import re
import statistics
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import getaddresses
from typing import Any

from hushh_mcp.services.gmail_receipt_amounts import NUMBER, receipt_currency

MAX_PROVIDERS = 6
MAX_MESSAGES_PER_PROVIDER = 10
SHOWN_TEXT_CHARS = 1_600
_HEAD_CHARS = 700
_WINDOW = 150

# Words that mark the passage a reasoning step needs: usage, refunds, price
# changes, renewals and cancellations. The head of a long marketing email can
# hide them, so the visible text is the head plus these windows.
_SALIENT = re.compile(
    r"(refund|credit(?:ed)?|reimburs|haven.t|hasn.t|not (?:watched|used|logged|opened|played|streamed)"
    r"|inactive|no activity|last (?:watched|used|login|active)|we miss you|come back|welcome back"
    r"|price|increase|will (?:be|go)|effective|renew|next (?:bill|payment|charge)|cancel|"
    r"per month|a month|monthly|yearly|annual|per year|\b\d+\s*(?:days?|weeks?|months?)\b)",
    re.I,
)
_AMOUNT = re.compile(
    r"(?:(?P<code1>INR|USD|EUR|GBP)\s*)?(?P<symbol>[₹€£$]|Rs\.?)\s*(?P<num>"
    + NUMBER
    + r")(?![0-9])"
    r"(?:\s*(?P<code2>INR|USD|EUR|GBP))?"
    r"|(?P<code3>INR|USD|EUR|GBP)\s*(?P<num3>" + NUMBER + r")(?![0-9])",
    re.I,
)
_ORDER_REF = re.compile(
    r"\b(?:order|invoice|receipt)(?:\s*(?:id|no|number)\b\s*[:#-]?\s*|\s*[#:.-]\s*)"
    r"((?!(?:order|invoice|receipt|confirmation|confirmed)\b)(?=[A-Z0-9._/-]*\d)[A-Z0-9][A-Z0-9._/-]{3,79})\b",
    re.I,
)
_TXN_REF = re.compile(
    r"\b(?:transaction|txn|payment|reference|ref)(?:\s*(?:id|no|number)\b\s*[:#-]?\s*|\s*[#:.-]\s*)"
    r"((?!(?:id|no|number|confirmation|confirmed|received|successful|method)\b)"
    r"(?=[A-Z0-9._/-]*\d)[A-Z0-9][A-Z0-9._/-]{3,79})\b",
    re.I,
)
_GREETING = re.compile(r"\s*(?:hi|hello|dear|hey)[, ]+([a-z][a-z'-]{1,20})", re.I)
_PLAN_NAME = re.compile(
    r"\b([a-z0-9+]+(?: [a-z0-9+]+){0,2}) (?:plan|membership|subscription|tier)\b"
)
_PLAN_NOISE = frozenset(
    {
        "your",
        "this",
        "the",
        "a",
        "an",
        "our",
        "new",
        "monthly",
        "annual",
        "yearly",
        "paid",
        "free",
        "current",
        "active",
        "of",
        "to",
        "for",
        "and",
        "on",
        "in",
        "my",
        "its",
        "that",
        "these",
        "those",
        "same",
        "one",
        "any",
        "each",
        "every",
        "cancel",
        "manage",
        "change",
        "update",
        "renew",
        "renewal",
        "with",
        "from",
        "is",
        "are",
        "was",
        "will",
        "be",
        "has",
        "have",
    }
)
_SUBJECT_REFUND = re.compile(r"\brefund", re.I)
_SUBJECT_CANCEL = re.compile(
    r"\b(cancel(?:led|ed|lation)|(?:subscription|membership|plan)\s+(?:has\s+)?ended|terminated)\b",
    re.I,
)
_PAID_SUBJECT = re.compile(
    r"\b(receipt|invoice|payment|paid|renew(?:al|ed)|charged|billing|order|purchase|subscription)\b",
    re.I,
)
# Second-level public suffixes whose registrable domain keeps three labels.
_TWO_LEVEL = frozenset({"co.in", "co.uk", "com.au", "co.nz", "co.jp", "com.br", "co.za", "com.sg"})

_QUOTES = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-"})


def norm(text: str) -> str:
    """Case, quote and whitespace-insensitive form used to check a quote against its source."""

    return " ".join(text.translate(_QUOTES).replace(" ", " ").casefold().split())


def registrable_domain(domain: str) -> str:
    labels = domain.lower().strip(".").split(".")
    if len(labels) <= 2:
        return ".".join(labels)
    return ".".join(labels[-3:] if ".".join(labels[-2:]) in _TWO_LEVEL else labels[-2:])


@dataclass(frozen=True)
class Money:
    minor: int
    currency: str

    def major(self) -> str:
        return f"{self.minor // 100}.{self.minor % 100:02d}"


def to_minor(number: str) -> int | None:
    cleaned = number.replace(",", "")
    whole, _, fraction = cleaned.partition(".")
    if not whole.isdigit() or (fraction and not fraction.isdigit()):
        return None
    return int(whole) * 100 + int((fraction + "00")[:2])


def find_amounts(text: str, limit: int = 12) -> list[tuple[Money, str]]:
    """Every explicit money amount with its surrounding words, as (amount, quote)."""

    found: list[tuple[Money, str]] = []
    for match in _AMOUNT.finditer(text):
        number = match.group("num") or match.group("num3") or ""
        currency = receipt_currency(
            match.group("code1") or match.group("code3"),
            match.group("symbol"),
            match.group("code2"),
        )
        minor = to_minor(number)
        if not currency or minor is None:
            continue
        start, end = max(0, match.start() - 40), min(len(text), match.end() + 40)
        item = (Money(minor, currency.upper()), " ".join(text[start:end].split()))
        if item[0] not in [amount for amount, _ in found]:
            found.append(item)
        if len(found) >= limit:
            break
    return found


def salient_text(text: str, limit: int = SHOWN_TEXT_CHARS) -> str:
    """The head of the message plus the passages that matter, in order, within ``limit``."""

    flat = " ".join(text.replace("\x00", " ").split())
    if len(flat) <= limit:
        return flat
    spans: list[tuple[int, int]] = [(0, _HEAD_CHARS)]
    for match in _SALIENT.finditer(flat, _HEAD_CHARS):
        spans.append((max(0, match.start() - _WINDOW), min(len(flat), match.end() + _WINDOW)))
    merged: list[list[int]] = []
    for start, end in sorted(spans):
        if merged and start <= merged[-1][1] + 1:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    pieces: list[str] = []
    used = 0
    for start, end in merged:
        piece = flat[start:end]
        room = limit - used
        if room <= 0:
            break
        pieces.append(piece[:room])
        used += len(pieces[-1]) + 3
    return " … ".join(pieces)[:limit]


@dataclass(frozen=True)
class NoticeMessage:
    eid: str
    pid: str
    message_id: str
    thread_id: str | None
    at: datetime
    domain: str
    root: str
    sender_name: str
    subject: str
    text: str
    amounts: tuple[tuple[Money, str], ...]
    paid: Money | None
    orders: tuple[str, ...]
    refs: tuple[str, ...]
    is_refund_subject: bool
    is_cancel_subject: bool
    is_receipt: bool
    # Who the mail was addressed to, how it greeted them, and which plan it names: what lets code tell
    # "this account and this plan" from another profile or another plan of the same provider.
    recipients: frozenset[str] = frozenset()
    greeting: str | None = None
    plan_tokens: frozenset[str] = frozenset()

    @property
    def haystack(self) -> str:
        return norm(f"{self.subject}\n{self.text}")

    def has_amount(self, money: Money) -> bool:
        return any(amount == money for amount, _ in self.amounts)


def _refs(pattern: re.Pattern[str], text: str) -> tuple[str, ...]:
    seen: list[str] = []
    for match in pattern.finditer(text):
        value = match.group(1).upper().strip(".-/")
        if value and value not in seen:
            seen.append(value)
        if len(seen) >= 6:
            break
    return tuple(seen)


def _recipients(headers: dict[str, str]) -> frozenset[str]:
    found = {
        address.lower()
        for _name, address in getaddresses([headers.get("to", ""), headers.get("delivered-to", "")])
        if address and "@" in address
    }
    return frozenset(found)


def _plan_tokens(haystack: str) -> frozenset[str]:
    tokens: set[str] = set()
    for match in _PLAN_NAME.finditer(haystack):
        tokens.update(
            word for word in match.group(1).split() if word not in _PLAN_NOISE and len(word) > 1
        )
    return frozenset(tokens)


def _greeting(body: str) -> str | None:
    match = _GREETING.match(body)
    return match.group(1).lower() if match else None


def build_notice_message(
    *,
    raw: dict[str, Any],
    evidence: dict[str, Any],
    iso_date: str | None,
    preferred_total: Any,
    eid: str,
    pid: str,
    message_id: str,
) -> NoticeMessage | None:
    """One message as bounded evidence, or ``None`` when it has no usable date or sender."""

    domain = evidence.get("sender_domain")
    if not isinstance(domain, str) or not domain or not iso_date:
        return None
    try:
        at = datetime.fromisoformat(iso_date)
    except ValueError:
        return None
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    at = at.astimezone(timezone.utc)
    subject = " ".join(str(evidence.get("subject") or "").split())[:240]
    body = str(evidence.get("body") or evidence.get("email_body") or "")
    whole = f"{subject}\n{body}"
    is_refund = bool(_SUBJECT_REFUND.search(subject))
    is_cancel = bool(_SUBJECT_CANCEL.search(subject))
    is_receipt = bool(evidence.get("receipt_signals")) or bool(_PAID_SUBJECT.search(subject))
    paid: Money | None = None
    total = preferred_total(evidence.get("total_candidates") or [])
    if total and is_receipt and not is_refund and not is_cancel:
        minor = to_minor(f"{float(total['amount']):.2f}")
        currency = str(total.get("currency") or "").upper()
        if minor is not None and currency:
            paid = Money(minor, currency)
    sender = " ".join(str(evidence.get("from_name") or "").split())[:60]
    merchant = evidence.get("verified_merchant")
    if not sender and isinstance(merchant, dict):
        sender = str(merchant.get("name") or "")[:60]
    return NoticeMessage(
        eid=eid,
        pid=pid,
        message_id=message_id,
        thread_id=raw.get("threadId") if isinstance(raw.get("threadId"), str) else None,
        at=at,
        domain=domain,
        root=registrable_domain(domain),
        sender_name=sender,
        subject=subject,
        text=salient_text(body),
        amounts=tuple(find_amounts(whole)),
        paid=paid,
        orders=_refs(_ORDER_REF, whole),
        refs=_refs(_TXN_REF, whole),
        is_refund_subject=is_refund,
        is_cancel_subject=is_cancel,
        is_receipt=is_receipt,
        recipients=_recipients(evidence.get("headers") or {}),
        greeting=_greeting(body),
        plan_tokens=_plan_tokens(norm(whole)),
    )


def cadence_of(paid_dates: list[datetime]) -> str:
    """monthly, yearly, weekly, irregular, or unknown (fewer than three payments)."""

    ordered = sorted(paid_dates)
    if len(ordered) < 3:
        return "unknown"
    gaps = [(b - a).days for a, b in zip(ordered, ordered[1:], strict=False)]
    middle = statistics.median(gaps)
    if 26 <= middle <= 35:
        return "monthly"
    if 350 <= middle <= 380:
        return "yearly"
    if 6 <= middle <= 8:
        return "weekly"
    return "irregular"


@dataclass
class Provider:
    pid: str
    root: str
    display: str
    messages: list[NoticeMessage] = field(default_factory=list)

    def paid(self) -> list[NoticeMessage]:
        return sorted((m for m in self.messages if m.paid), key=lambda m: m.at)

    def cadence(self, currency: str | None = None) -> str:
        return cadence_of(
            [m.at for m in self.paid() if currency is None or m.paid.currency == currency]
        )  # type: ignore[union-attr]


@dataclass
class Packet:
    providers: dict[str, Provider]
    now: datetime

    def message(self, eid: str) -> NoticeMessage | None:
        for provider in self.providers.values():
            for item in provider.messages:
                if item.eid == eid:
                    return item
        return None

    def provider_of(self, eid: str) -> Provider | None:
        for provider in self.providers.values():
            if any(item.eid == eid for item in provider.messages):
                return provider
        return None

    def all_messages(self) -> list[NoticeMessage]:
        return [item for provider in self.providers.values() for item in provider.messages]


def _display(messages: list[NoticeMessage], root: str) -> str:
    names = [
        m.sender_name for m in sorted(messages, key=lambda m: m.at, reverse=True) if m.sender_name
    ]
    name = names[0] if names else root.split(".", 1)[0].capitalize()
    for noise in (" via ", " <"):
        name = name.split(noise, 1)[0]
    return name.strip(" \"'") or root


def build_packet(messages: list[NoticeMessage], *, now: datetime) -> Packet:
    """Group by provider, newest first, keeping the bounded set the model may see."""

    by_root: dict[str, list[NoticeMessage]] = {}
    for item in messages:
        by_root.setdefault(item.root, []).append(item)
    ranked = sorted(
        by_root.items(),
        key=lambda pair: (sum(1 for m in pair[1] if m.paid), max(m.at for m in pair[1])),
        reverse=True,
    )[:MAX_PROVIDERS]
    providers: dict[str, Provider] = {}
    for index, (root, items) in enumerate(ranked, start=1):
        ordered = sorted(items, key=lambda m: m.at, reverse=True)
        keep = [m for m in ordered if m.paid][:5] + [m for m in ordered if not m.paid]
        keep = sorted(keep, key=lambda m: m.at, reverse=True)[:MAX_MESSAGES_PER_PROVIDER]
        pid = f"p{index}"
        providers[pid] = Provider(pid, root, _display(items, root), keep)
    return Packet(providers, now)


def model_payload(packet: Packet, prior: list[dict[str, Any]]) -> dict[str, Any]:
    """The JSON the model reads. Mail text is data; the schema tells it so again."""

    providers: list[dict[str, Any]] = []
    threads: dict[str, str] = {}
    for provider in packet.providers.values():
        history = [
            {
                "id": m.eid,
                "on": m.at.date().isoformat(),
                "amount": m.paid.major(),
                "currency": m.paid.currency,
            }
            for m in provider.paid()[-8:]
            if m.paid
        ]
        providers.append(
            {
                "provider_id": provider.pid,
                "name": provider.display,
                "domain": provider.root,
                "billing_rhythm": provider.cadence(),
                "paid_history": history,
                "messages": [
                    {
                        "id": m.eid,
                        "on": m.at.date().isoformat(),
                        "subject": m.subject,
                        "paid": {"amount": m.paid.major(), "currency": m.paid.currency}
                        if m.paid
                        else None,
                        "amounts_mentioned": [
                            {"amount": amount.major(), "currency": amount.currency}
                            for amount, _ in m.amounts[:6]
                        ],
                        "order_refs": list(m.orders),
                        "transaction_refs": list(m.refs),
                        "thread": threads.setdefault(m.thread_id, f"t{len(threads) + 1}")
                        if m.thread_id
                        else None,
                        "text": m.text,
                    }
                    for m in provider.messages
                ],
            }
        )
    return {
        "today": packet.now.date().isoformat(),
        "providers": providers,
        "prior_findings": prior[:12],
    }
