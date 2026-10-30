"""Reconciles voice-settings domain keys with what they actually cover.

Three namespaces disagree with each other here, and nothing else in the
codebase lines them up:

- UI-facing domain keys the person actually sees and toggles (see
  ``hushh-webapp/lib/agent/voice-engine-domains.ts``).
- Action-gateway id prefixes (``location.*``, ``consent.*``, ...).
- Specialist ``agent_id``s (``agent_location``, ``agent_nav``, ...).

Nav's own action prefix is ``consent``; its agent id is ``agent_nav``. This
module is the one place that expands a domain key into both of the things
that are actually checked -- action-id prefix (``run_app_action``,
``start_app_goal``) and specialist delegation
(``resolve_specialist_availability``, ``_specialist_turn``) -- so a
restriction means the same thing wherever it is enforced.

Deliberately excludes Finance and Calendar. Finance is a native ADK
``AgentTool`` on One's own tool list; Calendar is seven raw function tools.
Neither goes through either choke point below, so listing them here would
create a domain key that silently enforces nothing.
"""

from __future__ import annotations

VOICE_DOMAIN_ACTION_PREFIXES: dict[str, frozenset[str]] = {
    "location": frozenset({"location"}),
    "email": frozenset({"email"}),
    "connected_systems": frozenset({"connected_systems"}),
    "consent": frozenset({"consent"}),
    "connections": frozenset({"connections"}),
    "kyc": frozenset({"kyc"}),
}

# Location also reaches an open-ended conversational specialist
# (ask_location_agent) for requests with no generated action equivalent
# (check-in, SOS). KYC has no conversational specialist at all -- it is an
# in-app workflow, never a direct ask_* tool -- so it is action-gateway-only.
VOICE_DOMAIN_SPECIALIST_IDS: dict[str, frozenset[str]] = {
    "location": frozenset({"agent_location"}),
    "email": frozenset({"agent_email"}),
    "connected_systems": frozenset({"agent_connected_systems"}),
    "consent": frozenset({"agent_nav"}),
    "connections": frozenset({"agent_connections"}),
    "kyc": frozenset(),
}


# Mirrors the labels in voice-engine-domains.ts, so a refusal spoken here
# names the same thing the settings panel does.
VOICE_DOMAIN_LABELS: dict[str, str] = {
    "location": "Location",
    "email": "Email",
    "connected_systems": "Connected Systems",
    "consent": "Consent Center",
    "connections": "Connections",
    "kyc": "identity verification",
}


def voice_domain_label(domain: str | None) -> str:
    """A spoken-safe name for a domain key.

    Accepts None because every real call site resolves it from
    resolve_voice_domain() first (typed str | None) and only reaches this
    function once is_voice_domain_disabled() has already confirmed it is
    not None -- but that narrowing does not cross the function boundary, so
    this stays total rather than asserting a fact the type checker cannot see.
    """
    if not domain:
        return "this"
    return VOICE_DOMAIN_LABELS.get(domain, domain)


def resolve_voice_domain(action_id: str | None) -> str | None:
    """The voice-settings domain key an action id belongs to, or None.

    None covers both "not a domain-scoped action" (route.*, analysis.*, ...)
    and "unrecognised" -- either way, nothing here should ever be restricted
    by a voice domain toggle.
    """
    prefix = str(action_id or "").strip().split(".", 1)[0]
    if not prefix:
        return None
    for domain, prefixes in VOICE_DOMAIN_ACTION_PREFIXES.items():
        if prefix in prefixes:
            return domain
    return None


def resolve_voice_domain_for_specialist(agent_id: str | None) -> str | None:
    """The voice-settings domain key a specialist agent_id belongs to, or None."""
    clean_id = str(agent_id or "").strip()
    if not clean_id:
        return None
    for domain, agent_ids in VOICE_DOMAIN_SPECIALIST_IDS.items():
        if clean_id in agent_ids:
            return domain
    return None


def is_voice_domain_disabled(domain: str | None, disabled_domains: object) -> bool:
    """Whether the person has turned voice off for this domain.

    ``domain`` is None for anything not covered by a voice toggle (global
    navigation, Finance, Calendar, an unrecognised id) -- those are never
    restricted here, whatever ``disabled_domains`` contains.
    """
    if not domain or not isinstance(disabled_domains, (list, tuple, set, frozenset)):
        return False
    return domain in disabled_domains


def is_voice_entirely_disabled(voice_settings: object) -> bool:
    """Whether the person has turned the whole voice agent off (the master
    Voice control switch), independent of any per-domain toggle.

    Fails open (False) for anything not a dict -- absent context (non-live
    callers, tests, an older cached snapshot) must never block an
    already-authorized action, matching sanitize_voice_settings' own
    fail-open default and every other read of this dict.
    """
    if not isinstance(voice_settings, dict):
        return False
    return voice_settings.get("voice_enabled") is False
