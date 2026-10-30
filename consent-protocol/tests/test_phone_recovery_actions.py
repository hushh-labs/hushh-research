"""Recovery navigation never grants owner authority or replays a device effect."""

import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.routes import account
from api.routes import account_phone_recovery as routes
from hushh_mcp.services import device_action_proof as proof
from hushh_mcp.services import device_action_service as actions
from hushh_mcp.services import phone_recovery_continuation as recovery
from tests.helpers.phone_recovery_actions import CURRENT, DEVICE, PHONE
from tests.helpers.phone_recovery_actions import action_database as action_database

SYNTHETIC_PROOF = "synthetic-request-proof"


@pytest.mark.asyncio
async def test_continuation_only_reveals_action_to_matching_current_previous_owner(monkeypatch):
    row = {
        "target_user_id": "previous",
        "requester_user_id": "requester",
        "live": True,
        "action": "delete",
        **CURRENT,
    }
    conn = SimpleNamespace(fetchrow=AsyncMock(return_value=row))
    monkeypatch.setattr(recovery, "binding", AsyncMock(return_value=dict(CURRENT)))
    for owner in ("requester", "unrelated"):
        assert await recovery.ready(conn, owner, str(uuid4())) == (
            "awaiting_previous_sign_in",
            None,
            None,
        )
    assert (await recovery.ready(conn, "previous", str(uuid4())))[0] == "ready"
    row["generation"] += 1

    async def contract():
        assert await recovery.ready(conn, "previous", str(uuid4())) == ("stale", None, None)

    await contract()
    # Broken-code control: bypassing the snapshot predicate makes the actual
    # contract fail, rather than passing because the wrong owner was used.
    with monkeypatch.context() as broken:
        broken.setattr(recovery, "same_binding", lambda *_: True)
        with pytest.raises(AssertionError):
            await contract()


@pytest.mark.asyncio
async def test_recovery_producers_fail_closed_when_existing_flag_is_off(monkeypatch):
    from api.middlewares import auth_reliability_trace

    monkeypatch.setattr(auth_reliability_trace, "request_feature_enabled", lambda _: False)
    for operation in (
        recovery.create("requester", "delete", PHONE),
        actions.prepare("previous", DEVICE, None),
    ):
        with pytest.raises(HTTPException) as error:
            await operation
        assert error.value.detail["code"] == "PHONE_RECOVERY_UNAVAILABLE"


@pytest.mark.asyncio
async def test_delete_continuation_is_rechecked_before_existing_erasure(monkeypatch):
    from hushh_mcp.services.phone_recovery_state import refuse

    monkeypatch.setattr(routes, "require_recovery_signin", AsyncMock())
    require = AsyncMock(side_effect=refuse("PHONE_RECOVERY_PREVIOUS_SIGN_IN_REQUIRED", 403))
    monkeypatch.setattr(recovery, "require_ready", require)
    erase = AsyncMock()
    monkeypatch.setattr(account, "_perform_account_deletion", erase)
    operation = uuid4()
    with pytest.raises(HTTPException):
        await account.delete_account(
            account.DeleteAccountRequest(continuation_id=operation),
            token_data={"user_id": "previous"},
            authorization="Bearer synthetic",
        )
    require.assert_awaited_once_with("previous", str(operation), action="delete")
    erase.assert_not_awaited()


@pytest.mark.asyncio
async def test_device_proof_is_consumed_once_and_unknown_dispatch_never_replays(
    action_database, monkeypatch
):
    operation = action_database.operation()
    verify = AsyncMock(return_value="a" * 64)
    monkeypatch.setattr(proof, "verify", verify)
    revoke = AsyncMock(side_effect=ConnectionError("lost hub response"))
    first = await actions.confirm(
        "previous", DEVICE, operation, phone_id_token=SYNTHETIC_PROOF, test_code=None, revoke=revoke
    )
    assert first["state"] == "action_required"
    again = await actions.confirm(
        "previous", DEVICE, operation, phone_id_token=SYNTHETIC_PROOF, test_code=None, revoke=revoke
    )
    assert again == first
    revoke.assert_awaited_once()
    verify.assert_awaited_once()
    # Readback may settle already-revoked ledger work, without primary revoke.
    settle = AsyncMock(return_value={"success": True, "podBindingVersion": 7})
    result = await actions.status("previous", operation, reconcile=settle)
    assert result["state"] == "completed" and result["podBindingVersion"] == 7
    assert revoke.await_count == 1


