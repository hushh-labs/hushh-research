"""Where the agent's knowledge of its owner comes from, and how honest that is.

The design today, stated plainly
--------------------------------
Grounding is CLIENT-MEDIATED. The browser holds the vault key, decrypts the
person's holdings locally, serializes them, and posts the plaintext back as
``pkm_context`` on each turn. The hub never holds the vault key, which is a real
zero-knowledge property and not an accident -- it is why the server cannot simply
read someone's records to ground their agent.

It also has a cost that only shows up off the happy path: **grounding requires a
browser with an unlocked vault.** Anything else gets none. A pod-hosted agent, the
iOS shell, an A2A call from another person's agent, a proactive turn taken while
its owner is asleep -- all of them reach the model with no knowledge of the person
they serve. An "always-on private agent" that only knows you while you are looking
at it is not the product; it is a chat box with a good memory of the current tab.

What this module adds
---------------------
A second, POD-NATIVE source. A pod already holds the person's records: an
encrypted commit log plus a SQLite index (S4), wrapped to the POD's own key rather
than to the browser's, with consent verified asymmetrically so the pod needs no
hub round trip (S5). A pod can therefore ground its own agent without a browser
being open anywhere.

This resolver picks the source and, crucially, SAYS WHICH ONE IT PICKED. Provenance
is a returned field rather than a log line because "the agent knew this because the
client told it" and "the agent knew this because it read its owner's records" are
different trust statements, and downstream -- telemetry, receipts, and eventually
the person's own audit view -- has to be able to tell them apart.

The refusal that matters
------------------------
Pod-native grounding is REFUSED when the pod's key is ephemeral. Durable holdings
are wrapped only to a durable key (``pod_key_is_durable``), so an ephemeral-key pod
can open nothing. Reading anyway would return an empty set, and an empty set is
indistinguishable from "this person has no records" -- the agent would then say, with
total confidence, that it knows nothing about someone whose holdings are sitting
right there, sealed. That is the same false-negative shape as a 200 on an empty
page, and it is worse than having no grounding at all, because it is a confident
wrong answer instead of an absent one.

Ship-dark: ``HUSSH_POD_NATIVE_GROUNDING_ENABLED`` is off by default, so the live
client-mediated path is untouched until someone turns this on deliberately.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Where a turn's grounding actually came from. Reported, never inferred.
SOURCE_CLIENT = "client"
SOURCE_POD = "pod"
SOURCE_NONE = "none"

# The model context budget for grounding, matched to the existing client contract
# (``agent_chat`` caps ``pkm_context`` at 20000) so switching source cannot silently
# change how much the agent is told.
_MAX_GROUNDING_CHARS = 20000


@dataclass(frozen=True)
class Grounding:
    """The text handed to the agent, and the honest story of where it came from."""

    text: str
    source: str
    reason: str

    @property
    def is_grounded(self) -> bool:
        return bool(self.text.strip())


def _truncate(text: str) -> str:
    return str(text or "").strip()[:_MAX_GROUNDING_CHARS]


async def resolve_grounding(
    *,
    user_id: str,
    client_context: Optional[str] = None,
    store: Any = None,
    pod_native_enabled: Optional[bool] = None,
    key_is_durable: Optional[bool] = None,
) -> Grounding:
    """Choose a grounding source for one turn. Never mixes two.

    Order is deliberate: a pod that can read its OWN records is a better authority
    on its owner than a blob the caller supplied, so it wins when available. The
    client blob remains the fallback rather than being removed, because today it is
    the only source that works for a browser turn and deleting it would take
    grounding away from the one surface that currently has it.

    Every argument is injectable so the decision is testable without a pod, a vault
    key, or an environment.
    """
    enabled = (
        pod_native_enabled if pod_native_enabled is not None else _pod_native_grounding_enabled()
    )
    client_text = _truncate(client_context or "")

    if not enabled:
        return _client_or_none(client_text, "pod-native grounding is off")

    if store is None:
        return _client_or_none(client_text, "no pod store on this host")

    durable = key_is_durable if key_is_durable is not None else _key_is_durable()
    if not durable:
        # The refusal in the module docstring. Reading with an ephemeral key would
        # yield an empty set that reads as "you have no records".
        logger.warning("pkm_grounding.refused reason=ephemeral_pod_key user_id=%s", user_id)
        return _client_or_none(
            client_text,
            "pod key is ephemeral; sealed holdings cannot be opened, so an empty "
            "read would be a false negative",
        )

    try:
        text = _truncate(await _read_pod_grounding(store, user_id))
    except Exception as exc:  # noqa: BLE001 - a failed read falls back, never 500s a turn
        logger.warning("pkm_grounding.pod_read_failed %s", type(exc).__name__)
        return _client_or_none(client_text, f"pod read failed: {type(exc).__name__}")

    if not text:
        # Genuinely nothing stored. Distinct from the refusal above: here the pod
        # COULD read and there was nothing, which is a truthful empty. Fall back to
        # the client only if it actually has something, so a person mid-migration
        # (records still client-side, pod not yet populated) is not silently
        # downgraded to an unknowing agent.
        return _client_or_none(client_text, "pod holds no records for this owner yet")

    return Grounding(text=text, source=SOURCE_POD, reason="read from the pod's own store")


def _client_or_none(client_text: str, reason: str) -> Grounding:
    if client_text:
        return Grounding(text=client_text, source=SOURCE_CLIENT, reason=reason)
    # No grounding at all, and that is reported rather than papered over. An
    # ungrounded turn is a real state -- the agent should know it does not know.
    return Grounding(text="", source=SOURCE_NONE, reason=reason)


async def _read_pod_grounding(store: Any, user_id: str) -> str:
    """Ask the pod's store for this owner's grounding text.

    Kept as one seam so the store's read shape can change without this module's
    decision logic moving.
    """
    snapshot = await store.get_domain_snapshot({"user_id": user_id})
    if snapshot is None:
        return ""
    if isinstance(snapshot, str):
        return snapshot
    # A structured snapshot is rendered by the store's own contract when it has
    # one; anything else is stringified rather than guessed at, so a shape change
    # shows up as odd context rather than a crash mid-turn.
    render = getattr(snapshot, "as_grounding_text", None)
    if callable(render):
        return str(render())
    return str(snapshot)


def _pod_native_grounding_enabled() -> bool:
    from hushh_mcp.runtime_settings import pod_native_grounding_enabled  # noqa: PLC0415

    return pod_native_grounding_enabled()


def _key_is_durable() -> bool:
    try:
        from hushh_mcp.services.pod_self_registration import (  # noqa: PLC0415
            pod_key_is_durable,
        )

        return bool(pod_key_is_durable())
    except Exception:  # noqa: BLE001 - not in a pod, or no key: treat as not durable
        return False
