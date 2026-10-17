"""The five ways a pod turn can diverge from the hub, named once.

This enum is the SINGLE SOURCE OF TRUTH shared by three consumers that would
otherwise drift:

  * the parity oracle's ``classify()`` (which failure a diff is),
  * the honest user-facing copy (what the person is told when a specialist
    refuses), and
  * the learning loop's routing table (which phase owns which failure).

The drift this prevents is concrete and already happened once: ``agent_tree``
emits the transient string *"The specialist runtime is unavailable... Please
try again"* for a STRUCTURAL absence (a pod holds no database credential, by
design) -- a lie about transience. When copy and classification are one enum,
that lie cannot be written: a structural class cannot be given retry copy.

Nothing here imports the runtime. It is pure vocabulary, so both the pod side
(which may run with a minimal dependency set) and the test harness can hold it.
"""

from __future__ import annotations

from enum import Enum


class ParityFailureClass(str, Enum):
    """A pod-vs-hub divergence, classified by CAUSE, not by symptom."""

    #: The hub emitted a directive (nav / action card / analysis.start) and the
    #: pod dropped its payload (returns only a count). Agent One in the pod
    #: cannot drive the app. Owner: directive-transport phase.
    DIRECTIVE_DROP = "directive_drop"

    #: A specialist that needs consent-gated records returned
    #: ``runtime_unavailable`` in the pod (no database credential, by design)
    #: while the hub returned ``ok``. Owner: data-door phase.
    DATA_DOOR_MISS = "data_door_miss"

    #: The pod-side authority gate refused a capability -- wrong scope, wrong
    #: owner-binding, forged, or expired. This is the CORRECT behaviour for a
    #: bad token and a FAILURE only when a legitimately-scoped read is refused.
    #: Owner: data-door phase (token gate).
    TOKEN_FAIL = "token_fail"  # noqa: S105 - a failure-class name, not a credential

    #: A second turn recalled prior context on the hub but not in the pod
    #: (pod-local memory not seeded / not enabled). Owner: memory phase.
    MEMORY_GAP = "memory_gap"

    #: The pod seeded an empty conversation history, losing within-conversation
    #: continuity the hub preserves. Owner: history phase.
    HISTORY_GAP = "history_gap"


#: Which phase owns remediation for each class. The learning loop routes a
#: surviving parity failure to its owner instead of a human triaging it.
PARITY_FAILURE_OWNERS: dict[ParityFailureClass, str] = {
    ParityFailureClass.DIRECTIVE_DROP: "phase-2-directive-transport",
    ParityFailureClass.DATA_DOOR_MISS: "phase-5-data-door",
    ParityFailureClass.TOKEN_FAIL: "phase-5-data-door",
    ParityFailureClass.MEMORY_GAP: "phase-4-pod-memory",
    ParityFailureClass.HISTORY_GAP: "phase-3-history",
}


#: Honest, class-specific user-facing copy. A STRUCTURAL class must never be
#: told to "try again": nothing the person does changes a design boundary. The
#: copy names what is true and what, if anything, is being done about it. These
#: replace the single transient string this whole discipline exists to retire.
PARITY_FAILURE_COPY: dict[ParityFailureClass, str] = {
    ParityFailureClass.DIRECTIVE_DROP: ("Your agent answered, but couldn't act on it here yet."),
    ParityFailureClass.DATA_DOOR_MISS: (
        "Your agent can't reach that part of your information from your private space yet."
    ),
    ParityFailureClass.TOKEN_FAIL: ("Your agent isn't permitted to read that right now."),
    ParityFailureClass.MEMORY_GAP: (
        "Your agent doesn't have the earlier part of this conversation yet."
    ),
    ParityFailureClass.HISTORY_GAP: ("Your agent lost the thread of this conversation."),
}


def copy_for(failure: ParityFailureClass) -> str:
    """The honest sentence for a failure class. Total by construction."""
    return PARITY_FAILURE_COPY[failure]


def owner_of(failure: ParityFailureClass) -> str:
    """Which phase remediates this class."""
    return PARITY_FAILURE_OWNERS[failure]


__all__ = [
    "PARITY_FAILURE_COPY",
    "PARITY_FAILURE_OWNERS",
    "ParityFailureClass",
    "copy_for",
    "owner_of",
]