@pytest.mark.asyncio
async def test_same_sms_event_cannot_revoke_second_device_and_wrong_owner_never_dispatches(
    action_database, monkeypatch
):
    monkeypatch.setattr(proof, "verify", AsyncMock(return_value="b" * 64))
    revoke = AsyncMock(return_value={"success": True, "podBindingVersion": 0})
    first, second = action_database.operation(), action_database.operation()
    await actions.confirm(
        "previous", DEVICE, first, phone_id_token=SYNTHETIC_PROOF, test_code=None, revoke=revoke
    )
    with pytest.raises(HTTPException) as duplicate:
        await actions.confirm(
            "previous",
            DEVICE,
            second,
            phone_id_token=SYNTHETIC_PROOF,
            test_code=None,
            revoke=revoke,
        )
    assert duplicate.value.detail["code"] == "DEVICE_ACTION_PROOF_ALREADY_USED"
    with pytest.raises(HTTPException) as foreign:
        await actions.confirm(
            "requester",
            DEVICE,
            second,
            phone_id_token=SYNTHETIC_PROOF,
            test_code=None,
            revoke=revoke,
        )
    assert foreign.value.status_code == 404
    assert revoke.await_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("late_failure", [False, True])
async def test_completed_status_is_monotonic_when_original_dispatch_finishes(
    action_database, monkeypatch, late_failure
):
    monkeypatch.setattr(proof, "verify", AsyncMock(return_value="e" * 64))

    async def contract():
        operation = action_database.operation()

        # Model a status request settling the canonical ledger while the
        # original dispatcher is still awaiting its transport response.
        async def revoke(*args):
            settled = await actions.status(
                "previous",
                operation,
                reconcile=AsyncMock(return_value={"success": True, "podBindingVersion": 7}),
            )
            assert settled["state"] == "completed"
            if late_failure:
                raise ConnectionError("late lost response")
            return {"success": True, "podBindingVersion": 7}

        revoke_once = AsyncMock(side_effect=revoke)
        result = await actions.confirm(
            "previous",
            DEVICE,
            operation,
            phone_id_token=SYNTHETIC_PROOF,
            test_code=None,
            revoke=revoke_once,
        )
        assert result["state"] == "completed" and result["podBindingVersion"] == 7
        assert action_database.rows[operation]["state"] == "completed"
        revoke_once.assert_awaited_once()

    await contract()
    if late_failure:
        execute = action_database.execute

        async def broken_execute(query, *args):
            return await execute(query.replace(" AND state='pending'", ""), *args)

        # The prior unconditional error update downgrades the completed row.
        with monkeypatch.context() as broken:
            broken.setattr(action_database, "execute", broken_execute)
            action_database.events.clear()
            with pytest.raises(AssertionError):
                await contract()


@pytest.mark.asyncio
async def test_changed_binding_or_expired_action_rejects_before_proof_and_effect(
    action_database, monkeypatch
):
    verify, revoke = AsyncMock(), AsyncMock()
    monkeypatch.setattr(proof, "verify", verify)
    for changes in ({"live": False}, {"binding_revision": 4}, {"generation": 1}):
        operation = action_database.operation(**changes)
        with pytest.raises(HTTPException) as error:
            await actions.confirm(
                "previous",
                DEVICE,
                operation,
                phone_id_token=SYNTHETIC_PROOF,
                test_code=None,
                revoke=revoke,
            )
        assert error.value.detail["code"] == "DEVICE_ACTION_STALE"
    verify.assert_not_awaited()
    revoke.assert_not_awaited()


@pytest.mark.asyncio
async def test_second_tab_list_and_status_leave_prepared_first_tab_confirmable(
    action_database, monkeypatch
):
    operation = action_database.operation()
    verify = AsyncMock(return_value="c" * 64)
    revoke = AsyncMock(return_value={"success": True, "podBindingVersion": 0})
    monkeypatch.setattr(proof, "verify", verify)
    assert (await actions.pending_for_owner("previous"))[0]["state"] == "prepared"
    result = await actions.status("previous", operation)
    assert result["state"] == "prepared"
    confirmed = await actions.confirm(
        "previous", DEVICE, operation, phone_id_token=SYNTHETIC_PROOF, test_code=None, revoke=revoke
    )
    assert confirmed["state"] == "completed"
    verify.assert_awaited_once()
    revoke.assert_awaited_once()


