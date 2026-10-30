"""Owner recovery and provider-free rehearsal precede background work."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest


async def test_gmail_restart_waits_for_authority_but_not_foreground_startup(monkeypatch):
    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    import pod_server
    from api.routes.one import pod_maintenance
    from hushh_mcp.one_adk import turn_warmup
    from hushh_mcp.services import (
        pod_identity_store,
        pod_session_authority,
        pod_storage,
        pod_upgrade_admission,
    )

    recovering, recover, warming, warmed, gmail_started, gmail_stopped = (
        asyncio.Event() for _ in range(6)
    )
    order = []

    async def authority(**kwargs):
        order.append("authority")
        recovering.set()
        await recover.wait()

    async def gmail():
        gmail_started.set()
        try:
            await asyncio.Event().wait()
        finally:
            gmail_stopped.set()

    async def warmup():
        order.append("warmup")
        warming.set()
        await warmed.wait()

    permit = SimpleNamespace(release=AsyncMock())
    admission = SimpleNamespace(acquire_turn=AsyncMock(return_value=permit))
    monkeypatch.setattr(pod_storage, "resolve_boot_custody", AsyncMock(return_value=(None, None)))
    monkeypatch.setattr(
        pod_identity_store,
        "resolve_durable_private_key_b64",
        AsyncMock(side_effect=lambda **_: order.append("identity")),
    )
    monkeypatch.setattr(pod_session_authority, "build_pod_session_authority", authority)
    monkeypatch.setattr(turn_warmup, "warm_private_pod_turn_path", warmup)
    monkeypatch.setattr(pod_upgrade_admission, "ADMISSION", admission)
    monkeypatch.setattr(pod_maintenance, "gmail_notification_job", gmail)
    monkeypatch.setattr(pod_server, "pod_keypair", lambda: order.append("keypair"))
    monkeypatch.setattr(pod_server, "_start_heartbeat_loop", lambda: order.append("heartbeat"))
    monkeypatch.setattr(pod_server, "_ensure_memory_bank_task", AsyncMock())
    monkeypatch.delenv("POD_FILES_ENABLED", raising=False)
    boot = asyncio.create_task(pod_server._pod_startup())
    try:
        await asyncio.wait_for(recovering.wait(), 1)
        assert not gmail_started.is_set()
        admission.acquire_turn.assert_not_awaited()
        recover.set()
        await asyncio.wait_for(warming.wait(), 1)
        assert not gmail_started.is_set()
        warmed.set()
        await asyncio.wait_for(boot, 1)
        assert order == ["identity", "keypair", "authority", "warmup", "heartbeat"]
        await asyncio.wait_for(gmail_started.wait(), 1)
        permit.release.assert_not_awaited()
        await pod_server._stop_files_queue()

        assert gmail_stopped.is_set()
        permit.release.assert_awaited_once()
        assert pod_server.app.state.gmail_restart_consumer is None
    finally:
        boot.cancel()
        await asyncio.gather(boot, return_exceptions=True)
        await pod_server._stop_files_queue()


async def test_failed_rehearsal_never_starts_heartbeat_or_background_work(monkeypatch):
    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    monkeypatch.setenv("POD_COMPUTER_USE_ENABLED", "false")
    import pod_server
    from hushh_mcp.one_adk import turn_warmup
    from hushh_mcp.services import pod_identity_store, pod_session_authority, pod_storage

    monkeypatch.setattr(pod_storage, "resolve_boot_custody", AsyncMock(return_value=(None, None)))
    monkeypatch.setattr(
        pod_identity_store, "resolve_durable_private_key_b64", AsyncMock(return_value=None)
    )
    monkeypatch.setattr(pod_session_authority, "build_pod_session_authority", AsyncMock())
    monkeypatch.setattr(pod_server, "pod_keypair", Mock())
    heartbeat, memory, gmail = Mock(), AsyncMock(), AsyncMock()
    monkeypatch.setattr(pod_server, "_start_heartbeat_loop", heartbeat)
    monkeypatch.setattr(pod_server, "_ensure_memory_bank_task", memory)
    monkeypatch.setattr(pod_server, "_continue_gmail_notifications", gmail)
    monkeypatch.setattr(
        turn_warmup,
        "warm_private_pod_turn_path",
        AsyncMock(side_effect=RuntimeError("PRIVATE_POD_TURN_WARMUP_FAILED")),
    )
    with pytest.raises(RuntimeError, match="PRIVATE_POD_TURN_WARMUP_FAILED"):
        await pod_server._pod_startup()
    heartbeat.assert_not_called()
    memory.assert_not_awaited()
    gmail.assert_not_awaited()
