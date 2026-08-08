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
from pathlib import Path

# Repo-root anchored: this file is consent-protocol/hushh_mcp/one_adk/one_persona.py
# parents[0]=one_adk, [1]=hushh_mcp, [2]=consent-protocol, [3]=repo root.
_REGISTRY_PATH = (
    Path(__file__).resolve().parents[3] / "contracts" / "agents" / "product-agent-registry.v2.json"
)

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
    try:
        payload = json.loads(_REGISTRY_PATH.read_text(encoding="utf-8"))
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


def build_one_persona_grounding(roster_ids: list[str]) -> str:
    """Compose the durable persona core with the generated specialist catalog."""
    return _ONE_PERSONA_CORE + build_specialist_capability_catalog(list(roster_ids))
