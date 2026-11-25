"""Validation and ranking for model-proposed "One noticed" findings.

The model proposes; this module decides what may be shown. A finding survives
only when every cited message exists, every quote is a real passage of its
message, every number in its words is backed by evidence or computed here, and
the kind-specific facts hold. Nothing in a finding is trusted because it sounds
right. Mail text is never an instruction: it can only be quoted back as proof.
"""

from __future__ import annotations

import re
import statistics
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

from hushh_mcp.services.gmail_receipt_notice_evidence import (
    Money,
    NoticeMessage,
    Packet,
    Provider,
    find_amounts,
    norm,
)

KINDS = ("plan_review", "inactive_plan", "refund_followup", "possible_duplicate", "price_rise")
ROLES = (
    "paid",
    "provider_notice",
    "announcement",
    "refund_promise",
    "refund_confirmation",
    "cancellation",
    "charge",
)
ACTIONS = {
    "plan_review": ("review_plans", "Review plans"),
    "inactive_plan": ("review_plan", "Review plan"),
    "refund_followup": ("check_refund", "Check refund"),
    "possible_duplicate": ("compare_charges", "Compare charges"),
    "price_rise": ("review_bill", "Review bill"),
}
RISE_PERCENT = 20
MIN_PLANS = 3
DUPLICATE_DAYS = 3
MAX_FINDINGS = 5

_URL = re.compile(r"https?://|www\.|[\w.+-]+@[\w-]+\.[\w.-]+", re.I)
_INSTRUCTION = re.compile(
    r"\b(cancel (?:it |this |them )?(?:now|today|immediately)|pay now|click (?:here|the link)|"
    r"sign in|log in|ignore (?:previous|prior|all)|you must|confirm now|send)\b",
    re.I,
)
_NUMBER = re.compile(r"\d[\d,]*(?:\.\d+)?")
_DURATION = re.compile(
    r"\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)\s*[- ]?\s*(day|week|month)s?\b",
    re.I,
)
_USAGE = re.compile(
    r"\b(watch|watched|listen|listened|stream|streamed|play|played|log(?:ged)?\s*in|logged|used|use|"
    r"open|opened|visit|visited|active|activity|order|ordered|ride|rode|workout|signed in)\b",
    re.I,
)
_INACTIVITY_CLAIM = re.compile(
    r"\b(haven.t|hasn.t|not (?:watched|used|logged|opened|played|streamed|active)|inactive|"
    r"no activity|stopped (?:using|watching)|unused|never (?:used|watched))\b",
    re.I,
)
_DOUBLE_CLAIM = re.compile(
    r"\b(charged twice|double.charged|duplicate charge|billed twice|twice)\b", re.I
)
_NON_ARRIVAL = re.compile(
    r"\b(never (?:arrived|came|received)|didn.t arrive|hasn.t arrived|not (?:been )?(?:refunded|received|paid)|"
    r"wasn.t refunded|was not refunded|didn.t refund|still owes?|owed to you|you.re owed|stole|scam)\b",
    re.I,
)
_MONTHLY = re.compile(r"\b(per month|a month|/\s*month|/\s*mo\b|monthly|every month)\b", re.I)
_YEARLY = re.compile(
    r"\b(per year|a year|/\s*year|/\s*yr\b|yearly|annual(?:ly)?|every year)\b", re.I
)
_INACTIVITY_CHECKS = (
    "newer_message_considered",
    "other_account_considered",
    "shared_plan_considered",
    "already_cancelled_considered",
)
_WORD_NUMBERS = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
}


class Reject(Exception):
    """A finding that must not be shown, with the reason kept for tests and logs."""


@dataclass
class EvidenceRef:
    message: NoticeMessage
    role: str
    quote: str


@dataclass
class Finding:
    kind: str
    provider: Provider | None
    headline: str
    reason: str
    strength: str
    evidence: list[EvidenceRef]
    key_messages: list[NoticeMessage]
    facts: dict[str, Any]
    plans: list[dict[str, Any]] = field(default_factory=list)
    attribution: dict[str, Any] | None = None
    score: int = 0

    @property
    def action(self) -> tuple[str, str]:
        return ACTIONS[self.kind]


