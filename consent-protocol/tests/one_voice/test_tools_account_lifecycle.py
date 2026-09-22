"""reset_account / delete_account / report_account_lifecycle.

The tools never execute on the server; the tap issues a device step and the
server verifies afterwards. So the tests prove: the card names the exact
effect, nothing is armed without the prepared snapshot matching the owner,
the issued step is bound to owner+operation, and the verifier decides from
server evidence -- the device's word only picks between honest "not changed"
wordings and can never produce reset/deleted on its own.
"""

from __future__ import annotations

from typing import Any

import pytest

from hushh_mcp.one_voice.tools import account_lifecycle as lifecycle
from hushh_mcp.one_voice.tools.base import (
    EntityContext,
    Prepared,
    Rejected,
    ScreenContext,
    ToolContext,
    ToolPolicy,
)

USER = "firebase-user-123456789012"


def _fixture_credential(kind: str) -> str:
    """Non-production fixture credential without an inline secret-like literal."""
    return f"{kind}-fixture"


class LifecycleDouble:
    def __init__(self, *, tombstoned: bool = False, error: Exception | None = None) -> None:
        self.tombstoned = tombstoned
        self.error = error
        self.calls: list[str] = []

    def is_tombstoned(self, user_id: str) -> bool:
        self.calls.append(user_id)
        if self.error is not None:
            raise self.error
        return self.tombstoned


class AccountDouble:
    def __init__(self, evidence: dict[str, Any] | None = None, error: Exception | None = None):
        self.evidence = evidence
        self.error = error
        self.calls: list[str] = []

    def read_reset_evidence(self, user_id: str) -> dict[str, Any] | None:
        self.calls.append(user_id)
        if self.error is not None:
            raise self.error
        return self.evidence


def _ctx(*, prepared: dict[str, Any] | None = None, **services: Any) -> ToolContext:
    ctx = ToolContext(
        user_id=USER,
        conversation_id="conv-1",
        entities=EntityContext(),
        screen=ScreenContext(),
        vault_owner_token=_fixture_credential("vault"),
        firebase_id_token=_fixture_credential("firebase"),
        services=services,
    )
    ctx.prepared = prepared
    return ctx


def _spec(name: str):
    return next(t for t in lifecycle.TOOLS if t.name == name)


# -- catalog shape -------------------------------------------------------------


def test_reset_and_delete_are_tap_tier_device_steps_on_the_firebase_plane():
    for name, gateway in (
        ("reset_account", "profile.reset_account"),
        ("delete_account", "profile.delete_account"),
    ):
        spec = _spec(name)
        assert spec.policy is ToolPolicy.confirm_tap
        assert spec.firebase_plane is True
        assert spec.device_step is True
        assert spec.prepare is not None and spec.summarize is not None
        assert spec.gateway_action_id == gateway
    report = _spec("report_account_lifecycle")
    assert report.policy is ToolPolicy.read
    assert report.device_step is False


def test_descriptions_forbid_success_words_from_the_issued_result():
    for name in ("reset_account", "delete_account"):
        text = _spec(name).description
        assert "spoken yes cannot arm it" in text
        assert "report_account_lifecycle" in text
        assert "Never say" in text


# -- prepare -------------------------------------------------------------------


async def test_prepare_reset_names_the_exact_effect_and_snapshots_the_owner():
    ctx = _ctx(account_lifecycle=LifecycleDouble())
    prepared = await lifecycle.prepare_reset(ctx, lifecycle.ResetAccountInput())
    assert isinstance(prepared, Prepared)
    assert "keep your sign-in and vault" in prepared.summary
    assert "start onboarding again" in prepared.summary
    assert prepared.snapshot == {"user_id": USER}


async def test_prepare_delete_says_it_cannot_be_undone():
    ctx = _ctx(account_lifecycle=LifecycleDouble())
    prepared = await lifecycle.prepare_delete(ctx, lifecycle.DeleteAccountInput())
    assert isinstance(prepared, Prepared)
    assert "cannot be undone" in prepared.summary


