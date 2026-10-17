"""Admission must not report a specialist ready and then refuse it.

`resolve_specialist_availability` had NO test file at all, which is how its
authority pre-gate became dead code without anyone noticing: the branch tested
`not is_wired_specialist(agent_id)` -- whether the specialist was REGISTERED --
and once all three authority-ingress specialists were wired the condition could
never fire again. Admission answered `ready`, dispatch then raised
`EXACT_AUTHORITY_REQUIRED`, and the accurate per-specialist messages in
`_specialist_turn` were unreachable.

Registration is not authorisation. These tests pin that distinction.
"""

from __future__ import annotations

import dataclasses
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hushh_mcp.adk_bridge.contract import (  # noqa: E402
    A2AAuthorityContext,
    supplies_exact_authority,
)
from hushh_mcp.one_adk.specialist_availability import (  # noqa: E402
    _AUTHORITY_INGRESS_ONLY,
    resolve_specialist_availability,
)

USER = "HA1AVAIL0000001"
TOKEN = "consent-token-stub"  # noqa: S105 - a placeholder, never validated here


def _availability(agent_id: str, **kw):
    return resolve_specialist_availability(
        agent_id=agent_id,
        user_id=USER,
        consent_token=TOKEN,
        voice_context={},
        **kw,
    )


def _invocation_only() -> A2AAuthorityContext:
    """Exactly what a first-party hop carries today: permission to start, nothing more."""
    return A2AAuthorityContext(
        subject_user_id=USER,
        tenant_id=USER,
        task_id="task-1",
        caller_kind="first_party",
        invocation_capabilities=("custom.temporary",),
    )


# -- the derived predicate ------------------------------------------------------------


def test_invocation_alone_is_not_exact_authority() -> None:
    """Permission to START a task is not permission to read holdings or act."""
    assert supplies_exact_authority(None) is False
    assert supplies_exact_authority(_invocation_only()) is False


def test_any_ref_or_capability_counts_as_exact_authority() -> None:
    """Derived from the object, so it opens automatically when refs start flowing."""
    base = _invocation_only()
    for field, value in (
        ("information_grant_refs", ("grant",)),
        ("encrypted_export_refs", ("export",)),
        ("action_capabilities", ("act",)),
    ):
        assert supplies_exact_authority(dataclasses.replace(base, **{field: value})) is True


# -- the pre-gate ---------------------------------------------------------------------


def test_a_specialist_that_will_refuse_is_never_reported_ready() -> None:
    """The defect, stated directly.

    All three of these are registered and would pass every other admission check.
    Reporting them `ready` is a promise the very next call breaks.
    """
    for agent_id in sorted(_AUTHORITY_INGRESS_ONLY):
        result = _availability(agent_id, exact_authority_available=False)
        assert result.state == "authority_required", (
            f"{agent_id} was reported {result.state!r} while carrying no exact authority"
        )
        assert result.reason_code == "exact_a2a_authority_required"


def test_registration_is_not_what_opens_the_gate() -> None:
    """The exact shape of the original bug.

    All three specialists ARE wired -- `is_wired_specialist` returns True for each.
    If admission is keyed on registration rather than authority, this passes for the
    wrong reason and the assertion above silently stops meaning anything.
    """
    import hushh_mcp.adk_bridge  # noqa: F401,PLC0415 - side-effect registration
    from hushh_mcp.adk_bridge.dispatch import is_wired_specialist  # noqa: PLC0415

    for agent_id in sorted(_AUTHORITY_INGRESS_ONLY):
        assert is_wired_specialist(agent_id) is True, (
            f"{agent_id} is unwired, so this test can no longer distinguish "
            "registration from authorisation"
        )
        assert _availability(agent_id, exact_authority_available=False).state == (
            "authority_required"
        )


def test_the_gate_opens_when_exact_authority_arrives() -> None:
    """Self-healing: the day a first-party hop carries real refs, admission follows."""
    for agent_id in sorted(_AUTHORITY_INGRESS_ONLY):
        assert _availability(agent_id, exact_authority_available=True).state == "ready"


def test_omitting_the_argument_fails_closed() -> None:
    """A caller that forgets to pass it must get the safe answer, not the ready one."""
    for agent_id in sorted(_AUTHORITY_INGRESS_ONLY):
        assert _availability(agent_id).state == "authority_required"


def test_the_gate_is_scoped_to_the_specialists_that_demand_exact_authority() -> None:
    """Location and Nav do not call require_attenuated_authority(information=True).

    Widening this gate to them would break two working specialists to fix three
    broken ones.
    """
    for agent_id in ("agent_location", "agent_nav"):
        assert agent_id not in _AUTHORITY_INGRESS_ONLY
        assert _availability(agent_id, exact_authority_available=False).state == "ready"
