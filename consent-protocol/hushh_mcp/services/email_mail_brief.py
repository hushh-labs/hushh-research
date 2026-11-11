"""What an analyzed page of the owner's mail asks of them, counted and laid out.

The analyzer gene and the personal-information classifier decide what each
message asks of the owner. This module decides nothing about meaning: it counts
their findings per category, lays them out as the answer One relays, and builds
a bounded brief a surface can render as cards. No keyword, phrase or pattern
here chooses a category.

The brief carries no message body and no email address. A sender label that is
an address is not a name, and an address inside a subject or a finding is
replaced before the brief leaves this module.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from datetime import timezone as datetime_timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

AnalysisCategory = Literal[
    "personal_info", "action_items", "meetings", "payments_due", "security_alerts"
]
ANALYSIS_CATEGORIES: tuple[AnalysisCategory, ...] = (
    "personal_info",
    "action_items",
    "meetings",
    "payments_due",
    "security_alerts",
)
FindingState = Literal["active", "completed", "cancelled", "rescheduled", "unclear"]
_SOURCE_REF = r"^mail:(?:[1-9]|1[0-9]|2[0-5])$"
_TIME_LIMIT = 40

# How each category reads: "No {none} found", "1 {one} found:", "2 {many} found:"
# and "I couldn't complete the {failed} analysis".
CATEGORY_LABELS: dict[str, tuple[str, str, str, str]] = {
    "personal_info": (
        "personal-information requests",
        "personal-information request",
        "personal-information requests",
        "personal-information request",
    ),
    "action_items": ("action items", "action item", "action items", "action item"),
    "meetings": ("meetings", "meeting finding in Mail", "meeting findings in Mail", "meeting"),
    "payments_due": ("payments due", "payment due", "payments due", "payment"),
    "security_alerts": ("security alerts", "security alert", "security alerts", "security alert"),
}
# Any unbroken run with an @ inside it. Replacing it is privacy normalization,
# never a judgement about what the message means.
_ADDRESS = re.compile(r"\S+@\S+")
_ADDRESS_STAND_IN = "an email address"
_SENDERS_IN_TEXT = 6


class MailAnalysisFinding(BaseModel):
    """One analyzer finding. personal_info comes from the classifier, never here."""

    model_config = ConfigDict(extra="forbid", strict=True)
    category: Literal["action_items", "meetings", "payments_due", "security_alerts"]
    source_ref: str = Field(pattern=_SOURCE_REF)
    # A later message in the same retrieved thread can resolve or cancel an
    # earlier one. The analyzer cites every message it used for that conclusion.
    update_refs: list[str] = Field(default_factory=list, max_length=12)
    detail: str = Field(min_length=1, max_length=280)
    state: FindingState
    due_at: str | None = Field(default=None, max_length=_TIME_LIMIT)
    event_at: str | None = Field(default=None, max_length=_TIME_LIMIT)


class MailAnalysisAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    findings: list[MailAnalysisFinding] = Field(default_factory=list, max_length=12)


class MailBriefItem(BaseModel):
    """One finding as a card: who, what and when. Never a body or an address."""

    model_config = ConfigDict(extra="forbid", strict=True)
    source_ref: str = Field(pattern=_SOURCE_REF)
    category: AnalysisCategory
    sender_name: str | None = Field(default=None, max_length=160)
    subject: str | None = Field(default=None, max_length=320)
    detail: str | None = Field(default=None, max_length=280)
    state: FindingState
    received_at: str | None = Field(default=None, max_length=_TIME_LIMIT)
    due_at: str | None = Field(default=None, max_length=_TIME_LIMIT)
    event_at: str | None = Field(default=None, max_length=_TIME_LIMIT)


class MailBriefSender(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str = Field(min_length=1, max_length=160)
    messages: int = Field(ge=1, le=25)
    unread: int = Field(ge=0, le=25)


class MailBriefCoverage(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    checked: int = Field(ge=0, le=25)
    analyzed: int = Field(ge=0, le=25)
    unreadable: int = Field(ge=0, le=25)
    unnamed_sender_messages: int = Field(ge=0, le=25)
    more_mail_outside_page: bool
    text_shortened: bool


class MailBrief(BaseModel):
    """The owner's mail brief. A failed category is listed, never counted as zero."""

    model_config = ConfigDict(extra="forbid", strict=True)
    schema_version: Literal["mail_brief.v1"] = "mail_brief.v1"
    checked_at: str = Field(min_length=1, max_length=_TIME_LIMIT)
    requested: list[AnalysisCategory] = Field(min_length=1, max_length=5)
    failed: list[AnalysisCategory] = Field(default_factory=list, max_length=5)
    counts_by_category: dict[AnalysisCategory, int]
    items: list[MailBriefItem] = Field(default_factory=list, max_length=60)
    senders: list[MailBriefSender] = Field(default_factory=list, max_length=25)
    coverage: MailBriefCoverage


