"""A cloud default cannot replace an owner key without authorized model access."""

import asyncio
import time
from typing import Any

import pytest
from fastapi import HTTPException

from api.routes.one.pod_ai_selection import run_ai_selection_delete, run_ai_selection_put
from hushh_mcp.services import pod_ai_selection
from hushh_mcp.services.pod_consent_client import ConsentVerdict
from tests.helpers.pod_ai_selection_fixtures import allow_fixture_snapshot
from tests.test_pod_ai_selection_doors import (
    NOW,
    OWNER,
    OWNER_SESSION,
    PATH,
    _answers,
    _client,
    _envelope,
    _local,
    _opened,
    _owner_verifier,
    _records,
)
from tests.test_pod_ai_selection_doors import (
    owner_session as owner_session,
)
from tests.test_pod_ai_selection_doors import (
    pod as pod,
)
from tests.test_pod_session_authority import hub_key as hub_key


@pytest.mark.parametrize("platform", ["gcp", "azure"])
async def test_default_verification_cannot_clear_a_key_without_authorized_model_access(
    pod, owner_session, monkeypatch, platform
):
    from unittest.mock import Mock

    from hushh_mcp import runtime_settings
    from hushh_mcp.runtime_providers import azure_openai, factory

    await run_ai_selection_put(envelope=_envelope(NOW), check=_answers, now_ms=NOW, **_local())
    monkeypatch.setattr(azure_openai, "owner_azure_model", lambda: None)
    monkeypatch.setattr("hushh_mcp.services.pod_platform.workload_platform", lambda: platform)
    monkeypatch.setattr(runtime_settings, "pod_user_adc_enabled", lambda: False)
    monkeypatch.setattr(runtime_settings, "pod_managed_model_enabled", lambda: False)
    provider = Mock(side_effect=AssertionError("Unauthorized provider call"))
    monkeypatch.setattr(factory, "build_managed_runtime_client", provider)
    result = _client().patch(PATH, headers=OWNER_SESSION)
    assert result.status_code == 409
    assert result.json()["detail"]["code"] == "AI_DEFAULT_UNAVAILABLE"
    provider.assert_not_called()
    assert pod_ai_selection.active_ai_selection().provider == "openai"
    assert len(await _records(pod)) == 1


async def test_owner_revoked_during_provider_check_keeps_previous_selection(pod):
    await run_ai_selection_put(envelope=_envelope(NOW), check=_answers, now_ms=NOW, **_local())
    previous = pod_ai_selection.active_ai_selection()
    admitted = True

    async def verify(_token: str, *, expected_scope: str) -> ConsentVerdict:
        if not admitted:
            return ConsentVerdict(valid=False, available=True, reason="subject revoked")
        return await _owner_verifier(_token, expected_scope=expected_scope)

    async def revoke_during_check(_selection: Any, *, gemini_default: str) -> None:
        nonlocal admitted
        admitted = False

    with pytest.raises(HTTPException) as refused:
        await run_ai_selection_put(
            envelope=_envelope(NOW + 1),
            check=revoke_during_check,
            now_ms=NOW + 1,
            **{**_local(), "verifier": verify},
        )

    assert refused.value.status_code == 403
    assert len(await _records(pod)) == 1
    assert pod_ai_selection.active_ai_selection() == previous


