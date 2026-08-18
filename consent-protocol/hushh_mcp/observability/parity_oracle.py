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
    #: For an action directive, whether it carries a real execution target
    #: (execution == "frontend"). A directive with the right action_id but no
    #: execution target is HOLLOW -- it cannot drive the app, which is the exact
    #: thing directive_drop exists to catch. Keyed in EXACT mode so a hollow pod
    #: directive can never satisfy the set-difference against a real hub one.
    dispatchable: bool = True

    def key(self, mode: EquivalenceMode) -> tuple[str, ...]:
        """The comparison key.

        Identity (kind, action_id, delegate) in both modes -- never free text, so
        paraphrase never breaks a diff. EXACT additionally requires the directive
        be DISPATCHABLE, so a hollow action directive (right id, no execution
        target, no args) fails the diff instead of passing as parity. STRUCTURAL
        (the live smoke, real LLM) keeps identity only, because a live turn's
        exact slot fill varies and demanding it would train the team to ignore
        the smoke.
        """
        base = (self.kind, self.action_id, self.delegate_agent_id)
        if mode is EquivalenceMode.EXACT and self.kind == "action":
            return (*base, "dispatchable" if self.dispatchable else "hollow")
        return base


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
    """The result of comparing a pod turn against its hub reference.

    ``failures`` are the five remediation-owning classes. ``regressions`` are
    FUNDAMENTAL divergences that map to no phase because they mean the turn did
    not fundamentally work in the pod -- the pod produced no text where the hub
    did, or lost grounding the hub had. Both gate parity: a turn is at parity
    only when it has neither a classified failure nor a fundamental regression.
    Separating them keeps the phase-routing table clean while still refusing to
    certify a silent or ungrounded pod as equivalent.
    """

    failures: tuple[ParityFailureClass, ...] = ()
    regressions: tuple[str, ...] = ()
    detail: tuple[str, ...] = ()

    @property
    def at_parity(self) -> bool:
        return not self.failures and not self.regressions

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
        elif event in ("tool_start", "tool_waiting"):
            # tool_start and tool_waiting are the two frames of ONE action
            # directive; either carries the action_id, and the pair is collapsed
            # by the dedupe below. Observing both means a hub that signals an
            # action only via tool_waiting is still seen as having the directive.
            directives.append(
                DirectiveObservation(
                    kind="action",
                    action_id=str(data.get("action_id") or ""),
                    # Dispatchable only when it names a real execution target. A
                    # frame with an action_id but no "frontend" execution cannot
                    # drive the app; it is a hollow directive, not a real one.
                    dispatchable=str(data.get("execution") or "") == "frontend",
                )
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
    """Collapse the tool_start/tool_waiting pair into one directive.

    Dispatchability is OR-ed across the pair: if EITHER frame named a real
    execution target, the merged directive is dispatchable. So a real directive
    whose waiting frame happened to omit execution is not demoted to hollow.
    """
    by_key: dict[tuple[str, str, str], DirectiveObservation] = {}
    order: list[tuple[str, str, str]] = []
    for d in directives:
        k = (d.kind, d.action_id, d.delegate_agent_id)
        if k in by_key:
            prev = by_key[k]
            by_key[k] = DirectiveObservation(
                kind=prev.kind,
                action_id=prev.action_id,
                delegate_agent_id=prev.delegate_agent_id,
                dispatchable=prev.dispatchable or d.dispatchable,
            )
        else:
            by_key[k] = d
            order.append(k)
    return [by_key[k] for k in order]


# ---- the diff + classifier ---------------------------------------------------


def classify(pod: TurnObservation, hub: TurnObservation, mode: EquivalenceMode) -> ParityDiff:
    """Diff a pod turn against its hub reference; name every divergence.

    Hub is the reference. A divergence is only ever a pod DEFICIT relative to the
    hub (a pod doing MORE than the hub is out of scope for parity and ignored).
    """
    failures: list[ParityFailureClass] = []
    regressions: list[str] = []
    detail: list[str] = []

    hub_dirs = {d.key(mode) for d in hub.directives}
    pod_dirs = {d.key(mode) for d in pod.directives}
    missing_dirs = hub_dirs - pod_dirs
    if missing_dirs or (pod.directives_dropped and hub_dirs):
        failures.append(ParityFailureClass.DIRECTIVE_DROP)
        if pod.directives_dropped:
            detail.append(f"pod dropped directive payloads; hub delivered {len(hub_dirs)}")
        else:
            detail.append(f"pod missing/hollow directives: {sorted(missing_dirs)}")

    hub_served = {s.agent_id for s in hub.specialists if s.served}
    pod_status = {s.agent_id: s.status for s in pod.specialists}
    hub_status_of = {s.agent_id: s.status for s in hub.specialists}
    for agent_id in hub_served:
        status = pod_status.get(agent_id)
        if status == "ok":
            continue
        # A pod-side authority refusal that ALSO refuses on the hub is parity of a
        # non-working arm, not a pod regression -- skip only that exact case.
        if status == "authority_required" and hub_status_of.get(agent_id) == "authority_required":
            continue
        if status == "authority_required":
            # Refused only in the pod -> a token-gate failure, not a data miss.
            failures.append(ParityFailureClass.TOKEN_FAIL)
            detail.append(f"specialist {agent_id}: hub=ok pod=authority_required")
            continue
        # EVERY other outcome -- runtime_unavailable, absent, '', 'error',
        # 'timeout', any status the audit did not anticipate -- is a data-door
        # miss. There is no fall-through: a hub-served specialist that did not
        # serve 'ok' in the pod is a gap, full stop. (The original ladder had no
        # `else`, so an unanticipated status silently certified parity -- the
        # fatal false-parity hole this closes.)
        failures.append(ParityFailureClass.DATA_DOOR_MISS)
        detail.append(f"specialist {agent_id}: hub=ok pod={status or 'absent'}")

    # FUNDAMENTAL regressions: the turn did not fundamentally work in the pod.
    # These map to no remediation phase but must still refuse parity, or the
    # control journey (a plain grounded turn) would certify a silent, ungrounded
    # pod as equivalent to a texting, grounded hub.
    if hub.has_text and not pod.has_text:
        regressions.append("pod produced no text where the hub did")
    if hub.grounded and not pod.grounded:
        regressions.append("pod lost grounding the hub had")

    return ParityDiff(
        failures=tuple(dict.fromkeys(failures)),
        regressions=tuple(regressions),
        detail=tuple(detail),
    )


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
