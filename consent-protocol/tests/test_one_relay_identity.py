"""Credential failures must not mint anonymous voice tickets."""

from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException

from api.routes.one import adk_live, relay_auth
from api.utils import firebase_auth


async def test_absent_credential_preserves_explicit_anonymous_access(monkeypatch):
    verifier = Mock(side_effect=AssertionError("must not verify absent credentials"))
    monkeypatch.setattr(firebase_auth, "verify_firebase_bearer", verifier)
    assert await relay_auth.resolve_optional_uid(None) is None
    verifier.assert_not_called()


async def test_valid_credential_keeps_verified_owner(monkeypatch):
    monkeypatch.setattr(firebase_auth, "verify_firebase_bearer", lambda header: "synthetic-owner")
    assert await relay_auth.resolve_optional_uid("Bearer synthetic-token") == "synthetic-owner"


@pytest.mark.parametrize("header", ["", "Basic synthetic", "Bearer invalid", "Bearer expired"])
async def test_supplied_invalid_credentials_do_not_mint_tickets(monkeypatch, header):
    def invalid(_header):
        raise HTTPException(status_code=401, detail="Invalid Firebase ID token")

    monkeypatch.setattr(firebase_auth, "verify_firebase_bearer", invalid)
    monkeypatch.setattr(adk_live, "one_voice_enabled", lambda: True)
    mint = Mock(side_effect=AssertionError("must not mint"))
    monkeypatch.setattr(adk_live, "issue_relay_ticket", mint)
    with pytest.raises(HTTPException) as failure:
        await adk_live.create_one_adk_relay_session.__wrapped__(request=None, authorization=header)
    assert failure.value.status_code == 401
    mint.assert_not_called()


async def test_auth_provider_outage_preserves_503_without_ticket(monkeypatch):
    def unavailable(_header):
        raise HTTPException(status_code=503, detail={"error_code": "AUTH_PROVIDER_UNAVAILABLE"})

    monkeypatch.setattr(firebase_auth, "verify_firebase_bearer", unavailable)
    monkeypatch.setattr(adk_live, "one_voice_enabled", lambda: True)
    mint = Mock(side_effect=AssertionError("must not mint"))
    monkeypatch.setattr(adk_live, "issue_relay_ticket", mint)
    with pytest.raises(HTTPException) as failure:
        await adk_live.create_one_adk_relay_session.__wrapped__(
            request=None, authorization="Bearer synthetic"
        )
    assert failure.value.status_code == 503
    assert failure.value.detail["error_code"] == "AUTH_PROVIDER_UNAVAILABLE"
    mint.assert_not_called()


async def test_private_voice_does_not_mint_a_shared_ticket(monkeypatch):
    monkeypatch.setattr(adk_live, "one_voice_enabled", lambda: True)
    monkeypatch.setattr(firebase_auth, "verify_firebase_bearer", lambda header: "synthetic-owner")
    mint = Mock(side_effect=AssertionError("no shared personal session"))
    monkeypatch.setattr(adk_live, "issue_relay_ticket", mint)
    with pytest.raises(HTTPException) as failure:
        await adk_live.create_one_adk_relay_session.__wrapped__(
            request=None, authorization="Bearer synthetic"
        )
    assert failure.value.status_code == 503
    assert failure.value.detail["code"] == "AGENT_NOT_READY"
    assert failure.value.detail["status"] == "unavailable"
    mint.assert_not_called()


async def test_public_onboarding_still_mints_its_anonymous_ticket(monkeypatch):
    monkeypatch.setattr(adk_live, "one_voice_enabled", lambda: True)
    mint = Mock(return_value=("synthetic-ticket", 200))
    monkeypatch.setattr(adk_live, "issue_relay_ticket", mint)
    result = await adk_live.create_one_adk_relay_session.__wrapped__(
        request=None, authorization=None
    )
    assert result.tier == "intro"
    assert result.cell == "hub"
    mint.assert_called_once_with(None, "anon_onboarding")