@pytest.mark.parametrize("change", ["revoked", "superseded"])
async def test_authority_change_before_selection_cas_refuses_even_if_index_lags(pod, change):
    from hushh_mcp.services.pod_authority_store import PodAuthorityStore

    session = {
        **_local()["session"],
        "hushh_id": OWNER,
        "user_id": "owner-uid",
        "subject_id": "test-app",
        "version": 1,
        "exp": int(time.time()) + 300,
    }
    authority = PodAuthorityStore(pod, hushh_id=OWNER)
    await authority.load()
    binding = {
        "hushh_id": OWNER,
        "user_id": session["user_id"],
        "subject_id": session["subject_id"],
        "role": "app",
        "scopes": session["scopes"],
        "version": 1,
        "expires_at_ms": session["exp"] * 1000,
    }
    await authority.record_trust(binding)

    async def verifier(_token: str, *, expected_scope: str) -> ConsentVerdict:
        if authority.subject(session["subject_id"]).state != "trusted":
            return ConsentVerdict(valid=False, available=True, reason="subject revoked")
        return await _owner_verifier(_token, expected_scope=expected_scope)

    selection_waiting, resume_selection = asyncio.Event(), asyncio.Event()
    authority_committed, resume_fold = asyncio.Event(), asyncio.Event()
    original_append = pod.append

    async def delayed_append(kind, payload, **kwargs):
        if kind == pod_ai_selection.POD_AI_SELECTION_RECORD_KIND:
            selection_waiting.set()
            await resume_selection.wait()
        written = await original_append(kind, payload, **kwargs)
        if kind in {"authority_tombstone_v1", "authority_trust_v1"}:
            authority_committed.set()
            await resume_fold.wait()
        return written

    pod.append = delayed_append
    selection = asyncio.create_task(
        run_ai_selection_put(
            envelope=_envelope(NOW),
            check=_answers,
            now_ms=NOW,
            **{**_local(), "verifier": verifier, "session": session},
        )
    )
    revocation = None
    try:
        await asyncio.wait_for(selection_waiting.wait(), timeout=5)
        mutation = (
            authority.record_tombstone(session["subject_id"], at_version=1)
            if change == "revoked"
            else authority.record_trust({**binding, "version": 2})
        )
        revocation = asyncio.create_task(mutation)
        await asyncio.wait_for(authority_committed.wait(), timeout=5)
        assert authority.subject(session["subject_id"]).state == "trusted"
        resume_selection.set()
        with pytest.raises(HTTPException) as refused:
            await asyncio.wait_for(selection, timeout=5)
        assert refused.value.status_code == 403
        assert await _records(pod) == []
    finally:
        resume_selection.set()
        resume_fold.set()
        if revocation is not None:
            await revocation
        if not selection.done():
            selection.cancel()
            await asyncio.gather(selection, return_exceptions=True)


async def test_delayed_selection_completion_cannot_restore_a_newer_clear(pod):
    first_committed, resume_first = asyncio.Event(), asyncio.Event()
    original_append = pod.append

    async def delayed_append(kind, payload, **kwargs):
        written = await original_append(kind, payload, **kwargs)
        if kind == pod_ai_selection.POD_AI_SELECTION_RECORD_KIND and not payload.get("cleared"):
            first_committed.set()
            await resume_first.wait()
        return written

    pod.append = delayed_append
    first = asyncio.create_task(
        pod_ai_selection.record_ai_selection(
            pod,
            hushh_id=OWNER,
            opened=_opened(),
            checked_at_ms=NOW,
            authorize=allow_fixture_snapshot,
        )
    )
    try:
        await asyncio.wait_for(first_committed.wait(), timeout=5)
        receipt = {"provider": "azure", "model": "synthetic"}
        await pod_ai_selection.clear_ai_selection(
            pod, hushh_id=OWNER, authorize=allow_fixture_snapshot, verified_default=receipt
        )
        resume_first.set()
        with pytest.raises(pod_ai_selection.AiSelectionSuperseded):
            await asyncio.wait_for(first, timeout=5)
        assert pod_ai_selection.active_ai_selection() is None
        assert pod_ai_selection.default_verification() == receipt
        assert (await pod_ai_selection.read_ai_selection(pod, hushh_id=OWNER))[0] is None
    finally:
        resume_first.set()
        if not first.done():
            first.cancel()
            await asyncio.gather(first, return_exceptions=True)


async def test_delayed_hydration_cannot_replace_a_newer_selection(pod):
    captured, resume = asyncio.Event(), asyncio.Event()
    original_replay = pod.replay
    first_read = True

    async def delayed_replay():
        nonlocal first_read
        records = await original_replay()
        if first_read:
            first_read = False
            captured.set()
            await resume.wait()
        return records

    pod.replay = delayed_replay
    hydration = asyncio.create_task(pod_ai_selection.load_active_ai_selection(pod))
    try:
        await asyncio.wait_for(captured.wait(), timeout=5)
        selected = await pod_ai_selection.record_ai_selection(
            pod,
            hushh_id=OWNER,
            opened=_opened(),
            checked_at_ms=NOW,
            authorize=allow_fixture_snapshot,
        )
        resume.set()
        await asyncio.wait_for(hydration, timeout=5)
        assert pod_ai_selection.active_ai_selection() == selected
    finally:
        resume.set()
        if not hydration.done():
            hydration.cancel()
            await asyncio.gather(hydration, return_exceptions=True)


