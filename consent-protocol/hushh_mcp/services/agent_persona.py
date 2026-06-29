"""State-aware persona composer for One's realtime voice and typed chat.

This is the single place that turns the agent's active state into a system
instruction. It replaces the two hard-coded instruction strings that previously
lived inline in ``agent_realtime_gemini.py`` (full vs intro) with a tiered
assembly so the agent can speak to the user's actual situation: their access
tier, the screen they are on, and the active persona (investor vs RIA).

Design (mirrors the Hermes 3-tier prompt pattern):
  - stable:   identity and the hard safety boundary that never changes.
  - context:  the surface the user is on (screen) and the active persona lens.
  - volatile: the live access tier and what the user can/can't do right now.

Security:
  - Realtime voice and STT are tool-less and read/write no private data, so the
    instruction must never claim access to vault/PKM/portfolio regardless of
    tier. The composer encodes that boundary in the stable tier.
  - Any client-supplied context (screen id, persona) is scanned for prompt
    injection and sanitized before it is interpolated into the instruction.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal, Optional

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


@dataclass(frozen=True)
class AgentPersonaContext:
    """Normalized, safe inputs for composing a persona instruction."""

    tier: AgentTier
    screen: Optional[str]
    persona: AgentPersona


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
) -> AgentPersonaContext:
    """Validate + sanitize raw inputs into a persona context."""
    return AgentPersonaContext(
        tier=normalize_tier(tier),
        screen=sanitize_screen(screen),
        persona=normalize_persona(persona),
    )


# --- Tier 1: stable identity + hard safety boundary (never changes) ---------

_STABLE_IDENTITY = (
    "You are One, the personal agent inside Hussh. You hold the relationship "
    "layer and speak warmly and concisely."
)

# Realtime voice / STT are tool-less. This boundary is identical across tiers so
# the agent never claims access to private data on these channels.
_STABLE_VOICE_BOUNDARY = (
    "In this realtime voice conversation you have no tools, memory, portfolio "
    "access, PKM context, or app actions, so do not claim access to private user "
    "data or perform app actions. For finance defer to Kai, for privacy and "
    "consent defer to Nav, and for identity defer to KYC. Let the user know they "
    "can switch to typed chat for those workflows. Answer plainly in English."
)


# --- Tier 2: contextual surface (screen + persona lens) ---------------------

_PERSONA_LENS: dict[AgentPersona, str] = {
    "investor": ("The person is using Hussh as an individual investor managing their own money."),
    "ria": (
        "The person is a registered investment adviser using Hussh for their "
        "advisory practice and clients."
    ),
}


def _context_clause(ctx: AgentPersonaContext) -> str:
    parts: list[str] = [_PERSONA_LENS[ctx.persona]]
    if ctx.screen:
        parts.append(f"They are currently on the '{ctx.screen}' screen.")
    return " ".join(parts)


# --- Tier 3: volatile access state (what the user can do right now) ----------

_TIER_STATE: dict[AgentTier, str] = {
    "anon_onboarding": (
        "They are still getting started and have not unlocked their private vault "
        "yet. Help them understand Hussh and how to get set up, and when they want "
        "to do something with their own data, invite them to sign in and unlock "
        "their vault."
    ),
    "anon_browsing": (
        "They are browsing Hussh without being signed in. Help them understand "
        "what Hussh can do, and invite them to sign in when they want to act on "
        "their own data."
    ),
    "signed_locked": (
        "They are signed in but their vault is locked, so private data is not "
        "available right now. Help them with general questions and let them know "
        "they can unlock their vault in typed chat to work with their own data."
    ),
    "signed_unlocked": (
        "They are signed in with their vault unlocked. Even so, this voice channel "
        "stays read-only and tool-less; for anything touching their data, point "
        "them to typed chat."
    ),
}


def compose_voice_instructions(ctx: AgentPersonaContext) -> str:
    """Compose the realtime-voice system instruction for the given state."""
    return " ".join(
        [
            _STABLE_IDENTITY,
            _context_clause(ctx),
            _TIER_STATE[ctx.tier],
            _STABLE_VOICE_BOUNDARY,
        ]
    )