@pytest.mark.parametrize(
    "uid,tier",
    [
        ("synthetic-owner", "signed_locked"),
        ("synthetic-owner", "signed_unlocked"),
        ("synthetic-owner", "anon_onboarding"),
        (None, "signed_locked"),
    ],
)
async def test_old_signed_ticket_never_reads_credentials_or_builds_shared_runner(
    monkeypatch, uid, tier
):
    monkeypatch.setattr(adk_live, "one_voice_enabled", lambda: True)
    monkeypatch.setattr(
        adk_live, "consume_relay_ticket_shared", AsyncMock(return_value=(True, uid, tier))
    )
    bootstrap = AsyncMock(side_effect=AssertionError("must not read bootstrap"))
    runner = Mock(side_effect=AssertionError("must not build shared runner"))
    monkeypatch.setattr(adk_live, "_receive_runtime_bootstrap", bootstrap)
    monkeypatch.setattr(adk_live, "build_one_live_runner", runner)
    socket = Mock(query_params={"relay_ticket": "synthetic-old-ticket"})
    socket.accept = AsyncMock()
    socket.close = AsyncMock()
    await adk_live.one_adk_live_relay(socket)
    socket.close.assert_awaited_once_with(code=1008, reason=adk_live._PRIVATE_VOICE_UNAVAILABLE)
    bootstrap.assert_not_awaited()
    runner.assert_not_called()


async def test_anonymous_socket_reaches_existing_bootstrap(monkeypatch):
    monkeypatch.setattr(adk_live, "one_voice_enabled", lambda: True)
    monkeypatch.setattr(
        adk_live,
        "consume_relay_ticket_shared",
        AsyncMock(return_value=(True, None, "anon_onboarding")),
    )
    bootstrap = AsyncMock(side_effect=ValueError("runtime_bootstrap_required"))
    monkeypatch.setattr(adk_live, "_receive_runtime_bootstrap", bootstrap)
    socket = Mock(query_params={"relay_ticket": "synthetic-guest-ticket"})
    socket.accept = AsyncMock()
    socket.close = AsyncMock()
    await adk_live.one_adk_live_relay(socket)
    bootstrap.assert_awaited_once_with(socket, uid=None)


async def test_public_bootstrap_cannot_resume_an_older_personal_session():
    import json

    socket = Mock()
    socket.receive_text = AsyncMock(
        return_value=json.dumps(
            {
                "type": "runtime_bootstrap",
                "runtime_credential_mode": "hushh_managed_vertex",
                "resumption_handle": "synthetic-prior-owner-handle",
            }
        )
    )
    config = await adk_live._receive_runtime_bootstrap(socket, uid=None)
    assert config[5] is None


@pytest.mark.parametrize("private_field", ["consent_token", "pkmContext", "runtime_credential"])
async def test_anonymous_socket_rejects_private_context_before_state_or_provider(
    monkeypatch, private_field
):
    import asyncio
    import json
    from types import SimpleNamespace

    monkeypatch.setattr(adk_live, "one_voice_enabled", lambda: True)
    monkeypatch.setattr(
        adk_live,
        "consume_relay_ticket_shared",
        AsyncMock(return_value=(True, None, "anon_onboarding")),
    )
    monkeypatch.setattr(
        adk_live,
        "_receive_runtime_bootstrap",
        AsyncMock(
            return_value=("hushh_managed_vertex", None, "developer_api", None, None, None, None)
        ),
    )
    sessions = SimpleNamespace(
        create_session=AsyncMock(return_value=SimpleNamespace(state={})),
        append_event=AsyncMock(),
        delete_session=AsyncMock(),
    )
    runner = SimpleNamespace(
        session_service=sessions,
        run_live=Mock(side_effect=AssertionError("private context must not start a provider")),
    )
    build = Mock(return_value=runner)
    monkeypatch.setattr(adk_live, "build_one_live_runner", build)
    publish = Mock()
    monkeypatch.setattr(adk_live, "publish_live_voice_context", publish)
    socket = Mock(query_params={"relay_ticket": "synthetic-guest-ticket"})
    socket.accept = AsyncMock()
    socket.close = AsyncMock()
    socket.send_text = AsyncMock()
    socket.receive_text = AsyncMock(
        return_value=json.dumps(
            {"type": "app_context", "appContext": {private_field: "synthetic-private"}}
        )
    )
    await asyncio.wait_for(adk_live.one_adk_live_relay(socket), timeout=1)
    assert build.call_args.kwargs["public_intro_only"] is True
    assert any(call.kwargs.get("code") == 1008 for call in socket.close.await_args_list)
    assert sessions.create_session.call_args.kwargs["state"][adk_live.STATE_CONSENT_TOKEN] == ""
    sessions.append_event.assert_not_awaited()
    sessions.delete_session.assert_awaited_once()
    publish.assert_not_called()
    runner.run_live.assert_not_called()