async def test_older_hydration_cannot_hide_a_newer_unreadable_selection(pod):
    captured, resume = asyncio.Event(), asyncio.Event()
    original_replay = pod.replay
    first_read = True

    async def delayed_replay():
        nonlocal first_read
        records = await original_replay()
        if first_read:
            first_read = False
            captured.set()
            await resume.wait()
        return records

    pod.replay = delayed_replay
    older = asyncio.create_task(pod_ai_selection.load_active_ai_selection(pod))
    try:
        await asyncio.wait_for(captured.wait(), timeout=5)
        await pod.append(
            pod_ai_selection.POD_AI_SELECTION_RECORD_KIND,
            {"hushh_id": OWNER, "issuedAtMs": NOW, "provider": "incomplete"},
        )
        assert await pod_ai_selection.load_active_ai_selection(pod) is None
        assert pod_ai_selection.ai_selection_load_failed()
        resume.set()
        await asyncio.wait_for(older, timeout=5)
        assert pod_ai_selection.ai_selection_load_failed()
        with pytest.raises(pod_ai_selection.AiSelectionUnavailable):
            pod_ai_selection.active_ai_selection()
    finally:
        resume.set()
        if not older.done():
            older.cancel()
            await asyncio.gather(older, return_exceptions=True)


async def test_unknown_read_failure_requires_a_fresh_successful_read(pod):
    captured, resume = asyncio.Event(), asyncio.Event()
    original_replay = pod.replay
    calls = 0

    async def delayed_replay():
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("synthetic unavailable store")
        records = await original_replay()
        if calls == 1:
            captured.set()
            await resume.wait()
        return records

    pod.replay = delayed_replay
    older = asyncio.create_task(pod_ai_selection.load_active_ai_selection(pod))
    try:
        await asyncio.wait_for(captured.wait(), timeout=5)
        await pod_ai_selection.load_active_ai_selection(pod)
        assert pod_ai_selection.ai_selection_load_failed()
        resume.set()
        await asyncio.wait_for(older, timeout=5)
        assert pod_ai_selection.ai_selection_load_failed()
        await pod_ai_selection.load_active_ai_selection(pod)
        assert not pod_ai_selection.ai_selection_load_failed()
    finally:
        resume.set()
        if not older.done():
            older.cancel()
            await asyncio.gather(older, return_exceptions=True)


async def test_committed_selection_reports_recovery_pending_if_cache_cannot_reload(pod):
    waiting, resume = asyncio.Event(), asyncio.Event()
    original_append, original_replay = pod.append, pod.replay

    async def delayed_append(kind, payload, **kwargs):
        if kind == pod_ai_selection.POD_AI_SELECTION_RECORD_KIND:
            waiting.set()
            await resume.wait()
        return await original_append(kind, payload, **kwargs)

    async def unavailable_replay():
        raise OSError("synthetic unavailable store")

    pod.append = delayed_append
    selection = asyncio.create_task(
        run_ai_selection_put(envelope=_envelope(NOW), check=_answers, now_ms=NOW, **_local())
    )
    try:
        await asyncio.wait_for(waiting.wait(), timeout=5)
        pod.replay = unavailable_replay
        await pod_ai_selection.load_active_ai_selection(pod)
        resume.set()
        with pytest.raises(HTTPException) as pending:
            await asyncio.wait_for(selection, timeout=5)
        assert pending.value.status_code == 503
        assert pending.value.detail["code"] == "AI_SELECTION_RECOVERY_PENDING"
        pod.replay = original_replay
        assert len(await _records(pod)) == 1
        assert await pod_ai_selection.load_active_ai_selection(pod) is not None
    finally:
        resume.set()
        pod.replay = original_replay
        if not selection.done():
            selection.cancel()
            await asyncio.gather(selection, return_exceptions=True)


async def test_older_failed_hydration_cannot_poison_a_newer_selection(pod):
    await pod.append(
        pod_ai_selection.POD_AI_SELECTION_RECORD_KIND,
        {"hushh_id": OWNER, "issuedAtMs": NOW, "provider": "incomplete"},
    )
    captured, resume = asyncio.Event(), asyncio.Event()
    original_replay = pod.replay
    first_read = True

    async def delayed_replay():
        nonlocal first_read
        records = await original_replay()
        if first_read:
            first_read = False
            captured.set()
            await resume.wait()
        return records

    pod.replay = delayed_replay
    older = asyncio.create_task(pod_ai_selection.load_active_ai_selection(pod))
    try:
        await asyncio.wait_for(captured.wait(), timeout=5)
        newer = await pod_ai_selection.record_ai_selection(
            pod,
            hushh_id=OWNER,
            opened=_opened(issued_at_ms=NOW + 1),
            checked_at_ms=NOW,
            authorize=allow_fixture_snapshot,
        )
        resume.set()
        await asyncio.wait_for(older, timeout=5)
        assert pod_ai_selection.active_ai_selection() == newer
        assert not pod_ai_selection.ai_selection_load_failed()
    finally:
        resume.set()
        if not older.done():
            older.cancel()
            await asyncio.gather(older, return_exceptions=True)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("hushh_id", "another-owner"),
        ("user_id", "another-user"),
        ("subject_id", "another-app"),
        ("version", 2),
        ("exp", 1),
        ("scopes", []),
    ],
)
async def test_selection_snapshot_refuses_foreign_or_stale_authority(pod, field, value):
    from hushh_mcp.services.pod_ai_selection_authority import require_snapshot_authority
    from hushh_mcp.services.pod_binding_contract import SCOPE_POD_CONFIG, PodSessionRefused

    claims = {**_local()["session"], field: value}
    with pytest.raises(PodSessionRefused):
        require_snapshot_authority(
            await pod.replay(), log=pod, owner=OWNER, session=claims, scope=SCOPE_POD_CONFIG
        )