@dataclass
class Validated:
    findings: list[Finding]
    resolved: list[dict[str, Any]]
    rejected: list[dict[str, str]]
    none_reason: str


def _decimal(token: str) -> Decimal | None:
    try:
        return Decimal(token.replace(",", ""))
    except InvalidOperation:
        return None


def _day_numbers(*messages: NoticeMessage, dates: tuple[datetime, ...] = ()) -> set[Decimal]:
    values: set[Decimal] = set()
    for moment in [m.at for m in messages] + list(dates):
        values.update({Decimal(moment.day), Decimal(moment.year), Decimal(moment.year % 100)})
    return values


def _stated_date(value: Any) -> tuple[datetime, ...]:
    """A date the provider stated and the model copied; ignored unless it parses."""

    try:
        return (datetime.fromisoformat(f"{value}T00:00:00+00:00"),)
    except ValueError:
        return ()


def _money_numbers(money: list[Money]) -> set[Decimal]:
    return {Decimal(item.minor) / 100 for item in money}


def _check_numbers(text: str, allowed: set[Decimal]) -> None:
    for token in _NUMBER.findall(text):
        value = _decimal(token)
        if value is None or not any(value == known for known in allowed):
            raise Reject(f"unsupported_number:{token}")


def _check_words(raw: dict[str, Any]) -> tuple[str, str, str]:
    headline = " ".join(str(raw.get("headline") or "").split())
    reason = " ".join(str(raw.get("reason") or "").split())
    strength = raw.get("strength")
    if not 6 <= len(headline) <= 90 or not 10 <= len(reason) <= 200:
        raise Reject("text_length")
    if strength not in ("clear", "question"):
        raise Reject("strength")
    for text in (headline, reason):
        if _URL.search(text) or _INSTRUCTION.search(text):
            raise Reject("instruction_or_link")
    return headline, reason, str(strength)


def _cited(raw: dict[str, Any], packet: Packet) -> list[EvidenceRef]:
    entries = raw.get("evidence")
    if not isinstance(entries, list) or not 1 <= len(entries) <= 8:
        raise Reject("evidence_count")
    refs: list[EvidenceRef] = []
    for entry in entries:
        if not isinstance(entry, dict):
            raise Reject("evidence_shape")
        message = packet.message(str(entry.get("message_id") or ""))
        role, quote = entry.get("role"), " ".join(str(entry.get("quote") or "").split())
        if message is None:
            raise Reject("unknown_message")
        if role not in ROLES:
            raise Reject("unknown_role")
        if not 6 <= len(quote) <= 400 or "…" in quote or norm(quote) not in message.haystack:
            raise Reject("quote_not_in_message")
        refs.append(EvidenceRef(message, str(role), quote))
    return refs


def _by_role(refs: list[EvidenceRef], role: str) -> list[EvidenceRef]:
    return [ref for ref in refs if ref.role == role]


def _same_provider(messages: list[NoticeMessage]) -> None:
    if len({m.root for m in messages}) != 1:
        raise Reject("mixed_providers")


def _active_window(provider: Provider, currency: str) -> int:
    return 400 if provider.cadence(currency) == "yearly" else 45


def _cancelled_after(provider: Provider, moment: datetime) -> bool:
    return any(m.is_cancel_subject and m.at >= moment for m in provider.messages)


def _period(provider: Provider, message: NoticeMessage) -> str:
    """monthly or yearly when the provider's own rhythm or wording says so; otherwise unknown."""

    cadence = provider.cadence(message.paid.currency) if message.paid else "unknown"
    if cadence == "monthly" or _MONTHLY.search(message.haystack):
        return "monthly"
    if cadence == "yearly" or _YEARLY.search(message.haystack):
        return "yearly"
    return "unknown"