async def test_unknown_runner_error_never_reaches_logs_or_socket(monkeypatch, caplog):
    monkeypatch.setattr(adk_live, "one_voice_enabled", lambda: True)
    monkeypatch.setattr(
        adk_live,
        "consume_relay_ticket_shared",
        AsyncMock(return_value=(True, None, "anon_onboarding")),
    )
    monkeypatch.setattr(
        adk_live,
        "_receive_runtime_bootstrap",
        AsyncMock(
            return_value=("hushh_managed_vertex", None, "developer_api", None, None, None, None)
        ),
    )
    monkeypatch.setattr(
        adk_live,
        "build_one_live_runner",
        Mock(side_effect=RuntimeError("synthetic-private-provider-detail")),
    )
    socket = Mock(query_params={"relay_ticket": "synthetic"})
    socket.accept = AsyncMock()
    socket.close = AsyncMock()
    with caplog.at_level("INFO"):
        await adk_live.one_adk_live_relay(socket)
    assert "synthetic-private-provider-detail" not in caplog.text
    assert "synthetic-private-provider-detail" not in str(socket.close.await_args_list)


async def test_public_context_and_provider_frames_complete_and_cancel_idle_input(monkeypatch):
    import asyncio
    import json
    from types import SimpleNamespace

    monkeypatch.setattr(adk_live, "one_voice_enabled", lambda: True)
    monkeypatch.setattr(
        adk_live,
        "consume_relay_ticket_shared",
        AsyncMock(return_value=(True, None, "anon_onboarding")),
    )
    monkeypatch.setattr(
        adk_live,
        "_receive_runtime_bootstrap",
        AsyncMock(
            return_value=("hushh_managed_vertex", None, "developer_api", None, None, None, None)
        ),
    )
    sessions = SimpleNamespace(
        create_session=AsyncMock(return_value=SimpleNamespace(state={})),
        append_event=AsyncMock(),
        delete_session=AsyncMock(),
    )

    async def events(**kwargs):
        yield SimpleNamespace(
            content=SimpleNamespace(parts=[SimpleNamespace(text="Synthetic public greeting")]),
            turn_complete=True,
        )

    runner = SimpleNamespace(session_service=sessions, run_live=events)
    monkeypatch.setattr(adk_live, "build_one_live_runner", Mock(return_value=runner))
    reads = 0
    input_cancelled = False

    async def receive():
        nonlocal reads, input_cancelled
        reads += 1
        if reads == 1:
            return json.dumps(
                {
                    "type": "app_context",
                    "contextId": "synthetic-context",
                    "appContext": {"route_family": "/login", "consent_token": None},
                }
            )
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            input_cancelled = True
            raise

    socket = Mock(query_params={"relay_ticket": "synthetic"})
    socket.accept = AsyncMock()
    socket.close = AsyncMock()
    socket.send_text = AsyncMock()
    socket.receive_text = receive
    await asyncio.wait_for(adk_live.one_adk_live_relay(socket), timeout=1)
    frames = [json.loads(call.args[0]) for call in socket.send_text.await_args_list]
    assert {"appContextAccepted": {"contextId": "synthetic-context"}} in frames
    assert {
        "serverContent": {"modelTurn": {"parts": [{"text": "Synthetic public greeting"}]}}
    } in frames
    assert {"serverContent": {"turnComplete": True}} in frames
    assert input_cancelled
    sessions.delete_session.assert_awaited_once()