async def test_prepare_on_a_deleted_account_answers_without_a_card():
    ctx = _ctx(account_lifecycle=LifecycleDouble(tombstoned=True))
    for prepare, args in (
        (lifecycle.prepare_reset, lifecycle.ResetAccountInput()),
        (lifecycle.prepare_delete, lifecycle.DeleteAccountInput()),
    ):
        result = await prepare(ctx, args)
        assert not isinstance(result, Prepared)
        assert result.status == "account_deleted"
        assert result.reason_code == "account_deleted"


async def test_prepare_refuses_when_the_lifecycle_read_fails():
    ctx = _ctx(account_lifecycle=LifecycleDouble(error=RuntimeError("db down")))
    result = await lifecycle.prepare_reset(ctx, lifecycle.ResetAccountInput())
    assert isinstance(result, Rejected)
    assert result.reason_code == "lifecycle_unavailable"
    assert "didn't start" in result.spoken_facts[0]


# -- handler: the tap ----------------------------------------------------------


async def test_reset_tap_issues_a_step_bound_to_owner_and_operation_and_is_not_success():
    ctx = _ctx(prepared={"user_id": USER}, account_lifecycle=LifecycleDouble())
    result = await lifecycle.reset_account(ctx, lifecycle.ResetAccountInput())
    assert result.status == "reset_step_issued"
    assert result.needs == "client_step"
    step = result.client_step
    assert step["kind"] == "account_lifecycle"
    assert step["operation"] == "reset"
    assert step["user_id"] == USER
    assert isinstance(step["issued_at_ms"], int) and step["issued_at_ms"] > 0
    assert step["timeout_s"] == lifecycle.STEP_TIMEOUT_S
    spoken = " ".join(result.spoken_facts).lower()
    assert "has been reset" not in spoken and "was reset" not in spoken


async def test_delete_tap_issues_a_step_and_never_says_deleted():
    ctx = _ctx(prepared={"user_id": USER}, account_lifecycle=LifecycleDouble())
    result = await lifecycle.delete_account(ctx, lifecycle.DeleteAccountInput())
    assert result.status == "delete_step_issued"
    assert result.needs == "client_step"
    assert result.client_step["operation"] == "delete"
    assert result.client_step["user_id"] == USER
    assert "has been deleted" not in " ".join(result.spoken_facts).lower()


async def test_tap_refuses_when_the_prepared_owner_is_not_the_signed_in_owner():
    for handler, args in (
        (lifecycle.reset_account, lifecycle.ResetAccountInput()),
        (lifecycle.delete_account, lifecycle.DeleteAccountInput()),
    ):
        ctx = _ctx(prepared={"user_id": "someone-else"}, account_lifecycle=LifecycleDouble())
        result = await handler(ctx, args)
        assert isinstance(result, Rejected)
        assert result.reason_code == "owner_changed"
        ctx = _ctx(prepared=None, account_lifecycle=LifecycleDouble())
        result = await handler(ctx, args)
        assert isinstance(result, Rejected)


# -- verifier: deletion --------------------------------------------------------


def _report(operation: str, client_status: str, issued_at_ms: int = 1_000):
    return lifecycle.ReportAccountLifecycleInput(
        operation=operation, client_status=client_status, issued_at_ms=issued_at_ms
    )


async def test_delete_is_verified_by_the_tombstone_not_the_device():
    ctx = _ctx(account_lifecycle=LifecycleDouble(tombstoned=True))
    # Even a device that says "failed" cannot un-delete a tombstoned account.
    result = await lifecycle.report_account_lifecycle(ctx, _report("delete", "failed"))
    assert result.status == "account_deleted"
    assert result.spoken_facts == ["Your account has been deleted."]