def _percent_x10(new: int, base: int) -> int:
    """Rise over base in tenths of a percent, rounded half up, in whole-number arithmetic."""

    return ((new - base) * 2000 + base) // (2 * base)


def _rise_over(new: int, base: int) -> bool:
    return new * 100 > base * (100 + RISE_PERCENT)


def _baseline(earlier: list[Money]) -> tuple[int, str] | None:
    """Fixed bill: the agreed price. Variable bill: median of the last three paid."""

    if len(earlier) < 3:
        return None
    if len({item.minor for item in earlier}) == 1:
        return earlier[-1].minor, "agreed"
    last_three = [item.minor for item in earlier[-3:]]
    return int(statistics.median(last_three)), "median_of_last_three"


# -- one validator per kind -------------------------------------------------


def _inactive(raw, refs, packet, now, strength):
    paid_refs, notices = _by_role(refs, "paid"), _by_role(refs, "provider_notice")
    if not paid_refs or not notices:
        raise Reject("needs_paid_and_notice")
    checks = raw.get("checks") if isinstance(raw.get("checks"), dict) else {}
    if not all(checks.get(name) is True for name in _INACTIVITY_CHECKS):
        raise Reject("checks_not_done")
    _same_provider([ref.message for ref in refs])
    provider = packet.provider_of(refs[0].message.eid)
    paid = max((ref.message for ref in paid_refs), key=lambda m: m.at)
    notice_ref = max(notices, key=lambda ref: ref.message.at)
    notice = notice_ref.message
    if paid.paid is None:
        raise Reject("paid_message_has_no_amount")
    if (now - paid.at).days > _active_window(provider, paid.paid.currency):
        raise Reject("plan_not_active")
    if notice.at < paid.at - timedelta(days=14) or (now - notice.at).days > 120:
        raise Reject("notice_not_current")
    if _cancelled_after(provider, paid.at):
        raise Reject("already_cancelled")
    stated = _DURATION.search(notice_ref.quote)
    explicit = bool(stated and _USAGE.search(notice_ref.quote))
    strength = "clear" if (strength == "clear" and explicit) else "question"
    days_stated: int | None = None
    if stated:
        count = _WORD_NUMBERS.get(stated.group(1).lower()) or int(stated.group(1))
        days_stated = count * {"day": 1, "week": 7, "month": 30}[stated.group(2).lower()]
    facts = {
        "amount_minor": paid.paid.minor,
        "currency": paid.paid.currency,
        "last_paid_on": paid.at.date().isoformat(),
        "notice_on": notice.at.date().isoformat(),
        "stated": stated.group(0) if explicit else None,
        "period": _period(provider, paid),
    }
    allowed = _money_numbers([paid.paid]) | _day_numbers(paid, notice)
    if stated:
        allowed |= {
            _decimal(stated.group(1)) or Decimal(_WORD_NUMBERS.get(stated.group(1).lower(), 0))
        }
        allowed.add(Decimal(days_stated or 0))
    attribution = {
        "by": provider.display,
        "on": notice.at.date().isoformat(),
        "statement": notice_ref.quote,
    }
    return strength, facts, allowed, [paid, notice], attribution