async def test_admitted_owner_session_can_select_and_clear_ai(pod, tmp_path, hub_key, monkeypatch):
    from tests import test_pod_session_authority as session_tests

    monkeypatch.setattr(session_tests, "OWNER", OWNER)
    world = session_tests.World(tmp_path, name="admitted-owner")
    authority = await world.boot()
    subject = session_tests.Subject("owner-web", "web")
    _token, claims = await world.admit(subject, session_tests._binding(subject))
    door = {
        "consent_token": authority.local_token(claims),
        "verifier": authority.local_verifier(claims),
        "session": claims,
        "log": world.log,
    }
    assert (
        await run_ai_selection_put(envelope=_envelope(NOW), check=_answers, now_ms=NOW, **door)
    )["status"] == "active"
    assert (await run_ai_selection_delete(**door))["status"] == "cleared"


async def test_selection_store_refuses_the_same_issued_version(pod):
    from hushh_mcp.services.pod_ai_selection_seal import AiSelectionRefused

    await pod_ai_selection.record_ai_selection(
        pod, hushh_id=OWNER, opened=_opened(), checked_at_ms=NOW, authorize=allow_fixture_snapshot
    )
    with pytest.raises(AiSelectionRefused):
        await pod_ai_selection.record_ai_selection(
            pod,
            hushh_id=OWNER,
            opened=_opened(),
            checked_at_ms=NOW,
            authorize=allow_fixture_snapshot,
        )


@pytest.mark.parametrize("error_name", ["PodLogConflict", "PodLogFenced"])
async def test_clear_reports_log_refusal_without_changing_selection(pod, monkeypatch, error_name):
    from hushh_mcp.services import pod_commit_log

    await run_ai_selection_put(envelope=_envelope(NOW), check=_answers, now_ms=NOW, **_local())
    previous = pod_ai_selection.active_ai_selection()

    async def refuse_append(*_args, **_kwargs):
        raise getattr(pod_commit_log, error_name)("synthetic refusal")

    monkeypatch.setattr(pod, "append", refuse_append)
    with pytest.raises(HTTPException) as refused:
        await run_ai_selection_delete(**_local())
    expected = (
        (409, "AI_SELECTION_NOT_RECORDED")
        if error_name == "PodLogConflict"
        else (503, "AI_SELECTION_OUTCOME_UNKNOWN")
    )
    assert (refused.value.status_code, refused.value.detail["code"]) == expected
    assert (await pod_ai_selection.read_ai_selection(pod, hushh_id=OWNER))[0] == previous
    if error_name == "PodLogFenced":
        with pytest.raises(pod_ai_selection.AiSelectionUnavailable):
            pod_ai_selection.active_ai_selection()
        await pod_ai_selection.load_active_ai_selection(pod)
    assert pod_ai_selection.active_ai_selection() == previous


@pytest.mark.parametrize("committed", [False, True])
async def test_lost_selection_write_response_requires_readback(pod, committed):
    original_append = pod.append

    async def lost_response(kind, payload, **kwargs):
        if committed:
            await original_append(kind, payload, **kwargs)
        raise OSError("synthetic lost response")

    pod.append = lost_response
    with pytest.raises(HTTPException) as unknown:
        await run_ai_selection_put(envelope=_envelope(NOW), check=_answers, now_ms=NOW, **_local())
    assert unknown.value.status_code == 503
    assert unknown.value.detail["code"] == "AI_SELECTION_OUTCOME_UNKNOWN"
    with pytest.raises(pod_ai_selection.AiSelectionUnavailable):
        pod_ai_selection.active_ai_selection()
    assert len(await _records(pod)) == int(committed)
    await pod_ai_selection.load_active_ai_selection(pod)
    assert (pod_ai_selection.active_ai_selection() is not None) is committed