@pytest.mark.asyncio
async def test_explicit_cancel_fences_inflight_proof_without_cancelling_admitted_dispatch(
    action_database, monkeypatch
):
    async def contract():
        operation = action_database.operation()
        entered, finish = asyncio.Event(), asyncio.Event()

        async def verify(*args, **kwargs):
            entered.set()
            await finish.wait()
            return "d" * 64

        monkeypatch.setattr(proof, "verify", verify)
        revoke = AsyncMock(return_value={"success": True, "podBindingVersion": 0})
        confirm = asyncio.create_task(
            actions.confirm(
                "previous",
                DEVICE,
                operation,
                phone_id_token=SYNTHETIC_PROOF,
                test_code=None,
                revoke=revoke,
            )
        )
        await entered.wait()
        try:
            await actions.cancel("previous", operation)
        finally:
            finish.set()
        result = await confirm
        assert result["state"] == "not_started"
        revoke.assert_not_awaited()

    await contract()
    with monkeypatch.context() as broken:
        broken.setattr(actions, "cancel", actions.status)
        with pytest.raises(AssertionError):
            await contract()
    for state in ("pending", "action_required", "completed"):
        operation = action_database.operation(state=state)
        assert (await actions.cancel("previous", operation))["state"] == state
    with pytest.raises(HTTPException) as foreign:
        await actions.cancel("requester", operation)
    assert foreign.value.status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "created,now,wait",
    [(1000, 1000, 0), (1000.25, 1000.5, 500), (1000.25, 1001.5, 0), (1000.25, 999, 1000)],
)
async def test_prepare_returns_bounded_server_clock_wait_before_new_sms(
    action_database, monkeypatch, created, now, wait
):
    monkeypatch.setattr(actions, "bound_owner_drafts", AsyncMock())
    monkeypatch.setattr(
        action_database,
        "fetchrow",
        AsyncMock(
            return_value={
                "created_at": datetime.fromtimestamp(created, timezone.utc),
                "expires_at": datetime.fromtimestamp(created + 300, timezone.utc),
                "server_now": now,
            }
        ),
    )
    monkeypatch.setattr(proof, "fixture_challenge", lambda _: None)
    result = await actions.prepare("previous", DEVICE, None)
    assert result["proof_wait_ms"] == wait


@pytest.mark.asyncio
async def test_fixture_code_uses_configuration_and_never_becomes_a_signed_transfer_proof(
    monkeypatch,
):
    from hushh_mcp.services import phone_test_transport as transport

    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_NUMBERS", PHONE)
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_CODE", "317924")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_CHALLENGE_SECRET", "synthetic-only")
    monkeypatch.setattr(transport, "configured_dev_reviewer_phone_transport", lambda: None)
    operation = str(uuid4())
    digest = await proof.verify(
        "previous", operation, PHONE, 0, phone_id_token=None, test_code="317924"
    )
    assert len(digest) == 64
    for phone, code in ((PHONE, "000000"), ("+16505550102", "317924")):
        with pytest.raises(HTTPException):
            await proof.verify("previous", operation, phone, 0, phone_id_token=None, test_code=code)


@pytest.mark.asyncio
async def test_signed_device_proof_uses_readonly_provider_check_not_transfer_mutation_authority(
    monkeypatch,
):
    from api.utils import firebase_admin, phone_claim_proof
    from hushh_mcp.services import phone_transfer_authority as authority

    async def decoded(*args, **kwargs):
        kwargs["proof_metadata"].update(event="stable-auth-event", valid_until=1_000_300)
        return PHONE, "phone-proof-user"

    monkeypatch.setattr(phone_claim_proof, "verify_phone_claim_id_token", decoded)
    monkeypatch.setattr(firebase_admin, "get_firebase_auth_app", lambda: object())
    readonly = Mock()
    mutation = Mock(side_effect=AssertionError("device action must not mutate Firebase"))
    monkeypatch.setattr(authority, "assert_real_sms_provider", readonly)
    monkeypatch.setattr(authority, "check_provider", mutation)
    monkeypatch.setattr(proof.time, "time", lambda: 1_000_010)
    assert await proof._signed_event("synthetic", PHONE, 1_000_000) == "stable-auth-event"

    async def contract():
        try:
            await proof._signed_event("refreshed-same-event", PHONE, 1_000_000.2)
        except HTTPException as error:
            assert error.detail["code"] == "DEVICE_ACTION_FRESH_SMS_REQUIRED"
        else:
            raise AssertionError("prechallenge authentication event was admitted")

    await contract()
    with monkeypatch.context() as broken:
        broken.setattr(proof, "math", SimpleNamespace(ceil=int))
        with pytest.raises(AssertionError):
            await contract()
    with pytest.raises(HTTPException):
        await proof._signed_event("refreshed-same-event", PHONE, 1_000_001)
    assert readonly.call_count == 2
    mutation.assert_not_called()


@pytest.mark.asyncio
async def test_old_delete_cannot_bypass_device_proof(monkeypatch):
    revoke = AsyncMock()
    monkeypatch.setattr(account, "_revoke_trusted_device", revoke)
    with pytest.raises(HTTPException) as error:
        await account.revoke_trusted_device(DEVICE, firebase_uid="previous")
    assert error.value.detail["code"] == "DEVICE_ACTION_PROOF_REQUIRED"
    revoke.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("already_revoked", [False, True])