def _refund(raw, refs, packet, now, strength):
    promises = _by_role(refs, "refund_promise")
    if not promises or _by_role(refs, "refund_confirmation"):
        raise Reject("needs_unconfirmed_promise")
    _same_provider([ref.message for ref in refs])
    provider = packet.provider_of(refs[0].message.eid)
    promise = max((ref.message for ref in promises), key=lambda m: m.at)
    try:
        promised_by = datetime.fromisoformat(f"{raw.get('promised_by')}T00:00:00+00:00")
    except ValueError:
        raise Reject("no_promised_date") from None
    if not promise.at.date() <= promised_by.date() <= (promise.at + timedelta(days=120)).date():
        raise Reject("promised_date_out_of_range")
    if now.date() <= promised_by.date():
        raise Reject("not_due_yet")
    money = promise.amounts[0][0] if promise.amounts else None
    for other in provider.messages:
        if other.eid == promise.eid or other.at < promise.at:
            continue
        mentions_refund = other.is_refund_subject or (
            money is not None and other.has_amount(money) and "refund" in other.haystack
        )
        if mentions_refund:
            raise Reject("possible_confirmation_in_mail")
    if _NON_ARRIVAL.search(str(raw.get("reason") or "")) or _NON_ARRIVAL.search(
        str(raw.get("headline") or "")
    ):
        raise Reject("claims_money_missing")
    facts = {
        "promised_on": promise.at.date().isoformat(),
        "promised_by": promised_by.date().isoformat(),
        "amount_minor": money.minor if money else None,
        "currency": money.currency if money else None,
    }
    allowed = _day_numbers(promise, dates=(promised_by,)) | (
        _money_numbers([money]) if money else set()
    )
    return "question", facts, allowed, [promise], None


def _duplicate(raw, refs, packet, now, strength):
    charges = _by_role(refs, "charge")
    if len(charges) != 2:
        raise Reject("needs_two_charges")
    first, second = sorted((ref.message for ref in charges), key=lambda m: m.at)
    _same_provider([first, second])
    if first.message_id == second.message_id or not first.paid or not second.paid:
        raise Reject("not_two_paid_messages")
    if first.paid != second.paid:
        raise Reject("amounts_differ")
    if (second.at - first.at).days > DUPLICATE_DAYS:
        raise Reject("too_far_apart")
    if first.thread_id and first.thread_id == second.thread_id:
        raise Reject("same_conversation")
    orders_a, orders_b = set(first.orders), set(second.orders)
    refs_a, refs_b = set(first.refs), set(second.refs)
    strength = "question"
    if orders_a and orders_b:
        if not orders_a & orders_b:
            raise Reject("different_orders")
        # One order, so only distinct payment references make it two charges.
        if refs_a and refs_b and not refs_a & refs_b:
            strength = "clear"
        else:
            raise Reject("one_purchase_two_emails")
    elif refs_a and refs_b:
        if refs_a & refs_b:
            raise Reject("same_transaction")
        strength = "clear"
    facts = {
        "amount_minor": first.paid.minor,
        "currency": first.paid.currency,
        "first_on": first.at.date().isoformat(),
        "second_on": second.at.date().isoformat(),
    }
    allowed = _money_numbers([first.paid]) | _day_numbers(first, second)
    return strength, facts, allowed, [first, second], None


