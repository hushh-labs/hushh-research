"""The one place that declares what "wired" means for every pod capability.

WHY THIS EXISTS
---------------
Eight times this workstream, a mechanism shipped complete, correct, and covered by
tests, yet reached nothing on the live serving path: a door enabled in no lane, a
ledger switched on nowhere, a key nothing wrote, a migration flag rendered into the
pod from a hub variable no deploy lane ever set. Every one was found by a human
reading the wiring by hand. None was caught by CI.

The root enabler was that no single place declared the wiring. A capability's flag
is *emitted* by ``scripts/deploy/backend-deploy.sh``, *rendered* into the per-pod
Cloud Run env by ``gcp_backend.render_deploy_config``, and *read* by a runtime
consumer -- three files, and nothing joined them. That is the exact "reader and
writer of one vocabulary in two files, with nothing comparing them" shape that
``test_pod_status_vocabulary_is_one_vocabulary`` was written to kill for the status
vocabulary. This registry generalises that discipline to the whole capability
surface.

This module is DECLARATION ONLY: the intent that cannot be derived from code --
which lane a capability should be on in, and whether it is a pod-read or a hub-read
capability. Everything derivable (what the deploy script actually emits, what the
backend actually renders, what the runtime actually reads) is parsed from the real
files by ``test_pod_capability_wiring_is_closed_loop`` and cross-checked against
these declarations. A capability cannot then ship emitted-but-unread,
rendered-but-unemitted, declared-but-dead, or on-in-intent-but-off-in-lane, and a
newly added pod flag cannot escape the loop, because the guard fails until it is
declared here.

HOW TO ADD A CAPABILITY
-----------------------
Add one ``PodCapability`` row. Pick ``locus`` by where it is consumed: ``"pod"`` if
a module inside the pod's own router allowlist reads it (it must then be RENDERED
into the pod env), ``"hub"`` if only the hub's routers read it (no render needed).
Pick ``dev_intent``: ``"on"`` if the dev lane must set it truthy, ``"parked"`` if it
is deliberately not wired into any lane yet (the guard then asserts it stays
consistently absent, so it cannot half-ship). The guard tells you exactly which
wiring link is missing.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PodCapability:
    """One pod capability flag, and the intent the guard checks reality against."""

    #: The environment variable, spelled exactly. HUSSH_* (double-s) is the pod
    #: family; HUSHH_* is the lane family. A one-letter drift fails closed and
    #: silently, so this string is the load-bearing part of the row.
    env_var: str

    #: Where the capability is consumed. ``"pod"`` => a module inside the pod's
    #: own router allowlist reads it, so it MUST be rendered into the per-pod
    #: Cloud Run env by ``gcp_backend.render_deploy_config``. ``"hub"`` => only the
    #: hub's routers read it, so it needs deploy-emit + a reader but no render.
    locus: str

    #: The dev lane's intended state. ``"on"`` => the dev block must emit it
    #: truthy (and, for a pod capability, render it "true"). ``"parked"`` => it is
    #: deliberately unwired; the guard asserts it is emitted by no lane and
    #: rendered into no pod, so flipping it on later forces the full wiring.
    dev_intent: str

    #: One line: what it gates, and why its intent is what it is. Read by a human
    #: debugging a red guard, so keep it concrete.
    why: str


#: The canonical set. The guard closes the loop over this list; nothing else is
#: the source of truth for pod capability wiring.
POD_CAPABILITIES: tuple[PodCapability, ...] = (
    # -- pod-read capabilities: consumed inside the pod, so they MUST render ------
    PodCapability(
        env_var="HUSSH_POD_TURN_ENABLED",
        locus="pod",
        dev_intent="on",
        why="the pod runs Agent One; off, POST /api/one/pod/turn 404s",
    ),
    PodCapability(
        env_var="POD_LOCAL_PKM_ENABLED",
        locus="pod",
        dev_intent="on",
        why="the pod grounds itself from its own commit-log-derived index",
    ),
    PodCapability(
        env_var="POD_DURABLE_IDENTITY_ENABLED",
        locus="pod",
        dev_intent="on",
        why="the pod recovers a durable identity key from its own sealed storage",
    ),
    PodCapability(
        env_var="HUSSH_POD_MIGRATION_ENABLED",
        locus="pod",
        dev_intent="on",
        why="the in-pod export/import routes the migration rehearsal drives",
    ),
    # -- hub-read capabilities: consumed by the hub's routers, no render needed ---
    PodCapability(
        env_var="POD_DATA_DOOR_ENABLED",
        locus="hub",
        dev_intent="on",
        why="the consent-gated read doors that let an in-pod specialist see owner state",
    ),
    PodCapability(
        env_var="CONSENT_AUDIT_CHAIN_ENABLED",
        locus="hub",
        dev_intent="on",
        why="the tamper-evident per-subject consent audit hash chain",
    ),
    PodCapability(
        env_var="POD_DIRECTIVE_TRANSPORT_ENABLED",
        locus="hub",
        dev_intent="on",
        why="action frames from pod turns; off, the relay strips every frame",
    ),
    PodCapability(
        env_var="POD_HUB_IDENTITY_AUTH_ENABLED",
        locus="hub",
        dev_intent="on",
        why="the hub verifies a pod's signed identity proof on its callbacks",
    ),
    # -- parked: deliberately unwired, tracked so they cannot be silently forgotten
    PodCapability(
        env_var="HUSSH_POD_MANAGED_MODEL_ENABLED",
        locus="pod",
        dev_intent="parked",
        why="managed-Gemini pods; parked behind per-pod identity, wired in no lane",
    ),
    PodCapability(
        env_var="HUSSH_POD_NATIVE_GROUNDING_ENABLED",
        locus="pod",
        dev_intent="parked",
        why="in-pod native grounding; not yet wired into any lane",
    ),
    PodCapability(
        env_var="HUSSH_POD_AUTOHEAL_ENABLED",
        locus="hub",
        dev_intent="parked",
        why="fleet autoheal; not yet wired into any lane",
    ),
    PodCapability(
        env_var="POD_FLEET_HEALTH_SIGNAL_ENABLED",
        locus="hub",
        dev_intent="parked",
        why="fleet health signal; not yet wired into any lane",
    ),
)


def pod_capabilities() -> tuple[PodCapability, ...]:
    return POD_CAPABILITIES


def by_env_var() -> dict[str, PodCapability]:
    return {cap.env_var: cap for cap in POD_CAPABILITIES}


__all__ = ["PodCapability", "POD_CAPABILITIES", "pod_capabilities", "by_env_var"]
