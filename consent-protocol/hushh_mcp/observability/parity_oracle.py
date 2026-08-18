"""The parity oracle: measures whether a pod turn behaves as the hub turn does.

Parity is a NUMBER this prints, not a claim. It observes the *delivered
contract* of each path -- what the browser actually receives -- normalizes both
into one canonical shape, diffs them under a defined equivalence, and classifies
every divergence into a :class:`ParityFailureClass` that routes to the phase
that owns it.

THE ONE MISTAKE THIS IS BUILT NOT TO MAKE
-----------------------------------------
Observe the DELIVERED contract, never the generator. The hub streams SSE frames
(``specialist_directive`` / ``tool_start`` / ``tool_waiting``); the pod returns a
dict. If the oracle inspected the agent graph or the pre-serialization directive
list, it would report parity that the wire does not actually carry -- the exact
"passes while both ends are wrong together" trap that let the directive-drop
defect live. So both sides are reduced to a :class:`TurnObservation` built ONLY
from bytes a client receives: hub frames in, pod return-dict in, same shape out.

BUILT ON ADK's EVAL FRAMEWORK, NOT BESIDE IT
--------------------------------------------
:class:`PodParityEvaluator` implements ``google.adk.evaluation.evaluator.Evaluator``
so a parity journey is an ordinary ADK eval case and a parity failure is an
ordinary ``EvalStatus.FAILED`` with a score in [0,1] -- consumable by the same
result managers, dashboards, and thresholds ADK already provides. The parity
*semantics* (five failure classes, hub-as-reference) are ours; the *machinery*
(status, per-invocation results, scoring) is ADK's.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Optional

from hushh_mcp.observability.parity_classes import ParityFailureClass


class EquivalenceMode(str, Enum):
    """How strict a diff is.

    EXACT is for the deterministic CI harness (scripted model, byte-level
    intent): the directive set and specialist-status set must match exactly.
    STRUCTURAL is for the live-dev smoke (a real LLM whose wording varies): only
    the PRESENCE/ABSENCE of a directive kind or a specialist *class* is compared,
    never the free text. A live smoke that demanded exact text would fail on
    paraphrase and teach the team to ignore it.
    """

    EXACT = "exact"
    STRUCTURAL = "structural"


@dataclass(frozen=True)
class DirectiveObservation:
    """One directive as it reaches the client, reduced to what parity cares about."""

    #: "action" | "prompt" (from OneTextDirective.kind), or "specialist" for a
    #: delegate directive that the hub emits as a specialist_directive frame.
    kind: str
    #: For an action directive, the gateway action id (e.g. "analysis.start").
    #: Empty for prompt/specialist directives.
    action_id: str = ""
    #: For a delegate directive, the specialist agent id.
    delegate_agent_id: str = ""

    def key(self, mode: EquivalenceMode) -> tuple[str, ...]:
        """The comparison key.

        Both modes currently key on (kind, action_id, delegate) -- a directive's
        identity, never its free text, so paraphrase never breaks a diff. ``mode``
        is threaded through for the day a directive gains a text-bearing field
        that EXACT should compare and STRUCTURAL should not; keeping the parameter
        now avoids re-plumbing every call site then.
        """
        return (self.kind, self.action_id, self.delegate_agent_id)


@dataclass(frozen=True)
class SpecialistObservation:
    """A specialist One consulted, and whether it actually served."""

    agent_id: str
    #: "ok" | "runtime_unavailable" | "authority_required" | other status the
    #: specialist turn reported. The parity-critical value is whether it is "ok".
    status: str

    @property
    def served(self) -> bool:
        return self.status == "ok"


@dataclass(frozen=True)
class TurnObservation:
    """The delivered contract of ONE turn, path-agnostic.

    Built identically from a hub frame stream or a pod return dict, so the two
    can be compared as equals. Carries no message text, no projection, no slots
    -- only the parity-bearing shape (see the oracle docstring's privacy line).
    """

    path: str  # "hub" | "pod" -- provenance only, never part of equivalence
    has_text: bool
    grounded: bool
    runtime_mode: str
    directives: tuple[DirectiveObservation, ...] = ()
    specialists: tuple[SpecialistObservation, ...] = ()
    #: True when the pod signalled directives existed (directiveCount>0) but did
    #: not carry their payloads. This is the directive-drop fingerprint and it is
    #: recorded explicitly so the classifier never has to infer it from absence.
    directives_dropped: bool = False


@dataclass(frozen=True)
class ParityDiff:
    """The result of comparing a pod turn against its hub reference."""

    at_parity: bool
    failures: tuple[ParityFailureClass, ...] = ()
    detail: tuple[str, ...] = ()

    @property
    def owners(self) -> tuple[str, ...]:
        from hushh_mcp.observability.parity_classes import owner_of

        return tuple(dict.fromkeys(owner_of(f) for f in self.failures))


# ---- normalizers: DELIVERED bytes -> TurnObservation -------------------------


def observe_hub(
    frames: list[dict[str, Any]], *, grounded: bool = False, runtime_mode: str = "hub"
) -> TurnObservation:
    """Build the reference observation from the hub's emitted SSE frames.

    Each frame is ``{"event": str, "data": dict}`` as the chat route emits. Only
    directive-bearing and specialist-bearing frames matter; token/text frames
    contribute ``has_text`` and nothing else.
    """
    directives: list[DirectiveObservation] = []
    specialists: list[SpecialistObservation] = []
    has_text = False
    for frame in frames:
        event = str(frame.get("event") or "")
        data = frame.get("data") or {}
        if event in ("token", "message", "final"):
            has_text = has_text or bool(str(data.get("text") or data.get("delta") or ""))
        elif event == "tool_start":
            directives.append(
                DirectiveObservation(kind="action", action_id=str(data.get("action_id") or ""))
            )
        elif event == "specialist_directive":
            inner = data.get("directive") or {}
            directives.append(
                DirectiveObservation(
                    kind="specialist",
                    delegate_agent_id=str(data.get("delegate_agent_id") or ""),
                )
            )
            _ = inner  # payload text deliberately not observed
        elif event == "specialist_status":
            specialists.append(
                SpecialistObservation(
                    agent_id=str(data.get("agent_id") or data.get("delegate_agent_id") or ""),
                    status=str(data.get("status") or ""),
                )
            )
    # De-duplicate tool_start + tool_waiting for the same action into one directive.
    directives = _dedupe_directives(directives)
    return TurnObservation(
        path="hub",
        has_text=has_text,
        grounded=grounded,
        runtime_mode=runtime_mode,
        directives=tuple(directives),
        specialists=tuple(specialists),
    )


def observe_pod(
    turn: dict[str, Any], *, specialist_statuses: Optional[list[dict[str, str]]] = None
) -> TurnObservation:
    """Build the observation from the pod turn's DELIVERED return dict.

    Today the pod returns ``{text, grounded, directiveCount, runtimeMode, ...}``
    -- the directive PAYLOADS are dropped, only the count survives. So an
    observation of a real pod turn has ``directives_dropped=True`` whenever
    ``directiveCount>0`` while ``directives`` is empty. When the directive-
    transport phase lands, the pod will carry ``directives`` / ``frames`` and
    this normalizer reads them the same way :func:`observe_hub` reads frames.

    ``specialist_statuses`` is threaded separately because the pod return does
    not (today) enumerate specialist outcomes; the harness supplies them from the
    turn's structured log line.
    """
    frames = turn.get("frames")
    directives: list[DirectiveObservation] = []
    dropped = False
    if isinstance(frames, list) and frames:
        # Post-transport pod: frames present -> read them exactly as the hub's
        # are read, then re-stamp the provenance to "pod".
        return _rebuild_pod_from_frames(turn, frames)
    directive_count = int(turn.get("directiveCount") or 0)
    if directive_count > 0:
        # Count without payloads == the directive-drop fingerprint.
        dropped = True
    specialists = [
        SpecialistObservation(
            agent_id=str(s.get("agent_id") or ""), status=str(s.get("status") or "")
        )
        for s in (specialist_statuses or [])
    ]
    return TurnObservation(
        path="pod",
        has_text=bool(str(turn.get("text") or "")),
        grounded=bool(turn.get("grounded")),
        runtime_mode=str(turn.get("runtimeMode") or "pod"),
        directives=tuple(directives),
        specialists=tuple(specialists),
        directives_dropped=dropped,
    )


def _rebuild_pod_from_frames(turn: dict[str, Any], frames: list[dict[str, Any]]) -> TurnObservation:
    obs = observe_hub(
        frames,
        grounded=bool(turn.get("grounded")),
        runtime_mode=str(turn.get("runtimeMode") or "pod"),
    )
    return TurnObservation(
        path="pod",
        has_text=obs.has_text or bool(str(turn.get("text") or "")),
        grounded=obs.grounded,
        runtime_mode=obs.runtime_mode,
        directives=obs.directives,
        specialists=obs.specialists,
        directives_dropped=False,
    )


def _dedupe_directives(directives: list[DirectiveObservation]) -> list[DirectiveObservation]:
    seen: set[tuple[str, str, str]] = set()
    out: list[DirectiveObservation] = []
    for d in directives:
        k = (d.kind, d.action_id, d.delegate_agent_id)
        if k in seen:
            continue
        seen.add(k)
        out.append(d)
    return out


# ---- the diff + classifier ---------------------------------------------------


def classify(pod: TurnObservation, hub: TurnObservation, mode: EquivalenceMode) -> ParityDiff:
    """Diff a pod turn against its hub reference; name every divergence.

    Hub is the reference. A divergence is only ever a pod DEFICIT relative to the
    hub (a pod doing MORE than the hub is out of scope for parity and ignored).
    """
    failures: list[ParityFailureClass] = []
    detail: list[str] = []

    hub_dirs = {d.key(mode) for d in hub.directives}
    pod_dirs = {d.key(mode) for d in pod.directives}
    missing_dirs = hub_dirs - pod_dirs
    if missing_dirs or (pod.directives_dropped and hub_dirs):
        failures.append(ParityFailureClass.DIRECTIVE_DROP)
        if pod.directives_dropped:
            detail.append(f"pod dropped directive payloads; hub delivered {len(hub_dirs)}")
        else:
            detail.append(f"pod missing directives: {sorted(missing_dirs)}")

    hub_served = {s.agent_id for s in hub.specialists if s.served}
    pod_status = {s.agent_id: s.status for s in pod.specialists}
    for agent_id in hub_served:
        status = pod_status.get(agent_id)
        if status == "ok":
            continue
        if status in ("runtime_unavailable", None):
            failures.append(ParityFailureClass.DATA_DOOR_MISS)
            detail.append(f"specialist {agent_id}: hub=ok pod={status or 'absent'}")
        elif status in ("authority_required",):
            # Refused on both sides is parity of a non-working arm, not a pod
            # regression -- only a pod-ONLY refusal is a data-door miss.
            hub_status = next((s.status for s in hub.specialists if s.agent_id == agent_id), "ok")
            if hub_status != status:
                failures.append(ParityFailureClass.TOKEN_FAIL)
                detail.append(f"specialist {agent_id}: hub={hub_status} pod={status}")

    deduped = tuple(dict.fromkeys(failures))
    return ParityDiff(at_parity=not deduped, failures=deduped, detail=tuple(detail))


__all__ = [
    "DirectiveObservation",
    "EquivalenceMode",
    "ParityDiff",
    "SpecialistObservation",
    "TurnObservation",
    "classify",
    "observe_hub",
    "observe_pod",
]
