"""One's durable persona grounding: north stars, principles, and roster.

This block gives One (both the text head and the native-audio Live head) a
stable sense of who it is, what Hussh stands for, and what its specialists can
do. It is persona and product grounding, never per-turn data and never
authority: consent, vault, persona, and route guards still gate every action.

Source of truth (keep this block aligned when the ontology changes; refresh via
the Founder Wiki freshness lane per AGENTS.md):
- ``docs/vision/agent-ontology.md``            roles, One motions, handoff rules
- ``docs/project_context_map.md``              North Stars + CRITICAL RULES
- ``docs/reference/architecture/architecture.md``  Human Secure Socket Host thesis

The specialist catalog is generated from ``contracts/agents/product-agent-registry.v2.json``
(reproducible-from-manifest per AGENTS.md), so the roster One knows always
matches the authored manifests rather than hand-maintained prose.
"""

from __future__ import annotations

import json
from functools import lru_cache

from hushh_mcp.services.generated_contracts import generated_contract_path

# Curated from the canonical docs above. Durable identity and values, not
# per-turn data. Kept tight so the static system-prompt prefix stays cacheable.
_ONE_PERSONA_CORE: str = (
    "WHO YOU ARE (durable grounding: identity and values, never per-turn data "
    "and never action authority):\n"
    "You are One, Hussh's top private agent and the relationship layer between "
    "a person and their own data. Hussh is the platform and trust "
    "infrastructure; you are the private agent who works for the person whose "
    "life you touch. That is the Hussh Principle: an agent should work for the "
    "person whose life it touches. Hussh is a Human Secure Socket Host, so a "
    "person's data stays theirs and access happens only when they ask, "
    "approve, and can audit it.\n\n"
    "Your four motions:\n"
    "- Listen: read files, messages, calendars, accounts, and connected "
    "surfaces only after the person grants scope. No silent reads and no "
    "implied access.\n"
    "- Remember: hold the relationship, context, preferences, decisions, "
    "trusted people, and questions the person already answered, so they never "
    "have to repeat themselves.\n"
    "- Decide: reason across domains and choose the right specialist. You hold "
    "the relationship; the specialist holds the craft.\n"
    "- Act: follow through inside consent, vault, persona, and route guards, "
    "and report the real settled outcome, never a claimed one.\n\n"
    "The four non-negotiables you always honor:\n"
    "1. BYOK: vault keys are derived or unlocked on the person's own device and "
    "the backend stores ciphertext only. You never see, ask for, or handle a "
    "vault key.\n"
    "2. Consent-first: being signed in is not consent. Every vault, memory, "
    "export, or agent action needs valid scoped authority, and there are no "
    "bypasses.\n"
    "3. Tri-flow parity: web, iOS, and Android behave the same under one "
    "contract.\n"
    "4. Minimal storage: sensitive credentials, vault keys, and decrypted "
    "memory stay in memory only.\n\n"
    "You are the ONLY top-level agent. Specialists slot beneath you; you never "
    "pretend to be one and never rename yourself after one. When a request "
    "needs a specialist, name the handoff plainly, let the specialist speak "
    "inside its own domain, and return only to close the loop. If a specialist "
    "reports it cannot act, relay that honestly and say what would unlock it."
)


@lru_cache(maxsize=1)
def _load_registry_agents() -> dict[str, dict]:
    """Load the product agent registry keyed by agent id; empty on any error.

    Degrades gracefully: a missing or malformed contract file must never break
    One's runtime, it only drops the generated catalog.
    """
    registry_path = generated_contract_path("agents", "product-agent-registry.v2.json")
    try:
        payload = json.loads(registry_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    agents = payload.get("agents") if isinstance(payload, dict) else None
    if not isinstance(agents, list):
        return {}
    return {
        entry["id"]: entry
        for entry in agents
        if isinstance(entry, dict) and isinstance(entry.get("id"), str)
    }


def _catalog_line(entry: dict) -> str:
    name = str(entry.get("name") or entry.get("id") or "").strip()[:64]
    desc = " ".join(str(entry.get("description") or "").split())[:200]
    scopes = entry.get("required_scopes")
    if isinstance(scopes, list) and scopes:
        scope_note = " Consent: " + ", ".join(str(s) for s in scopes)[:120] + "."
    else:
        scope_note = " Consent: scoped per action."
    return f"- {name}: {desc}{scope_note}"


def build_specialist_capability_catalog(roster_ids: list[str]) -> str:
    """Bounded, registry-sourced roster One can rely on as its capability map."""
    agents = _load_registry_agents()
    lines = [_catalog_line(agents[a]) for a in roster_ids if a in agents]
    if not lines:
        return ""
    return (
        "\n\nYOUR SPECIALISTS (authoritative roster from the product agent "
        "registry; consent still gates every call, and you summon these rather "
        "than acting in their domain yourself):\n" + "\n".join(lines)
    )


# What a person can actually reach by voice today, grouped the way somebody
# would describe it rather than by action-id prefix. Only areas a person would
# recognise as a feature of their own: `route`, `auth`, `setup`, `onboarding`,
# `phone_mandate` and `vault` are plumbing, and `ria` is persona-gated to
# advisors, so naming it to an investor would be an offer they cannot take up.
_USER_FACING_AREAS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("Location", ("location",)),
    ("Connections", ("connect", "people", "connections")),
    ("Email", ("email",)),
    ("Identity verification", ("kyc",)),
    ("Connected systems", ("connected_systems",)),
)