@dataclass(frozen=True)
class MailAnalysisOutcome:
    """Everything a successful analysis hands back, computed here by code."""

    text: str
    coverage: dict[str, Any]
    items: list[dict[str, Any]]
    cited: list[str]
    brief: dict[str, Any]


def _display_name(value: Any) -> str | None:
    """A sender's display name. An address, or a label holding one, is no name."""
    if not isinstance(value, str):
        return None
    name = " ".join(value.split())[:160]
    return None if not name or _ADDRESS.search(name) else name


def _without_addresses(value: Any, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = " ".join(_ADDRESS.sub(_ADDRESS_STAND_IN, value).split())
    return cleaned[:limit] or None


def _senders(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    """Who mailed, newest first, with counts. Rows without a name are counted apart."""
    named: dict[str, dict[str, Any]] = {}
    unnamed = 0
    for row in rows:
        name = _display_name(row.get("sender"))
        if name is None:
            unnamed += 1
            continue
        entry = named.setdefault(name, {"name": name, "messages": 0, "unread": 0})
        entry["messages"] += 1
        entry["unread"] += int(row.get("unread") is True)
    return list(named.values()), unnamed


def _sender_line(senders: list[dict[str, Any]], unnamed: int) -> str | None:
    if not senders:
        return None
    names = [
        sender["name"] + (f" ({sender['messages']})" if sender["messages"] > 1 else "")
        for sender in senders[:_SENDERS_IN_TEXT]
    ]
    if unnamed or len(senders) > _SENDERS_IN_TEXT:
        names.append("others")
    listing = names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]
    return f"Mail in this page came from {listing}."


def _category_lines(
    category: AnalysisCategory, failed: list[AnalysisCategory], findings: list[dict[str, Any]]
) -> list[str]:
    nothing, one, many, failed_name = CATEGORY_LABELS[category]
    if category in failed:
        return [f"I couldn't complete the {failed_name} analysis."]
    matches = [finding for finding in findings if finding["category"] == category]
    if not matches:
        return [f"No {nothing} found among the messages checked."]
    return [
        f"{len(matches)} {one if len(matches) == 1 else many} found:",
        *(
            f"• {match['detail']} (email {match['source_ref'].split(':')[1]}; {match['state']})"
            for match in matches
        ),
    ]


def _answer_text(
    *,
    requested: list[AnalysisCategory],
    failed: list[AnalysisCategory],
    findings: list[dict[str, Any]],
    coverage: dict[str, Any],
    senders: list[dict[str, Any]],
    unnamed: int,
) -> str:
    lines = [f"I checked {coverage['assessed']} Mail messages in this bounded page."]
    sender_line = _sender_line(senders, unnamed)
    if sender_line is not None:
        lines.append(sender_line)
    for category in requested:
        lines.extend(_category_lines(category, failed, findings))
    if "meetings" in requested:
        lines.append("These are findings from Mail, not a check of your Calendar.")
    if coverage.get("matches_beyond_page") or coverage.get("items_omitted"):
        lines.append("More matching mail may be outside this page.")
    if coverage.get("content_shortened"):
        lines.append("Some message text was shortened; open the original for the full text.")
    if coverage["analysis_unassessable"]:
        lines.append("Some messages had no readable text and were not analyzed.")
    return "\n\n".join(lines)


def _brief_item(finding: dict[str, Any], row: dict[str, Any]) -> MailBriefItem:
    received = row.get("received_at")
    if not isinstance(received, str) or len(received) > _TIME_LIMIT:
        received = None
    return MailBriefItem(
        source_ref=finding["source_ref"],
        category=finding["category"],
        sender_name=_display_name(row.get("sender")),
        subject=_without_addresses(row.get("subject"), 320),
        detail=_without_addresses(finding["detail"], 280),
        state=finding["state"],
        received_at=received,
        due_at=finding.get("due_at"),
        event_at=finding.get("event_at"),
    )


def _brief(
    *,
    rows: list[dict[str, Any]],
    findings: list[dict[str, Any]],
    requested: list[AnalysisCategory],
    failed: list[AnalysisCategory],
    counts: dict[AnalysisCategory, int],
    senders: list[dict[str, Any]],
    unnamed: int,
    coverage: dict[str, Any],
    checked_at: datetime,
) -> dict[str, Any]:
    by_ref = {row["source_ref"]: row for row in rows}
    brief = MailBrief(
        checked_at=checked_at.astimezone(datetime_timezone.utc).isoformat(),
        requested=list(requested),
        failed=list(failed),
        counts_by_category=counts,
        items=[_brief_item(finding, by_ref.get(finding["source_ref"], {})) for finding in findings],
        senders=[MailBriefSender(**sender) for sender in senders],
        coverage=MailBriefCoverage(
            checked=len(rows),
            analyzed=coverage["assessed"],
            unreadable=coverage["analysis_unassessable"],
            unnamed_sender_messages=unnamed,
            more_mail_outside_page=bool(
                coverage.get("matches_beyond_page") or coverage.get("items_omitted")
            ),
            text_shortened=bool(coverage.get("content_shortened")),
        ),
    )
    return brief.model_dump(mode="json")


def mail_analysis_outcome(
    *,
    rows: list[dict[str, Any]],
    analyzed: int,
    findings: list[dict[str, Any]],
    failed: list[AnalysisCategory],
    requested: list[AnalysisCategory],
    reader_coverage: dict[str, Any] | None,
    plan_source: str,
    checked_at: datetime,
) -> MailAnalysisOutcome:
    """Count validated findings per category; lay out the answer, rows and brief."""
    counts: dict[AnalysisCategory, int] = {
        category: sum(finding["category"] == category for finding in findings)
        for category in ANALYSIS_CATEGORIES
        if category in requested and category not in failed
    }
    cited = list(
        dict.fromkeys(
            ref for finding in findings for ref in [finding["source_ref"], *finding["update_refs"]]
        )
    )
    coverage = dict(reader_coverage or {})
    coverage.update(
        assessed=analyzed,
        analysis_unassessable=len(rows) - analyzed,
        plan_source=plan_source,
        analysis_requested=list(requested),
        analysis_failed=list(failed),
        cited=len(cited),
    )
    coverage.update({f"findings_{category}": count for category, count in counts.items()})
    by_ref: dict[str, list[dict[str, Any]]] = {}
    for finding in findings:
        by_ref.setdefault(finding["source_ref"], []).append(finding)
    senders, unnamed = _senders(rows)
    text = _answer_text(
        requested=requested,
        failed=failed,
        findings=findings,
        coverage=coverage,
        senders=senders,
        unnamed=unnamed,
    )
    brief = _brief(
        rows=rows,
        findings=findings,
        requested=requested,
        failed=failed,
        counts=counts,
        senders=senders,
        unnamed=unnamed,
        coverage=coverage,
        checked_at=checked_at,
    )
    return MailAnalysisOutcome(
        text=text,
        coverage=coverage,
        items=[{**row, "analysis": by_ref.get(row["source_ref"], [])} for row in rows],
        cited=cited,
        brief=brief,
    )


__all__ = [
    "ANALYSIS_CATEGORIES",
    "AnalysisCategory",
    "CATEGORY_LABELS",
    "MailAnalysisAnswer",
    "MailAnalysisFinding",
    "MailAnalysisOutcome",
    "MailBrief",
    "MailBriefCoverage",
    "MailBriefItem",
    "MailBriefSender",
    "mail_analysis_outcome",
]