def _price_rise(raw, refs, packet, now, strength):
    paid_refs = _by_role(refs, "paid")
    if not paid_refs:
        raise Reject("needs_paid")
    _same_provider([ref.message for ref in refs])
    provider = packet.provider_of(refs[0].message.eid)
    latest_ref = max(paid_refs, key=lambda ref: ref.message.at)
    currency = latest_ref.message.paid.currency if latest_ref.message.paid else None
    if currency is None:
        raise Reject("paid_message_has_no_amount")
    history = [m for m in provider.paid() if m.paid.currency == currency]
    announcement = max(_by_role(refs, "announcement"), key=lambda ref: ref.message.at, default=None)
    announced: Money | None = None
    if announcement is not None:
        given = find_amounts(str(((raw.get("announced") or {}).get("amount_text")) or ""))
        quoted = [amount for amount, _ in find_amounts(announcement.quote)]
        announced = next(
            (amount for amount, _ in given if amount in quoted and amount.currency == currency),
            None,
        )
        if announced is None:
            raise Reject("announced_price_not_in_quote")
        earlier = [m for m in history if m.at <= announcement.message.at]
        new_minor = announced.minor
        key_messages = [announcement.message, *earlier[-1:]]
    else:
        latest = latest_ref.message
        if (now - latest.at).days > 60:
            raise Reject("bill_too_old")
        earlier = [m for m in history if m.at < latest.at]
        new_minor = latest.paid.minor
        key_messages = [latest]
    base = _baseline([m.paid for m in earlier])
    if base is None:
        raise Reject("needs_three_earlier_bills")
    base_minor, base_kind = base
    if not _rise_over(new_minor, base_minor):
        raise Reject("not_above_twenty_percent")
    last_paid = earlier[-1].paid
    percent = _percent_x10(new_minor, base_minor)
    facts = {
        "currency": currency,
        "last_paid_minor": last_paid.minor if announcement else earlier[-1].paid.minor,
        "new_minor": new_minor,
        "new_is_announced": announcement is not None,
        "base_minor": base_minor,
        "base_kind": base_kind,
        "percent": f"{percent // 10}.{percent % 10}",
        "effective_on": str(((raw.get("announced") or {}).get("effective_on")) or "") or None,
    }
    allowed = {
        Decimal(base_minor) / 100,
        Decimal(new_minor) / 100,
        Decimal(last_paid.minor) / 100,
        Decimal(percent) / 10,
        Decimal(percent // 10),
        Decimal(RISE_PERCENT),
    } | _day_numbers(*key_messages, dates=_stated_date(facts["effective_on"]))
    return (
        ("clear" if announced is not None or strength == "clear" else "question"),
        facts,
        allowed,
        key_messages,
        None,
    )


def _plans(raw, refs, packet, now, strength):
    entries = raw.get("plans")
    if not isinstance(entries, list):
        raise Reject("no_plans")
    kept: list[tuple[str, dict[str, Any], NoticeMessage, Provider]] = []
    seen: set[str] = set()
    for entry in entries[:12]:
        if not isinstance(entry, dict):
            continue
        provider = packet.providers.get(str(entry.get("provider_id") or ""))
        message = packet.message(str(entry.get("paid_message_id") or ""))
        category = norm(str(entry.get("category") or ""))[:40]
        quote = " ".join(str(entry.get("category_quote") or "").split())
        if provider is None or message is None or message.paid is None or not category:
            continue
        if (
            provider.root in seen
            or message not in provider.messages
            or entry.get("active") is not True
        ):
            continue
        if not 6 <= len(quote) <= 300 or norm(quote) not in message.haystack:
            continue
        if (now - message.at).days > _active_window(provider, message.paid.currency):
            continue
        if _cancelled_after(provider, message.at):
            continue
        seen.add(provider.root)
        kept.append((category, entry, message, provider))
    groups: dict[tuple[str, str], list[tuple[str, dict[str, Any], NoticeMessage, Provider]]] = {}
    for item in kept:
        groups.setdefault((item[0], item[2].paid.currency), []).append(item)
    best = max(groups.values(), key=len, default=[])
    if len(best) < MIN_PLANS:
        raise Reject("fewer_than_three_verified_plans")
    plans: list[dict[str, Any]] = []
    for category, _entry, message, provider in best:
        period = _period(provider, message)
        plans.append(
            {"provider": provider, "message": message, "category": category, "period": period}
        )
    currency = best[0][2].paid.currency
    all_monthly = all(plan["period"] == "monthly" for plan in plans)
    total = sum(plan["message"].paid.minor for plan in plans) if all_monthly else None
    facts = {
        "count": len(plans),
        "currency": currency,
        "monthly_total_minor": total,
        "category": best[0][0],
    }
    allowed = {Decimal(len(plans))} | _money_numbers([plan["message"].paid for plan in plans])
    if total is not None:
        allowed.add(Decimal(total) / 100)
    allowed |= _day_numbers(*[plan["message"] for plan in plans])
    return "question", facts, allowed, [plan["message"] for plan in plans], plans


_VALIDATORS = {
    "inactive_plan": _inactive,
    "refund_followup": _refund,
    "possible_duplicate": _duplicate,
    "price_rise": _price_rise,
    "plan_review": _plans,
}


def validate_finding(raw: dict[str, Any], packet: Packet, now: datetime) -> Finding:
    kind = raw.get("kind")
    if kind not in KINDS:
        raise Reject("unknown_kind")
    headline, reason, strength = _check_words(raw)
    refs = _cited(raw, packet) if kind != "plan_review" else _optional_refs(raw, packet)
    strength, facts, allowed, key_messages, extra = _VALIDATORS[kind](
        raw, refs, packet, now, strength
    )
    cited_messages = [ref.message for ref in refs]
    cited_numbers: set[Decimal] = set(allowed)
    for ref in refs:
        cited_numbers.update(
            v for v in (_decimal(t) for t in _NUMBER.findall(ref.quote)) if v is not None
        )
    cited_numbers |= _day_numbers(*cited_messages)
    _check_numbers(f"{headline} {reason}", cited_numbers)
    if strength == "question" and (_INACTIVITY_CLAIM.search(reason) and kind == "inactive_plan"):
        raise Reject("claims_inactivity_without_proof")
    if strength == "question" and kind == "possible_duplicate" and _DOUBLE_CLAIM.search(reason):
        raise Reject("claims_double_charge_without_proof")
    plans: list[dict[str, Any]] = extra if kind == "plan_review" and isinstance(extra, list) else []
    attribution = extra if kind == "inactive_plan" and isinstance(extra, dict) else None
    provider = None if kind == "plan_review" else packet.provider_of(key_messages[0].eid)
    return Finding(
        kind=str(kind),
        provider=provider,
        headline=headline,
        reason=reason,
        strength=strength,
        evidence=refs,
        key_messages=key_messages,
        facts=facts,
        plans=plans,
        attribution=attribution,
    )


def _optional_refs(raw: dict[str, Any], packet: Packet) -> list[EvidenceRef]:
    return _cited(raw, packet) if raw.get("evidence") else []


def score(finding: Finding, now: datetime) -> int:
    base = {
        "possible_duplicate": 90,
        "refund_followup": 85,
        "price_rise": 80,
        "inactive_plan": 75,
        "plan_review": 60,
    }[finding.kind]
    if finding.strength == "question":
        base -= 20 if finding.kind in {"inactive_plan", "possible_duplicate"} else 5
    newest = max(m.at for m in finding.key_messages)
    age = (now - newest).days
    base += 10 if age <= 14 else 5 if age <= 45 else 0
    money = (
        finding.facts.get("amount_minor")
        or finding.facts.get("new_minor")
        or finding.facts.get("monthly_total_minor")
        or 0
    )
    return base + min(5, int(money) // 100_000)


def validate_output(
    raw: dict[str, Any], packet: Packet, *, now: datetime, prior_ids: set[str]
) -> Validated:
    """Every proposal checked; rejected ones are counted, never shown."""

    findings: list[Finding] = []
    rejected: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for item in (raw.get("findings") if isinstance(raw.get("findings"), list) else [])[:12]:
        if not isinstance(item, dict):
            continue
        try:
            finding = validate_finding(item, packet, now)
        except Reject as exc:
            rejected.append({"kind": str(item.get("kind")), "reason": str(exc)})
            continue
        signature = (
            finding.kind,
            finding.provider.root
            if finding.provider
            else ",".join(sorted(m.root for m in finding.key_messages)),
        )
        if signature in seen:
            continue
        seen.add(signature)
        finding.score = score(finding, now)
        findings.append(finding)
    resolved: list[dict[str, Any]] = []
    for item in (raw.get("resolved") if isinstance(raw.get("resolved"), list) else [])[:12]:
        if not isinstance(item, dict) or str(item.get("prior_id")) not in prior_ids:
            continue
        message = packet.message(str(item.get("message_id") or ""))
        quote = " ".join(str(item.get("quote") or "").split())
        if message is None or not 6 <= len(quote) <= 400 or norm(quote) not in message.haystack:
            continue
        resolved.append({"prior_id": str(item["prior_id"]), "message": message, "quote": quote})
    findings.sort(key=lambda f: f.score, reverse=True)
    none_reason = " ".join(str(raw.get("none_reason") or "").split())[:200]
    return Validated(findings[:MAX_FINDINGS], resolved, rejected, none_reason)
