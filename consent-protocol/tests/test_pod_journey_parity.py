"""The parity ruler, as a test. Phase 1 of the pod-journey-parity plan.

This does NOT assert the pod is at parity today -- it demonstrably is not, by
construction (directive drop + data-door miss are live). It asserts the ORACLE
correctly MEASURES the gap: each golden journey classifies into the failure
class the audit predicted, the reference journeys are non-vacuous, and the
pod's zero-database-credential posture holds so a future green oracle can never
certify a database grant.

As each remediation phase lands, its journey's pod_turn fixture is updated to
the fixed delivered contract and its assertion flips from "this class fires" to
"at parity" -- the same file, the same test, the divergence closing in place.
That is the loop: the ruler is written first and stays; the reality it measures
moves toward it.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from hushh_mcp.observability.parity_classes import (
    PARITY_FAILURE_COPY,
    ParityFailureClass,
    copy_for,
)
from hushh_mcp.observability.parity_evaluator import load_corpus

_CORPUS = load_corpus()
_BY_NAME = {j.name: j for j in _CORPUS}


def test_the_corpus_is_present_and_loads():
    assert _CORPUS, "no golden journeys found — the ruler has nothing to measure"
    for journey in _CORPUS:
        # A malformed/vacuous reference raises here; a green corpus means every
        # journey actually asserts something on the hub side.
        journey.assert_reference_is_not_vacuous()


def test_a_fully_matching_turn_is_at_parity():
    """The grounded turn does the same thing on both paths — the control."""
    diff = _BY_NAME["grounded_turn"].run()
    assert diff.at_parity, f"expected parity, got {diff.failures} :: {diff.detail}"


def test_the_debate_launch_is_a_directive_drop_today():
    """The decisive gap: hub emits analysis.start, pod carries only a count."""
    diff = _BY_NAME["analyze_nvidia_debate"].run()
    assert ParityFailureClass.DIRECTIVE_DROP in diff.failures, diff.detail
    assert diff.owners == ("phase-2-directive-transport",)


@pytest.mark.parametrize("name", ["location_question", "consent_question"])
def test_db_backed_specialists_are_a_data_door_miss_today(name: str):
    """Location and consent serve on the hub, refuse in the pod (no DB cred)."""
    diff = _BY_NAME[name].run()
    assert ParityFailureClass.DATA_DOOR_MISS in diff.failures, diff.detail
    assert "phase-5-data-door" in diff.owners


def test_every_failure_class_has_honest_nontransient_copy():
    """The copy that replaces 'please try again'. A structural class must never
    be told to retry — assert the copy carries no transient promise."""
    for cls in ParityFailureClass:
        assert cls in PARITY_FAILURE_COPY, f"{cls} has no user-facing copy"
        text = copy_for(cls).lower()
        for transient in ("try again", "please retry", "temporarily"):
            assert transient not in text, (
                f"{cls} copy makes a transient promise for a structural condition: {text!r}"
            )


def test_the_pod_holds_zero_database_credentials():
    """The invariant that keeps a green oracle honest: no parity 'fix' may hand
    the pod a Postgres credential. If this fires, a data-door design regressed
    into a DB grant, and every downstream parity claim is void."""
    root = Path(__file__).resolve().parents[1]
    creds = ("DB_USER", "DB_PASSWORD", "DB_HOST", "DB_UNIX_SOCKET", "DATABASE_URL")
    for rel in (
        "hushh_mcp/services/gcp_backend.py",
        "hushh_mcp/services/user_gcp_backend.py",
    ):
        body = (root / rel).read_text()
        for cred in creds:
            assert cred not in body, (
                f"{rel} references {cred}: the pod's zero-role identity is the whole "
                "point; a specialist must reach data through the hub broker, never a "
                "database credential in the pod."
            )
