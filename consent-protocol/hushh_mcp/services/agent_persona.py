"""State-aware persona composer for One's realtime voice and typed chat.

This is the single place that turns the agent's active state into a system
instruction. It replaces the two hard-coded instruction strings that previously
lived inline in ``agent_realtime_gemini.py`` (full vs intro) with a tiered
assembly so the agent can speak to the user's actual situation: their access
tier, the screen they are on, and the active persona (investor vs RIA).

Design (mirrors the Hermes 3-tier prompt pattern):
  - stable:   identity and the hard safety boundary that never changes.
  - context:  the surface the user is on (screen) and the active persona lens.
  - volatile: the live access/cache tier and what the user can/can't do right now.

Security:
  - Realtime voice and STT do not expose raw vault/PKM data or provider-native
    function calls, so the instruction must never claim completed actions or
    private data access without explicit redacted app-state evidence. The
    composer still allows One to discuss governed finance workflows when the
    active route/action contracts expose Kai capabilities.
  - Any client-supplied context (screen id, persona) is scanned for prompt
    injection and sanitized before it is interpolated into the instruction.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal, Optional, Sequence

# Access tiers, aligned with the frontend AgentAccessTier in
# hushh-webapp/lib/agent/agent-runtime-context.tsx.
AgentTier = Literal[
    "anon_onboarding",
    "anon_browsing",
    "signed_locked",
    "signed_unlocked",
]

# Persona lens, aligned with the frontend Persona type (investor | ria).
AgentPersona = Literal["investor", "ria"]
CacheFreshness = Literal["fresh_or_stale_safe", "locked", "missing"]

_VALID_TIERS: frozenset[str] = frozenset(
    {"anon_onboarding", "anon_browsing", "signed_locked", "signed_unlocked"}
)
_VALID_PERSONAS: frozenset[str] = frozenset({"investor", "ria"})

# Patterns that indicate an attempt to override the system instruction. Injected
# context that matches any of these is dropped rather than interpolated.
_INJECTION_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"ignore\s+(all\s+)?(previous|prior|above)\s+instructions", re.IGNORECASE),
    re.compile(r"disregard\s+(all\s+)?(previous|prior|above)", re.IGNORECASE),
    re.compile(r"you\s+are\s+now\s+", re.IGNORECASE),
    re.compile(r"system\s*prompt", re.IGNORECASE),
    re.compile(r"</?\s*(system|instruction|assistant|user)\s*>", re.IGNORECASE),
    re.compile(r"\bact\s+as\b", re.IGNORECASE),
)

# A conservative allow-list for screen identifiers: lowercase words, digits,
# hyphens, underscores and slashes only. Anything else is rejected.
_SCREEN_ID_PATTERN = re.compile(r"^[a-z0-9_\-/]{1,64}$")
_ACTION_ID_PATTERN = re.compile(r"^[a-z0-9_.:/-]{1,96}$")
_SAFE_LABEL_PATTERN = re.compile(r"^[a-z0-9][a-z0-9 _./:-]{0,63}$", re.IGNORECASE)


@dataclass(frozen=True)
class AgentPersonaContext:
    """Normalized, safe inputs for composing a persona instruction."""

    tier: AgentTier
    screen: Optional[str]
    persona: AgentPersona
    route_family: Optional[str] = None
    voice_state: Optional[str] = None
    available_action_ids: tuple[str, ...] = ()
    visible_modules: tuple[str, ...] = ()
    cache_freshness: Optional[CacheFreshness] = None
    vault_ready: Optional[bool] = None
    portfolio_ready: Optional[bool] = None


def _contains_injection(value: str) -> bool:
    return any(pattern.search(value) for pattern in _INJECTION_PATTERNS)


def sanitize_screen(raw: Optional[str]) -> Optional[str]:
    """Return a safe screen id, or None when the input is unusable/suspicious."""
    if not raw:
        return None
    candidate = raw.strip().lower()
    if not candidate:
        return None
    if _contains_injection(candidate):
        return None
    if not _SCREEN_ID_PATTERN.match(candidate):
        return None
    return candidate


def sanitize_action_id(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    candidate = raw.strip().lower()
    if not candidate:
        return None
    if _contains_injection(candidate):
        return None
    if not _ACTION_ID_PATTERN.match(candidate):
        return None
    return candidate


def sanitize_label(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    candidate = " ".join(raw.strip().split())
    if not candidate:
        return None
    if _contains_injection(candidate):
        return None
    if not _SAFE_LABEL_PATTERN.match(candidate):
        return None
    return candidate[:64]


def _sanitize_sequence(
    values: Optional[Sequence[str]],
    sanitizer,
    *,
    limit: int = 10,
) -> tuple[str, ...]:
    if not values:
        return ()
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        clean = sanitizer(value)
        if not clean or clean in seen:
            continue
        seen.add(clean)
        out.append(clean)
        if len(out) >= limit:
            break
    return tuple(out)


def normalize_tier(raw: Optional[str]) -> AgentTier:
    candidate = (raw or "").strip().lower()
    if candidate in _VALID_TIERS:
        return candidate  # type: ignore[return-value]
    # Unknown/missing tier degrades to the safest pre-vault tier.
    return "anon_onboarding"


def normalize_persona(raw: Optional[str]) -> AgentPersona:
    candidate = (raw or "").strip().lower()
    if candidate in _VALID_PERSONAS:
        return candidate  # type: ignore[return-value]
    return "investor"


def build_persona_context(
    *,
    tier: Optional[str],
    screen: Optional[str] = None,
    persona: Optional[str] = None,
    route_family: Optional[str] = None,
    voice_state: Optional[str] = None,
    available_action_ids: Optional[Sequence[str]] = None,
    visible_modules: Optional[Sequence[str]] = None,
    cache_freshness: Optional[str] = None,
    vault_ready: Optional[bool] = None,
    portfolio_ready: Optional[bool] = None,
) -> AgentPersonaContext:
    """Validate + sanitize raw inputs into a persona context."""
    normalized_voice_state = (voice_state or "").strip().lower()
    if normalized_voice_state not in {
        "idle",
        "opening",
        "listening",
        "understanding",
        "intent_preview",
        "needs_consent",
        "acting",
        "navigation_settling",
        "result",
        "follow_up",
        "error_recovery",
    }:
        normalized_voice_state = ""
    normalized_cache_freshness = (cache_freshness or "").strip().lower()
    if normalized_cache_freshness not in {"fresh_or_stale_safe", "locked", "missing"}:
        normalized_cache_freshness = ""
    return AgentPersonaContext(
        tier=normalize_tier(tier),
        screen=sanitize_screen(screen),
        persona=normalize_persona(persona),
        route_family=sanitize_screen(route_family),
        voice_state=normalized_voice_state or None,
        # 18 mirrors the frontend AVAILABLE_ACTION_IDS_CAP: screen segment (10)
        # plus the reserved global navigation segment (8).
        available_action_ids=_sanitize_sequence(available_action_ids, sanitize_action_id, limit=18),
        visible_modules=_sanitize_sequence(visible_modules, sanitize_label),
        cache_freshness=(normalized_cache_freshness or None),  # type: ignore[arg-type]
        vault_ready=vault_ready if isinstance(vault_ready, bool) else None,
        portfolio_ready=portfolio_ready if isinstance(portfolio_ready, bool) else None,
    )


# --- Tier 1: stable identity + hard safety boundary (never changes) ---------

_STABLE_IDENTITY = (
    "You are One, the Agent First personal agent inside Hussh. You hold the "
    "relationship layer, orchestrate specialist subagents through governed "
    "A2A/ADK-style contracts, and speak warmly and concisely."
)

# Realtime voice / STT may expose proposal-only provider tool calls, but never
# provider-side execution or raw private data. This boundary is identical across
# tiers so the agent never claims private access or completed execution without
# app confirmation.
_STABLE_VOICE_BOUNDARY = (
    "In this realtime voice conversation provider-native function calling may "
    "only be used to propose a generated Hussh action id with slots and a reason; "
    "it never executes tools. Treat listed action contracts and visible app state "
    "as redacted capabilities for intelligent intent understanding, navigation "
    "guidance, specialist delegation, and consent-aware previews; do not claim an "
    "app action completed unless the app confirms it. Prefer reasoning from these "
    "system instructions and contracts over memorized shortcuts or hard-coded "
    "phrases. "
    "Never claim access to raw vault data, PKM documents, secrets, transcript "
    "history, or private portfolio holdings unless the redacted cache posture says "
    "the relevant data is ready and the user or visible app state supplies enough "
    "context. You may answer ordinary low-risk general-knowledge questions from "
    "your model knowledge, but public/app knowledge fetches and private connected "
    "system reads must be proposed as governed app goals when the user needs "
    "freshness, evidence, or their own data. If the user shares a durable "
    "preference or asks you to remember something, offer a PKM review/confirmation "
    "path; never save inferred memory directly from the transcript. For finance, "
    "Kai is the specialist contract: answer stock, market, "
    "and portfolio-analysis questions within these boundaries instead of refusing "
    "categorically. Do not guarantee returns, give legal or tax advice, place "
    "trades, move money, or bypass confirmation. Answer plainly in English."
)


# --- Tier 2: contextual surface (screen + persona lens) ---------------------

_PERSONA_LENS: dict[AgentPersona, str] = {
    "investor": ("The person is using Hussh as an individual investor managing their own money."),
    "ria": (
        "The person is a registered investment adviser using Hussh for their "
        "advisory practice and clients."
    ),
}


def _describe_action_inputs(manifest_action: dict) -> str:
    """Render a compact MCP-tool-style parameter signature for one action.

    Mirrors how tool schemas read to coding agents: each required input shows
    its slot name, and defaults are stated inline so the model knows it never
    needs to ask a clarifying question for an input the contract already
    answers. Example: "inputs: symbol=<ticker>, pickSource default 'default'".
    """
    goal = manifest_action.get("goal")
    if not isinstance(goal, dict):
        return ""
    required_inputs = goal.get("required_inputs")
    if not isinstance(required_inputs, list) or not required_inputs:
        return ""
    rendered: list[str] = []
    for entry in required_inputs:
        if not isinstance(entry, dict):
            continue
        slot = sanitize_label(str(entry.get("slot") or entry.get("name") or ""))
        if not slot:
            continue
        default_value = sanitize_label(str(entry.get("default_value") or ""))
        if default_value:
            rendered.append(f"{slot} default '{default_value}'")
            continue
        resolver = sanitize_label(str(entry.get("resolver") or ""))
        rendered.append(f"{slot}=<{resolver or 'value'}>")
        if len(rendered) >= 4:
            break
    if not rendered:
        return ""
    return "; inputs: " + ", ".join(rendered)


def _describe_action_contract(action_id: str, ctx: AgentPersonaContext) -> str:
    """Render one action id like an MCP tool doc: label, param signature, lock.

    The manifest load is process-cached (lru_cache), so this adds no I/O on the
    hot token/relay path. Labels + input signatures give the model the same
    affordance a coding agent gets from a tool schema: it can propose the
    action with slots filled (using contract defaults) instead of guessing
    from a bare id or asking questions the contract already answers. The app
    still enforces every guard at execution time.
    """
    try:
        from hushh_mcp.services.voice_action_manifest import get_voice_manifest_action

        manifest_action = get_voice_manifest_action(action_id)
    except Exception:  # noqa: BLE001 - instruction enrichment is best-effort
        manifest_action = None
    if not manifest_action:
        return action_id
    label = sanitize_label(str(manifest_action.get("label") or ""))
    guard_ids = {
        str(guard.get("id") or "").strip()
        for guard in (manifest_action.get("guards") or [])
        if isinstance(guard, dict)
    }
    locked_hint = ""
    if "vault_unlocked" in guard_ids and ctx.vault_ready is not True:
        locked_hint = " [locked until vault unlock]"
    elif {"auth_signed_in", "auth_required"} & guard_ids and ctx.tier in {
        "anon_onboarding",
        "anon_browsing",
    }:
        locked_hint = " [requires sign-in]"
    inputs_hint = _describe_action_inputs(manifest_action)
    if label:
        return f"{action_id} ({label}{inputs_hint}){locked_hint}"
    return f"{action_id}{locked_hint}"


def _context_clause(ctx: AgentPersonaContext) -> str:
    parts: list[str] = [_PERSONA_LENS[ctx.persona]]
    if ctx.screen:
        parts.append(f"They are currently on the '{ctx.screen}' screen.")
    if ctx.route_family and ctx.route_family != ctx.screen:
        parts.append(f"The current route family is '{ctx.route_family}'.")
    if ctx.visible_modules:
        parts.append("Visible app modules: " + ", ".join(ctx.visible_modules) + ".")
    if ctx.available_action_ids:
        described = [
            _describe_action_contract(action_id, ctx) for action_id in ctx.available_action_ids
        ]
        parts.append(
            "Available app action contracts (route.* navigation contracts work "
            "from any screen): " + ", ".join(described) + "."
        )
    if ctx.voice_state:
        parts.append(f"The current voice transition state is '{ctx.voice_state}'.")
    cache_parts: list[str] = []
    if ctx.cache_freshness:
        cache_parts.append(f"cache freshness is '{ctx.cache_freshness}'")
    if ctx.vault_ready is not None:
        cache_parts.append("vault is ready" if ctx.vault_ready else "vault is not ready")
    if ctx.portfolio_ready is not None:
        cache_parts.append(
            "portfolio context is available"
            if ctx.portfolio_ready
            else "portfolio context is not available"
        )
    if cache_parts:
        parts.append("Redacted app readiness: " + "; ".join(cache_parts) + ".")
    return " ".join(parts)


def _has_finance_capability(ctx: AgentPersonaContext) -> bool:
    finance_markers = (
        "kai",
        "analysis",
        "portfolio",
        "investment",
        "investments",
        "stock",
        "market",
        "optimize",
        "ria_picks",
    )
    surface_text = " ".join(
        value for value in (ctx.screen or "", ctx.route_family or "", *ctx.visible_modules) if value
    ).lower()
    if any(marker in surface_text for marker in finance_markers):
        return True
    for action_id in ctx.available_action_ids:
        if (
            action_id.startswith("route.kai")
            or action_id.startswith("analysis.")
            or action_id.startswith("kai.")
            or action_id.startswith("ria.picks")
            or action_id.startswith("ria.client_workspace.open_portfolio")
        ):
            return True
    return False


def _finance_clause(ctx: AgentPersonaContext) -> str:
    if _has_finance_capability(ctx):
        return (
            "Kai finance capability is in scope for this turn. Do not say you are "
            "unable to provide stock analysis or portfolio analysis solely because "
            "the topic is financial. Use the available Kai action contracts and "
            "current screen state to explain what can be analyzed, preview the next "
            "governed step, or guide the user to the analysis, portfolio, import, "
            "investments, or optimize surface. If holdings or live market data are "
            "not present in the visible/redacted context, say what data is missing "
            "and offer the appropriate Kai route instead of inventing data."
        )
    return (
        "If the user asks for finance while the current surface does not expose "
        "Kai finance contracts, do not issue a blanket refusal. Explain that Kai "
        "handles stock, market, and portfolio analysis, then offer to route them "
        "to the governed Kai analysis or portfolio surface."
    )


# --- Tier 3: volatile access state (what the user can do right now) ----------

_TIER_STATE: dict[AgentTier, str] = {
    "anon_onboarding": (
        "They are still getting started and have not unlocked their private vault "
        "yet. Help them understand Hussh and how to get set up, and when they want "
        "to do something with their own data, invite them to sign in and unlock "
        "their vault. You may propose the listed low-risk navigation contracts "
        "(such as continuing onboarding or opening sign-in) to move them forward; "
        "actions marked as locked need sign-in or vault unlock first."
    ),
    "anon_browsing": (
        "They are browsing Hussh without being signed in. Help them understand "
        "what Hussh can do, and invite them to sign in when they want to act on "
        "their own data. You may propose the listed low-risk navigation contracts "
        "to guide them; actions marked as locked need sign-in first."
    ),
    "signed_locked": (
        "They are signed in but their vault is locked, so private data is not "
        "available right now. Help with general questions, public-market reasoning, "
        "and route guidance. For their own holdings or saved financial context, "
        "ask them to unlock the vault first."
    ),
    "signed_unlocked": (
        "They are signed in with their vault unlocked. You may acknowledge that the "
        "vault/cache posture is ready when the redacted context says so, but data "
        "access and sensitive execution still require governed app actions and "
        "confirmation."
    ),
}


def compose_voice_instructions(ctx: AgentPersonaContext) -> str:
    """Compose the realtime-voice system instruction for the given state."""
    return " ".join(
        [
            _STABLE_IDENTITY,
            _context_clause(ctx),
            _finance_clause(ctx),
            _TIER_STATE[ctx.tier],
            _STABLE_VOICE_BOUNDARY,
        ]
    )
