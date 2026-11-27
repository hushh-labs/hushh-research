"""Universal 6-surface prompt-injection quarantine and background curation operon.

Every offline background wake that ingests untrusted third-party text runs inside
a hard runtime capability quarantine across all six external input channels:

1. ``gmail`` (inbound messages and attachments)
2. ``calendar`` (external invite titles, descriptions, and attendee notes)
3. ``drive`` ("Shared with me" documents and collaborator comments)
4. ``contacts`` (synced external directory cards and notes)
5. ``mcp`` (GitHub issues/PRs, Slack messages, Linear tickets, Stripe metadata, CRM notes)
6. ``information_exchange_and_browser`` (requester prompt text and public web pages)

Hard Quarantine Invariant:
During any background turn reading untrusted external input, all outbound external
write, send, delete, payment, terminal, and unapproved share tools are structurally
stripped at the runtime boundary (never merely discouraged in a prompt). Outbound
actions stage cleanly for owner review instead.

Non-Aggressive Curation & Anti-Poisoning Invariant:
1. Low-signal noise (newsletters, promotions, automated no-reply receipts, OTPs)
   is dropped before reaching Agent Memory or Personal Wiki.
2. Canonical sovereign Vault capital domains (financial holdings, net worth, tax,
   identity/KYC, brokerage statements) never auto-commit; they stage as encrypted
   intake proposals for the next owner unlock.
3. Durable commitments, upcoming meetings, and project context auto-curate with
   explicit connector provenance tags (``from Mail``, ``from Calendar``, etc.) and
   can never supersede ``owner_direct`` facts, preferences, or consent rules.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

UNTRUSTED_BACKGROUND_SURFACES: tuple[str, ...] = (
    "gmail",
    "calendar",
    "drive",
    "contacts",
    "mcp",
    "information_exchange_and_browser",
)

SURFACE_PROVENANCE_LABELS: dict[str, str] = {
    "gmail": "from Mail",
    "calendar": "from Calendar",
    "drive": "from Drive",
    "contacts": "from Contacts",
    "mcp": "from Connector",
    "information_exchange_and_browser": "from External Request",
}

# Exact local staging & read-only tools safe inside a quarantined background turn.
SAFE_BACKGROUND_STAGING_TOOLS: frozenset[str] = frozenset(
    {
        "stage_local_draft",
        "open_gmail_email_draft",
        "stage_calendar_proposal",
        "open_calendar_invitation",
        "propose_calendar_event",
        "propose_calendar_reschedule",
        "propose_calendar_cancellation",
        "stage_vault_proposal",
        "stage_information_review",
        "curate_background_memory",
        "curate_background_wiki",
    }
)

SAFE_BACKGROUND_READ_TOOLS: frozenset[str] = frozenset(
    {
        "get_current_time",
        "search_memory",
        "load_memory",
        "ask_email_agent",
        "ask_documents_agent",
        "read_google_drive",
        "read_workspace_tool",
        "calendar_summary",
        "calendar_invitations",
        "calendar_calendars",
        "calendar_events",
        "calendar_event_detail",
        "calendar_availability",
        "calendar_free_slots",
        "search_contacts",
        "get_contact",
    }
)

# Outbound / mutating / privileged tool prefixes and tokens structurally stripped.
_FORBIDDEN_MUTATION_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"(?:^|_)(?:send|deliver|dispatch|forward|reply)(?:_|$)",
        r"(?:^|_)(?:delete|remove|trash|purge|erase|revoke|drop)(?:_|$)",
        r"(?:^|_)(?:write|create|insert|update|patch|modify|mutate|overwrite|commit|put|post)(?:_|$)",
        r"(?:^|_)(?:share|publish|grant|approve|accept|decline|cancel)(?:_|$)",
        r"(?:^|_)(?:pay|charge|transfer|withdraw|payout|purchase|checkout)(?:_|$)",
        r"(?:^|_)(?:bash|shell|exec|execute|terminal|command|spawn)(?:_|$)",
        r"(?:^|_)(?:archive|label|mark_read|mark_unread)(?:_|$)",
    )
)

_LOW_SIGNAL_NOISE_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"\bunsubscribe\b",
        r"\bview in browser\b",
        r"\bmanage preferences\b",
        r"\bpromotional\b|\bsponsored\b|\bflash sale\b|\blimited time offer\b",
        r"\bverification code\b|\bone-time passcode\b|\bsecurity code\b|\botp\b",
        r"\bautomated (?:receipt|notification|message)\b",
        r"\bdo not reply\b|\bno[-_]?reply@",
        r"\bnewsletter\b|\bdaily digest\b|\bmarketing@",
    )
)

_SOVEREIGN_VAULT_DOMAINS: frozenset[str] = frozenset(
    {
        "financial",
        "finance",
        "holdings",
        "portfolio",
        "net_worth",
        "brokerage",
        "tax",
        "taxes",
        "w2",
        "1099",
        "identity",
        "passport",
        "ssn",
        "kyc",
        "kyc_connector",
        "kyc_workflow",
        "wallet",
        "bank_statement",
        "secrets",
    }
)

_SOVEREIGN_VAULT_TEXT_RE = re.compile(
    r"\b(?:form\s*(?:1040|1099|w-?2|k-?1)|brokerage statement|account balance|"
    r"portfolio holdings|net worth|wire routing|passport number|social security)\b",
    re.IGNORECASE,
)

_OWNER_PROTECTED_PROVENANCE: frozenset[str] = frozenset(
    {
        "owner_direct",
        "owner_preference",
        "consent_rule",
        "circle_policy",
        "vault_canonical",
    }
)


@dataclass(frozen=True)
class QuarantinedToolsetResult:
    """Result of applying the 6-surface runtime quarantine to a tool dictionary."""

    admitted_tools: dict[str, Any]
    stripped_tool_names: tuple[str, ...]
    surfaces: tuple[str, ...]
    quarantine_active: bool


@dataclass(frozen=True)
class BackgroundCurationDecision:
    """Typed outcome of evaluating one external snippet for memory/wiki/Vault."""

    decision: str  # "drop_low_signal" | "stage_vault_proposal" | "auto_curate_memory_and_wiki"
    surface: str
    reason: str
    provenance: dict[str, Any]


def normalize_background_surface(surface: str) -> str:
    """Normalize a connector or trigger name onto the closed 6-surface set."""
    raw = str(surface or "").strip().lower()
    if raw in UNTRUSTED_BACKGROUND_SURFACES:
        return raw
    if raw.startswith("custom_") or raw in {"github", "slack", "linear", "stripe", "notion"}:
        return "mcp"
    if raw in {"browser", "information_request", "circle_request", "web", "a2a"}:
        return "information_exchange_and_browser"
    if raw in {"mail", "email"}:
        return "gmail"
    raise ValueError(f"Unsupported background surface: {surface!r}")


def _is_explicitly_readonly_mcp_tool(name: str, tool: Any) -> bool:
    """Fail-closed check for governed MCP tools during untrusted background turns."""
    if any(p.search(name) for p in _FORBIDDEN_MUTATION_PATTERNS):
        return False
    # Accept a metadata dict or tool object only when explicitly annotated read-only.
    if isinstance(tool, Mapping):
        access = str(tool.get("access") or "").strip().lower()
        read_only = tool.get("readOnlyHint") is True or tool.get("read_only") is True
        return access == "read" or read_only
    access_attr = str(getattr(tool, "access", "") or "").strip().lower()
    annotations = getattr(tool, "annotations", None)
    read_only_hint = bool(
        getattr(tool, "read_only", False)
        or getattr(annotations, "readOnlyHint", False)
        or (isinstance(annotations, Mapping) and annotations.get("readOnlyHint") is True)
    )
    return access_attr == "read" or read_only_hint


def is_tool_permitted_in_quarantine(name: str, tool: Any = None) -> bool:
    """True only if ``name``/``tool`` cannot perform an unconfirmed external side effect."""
    clean = str(name or "").strip()
    if not clean:
        return False
    if clean in SAFE_BACKGROUND_STAGING_TOOLS or clean in SAFE_BACKGROUND_READ_TOOLS:
        return True
    if any(p.search(clean) for p in _FORBIDDEN_MUTATION_PATTERNS):
        return False
    if tool is not None and _is_explicitly_readonly_mcp_tool(clean, tool):
        return True
    # Fail closed on any unclassified tool during an untrusted background wake.
    return False


def quarantine_tools_for_background_turn(
    tools_by_name: Mapping[str, Any],
    *,
    active_surfaces: Iterable[str] = UNTRUSTED_BACKGROUND_SURFACES,
) -> QuarantinedToolsetResult:
    """Structurally strip all outbound/mutating tools for a background wake."""
    normalized_surfaces = tuple(
        dict.fromkeys(normalize_background_surface(s) for s in active_surfaces)
    )
    if not normalized_surfaces:
        normalized_surfaces = UNTRUSTED_BACKGROUND_SURFACES

    admitted: dict[str, Any] = {}
    stripped: list[str] = []
    for name, tool in dict(tools_by_name).items():
        if is_tool_permitted_in_quarantine(name, tool):
            admitted[name] = tool
        else:
            stripped.append(name)

    return QuarantinedToolsetResult(
        admitted_tools=admitted,
        stripped_tool_names=tuple(sorted(stripped)),
        surfaces=normalized_surfaces,
        quarantine_active=True,
    )


def tag_background_memory_provenance(
    *,
    surface: str,
    source_ref: str = "",
) -> dict[str, Any]:
    """Attach explicit connector provenance and 1-tap rollback metadata."""
    norm = normalize_background_surface(surface)
    meta: dict[str, Any] = {
        "provenance_kind": "connector_background",
        "connector_surface": norm,
        "source_label": SURFACE_PROVENANCE_LABELS[norm],
        "trust_tier": "external_derived",
        "reversible": True,
    }
    clean_ref = str(source_ref or "").strip()[:128]
    if clean_ref:
        meta["source_ref"] = clean_ref
    return meta


def can_supersede_existing_fact(
    *,
    existing_metadata: Mapping[str, Any] | None,
    candidate_metadata: Mapping[str, Any] | None,
) -> bool:
    """External background facts can NEVER override owner-stated facts or consent rules."""
    existing = dict(existing_metadata or {})
    candidate = dict(candidate_metadata or {})
    existing_kind = (
        str(existing.get("provenance_kind") or existing.get("source_kind") or "").strip().lower()
    )
    existing_author = str(existing.get("author") or "").strip().lower()
    candidate_tier = str(candidate.get("trust_tier") or "").strip().lower()
    candidate_kind = str(candidate.get("provenance_kind") or "").strip().lower()

    is_external_candidate = (
        candidate_tier == "external_derived" or candidate_kind == "connector_background"
    )
    if not is_external_candidate:
        return True

    if existing_kind in _OWNER_PROTECTED_PROVENANCE or existing_author in {"user", "owner"}:
        return False
    return True


def evaluate_background_curation_candidate(
    *,
    surface: str,
    summary_text: str,
    sender_hint: str = "",
    category_hint: str = "",
    target_domain: str = "",
    source_ref: str = "",
) -> BackgroundCurationDecision:
    """Classify a candidate insight into drop, Vault proposal, or Memory/Wiki curation."""
    norm = normalize_background_surface(surface)
    provenance = tag_background_memory_provenance(surface=norm, source_ref=source_ref)
    text = str(summary_text or "").strip()
    sender = str(sender_hint or "").strip().lower()
    category = str(category_hint or "").strip().lower()
    domain = str(target_domain or "").strip().lower()

    if len(text) < 12:
        return BackgroundCurationDecision(
            decision="drop_low_signal",
            surface=norm,
            reason="too_short",
            provenance=provenance,
        )

    if category in {
        "promotions",
        "social",
        "trash",
        "spam",
        "newsletter",
        "marketing",
        "automated_receipt",
    }:
        return BackgroundCurationDecision(
            decision="drop_low_signal",
            surface=norm,
            reason="low_signal_category",
            provenance=provenance,
        )

    combined_probe = f"{sender}\n{text}"
    if any(pattern.search(combined_probe) for pattern in _LOW_SIGNAL_NOISE_PATTERNS):
        return BackgroundCurationDecision(
            decision="drop_low_signal",
            surface=norm,
            reason="low_signal_pattern",
            provenance=provenance,
        )

    if domain in _SOVEREIGN_VAULT_DOMAINS or _SOVEREIGN_VAULT_TEXT_RE.search(text):
        return BackgroundCurationDecision(
            decision="stage_vault_proposal",
            surface=norm,
            reason="sovereign_vault_domain_requires_owner_unlock",
            provenance=provenance,
        )

    return BackgroundCurationDecision(
        decision="auto_curate_memory_and_wiki",
        surface=norm,
        reason="durable_high_signal",
        provenance=provenance,
    )


__all__ = [
    "SAFE_BACKGROUND_READ_TOOLS",
    "SAFE_BACKGROUND_STAGING_TOOLS",
    "SURFACE_PROVENANCE_LABELS",
    "UNTRUSTED_BACKGROUND_SURFACES",
    "BackgroundCurationDecision",
    "QuarantinedToolsetResult",
    "can_supersede_existing_fact",
    "evaluate_background_curation_candidate",
    "is_tool_permitted_in_quarantine",
    "normalize_background_surface",
    "quarantine_tools_for_background_turn",
    "tag_background_memory_provenance",
]