async def test_canonical_hub_settlement_keeps_existing_idempotent_revocation(
    monkeypatch, already_revoked
):
    from api.routes import account_device_revocation

    async def run(function, **kwargs):
        return function(**kwargs)

    devices = SimpleNamespace(
        revoke_device=Mock(return_value=not already_revoked),
        device_status=Mock(return_value={"status": "revoked"}),
    )
    consent = SimpleNamespace(
        get_active_internal_tokens=AsyncMock(return_value=[]),
        get_active_tokens=AsyncMock(return_value=[]),
    )
    monkeypatch.setattr("hushh_mcp.services.consent_db.ConsentDBService", lambda: consent)
    registry = SimpleNamespace(
        get=AsyncMock(return_value={"backend_metadata": {"bindings": {DEVICE: {"version": 7}}}})
    )
    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_registry_repo.PersonalAgentRegistryRepo",
        lambda: registry,
    )
    result = await account_device_revocation.revoke(
        DEVICE, "previous", devices=devices, run=run, logger=Mock()
    )
    assert result == {"success": True, "device_id": DEVICE, "podBindingVersion": 7}
    devices.revoke_device.assert_called_once_with(user_id="previous", device_id=DEVICE)
    devices.revoke_device.reset_mock()
    assert (
        await account_device_revocation.settle(
            DEVICE, "previous", devices=devices, run=run, logger=Mock()
        )
        == result
    )
    devices.revoke_device.assert_not_called()


def test_confirm_requires_literal_true_and_does_not_echo_credentials(monkeypatch):
    app = FastAPI()
    app.include_router(routes.router, prefix="/api/account")
    app.dependency_overrides[routes.recovery_owner] = lambda: "previous"
    confirm = AsyncMock()
    monkeypatch.setattr(actions, "confirm", confirm)
    client = TestClient(app)
    secret = "synthetic-sensitive-token"
    for confirmed in (None, False, 1, "true"):
        response = client.post(
            f"/api/account/trusted-devices/{DEVICE}/revoke/confirm",
            json={
                "operation_id": str(uuid4()),
                "confirmed": confirmed,
                "phone_id_token": secret,
            },
        )
        assert response.status_code == 422 and secret not in response.text
        assert response.headers["cache-control"] == "private, no-store"
    confirm.assert_not_awaited()

    cancel = AsyncMock(return_value={"state": "not_started", "code": "DEVICE_ACTION_NOT_STARTED"})
    monkeypatch.setattr(actions, "cancel", cancel)
    operation = str(uuid4())
    response = client.post(f"/api/account/trusted-devices/revocations/{operation}/cancel", json={})
    assert response.status_code == 200 and response.json()["state"] == "not_started"
    cancel.assert_awaited_once_with("previous", operation)


@pytest.mark.feature_auth_reliability
@pytest.mark.trace_loop
@pytest.mark.parametrize("environment", ["dev", "uat", "production"])
def test_linked_deletion_routes_hide_credentials_and_require_opt_in(monkeypatch, environment):
    from api.routes import account_phone_linked_deletion as linked_routes
    from hushh_mcp.services import phone_linked_deletion

    app = FastAPI()
    app.include_router(linked_routes.router)
    app.dependency_overrides[routes.recovery_owner] = lambda: "receiving"
    client = TestClient(app)
    secret = "synthetic-sensitive-token"
    for body in (
        {"confirmed": True, "phone_id_token": secret, "test_code": "123456"},
        {"confirmed": False, "phone_id_token": secret},
    ):
        response = client.post(
            "/api/account/phone/linked-account/deletions/confirm",
            json={"operation_id": str(uuid4()), "phone_number": PHONE, **body},
        )
        assert response.status_code == 422 and secret not in response.text
        assert response.json() == {"detail": {"code": "PHONE_RECOVERY_INVALID_REQUEST"}}
    for name in ("HUSHH_PHONE_LINKED_DELETION_ENABLED", "APP_RUNTIME_PROFILE", "HUSHH_DEPLOY_ENV"):
        monkeypatch.delenv(name, raising=False)
    from unittest.mock import Mock

    monkeypatch.setenv("ENVIRONMENT", environment)
    storage = Mock(side_effect=AssertionError("disabled flow reached storage"))
    monkeypatch.setattr(phone_linked_deletion, "transaction", storage)
    assert phone_linked_deletion.enabled() is False
    response = client.post(
        "/api/account/phone/linked-account/deletions", json={"phone_number": PHONE}
    )
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "PHONE_LINKED_DELETION_UNAVAILABLE"
    storage.assert_not_called()