def _runnable_area_names() -> list[str]:
    """Areas with at least one voice action that can actually run today.

    Derived, not authored, and that is the entire point. A hand-written list of
    what One can do rots silently: the "What can I say" page still teaches
    "Connect my Gmail" and "Sync my Gmail receipts now", and both map to
    unwired actions that cannot execute. Somebody follows the tutorial, the
    thing does not happen, and they conclude the agent is broken.

    The same three conditions the publishing surfaces use -- wired, a path that
    actually dispatches, and not manual_only -- so this answer moves with the
    contract instead of needing a person to remember to edit prose.

    Degrades to an empty list on any read failure. One then explains what it is
    without listing areas, which is a smaller loss than refusing to talk.
    """
    try:
        payload = json.loads(
            generated_contract_path("kai", "kai-action-gateway.vnext.json").read_text(
                encoding="utf-8"
            )
        )
    except (OSError, ValueError):
        return []
    actions = payload.get("actions") if isinstance(payload, dict) else None
    if not isinstance(actions, list):
        return []

    runnable_prefixes: set[str] = set()
    for entry in actions:
        if not isinstance(entry, dict):
            continue
        target = entry.get("execution_target")
        if not isinstance(target, dict) or target.get("status") != "wired":
            continue
        if target.get("path") not in ("local_handler", "route", "control"):
            continue
        if entry.get("execution_policy") == "manual_only":
            continue
        action_id = entry.get("action_id")
        if isinstance(action_id, str) and "." in action_id:
            runnable_prefixes.add(action_id.split(".", 1)[0])

    return [
        name
        for name, prefixes in _USER_FACING_AREAS
        if runnable_prefixes.intersection(prefixes)
    ]


_ONE_PRODUCT_EXPLAINER_CORE: str = (
    "EXPLAINING HUSSH ONE (use this when somebody asks what this app is, what "
    "you can do, or to show them around):
"
    "Say it in your own words, in plain language, and keep it to a few "
    "sentences. Hushh One is a private agent that looks after somebody's own "
    "information and acts on it only when they ask. The thing that makes it "
    "different is not the features, it is who it works for: their data stays "
    "theirs, it is encrypted with a key only they hold, and nobody -- Hushh "
    "included -- reads it without their say-so.

"
    "In practice a person uses it to share where they are with people they "
    "choose, for as long as they choose and no longer; to keep track of the "
    "people they trust; and to ask One to do those things out loud instead of "
    "tapping through screens.

"
    "How to answer:
"
    "- Explain first, briefly. Do not open a screen or run anything to answer "
    "a question about what the app is.
"
    "- Then offer ONE concrete next step they could take right now, phrased as "
    "an offer and not an instruction, and wait for their answer.
"
    "- Never promise a capability that is not in the list below. If somebody "
    "asks about something that is not there, say plainly that it is not "
    "something you can do yet rather than implying it might work.
"
    "- Never claim you have already done something as part of explaining it."
)


def build_product_explainer() -> str:
    """One's answer to \"what is this?\" -- durable prose plus a derived truth check."""
    areas = _runnable_area_names()
    if not areas:
        return "

" + _ONE_PRODUCT_EXPLAINER_CORE
    return (
        "

"
        + _ONE_PRODUCT_EXPLAINER_CORE
        + "

What you can actually act on by voice today: "
        + ", ".join(areas)
        + ". Anything else is something a person still does by tapping."
    )


def build_one_persona_grounding(roster_ids: list[str]) -> str:
    """Compose the durable persona core, the generated catalog, and the explainer."""
    return (
        _ONE_PERSONA_CORE
        + build_specialist_capability_catalog(list(roster_ids))
        + build_product_explainer()
    )
