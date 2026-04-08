from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal

VoiceKnowledgeTier = Literal[
    "control",
    "section",
    "surface",
    "local_concept",
    "global_concept",
    "fallback",
]


@dataclass(frozen=True)
class VoiceKnowledgeEntry:
    key: str
    summary: str
    detail: str | None = None
    aliases: tuple[str, ...] = ()


@dataclass(frozen=True)
class VoiceKnowledgeResolution:
    tier: VoiceKnowledgeTier
    key: str
    summary: str
    detail: str | None = None


def _normalize(value: Any) -> str:
    lowered = str(value or "").strip().lower()
    lowered = re.sub(r"[_\-]+", " ", lowered)
    lowered = re.sub(r"[^a-z0-9\s]+", " ", lowered)
    return re.sub(r"\s+", " ", lowered).strip()


def _matches_phrase(text: str, phrase: str) -> bool:
    normalized_text = _normalize(text)
    normalized_phrase = _normalize(phrase)
    if not normalized_text or not normalized_phrase:
        return False
    pattern = r"\b" + r"\s+".join(re.escape(token) for token in normalized_phrase.split()) + r"\b"
    return re.search(pattern, normalized_text) is not None


def _coerce_bool(value: Any, *, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    return default


def _coerce_int(value: Any) -> int | None:
    return value if isinstance(value, int) else None


def _coerce_text(value: Any) -> str | None:
    text = str(value or "").strip()
    return text or None


def _coerce_str_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    items: list[str] = []
    for raw in value:
        text = _coerce_text(raw)
        if text:
            items.append(text)
    return items


def _build_dynamic_control_entry(label: str) -> VoiceKnowledgeEntry:
    normalized = _normalize(label)
    known = {
        "connect gmail": VoiceKnowledgeEntry(
            key="connect_gmail",
            summary="Connect Gmail starts Gmail OAuth for receipt sync.",
            detail="It links the selected inbox so receipts can be synced into the receipts store.",
            aliases=("connect gmail", "reconnect gmail", "open gmail connector"),
        ),
        "sync gmail receipts": VoiceKnowledgeEntry(
            key="sync_gmail_receipts",
            summary="Sync Gmail receipts refreshes receipt extraction from the connected inbox.",
            detail="It queues a sync run and updates the stored receipt list when the run completes.",
            aliases=("sync gmail receipts", "sync gmail", "refresh gmail status"),
        ),
        "disconnect gmail": VoiceKnowledgeEntry(
            key="disconnect_gmail",
            summary="Disconnect Gmail removes the current Gmail connector from future syncs.",
            detail="It stops new receipt sync runs until Gmail is connected again.",
            aliases=("disconnect gmail",),
        ),
        "add receipts to memory": VoiceKnowledgeEntry(
            key="add_receipts_to_memory",
            summary="Add receipts to memory builds a compact receipts-memory preview from stored Gmail receipts.",
            detail="It does not save to PKM yet. It prepares the preview first.",
            aliases=("add receipts to memory", "build receipts memory preview"),
        ),
        "refresh receipt memory": VoiceKnowledgeEntry(
            key="refresh_receipt_memory",
            summary="Refresh receipt memory rebuilds the current receipts-memory preview from stored receipts.",
            detail="It refreshes merchants, patterns, highlights, and signals before save.",
            aliases=("refresh receipt memory",),
        ),
        "save receipts memory to pkm": VoiceKnowledgeEntry(
            key="save_receipts_memory_to_pkm",
            summary="Save receipts memory to PKM writes the current receipts-memory preview into your shopping PKM domain.",
            detail="It validates the prepared payload and persists the current preview as durable encrypted memory.",
            aliases=("save receipts memory to pkm",),
        ),
        "generate pkm preview": VoiceKnowledgeEntry(
            key="generate_pkm_preview",
            summary="Generate PKM preview builds a PKM capture preview without saving it.",
            detail="It prepares a structured preview so you can review it before any PKM write.",
            aliases=("generate pkm preview", "generate pkm capture preview"),
        ),
        "save pkm capture": VoiceKnowledgeEntry(
            key="save_pkm_capture",
            summary="Save PKM capture persists the current PKM preview into encrypted PKM storage.",
            detail="It turns the reviewed preview into a durable PKM write.",
            aliases=("save pkm capture",),
        ),
        "resume pkm upgrade": VoiceKnowledgeEntry(
            key="resume_pkm_upgrade",
            summary="Resume PKM upgrade continues a pending local PKM upgrade flow.",
            detail="It is used when the PKM upgrade is waiting for local auth or a resumed step.",
            aliases=("resume pkm upgrade",),
        ),
        "review domain permissions": VoiceKnowledgeEntry(
            key="review_domain_permissions",
            summary="Review domain permissions opens the permission controls for the selected PKM domain.",
            detail="It lets you inspect which PKM sections are enabled or exposed for that domain.",
            aliases=("review domain permissions",),
        ),
    }
    if normalized in known:
        return known[normalized]
    return VoiceKnowledgeEntry(
        key=normalized or "control",
        summary=f"{label} is an action on this screen.",
        detail=f"It starts the {label[:1].lower() + label[1:] if label else 'current'} flow.",
        aliases=(label,),
    )


_GLOBAL_CONCEPTS: tuple[VoiceKnowledgeEntry, ...] = (
    VoiceKnowledgeEntry(
        key="pkm",
        summary="PKM is your structured personal memory layer.",
        detail="It stores compact, governed memory instead of raw source-system payloads.",
        aliases=("pkm", "personal knowledge model"),
    ),
    VoiceKnowledgeEntry(
        key="gmail_connector",
        summary="The Gmail connector links your inbox for receipt sync.",
        detail="It manages Gmail connection state and receipt sync, but raw email bodies are not saved into PKM.",
        aliases=("gmail connector", "gmail receipts connector", "gmail integration"),
    ),
    VoiceKnowledgeEntry(
        key="receipt_memory",
        summary="Receipt memory is a compact shopping-memory snapshot built from stored Gmail receipts.",
        detail="It summarizes merchants, purchase patterns, recent highlights, and preference signals before save.",
        aliases=("receipt memory", "receipts memory", "receipts memory preview"),
    ),
    VoiceKnowledgeEntry(
        key="consent_center",
        summary="The consent center is where sharing and approval requests are reviewed.",
        detail="It shows pending requests and the scopes involved before you approve or deny them.",
        aliases=("consent center", "consents", "consent"),
    ),
)

_SURFACE_CONCEPTS: dict[str, VoiceKnowledgeEntry] = {
    "profile_receipts": VoiceKnowledgeEntry(
        key="profile_receipts",
        summary="This receipts workspace manages Gmail receipts and the receipts-to-PKM flow.",
        detail="It combines connector status, receipt sync state, stored receipts, and the receipts-memory preview.",
        aliases=("receipts", "receipts workspace"),
    ),
    "profile_gmail_panel": VoiceKnowledgeEntry(
        key="profile_gmail_panel",
        summary="This Gmail connector screen manages inbox connection and receipt sync readiness.",
        detail="It shows the linked Gmail account, connector status, and receipt-related actions.",
        aliases=("gmail connector", "gmail panel"),
    ),
    "profile_pkm_agent_lab": VoiceKnowledgeEntry(
        key="profile_pkm_agent_lab",
        summary="This PKM Agent Lab screen previews and saves structured PKM captures.",
        detail="It shows domain state, capture previews, and permission controls before a PKM save.",
        aliases=("pkm agent lab", "memory lab"),
    ),
    "profile_support_panel": VoiceKnowledgeEntry(
        key="profile_support_panel",
        summary="This support screen is for bug reports and direct support requests.",
        detail="It routes feedback or support messages to the team from inside profile.",
        aliases=("support", "support panel"),
    ),
    "profile_security_panel": VoiceKnowledgeEntry(
        key="profile_security_panel",
        summary="This vault security screen manages local vault access controls.",
        detail="It covers unlock method changes and related vault security actions.",
        aliases=("vault security", "security panel"),
    ),
    "profile_account": VoiceKnowledgeEntry(
        key="profile_account",
        summary="This account screen manages profile-level product connections and settings.",
        detail="It includes entry points for Gmail, receipts, support, and PKM Agent Lab.",
        aliases=("account", "profile account"),
    ),
    "profile_preferences": VoiceKnowledgeEntry(
        key="profile_preferences",
        summary="This preferences screen manages product behavior and personalization settings.",
        detail="It is for preference choices rather than secure data operations.",
        aliases=("preferences", "profile preferences"),
    ),
    "profile_privacy": VoiceKnowledgeEntry(
        key="profile_privacy",
        summary="This privacy screen manages consent and vault security entry points.",
        detail="It focuses on consent review and privacy-related controls.",
        aliases=("privacy", "profile privacy"),
    ),
    "dashboard": VoiceKnowledgeEntry(
        key="dashboard",
        summary="This portfolio dashboard summarizes your current holdings view.",
        detail="It is the main portfolio surface before deeper analysis or optimization.",
        aliases=("dashboard", "portfolio dashboard"),
    ),
    "home": VoiceKnowledgeEntry(
        key="home",
        summary="This market home screen summarizes the current market view.",
        detail="It is the entry surface for market context and watchlist-style reads.",
        aliases=("market home", "market"),
    ),
    "kai_market": VoiceKnowledgeEntry(
        key="kai_market",
        summary="This market home screen summarizes the live tape, advisor signals, and discovery modules.",
        detail="It is the main market surface for current tape, picks, themes, and next analysis ideas.",
        aliases=("market home", "market", "kai market"),
    ),
    "analysis": VoiceKnowledgeEntry(
        key="analysis",
        summary="This analysis screen is where Kai explains a selected analysis run.",
        detail="It is focused on active analysis context and detailed reasoning views.",
        aliases=("analysis",),
    ),
    "kai_analysis": VoiceKnowledgeEntry(
        key="kai_analysis",
        summary="This analysis screen is where Kai reviews debate runs, tabs, and saved reasoning.",
        detail="It covers active analysis work, saved history, and detailed stock reasoning views.",
        aliases=("analysis", "analysis workspace"),
    ),
    "kai_analysis_workspace": VoiceKnowledgeEntry(
        key="kai_analysis_workspace",
        summary="This analysis workspace is where the active stock debate and summary tabs are reviewed.",
        detail="It focuses on the current ticker, the live run state, and the debate, summary, or detailed tabs.",
        aliases=("analysis workspace", "analysis"),
    ),
    "kai_analysis_history": VoiceKnowledgeEntry(
        key="kai_analysis_history",
        summary="This analysis history screen shows prior debates and lets you reopen saved work.",
        detail="It is the history-first view for selecting a prior debate or reentering an active run.",
        aliases=("analysis history", "analysis"),
    ),
    "kai_portfolio_bootstrap": VoiceKnowledgeEntry(
        key="kai_portfolio_bootstrap",
        summary="This portfolio screen is setting up the holdings workspace.",
        detail="It is the bootstrap state before import, source selection, or dashboard review is ready.",
        aliases=("portfolio", "portfolio setup"),
    ),
    "kai_portfolio_import": VoiceKnowledgeEntry(
        key="kai_portfolio_import",
        summary="This portfolio import screen is where statements or brokerage connections are started.",
        detail="It is the intake surface for bringing positions into Kai before review or dashboard analysis.",
        aliases=("portfolio import", "import portfolio"),
    ),
    "kai_portfolio_import_progress": VoiceKnowledgeEntry(
        key="kai_portfolio_import_progress",
        summary="This portfolio import screen shows statement parsing or import progress.",
        detail="It tracks the current import stage, progress, and any import-time issues before review.",
        aliases=("portfolio import progress", "import progress"),
    ),
    "kai_portfolio_import_complete": VoiceKnowledgeEntry(
        key="kai_portfolio_import_complete",
        summary="This portfolio screen confirms that the latest import is ready for review.",
        detail="It is the handoff point between import completion and holdings review before save.",
        aliases=("portfolio import complete", "import complete"),
    ),
    "kai_portfolio_review": VoiceKnowledgeEntry(
        key="kai_portfolio_review",
        summary="This portfolio review screen lets you inspect parsed holdings before saving them.",
        detail="It is the review step where extracted holdings are checked before becoming the active source.",
        aliases=("portfolio review", "review holdings"),
    ),
    "kai_portfolio_dashboard": VoiceKnowledgeEntry(
        key="kai_portfolio_dashboard",
        summary="This portfolio dashboard shows the active holdings source, summary, and optimization views.",
        detail="It is the main portfolio workspace for source switching, overview, holdings, and deep-dive analysis.",
        aliases=("portfolio dashboard", "portfolio", "holdings dashboard"),
    ),
    "kai_portfolio_analysis": VoiceKnowledgeEntry(
        key="kai_portfolio_analysis",
        summary="This portfolio analysis screen focuses on deeper portfolio review from the holdings workspace.",
        detail="It is used when the portfolio flow is centered on deeper analysis instead of import or review.",
        aliases=("portfolio analysis",),
    ),
    "consents": VoiceKnowledgeEntry(
        key="consents",
        summary="This consent screen is where sharing requests are reviewed.",
        detail="It shows pending consent requests and available decisions.",
        aliases=("consents", "consent center"),
    ),
}

_SECTION_CONCEPTS: dict[str, dict[str, VoiceKnowledgeEntry]] = {
    "profile_receipts": {
        "receipt memory preview": VoiceKnowledgeEntry(
            key="receipt_memory_preview_section",
            summary="Receipt Memory Preview shows the compact shopping memory derived from your stored receipts.",
            detail="It surfaces merchants, purchase patterns, recent highlights, and preference signals before save.",
            aliases=("receipt memory preview",),
        ),
        "latest sync": VoiceKnowledgeEntry(
            key="latest_sync_section",
            summary="Latest Sync shows the current Gmail receipt sync run.",
            detail="It reports sync status, errors, and whether backfill is still running.",
            aliases=("latest sync",),
        ),
        "stored receipts": VoiceKnowledgeEntry(
            key="stored_receipts_section",
            summary="Stored Receipts lists the receipt records already synced from Gmail.",
            detail="This is the source list used to build receipts memory.",
            aliases=("stored receipts", "receipts list"),
        ),
    },
    "profile_gmail_panel": {
        "gmail connector": VoiceKnowledgeEntry(
            key="gmail_connector_section",
            summary="Gmail Connector manages the linked inbox and receipt sync readiness.",
            detail="It shows connection state, the linked account, and Gmail-specific actions.",
            aliases=("gmail connector",),
        ),
    },
    "profile_pkm_agent_lab": {
        "domain permissions": VoiceKnowledgeEntry(
            key="domain_permissions_section",
            summary="Domain Permissions controls which PKM sections are enabled or exposed for a domain.",
            detail="It is where domain-specific access and section exposure are reviewed.",
            aliases=("domain permissions",),
        ),
        "latest capture preview": VoiceKnowledgeEntry(
            key="latest_capture_preview_section",
            summary="Latest Capture Preview shows the current PKM capture before save.",
            detail="It is the review step before the preview is persisted into PKM.",
            aliases=("latest capture preview", "capture preview"),
        ),
        "pkm overview": VoiceKnowledgeEntry(
            key="pkm_overview_section",
            summary="PKM Overview summarizes the current PKM workspace state.",
            detail="It highlights upgrade state, domain counts, and capture context.",
            aliases=("pkm overview",),
        ),
    },
}

_LOCAL_CONCEPTS: dict[str, tuple[VoiceKnowledgeEntry, ...]] = {
    "profile_receipts": (
        VoiceKnowledgeEntry(
            key="merchant_affinity",
            summary="Merchant affinity shows which merchants appear most strongly in the receipts-memory snapshot.",
            detail="It is a compact memory signal, not a full spend report.",
            aliases=("merchant affinity",),
        ),
        VoiceKnowledgeEntry(
            key="purchase_patterns",
            summary="Purchase patterns summarize recurring or repeat receipt behavior.",
            detail="They capture cadence and repetition without storing the raw Gmail corpus in PKM.",
            aliases=("purchase patterns", "patterns"),
        ),
        VoiceKnowledgeEntry(
            key="recent_highlights",
            summary="Recent highlights call out the most notable recent receipt activity.",
            detail="They are a bounded set of important recent events, not the full receipt list.",
            aliases=("recent highlights", "highlights"),
        ),
        VoiceKnowledgeEntry(
            key="preference_signals",
            summary="Preference signals are deterministic shopping inferences derived from the receipt projection.",
            detail="They represent compact behavioral signals rather than raw analytics.",
            aliases=("preference signals", "signals"),
        ),
    ),
    "profile_pkm_agent_lab": (
        VoiceKnowledgeEntry(
            key="readable_pkm_view",
            summary="Readable PKM View shows the current PKM state in a natural-language layout.",
            detail="It is a human-readable view over the structured PKM data.",
            aliases=("readable pkm view", "readable view"),
        ),
        VoiceKnowledgeEntry(
            key="explorer",
            summary="Explorer shows the structured PKM data more directly.",
            detail="It is useful when you need to inspect PKM structure instead of the natural-language view.",
            aliases=("explorer",),
        ),
    ),
}


def looks_like_voice_knowledge_request(transcript: str) -> bool:
    normalized = _normalize(transcript)
    return bool(
        re.match(
            r"^(?:what(?:'s| is)|explain|tell me about|how does|what does)\b",
            normalized,
        )
    )


def _resolve_control(
    *,
    transcript: str,
    focused_widget: str | None,
    available_actions: list[str],
) -> VoiceKnowledgeResolution | None:
    normalized = _normalize(transcript)
    candidates: list[str] = []
    if focused_widget:
        candidates.append(focused_widget)
    candidates.extend(available_actions)
    for label in sorted(
        {candidate for candidate in candidates if candidate}, key=len, reverse=True
    ):
        if _matches_phrase(normalized, label):
            entry = _build_dynamic_control_entry(label)
            return VoiceKnowledgeResolution(
                tier="control",
                key=entry.key,
                summary=entry.summary,
                detail=entry.detail,
            )
    if focused_widget and any(
        token in normalized for token in ("this button", "this control", "this action", "this card")
    ):
        entry = _build_dynamic_control_entry(focused_widget)
        return VoiceKnowledgeResolution(
            tier="control",
            key=entry.key,
            summary=entry.summary,
            detail=entry.detail,
        )
    return None


def _is_surface_overview_request(transcript: str) -> bool:
    normalized = _normalize(transcript)
    return any(
        phrase in normalized
        for phrase in (
            "screen",
            "page",
            "my profile",
            "this profile",
            "happening here",
            "going on on my screen",
            "going on my screen",
            "on my screen",
        )
    )


def _references_current_surface(
    transcript: str,
    *,
    screen: str,
    title: str | None,
) -> bool:
    normalized = _normalize(transcript)
    candidates: list[str] = []
    clean_title = _coerce_text(title)
    if clean_title:
        candidates.extend(
            [
                clean_title,
                f"my {clean_title}",
                f"this {clean_title}",
            ]
        )
    screen_phrase = screen.replace("_", " ").strip()
    if screen_phrase:
        candidates.append(screen_phrase)
    if screen.startswith("profile"):
        candidates.extend(["profile", "my profile", "this profile"])
    return any(_matches_phrase(normalized, candidate) for candidate in candidates if candidate)


def _resolve_section(
    *,
    transcript: str,
    screen: str,
    active_section: str | None,
    active_tab: str | None,
    screen_metadata: dict[str, Any],
) -> VoiceKnowledgeResolution | None:
    section_label = active_section or active_tab
    if not section_label:
        return None
    normalized = _normalize(transcript)
    section_key = _normalize(section_label)
    entries = _SECTION_CONCEPTS.get(screen, {})
    entry = entries.get(section_key)
    references_section = (
        "section" in normalized
        or "tab" in normalized
        or _matches_phrase(normalized, section_label)
        or _is_surface_overview_request(normalized)
    )
    if not references_section:
        return None
    if entry is None:
        label = section_label.strip()
        entry = VoiceKnowledgeEntry(
            key=section_key or "section",
            summary=f"{label} is the active section on this screen.",
            detail=f"It is the current focus area inside the {screen.replace('_', ' ')} surface.",
            aliases=(label,),
        )
    summary = entry.summary
    detail = entry.detail
    if screen == "profile_receipts" and section_key == "receipt memory preview":
        connector = _coerce_text(
            screen_metadata.get("connector_badge_label") or screen_metadata.get("connector_state")
        )
        receipt_count = _coerce_int(screen_metadata.get("receipt_count"))
        preview_available = _coerce_bool(screen_metadata.get("preview_available"), default=False)
        preview_stale = _coerce_bool(screen_metadata.get("preview_stale"), default=False)
        if connector and receipt_count is not None:
            summary = (
                "Receipt Memory Preview shows the compact shopping memory built from your stored "
                f"receipts. Gmail is {connector.lower()} with {receipt_count} stored receipts."
            )
            if preview_available:
                summary = (
                    f"{summary} The current preview is {'stale' if preview_stale else 'ready'}."
                )
    elif screen == "profile_gmail_panel" and section_key == "gmail connector":
        inbox = _coerce_text(screen_metadata.get("google_email"))
        connected = _coerce_bool(screen_metadata.get("gmail_connected"), default=False)
        if connected and inbox:
            summary = f"Gmail Connector manages the linked inbox. It is connected to {inbox}."
        elif connected:
            summary = "Gmail Connector manages the linked inbox. It is connected."
        else:
            summary = "Gmail Connector manages the linked inbox. It is not connected yet."
    elif screen == "profile_pkm_agent_lab":
        domain_count = _coerce_int(screen_metadata.get("domain_count"))
        preview_count = _coerce_int(screen_metadata.get("preview_card_count"))
        selected_domain = _coerce_text(screen_metadata.get("selected_domain_key"))
        if section_key == "latest capture preview" and preview_count is not None:
            summary = (
                "Latest Capture Preview shows the current PKM capture before save. "
                f"{preview_count} preview capture{'' if preview_count == 1 else 's'} "
                "are visible."
            )
        elif section_key == "pkm overview" and domain_count is not None:
            summary = (
                "PKM Overview summarizes the current PKM workspace state. "
                f"{domain_count} domain{'' if domain_count == 1 else 's'} are loaded."
            )
        elif section_key == "domain permissions" and selected_domain:
            summary = (
                "Domain Permissions controls which PKM sections are enabled or exposed. "
                f"The selected domain is {_normalize(selected_domain).title()}."
            )
    return VoiceKnowledgeResolution(
        tier="section",
        key=entry.key,
        summary=summary,
        detail=detail,
    )


def _resolve_surface(
    *,
    transcript: str,
    screen: str,
    screen_metadata: dict[str, Any],
) -> VoiceKnowledgeResolution | None:
    if not _is_surface_overview_request(transcript):
        return None
    entry = _SURFACE_CONCEPTS.get(screen)
    if entry is None:
        return None

    summary = entry.summary
    detail = entry.detail

    if screen == "profile_receipts":
        connector = _coerce_text(
            screen_metadata.get("connector_badge_label") or screen_metadata.get("connector_state")
        )
        receipt_count = _coerce_int(screen_metadata.get("receipt_count"))
        preview_available = _coerce_bool(screen_metadata.get("preview_available"), default=False)
        preview_stale = _coerce_bool(screen_metadata.get("preview_stale"), default=False)
        if connector and receipt_count is not None:
            summary = f"Receipt Memory Preview is active. Gmail is {connector.lower()} with {receipt_count} stored receipts."
            if preview_available:
                summary = (
                    f"{summary} The current receipts-memory preview is "
                    f"{'stale' if preview_stale else 'ready'}."
                )
    elif screen == "profile_gmail_panel":
        inbox = _coerce_text(screen_metadata.get("google_email"))
        connected = _coerce_bool(screen_metadata.get("gmail_connected"), default=False)
        if connected and inbox:
            summary = f"Gmail connector is linked to {inbox}."
        elif connected:
            summary = "Gmail connector is connected."
        else:
            summary = "Gmail connector is not connected yet."
    elif screen == "profile_pkm_agent_lab":
        domain_count = _coerce_int(screen_metadata.get("domain_count"))
        preview_count = _coerce_int(screen_metadata.get("preview_card_count"))
        selected_domain = _coerce_text(screen_metadata.get("selected_domain_key"))
        if selected_domain:
            summary = f"PKM Agent Lab is focused on {_normalize(selected_domain).title()}."
        elif domain_count is not None and preview_count is not None:
            summary = (
                f"PKM Agent Lab has {domain_count} PKM domain"
                f"{'' if domain_count == 1 else 's'} loaded and {preview_count} preview"
                f" capture{'' if preview_count == 1 else 's'} visible."
            )

    return VoiceKnowledgeResolution(
        tier="surface",
        key=entry.key,
        summary=summary,
        detail=detail,
    )


def _resolve_local_concept(
    *,
    transcript: str,
    screen: str,
) -> VoiceKnowledgeResolution | None:
    normalized = _normalize(transcript)
    for entry in _LOCAL_CONCEPTS.get(screen, ()):
        for alias in entry.aliases or (entry.key,):
            if _matches_phrase(normalized, alias):
                return VoiceKnowledgeResolution(
                    tier="local_concept",
                    key=entry.key,
                    summary=entry.summary,
                    detail=entry.detail,
                )
    return None


def _resolve_global_concept(transcript: str) -> VoiceKnowledgeResolution | None:
    normalized = _normalize(transcript)
    for entry in _GLOBAL_CONCEPTS:
        for alias in entry.aliases or (entry.key,):
            if _matches_phrase(normalized, alias):
                return VoiceKnowledgeResolution(
                    tier="global_concept",
                    key=entry.key,
                    summary=entry.summary,
                    detail=entry.detail,
                )
    return None


def resolve_voice_explain_knowledge(
    *,
    transcript: str,
    screen: str,
    pathname: str,
    active_section: str | None = None,
    active_tab: str | None = None,
    focused_widget: str | None = None,
    available_actions: list[str] | None = None,
    visible_modules: list[str] | None = None,
    screen_metadata: dict[str, Any] | None = None,
    allow_surface_overview: bool = True,
) -> VoiceKnowledgeResolution:
    del pathname  # reserved for future route-specific knowledge branches
    actions = list(available_actions or [])
    modules = list(visible_modules or [])
    metadata = dict(screen_metadata or {})

    control_resolution = _resolve_control(
        transcript=transcript,
        focused_widget=focused_widget,
        available_actions=actions,
    )
    if control_resolution is not None:
        return control_resolution

    section_resolution = _resolve_section(
        transcript=transcript,
        screen=screen,
        active_section=active_section,
        active_tab=active_tab,
        screen_metadata=metadata,
    )
    if section_resolution is not None:
        return section_resolution

    if allow_surface_overview:
        surface_resolution = _resolve_surface(
            transcript=transcript,
            screen=screen,
            screen_metadata=metadata,
        )
        if surface_resolution is not None:
            return surface_resolution

    local_resolution = _resolve_local_concept(
        transcript=transcript,
        screen=screen,
    )
    if local_resolution is not None:
        return local_resolution

    global_resolution = _resolve_global_concept(transcript)
    if global_resolution is not None:
        return global_resolution

    visible_hint = modules[0] if modules else None
    if visible_hint:
        return VoiceKnowledgeResolution(
            tier="fallback",
            key="fallback_visible_module",
            summary=f"{visible_hint} is the nearest visible module on this screen.",
            detail="Ask me to explain a specific control, section, or product concept if you want more detail.",
        )
    return VoiceKnowledgeResolution(
        tier="fallback",
        key="fallback",
        summary="This screen handles the current Kai workflow.",
        detail="Ask me about a specific section, control, or product concept for a more exact answer.",
    )


_COMPAT_GLOBAL_CONCEPTS: dict[str, dict[str, Any]] = {
    "kai": {
        "label": "Kai",
        "aliases": ["kai", "kai agent"],
        "short": "Kai is Hushh's in-app investor agent for navigation, analysis, and memory-aware workflows.",
        "detailed": (
            "Kai is Hushh's in-app investor agent. It helps with market navigation, portfolio workflows, "
            "analysis, consent-aware actions, and memory-aware features like PKM."
        ),
    },
    "profile": {
        "label": "Profile",
        "aliases": ["profile", "my profile", "account settings"],
        "short": "Profile is where you manage your account, Gmail receipts, support, and PKM access.",
        "detailed": (
            "Profile is the account workspace. It includes account settings, Gmail receipts access, "
            "support, vault and privacy controls, and entry points into PKM tools."
        ),
    },
    "pkm": {
        "label": "PKM",
        "aliases": ["pkm", "personal knowledge model", "memory layer", "personal memory"],
        "short": "PKM is your encrypted personal memory layer. Kai uses it to store durable user memory safely.",
        "detailed": (
            "PKM is your encrypted personal memory layer. Kai uses it to store durable, governed user memory "
            "such as profile context, structured captures, and reusable knowledge without exposing raw source data."
        ),
    },
    "gmail_receipts": {
        "label": "Gmail receipts",
        "aliases": ["gmail receipts", "receipt sync", "email receipts"],
        "short": "Gmail receipts connects Gmail receipt sync and feeds receipt-memory imports into PKM.",
        "detailed": (
            "Gmail receipts manages receipt sync from Gmail, shows backfill and sync state, and supports "
            "turning stored receipts into compact PKM memory instead of storing raw emails in PKM."
        ),
    },
    "portfolio": {
        "label": "Portfolio",
        "aliases": ["portfolio", "dashboard", "holdings"],
        "short": "Portfolio is the workspace for holdings, imports, and optimization context.",
        "detailed": (
            "Portfolio is the holdings workspace. It centers imports, source-of-truth portfolio data, "
            "holdings context, and optimization entry points."
        ),
    },
    "market": {
        "label": "Market",
        "aliases": ["market", "market home", "kai home"],
        "short": "Market is the live market overview workspace.",
        "detailed": (
            "Market is the live market overview workspace. It highlights the current tape, advisor signals, "
            "and discovery surfaces for stocks and themes."
        ),
    },
    "analysis": {
        "label": "Analysis",
        "aliases": ["analysis", "debate", "research"],
        "short": "Analysis is the debate and research workspace for a ticker.",
        "detailed": (
            "Analysis is the ticker research workspace. It runs debate-style analysis, stores history, "
            "and supports reviewing summary and detailed outputs."
        ),
    },
    "consents": {
        "label": "Consents",
        "aliases": ["consents", "consent center", "consent"],
        "short": "Consents is where you review and manage data-sharing permissions.",
        "detailed": (
            "Consents is the permission workspace where you review pending requests, inspect consent state, "
            "and manage what data can be shared."
        ),
    },
}

_COMPAT_SURFACE_DEFINITIONS: dict[str, dict[str, Any]] = {
    "profile_account": {
        "screenId": "profile_account",
        "title": "Profile",
        "purpose": "This page gives you account settings, Gmail receipts access, support, and PKM access.",
        "sections": [
            {
                "id": "account",
                "title": "Account",
                "purpose": "This section covers your signed-in account and profile-level entry points.",
            },
            {
                "id": "preferences",
                "title": "Preferences",
                "purpose": "This section manages personal preferences and profile defaults.",
            },
            {
                "id": "privacy",
                "title": "Privacy",
                "purpose": "This section manages vault, privacy, and consent-related settings.",
            },
        ],
        "controls": [
            {
                "id": "pkm_agent_lab",
                "label": "PKM Agent Lab",
                "purpose": "opens the workspace for previewing and saving encrypted PKM captures.",
                "action_id": "nav.profile_pkm_agent_lab",
                "role": "card",
                "voice_aliases": ["pkm agent lab", "memory lab"],
            },
            {
                "id": "gmail_receipts",
                "label": "Gmail receipts",
                "purpose": "opens Gmail receipt sync and receipt-memory import.",
                "action_id": "nav.profile_receipts",
                "role": "card",
                "voice_aliases": ["gmail receipts", "receipts"],
            },
            {
                "id": "support_feedback",
                "label": "Support & feedback",
                "purpose": "opens direct support and product feedback tools.",
                "action_id": "nav.profile_support_panel",
                "role": "card",
                "voice_aliases": ["support", "feedback"],
            },
        ],
        "concepts": [
            {
                "id": "pkm",
                "label": "PKM",
                "explanation": _COMPAT_GLOBAL_CONCEPTS["pkm"]["short"],
                "aliases": _COMPAT_GLOBAL_CONCEPTS["pkm"]["aliases"],
            },
            {
                "id": "gmail_receipts",
                "label": "Gmail receipts",
                "explanation": _COMPAT_GLOBAL_CONCEPTS["gmail_receipts"]["short"],
                "aliases": _COMPAT_GLOBAL_CONCEPTS["gmail_receipts"]["aliases"],
            },
        ],
    },
    "profile_receipts": {
        "screenId": "profile_receipts",
        "title": "Gmail receipts",
        "purpose": "This page manages Gmail receipt sync, backfill state, stored receipts, and receipt-memory import into PKM.",
        "sections": [
            {
                "id": "receipt_memory",
                "title": "Receipt memory",
                "purpose": "This section previews and saves the compact receipt snapshot before it reaches PKM.",
            },
            {
                "id": "stored_receipts",
                "title": "Stored receipts",
                "purpose": "This section lists normalized stored receipts from Gmail.",
            },
        ],
        "controls": [
            {
                "id": "add_receipts_to_memory",
                "label": "Add receipts to memory",
                "purpose": "builds the receipts-memory preview from stored receipts.",
                "action_id": "profile.receipts_memory.preview",
                "role": "button",
                "voice_aliases": ["add receipts to memory", "build receipts memory preview"],
            },
            {
                "id": "save_receipts_memory",
                "label": "Save receipts memory to PKM",
                "purpose": "saves the current receipts-memory preview into shopping receipts memory.",
                "action_id": "profile.receipts_memory.save",
                "role": "button",
                "voice_aliases": ["save receipts memory", "save receipts memory to pkm"],
            },
        ],
        "concepts": [
            {
                "id": "pkm",
                "label": "PKM",
                "explanation": _COMPAT_GLOBAL_CONCEPTS["pkm"]["short"],
                "aliases": _COMPAT_GLOBAL_CONCEPTS["pkm"]["aliases"],
            }
        ],
    },
    "profile_pkm_agent_lab": {
        "screenId": "profile_pkm_agent_lab",
        "title": "PKM Agent Lab",
        "purpose": "This workspace previews, saves, and inspects encrypted PKM captures and permissions.",
        "sections": [
            {
                "id": "pkm_overview",
                "title": "PKM overview",
                "purpose": "This section summarizes current PKM state, domains, and capture context.",
            },
            {
                "id": "capture_preview",
                "title": "Latest capture preview",
                "purpose": "This section previews candidate PKM writes before they are saved.",
            },
            {
                "id": "domain_permissions",
                "title": "Domain permissions",
                "purpose": "This section manages permission exposure for PKM domains and scopes.",
            },
        ],
        "controls": [
            {
                "id": "generate_pkm_preview",
                "label": "Generate PKM preview",
                "purpose": "builds a preview of the current PKM capture without saving it.",
                "action_id": "profile.pkm.preview_capture",
                "role": "button",
                "voice_aliases": ["generate pkm preview"],
            },
            {
                "id": "save_pkm_capture",
                "label": "Save PKM capture",
                "purpose": "persists the current capture into encrypted PKM storage.",
                "action_id": "profile.pkm.save_capture",
                "role": "button",
                "voice_aliases": ["save pkm capture", "save pkm"],
            },
        ],
        "concepts": [
            {
                "id": "pkm",
                "label": "PKM",
                "explanation": _COMPAT_GLOBAL_CONCEPTS["pkm"]["short"],
                "aliases": _COMPAT_GLOBAL_CONCEPTS["pkm"]["aliases"],
            }
        ],
    },
    "profile_gmail_panel": {
        "screenId": "profile_gmail_panel",
        "title": "Gmail connector",
        "purpose": "This panel manages Gmail connection state and receipt-sync readiness.",
    },
    "dashboard": {
        "screenId": "dashboard",
        "title": "Portfolio",
        "purpose": "This screen is the portfolio workspace for holdings, imports, and optimization context.",
    },
    "home": {
        "screenId": "home",
        "title": "Market",
        "purpose": "This screen is the market overview workspace for live tape, signals, and discovery.",
    },
    "analysis": {
        "screenId": "analysis",
        "title": "Analysis",
        "purpose": "This screen is the research workspace for running and reviewing ticker analysis.",
    },
    "consents": {
        "screenId": "consents",
        "title": "Consents",
        "purpose": "This screen is the permission workspace for reviewing and managing data-sharing consent.",
    },
}


def _normalize_list_of_dicts(
    payload: Any,
    *,
    required_keys: tuple[str, ...],
) -> list[dict[str, Any]]:
    if not isinstance(payload, list):
        return []
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in payload:
        if not isinstance(raw, dict):
            continue
        item_id = _coerce_text(raw.get("id"))
        if not item_id or item_id in seen:
            continue
        item = {"id": item_id}
        for key in required_keys:
            item[key] = _coerce_text(raw.get(key))
        item["voice_aliases"] = _coerce_str_list(
            raw.get("voice_aliases") if "voice_aliases" in raw else raw.get("voiceAliases")
        )
        item["aliases"] = _coerce_str_list(raw.get("aliases"))
        if not all(item.get(key) for key in required_keys):
            continue
        items.append(item)
        seen.add(item_id)
    return items


def _merge_by_id(
    base_items: list[dict[str, Any]],
    overlay_items: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for item in base_items + overlay_items:
        if not item.get("id"):
            continue
        merged[item["id"]] = item
    return list(merged.values())


def build_surface_knowledge(*, screen: str, surface_payload: Any = None) -> dict[str, Any]:
    base = dict(_COMPAT_SURFACE_DEFINITIONS.get(screen, {}))
    if not isinstance(surface_payload, dict):
        return base
    overlay = {
        "screenId": _coerce_text(
            surface_payload.get("screen_id") or surface_payload.get("screenId")
        ),
        "title": _coerce_text(surface_payload.get("title")),
        "purpose": _coerce_text(surface_payload.get("purpose")),
        "primaryEntity": _coerce_text(
            surface_payload.get("primary_entity") or surface_payload.get("primaryEntity")
        ),
        "sections": _normalize_list_of_dicts(
            surface_payload.get("sections"),
            required_keys=("title", "purpose"),
        ),
        "actions": _normalize_list_of_dicts(
            surface_payload.get("actions"),
            required_keys=("label", "purpose"),
        ),
        "controls": _normalize_list_of_dicts(
            surface_payload.get("controls"),
            required_keys=("label", "purpose"),
        ),
        "concepts": _normalize_list_of_dicts(
            surface_payload.get("concepts"),
            required_keys=("label", "explanation"),
        ),
        "activeControlId": _coerce_text(
            surface_payload.get("active_control_id") or surface_payload.get("activeControlId")
        ),
        "lastInteractedControlId": _coerce_text(
            surface_payload.get("last_interacted_control_id")
            or surface_payload.get("lastInteractedControlId")
        ),
    }
    if not base:
        return overlay
    return {
        "screenId": overlay["screenId"] or base.get("screenId") or screen,
        "title": overlay["title"] or base.get("title"),
        "purpose": overlay["purpose"] or base.get("purpose"),
        "primaryEntity": overlay["primaryEntity"] or base.get("primaryEntity"),
        "sections": _merge_by_id(base.get("sections", []), overlay.get("sections", [])),
        "actions": _merge_by_id(base.get("actions", []), overlay.get("actions", [])),
        "controls": _merge_by_id(base.get("controls", []), overlay.get("controls", [])),
        "concepts": _merge_by_id(base.get("concepts", []), overlay.get("concepts", [])),
        "activeControlId": overlay["activeControlId"] or base.get("activeControlId"),
        "lastInteractedControlId": overlay["lastInteractedControlId"]
        or base.get("lastInteractedControlId"),
    }


def resolve_global_concept(transcript: str, *, detailed: bool = False) -> str | None:
    normalized = _normalize(transcript)
    for concept in _COMPAT_GLOBAL_CONCEPTS.values():
        if any(_matches_phrase(normalized, alias) for alias in concept["aliases"]):
            message = concept["detailed"] if detailed else concept["short"]
            return message if message.endswith((".", "!", "?")) else f"{message}."
    return None


def resolve_surface_explanation(
    transcript: str,
    *,
    screen: str,
    surface_payload: Any = None,
    active_section: str | None = None,
    active_tab: str | None = None,
    focused_widget: str | None = None,
    detailed: bool = False,
) -> str | None:
    normalized = _normalize(transcript)
    if not looks_like_voice_knowledge_request(transcript) and not _is_surface_overview_request(
        transcript
    ):
        return None

    surface = build_surface_knowledge(screen=screen, surface_payload=surface_payload)
    controls = surface.get("controls", [])
    sections = surface.get("sections", [])
    concepts = surface.get("concepts", [])
    title = _coerce_text(surface.get("title"))
    purpose = _coerce_text(surface.get("purpose"))

    if _is_surface_overview_request(transcript) or _references_current_surface(
        transcript,
        screen=screen,
        title=title,
    ):
        if title and purpose:
            if detailed:
                active_context = active_section or active_tab
                detail_parts = [
                    f"You are on {title}.",
                    purpose if purpose.endswith(".") else f"{purpose}.",
                ]
                if active_context:
                    detail_parts.append(f"The active area is {active_context}.")
                return " ".join(detail_parts)
            return f"You are on {title}. {purpose if purpose.endswith('.') else f'{purpose}.'}"

    references_control = any(
        token in normalized for token in ("this button", "this control", "this action", "this card")
    )
    if references_control:
        active_control = next(
            (
                control
                for control in controls
                if control.get("id")
                in {surface.get("activeControlId"), surface.get("lastInteractedControlId")}
            ),
            None,
        )
        if active_control is None and focused_widget:
            active_control = next(
                (
                    control
                    for control in controls
                    if _matches_phrase(_normalize(focused_widget), control.get("label", ""))
                ),
                None,
            )
        if active_control:
            label = _coerce_text(active_control.get("label")) or "This control"
            purpose = _coerce_text(active_control.get("purpose")) or "starts the current flow"
            return f"{label} {purpose if purpose.endswith('.') else f'{purpose}.'}"

    for control in controls:
        aliases = _coerce_str_list(control.get("voice_aliases")) or [control.get("label", "")]
        if any(_matches_phrase(normalized, alias) for alias in aliases if alias):
            label = _coerce_text(control.get("label")) or "This control"
            purpose = _coerce_text(control.get("purpose")) or "starts the current flow"
            return f"{label} {purpose if purpose.endswith('.') else f'{purpose}.'}"

    for concept in concepts:
        aliases = _coerce_str_list(concept.get("aliases")) or [concept.get("label", "")]
        if any(_matches_phrase(normalized, alias) for alias in aliases if alias):
            explanation = _coerce_text(concept.get("explanation"))
            if explanation:
                return explanation if explanation.endswith((".", "!", "?")) else f"{explanation}."

    references_section = "section" in normalized or "tab" in normalized or "panel" in normalized
    if references_section and (active_section or active_tab):
        current_section = _normalize(active_section or active_tab)
        for section in sections:
            if _matches_phrase(current_section, section.get("title", "")):
                label = _coerce_text(section.get("title")) or "This section"
                purpose = _coerce_text(section.get("purpose")) or "is the current focus area"
                return f"{label} {purpose if purpose.endswith('.') else f'{purpose}.'}"

    for section in sections:
        if _matches_phrase(normalized, section.get("title", "")):
            label = _coerce_text(section.get("title")) or "This section"
            purpose = _coerce_text(section.get("purpose")) or "is the current focus area"
            return f"{label} {purpose if purpose.endswith('.') else f'{purpose}.'}"

    return None