async def test_device_claiming_deleted_without_a_tombstone_is_never_narrated_as_deleted():
    ctx = _ctx(account_lifecycle=LifecycleDouble(tombstoned=False))
    result = await lifecycle.report_account_lifecycle(ctx, _report("delete", "deleted"))
    assert result.status == "not_changed"
    assert "Nothing was deleted" in result.spoken_facts[0]


@pytest.mark.parametrize(
    ("client_status", "expected", "reason"),
    [
        ("needs_unlock", "needs_unlock", "vault_locked"),
        ("blocked_external", "blocked_external", "external_resources_require_deprovisioning"),
        ("unknown", "unverified", "outcome_unknown"),
        ("auth_failed", "not_changed", "client_auth_failed"),
        ("failed", "not_changed", "client_failed"),
    ],
)
async def test_delete_not_tombstoned_maps_the_device_report_to_honest_wording(
    client_status: str, expected: str, reason: str
):
    ctx = _ctx(account_lifecycle=LifecycleDouble(tombstoned=False))
    result = await lifecycle.report_account_lifecycle(ctx, _report("delete", client_status))
    assert result.status == expected
    assert result.reason_code == reason
    assert "has been deleted" not in " ".join(result.spoken_facts).lower()


async def test_delete_verification_failure_is_unverified_not_failed():
    ctx = _ctx(account_lifecycle=LifecycleDouble(error=RuntimeError("db down")))
    result = await lifecycle.report_account_lifecycle(ctx, _report("delete", "deleted"))
    assert result.status == "unverified"
    assert result.reason_code == "lifecycle_unavailable"
    assert "couldn't confirm" in result.spoken_facts[0]


# -- verifier: reset -----------------------------------------------------------


async def test_reset_is_verified_by_a_fresh_stamp_after_the_step_was_issued():
    ctx = _ctx(account=AccountDouble({"setup_completed": None, "setup_state_updated_at_ms": 5_000}))
    result = await lifecycle.report_account_lifecycle(
        ctx, _report("reset", "reset", issued_at_ms=4_000)
    )
    assert result.status == "account_reset"
    assert result.ui_refresh == ["profile", "onboarding"]


async def test_reset_with_a_stale_stamp_is_unverified_even_if_the_device_says_reset():
    # Graph observation 5, server side: a resolved call is not a reset.
    ctx = _ctx(account=AccountDouble({"setup_completed": None, "setup_state_updated_at_ms": 3_000}))
    result = await lifecycle.report_account_lifecycle(
        ctx, _report("reset", "reset", issued_at_ms=4_000)
    )
    assert result.status == "unverified"
    assert result.reason_code == "stamp_not_seen"


async def test_reset_with_setup_still_completed_is_not_a_reset():
    ctx = _ctx(account=AccountDouble({"setup_completed": True, "setup_state_updated_at_ms": 9_000}))
    result = await lifecycle.report_account_lifecycle(
        ctx, _report("reset", "not_reset", issued_at_ms=4_000)
    )
    assert result.status == "not_changed"
    assert result.spoken_facts == ["Your account was not reset."]


async def test_reset_needs_unlock_and_missing_row_and_read_failure():
    ctx = _ctx(account=AccountDouble({"setup_completed": True, "setup_state_updated_at_ms": 1}))
    result = await lifecycle.report_account_lifecycle(ctx, _report("reset", "needs_unlock"))
    assert result.status == "needs_unlock" and result.reason_code == "vault_locked"

    ctx = _ctx(account=AccountDouble(None))
    result = await lifecycle.report_account_lifecycle(ctx, _report("reset", "reset"))
    assert result.status == "unverified" and result.reason_code == "no_vault_row"

    ctx = _ctx(account=AccountDouble(error=RuntimeError("db down")))
    result = await lifecycle.report_account_lifecycle(ctx, _report("reset", "reset"))
    assert result.status == "unverified" and result.reason_code == "evidence_unavailable"


def test_verifier_input_rejects_an_unknown_device_status():
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        lifecycle.ReportAccountLifecycleInput(
            operation="reset", client_status="succeeded", issued_at_ms=1
        )
