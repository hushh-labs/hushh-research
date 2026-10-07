"""A current rendered draft, not identity or a prior yes, authorizes delivery."""

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.one_voice.tools.base import EntityContext, ScreenContext, ToolContext
from hushh_mcp.one_voice.tools.mail_compose import (
    DraftStatusInput,
    EditDraftInput,
    MailComposeRuntime,
    _edit,
    _status,
)
from hushh_mcp.services.gmail_delivery_service import GmailDeliveryError


@pytest.fixture
def compose():
    delivery = SimpleNamespace(
        prepare=AsyncMock(
            return_value={
                "action_id": "a" * 36,
                "state": "prepared",
                "sender_token": "private",
                "sender_label": "owner@example.com",
                "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
            }
        ),
        execute=AsyncMock(return_value={"action_id": "a" * 36, "state": "sent"}),
        cancel_prepared=AsyncMock(return_value={"cancelled": True, "state": "cancelled"}),
        get_action_status=AsyncMock(return_value=None),
    )
    ctx = ToolContext(
        user_id="owner",
        conversation_id="conversation",
        entities=EntityContext(),
        screen=ScreenContext(),
        vault_owner_token="private",  # noqa: S106 - test credential
    )
    ctx.services["gmail_delivery"] = delivery
    runtime = MailComposeRuntime(review_supported=True)
    ctx.services["mail_compose"] = runtime
    return runtime, ctx, delivery


@pytest.fixture
def input_guard(compose):
    runtime, _, _ = compose
    state = SimpleNamespace(generation=1, active=False)
    runtime.input_generation = lambda: state.generation
    runtime.input_active = lambda: state.active
    return state


async def ready(compose):
    runtime, ctx, delivery = compose
    result = await runtime.create(ctx, {"to": "friend@example.com", "subject": "", "body": "Hi"})
    ref, revision = result.draft_ref, result.revision
    assert runtime.mark_reviewed(ref, revision, "a" * 36)
    return ref, revision


@pytest.mark.asyncio
async def test_render_ack_and_exact_revision_are_required(compose):
    runtime, ctx, delivery = compose
    result = await runtime.create(ctx, {"to": "friend@example.com", "subject": "", "body": "Hi"})
    assert (
        runtime.prepare_send(result.draft_ref, result.revision).reason_code == "draft_not_reviewed"
    )
    assert not runtime.mark_reviewed(result.draft_ref, result.revision, "wrong")
    delivery.execute.assert_not_awaited()
    assert "friend@example.com" not in str(result.model_public())
    assert "private" not in str(result.model_public())


@pytest.mark.asyncio
async def test_edit_retires_old_action_and_retains_other_fields(compose):
    runtime, ctx, delivery = compose
    ref, revision = await ready(compose)
    changed = await runtime.edit(ctx, ref, revision, {"subject": "Demo"}, operation_id="edit-1")
    assert changed.revision == revision + 1
    delivery.cancel_prepared.assert_awaited_once()
    assert runtime.tasks[ref].draft["body"] == "Hi"
    assert runtime.prepare_send(ref, revision).reason_code == "draft_stale"
    assert runtime.prepare_send(ref, changed.revision).reason_code == "draft_not_reviewed"
    delivery.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_duplicate_send_reuses_same_action_and_returns_ledger_state(compose):
    runtime, ctx, delivery = compose
    ref, revision = await ready(compose)
    prepared = runtime.prepare_send(ref, revision)
    ctx.prepared = prepared.snapshot
    sent = await runtime.send(ctx, ref, revision)
    repeated = await runtime.send(ctx, ref, revision)
    assert sent.status == repeated.status == "sent"
    delivery.execute.assert_awaited_once()
    assert delivery.execute.await_args.kwargs["draft_payload"]["sender_token"] == "private"


@pytest.mark.asyncio
async def test_cancel_or_foreign_revision_cannot_send(compose):
    runtime, ctx, delivery = compose
    ref, revision = await ready(compose)
    rejected = await runtime.edit(ctx, ref, revision + 1, {"body": "wrong"}, operation_id="stale-1")
    assert rejected.reason_code == "draft_stale"
    delivery.cancel_prepared.assert_not_awaited()
    cancelled = await runtime.cancel(ctx, ref, revision)
    assert cancelled.status == "cancelled"
    assert runtime.prepare_send(ref, revision).reason_code == "draft_not_reviewed"
    delivery.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_invalid_edit_blocks_old_review_before_validation(compose):
    runtime, ctx, delivery = compose
    ref, revision = await ready(compose)
    invalid = await runtime.edit(ctx, ref, revision, {"to": "broken"}, operation_id="edit-invalid")
    assert invalid.status == "needs_input"
    assert runtime.prepare_send(ref, revision).reason_code == "draft_stale"
    delivery.cancel_prepared.assert_awaited_once()
    delivery.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_missing_delivery_state_is_unknown_never_success(compose):
    runtime, ctx, delivery = compose
    ref, revision = await ready(compose)
    ctx.prepared = runtime.prepare_send(ref, revision).snapshot
    delivery.execute.return_value = {"action_id": "a" * 36}
    result = await runtime.send(ctx, ref, revision)
    assert result.status == "outcome_unknown"
    await runtime.send(ctx, ref, revision)
    delivery.execute.assert_awaited_once()


@pytest.mark.asyncio
async def test_retirement_failure_keeps_old_action_until_verified(compose):
    runtime, ctx, delivery = compose
    ref, revision = await ready(compose)
    delivery.cancel_prepared.side_effect = RuntimeError("private transport failure")
    result = await runtime.edit(ctx, ref, revision, {"body": "New"}, operation_id="edit-fail")
    assert result.reason_code == "review_retirement_unavailable"
    assert runtime.tasks[ref].prepared["action_id"] == "a" * 36
    assert runtime.tasks[ref].revision == revision
    assert runtime.tasks[ref].draft["body"] == "Hi"
    assert runtime.prepare_send(ref, revision).reason_code == "draft_not_reviewed"
    await runtime.edit(ctx, ref, revision, {"body": "New"}, operation_id="edit-retry")
    assert delivery.prepare.await_count == 1
    delivery.cancel_prepared.side_effect = None
    result = await runtime.edit(ctx, ref, revision, {"body": "New"}, operation_id="edit-recovered")
    assert result.status == "review_requested"
    assert result.revision == revision + 1
    assert delivery.prepare.await_count == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["invalidate", "cancel"])
async def test_queued_stale_request_does_not_retire_newer_revision(compose, method):
    runtime, ctx, delivery = compose
    ref, revision = await ready(compose)
    task = runtime.tasks[ref]
    await task.lock.acquire()
    request = asyncio.create_task(getattr(runtime, method)(ctx, ref, revision))
    await asyncio.sleep(0)
    task.revision += 1
    task.state = "review_pending"
    task.prepared = {**task.prepared, "action_id": "b" * 36}
    task.lock.release()
    result = await request
    assert result.reason_code == "draft_stale"
    assert task.prepared["action_id"] == "b" * 36
    assert task.state == "review_pending"
    delivery.cancel_prepared.assert_not_awaited()


@pytest.mark.asyncio
async def test_cancel_during_prepare_cannot_resurrect_review(compose):
    runtime, ctx, delivery = compose
    preparing, release = asyncio.Event(), asyncio.Event()
    prepared = dict(delivery.prepare.return_value)

    async def wait_prepare(**_):
        preparing.set()
        await release.wait()
        return prepared

    delivery.prepare.side_effect = wait_prepare
    creation = asyncio.create_task(runtime.create(ctx, {"to": "friend@example.com", "body": "Hi"}))
    await preparing.wait()
    task = next(iter(runtime.tasks.values()))
    cancellation = asyncio.create_task(runtime.cancel(ctx, task.ref, task.revision))
    await asyncio.sleep(0)
    release.set()
    await creation
    result = await cancellation
    assert result.status == task.state == "cancelled"
    assert not task.prepared and not task.draft and not task.rendered
    assert not runtime.mark_reviewed(task.ref, task.revision, "a" * 36)
    delivery.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_edit_during_recipient_validation_fences_send(compose, monkeypatch):
    from hushh_mcp.one_voice.tools import mail_recipients

    runtime, ctx, delivery = compose
    ref, revision = await ready(compose)
    task = runtime.tasks[ref]
    task.recipients = object()
    checking, release = asyncio.Event(), asyncio.Event()

    async def wait_check(*_):
        checking.set()
        await release.wait()
        return task.recipients

    monkeypatch.setattr(mail_recipients, "revalidate_recipient_sources", wait_check)
    ctx.prepared = runtime.prepare_send(ref, revision).snapshot
    sending = asyncio.create_task(runtime.send(ctx, ref, revision))
    await checking.wait()
    correction = asyncio.create_task(runtime.invalidate(ctx, ref, revision))
    await asyncio.sleep(0)
    release.set()
    result = await sending
    await correction
    assert result.reason_code == "draft_changed"
    delivery.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_non_sendable_action_is_unknown_and_cannot_create_another(compose):
    runtime, ctx, delivery = compose
    ref, revision = await ready(compose)
    ctx.prepared = runtime.prepare_send(ref, revision).snapshot
    delivery.execute.side_effect = GmailDeliveryError("ACTION_NOT_SENDABLE", "private error")
    result = await runtime.send(ctx, ref, revision)
    assert result.status == "outcome_unknown"
    other = await runtime.create(ctx, {"to": "friend@example.com", "body": "Hi"})
    assert other.status == "draft_already_open"
    assert "private error" not in str(result.model_public())
    await runtime.send(ctx, ref, revision)
    delivery.execute.assert_awaited_once()


@pytest.mark.asyncio
async def test_failed_recipient_correction_cannot_restore_old_destination(compose):
    runtime, ctx, delivery = compose
    ref, revision = await ready(compose)
    result = await _edit(
        ctx,
        EditDraftInput.model_validate({"draft_ref": ref, "revision": revision, "recipients": []}),
    )
    assert result.status == "needs_input"
    task = runtime.tasks[ref]
    assert task.draft["to"] == task.draft["cc"] == task.draft["bcc"] == ""
    changed = await runtime.edit(ctx, ref, task.revision, {"body": "New"}, operation_id="body-edit")
    assert changed.status == "needs_input"
    assert changed.client_step["prepared"] is None
    assert changed.client_step["draft"]["body"] == "New"
    assert "New" not in str(changed.model_public())
    assert delivery.prepare.await_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("expires", [None, "nonsense", "2000-01-01T00:00:00Z"])
async def test_missing_invalid_or_expired_review_never_authorizes_send(compose, expires):
    runtime, ctx, delivery = compose
    ref, revision = await ready(compose)
    runtime.tasks[ref].prepared["expires_at"] = expires
    assert runtime.prepare_send(ref, revision).reason_code == "draft_expired"
    delivery.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_status_cannot_use_wrong_action_or_reopen_cancelled_draft(compose):
    runtime, ctx, delivery = compose
    ref, revision = await ready(compose)
    reader = AsyncMock(return_value={"action_id": "wrong", "state": "sent"})
    ctx.services["mail_delivery_status"] = reader
    result = await _status(ctx, DraftStatusInput(draft_ref=ref))
    assert result.status == "unverified"
    assert runtime.tasks[ref].state == "review_ready"
    await runtime.cancel(ctx, ref, revision)
    reader.reset_mock()
    result = await _status(ctx, DraftStatusInput(draft_ref=ref))
    assert result.status == "cancelled"
    reader.assert_not_awaited()


@pytest.mark.asyncio
async def test_status_recovers_retirement_only_from_authoritative_terminal_state(compose):
    runtime, ctx, delivery = compose
    ref, revision = await ready(compose)
    delivery.cancel_prepared.side_effect = RuntimeError("storage unavailable")
    await runtime.edit(ctx, ref, revision, {"body": "New"}, operation_id="edit-fail")
    ctx.services["mail_delivery_status"] = AsyncMock(
        return_value={"action_id": "a" * 36, "state": "cancelled"}
    )
    result = await _status(ctx, DraftStatusInput(draft_ref=ref))
    assert result.status == "needs_input"
    assert not runtime.tasks[ref].prepared
    assert runtime.tasks[ref].draft["body"] == "Hi"


@pytest.mark.asyncio
async def test_full_typed_snapshot_preserves_unchanged_connection_sources(compose, monkeypatch):
    from hushh_mcp.one_voice.tools import mail_recipients

    runtime, ctx, delivery = compose
    ref, revision = await ready(compose)
    task = runtime.tasks[ref]
    snapshot = SimpleNamespace(
        sources=[SimpleNamespace(kind="connection", person=SimpleNamespace(user_id="friend"))]
    )
    task.recipients = snapshot
    changed = await runtime.edit(
        ctx,
        ref,
        revision,
        {**task.draft, "to": "Friend@EXAMPLE.com", "body": "New"},
        operation_id="typed-body",
    )
    assert task.recipients is snapshot
    assert delivery.prepare.await_args.kwargs["draft_payload"]["_connection_recipient_ids"] == [
        "friend"
    ]
    check = AsyncMock(return_value=snapshot)
    monkeypatch.setattr(mail_recipients, "revalidate_recipient_sources", check)
    assert runtime.mark_reviewed(ref, changed.revision, "a" * 36)
    ctx.prepared = runtime.prepare_send(ref, changed.revision).snapshot
    await runtime.send(ctx, ref, changed.revision)
    check.assert_awaited_once_with(ctx, snapshot)


@pytest.mark.asyncio
async def test_actual_typed_destination_change_replaces_old_connection_authority(compose):
    runtime, ctx, delivery = compose
    ref, revision = await ready(compose)
    task = runtime.tasks[ref]
    task.recipients = SimpleNamespace(
        sources=[SimpleNamespace(kind="connection", person=SimpleNamespace(user_id="friend"))]
    )
    changed = await runtime.edit(
        ctx,
        ref,
        revision,
        {**task.draft, "to": "other@example.com"},
        operation_id="typed-recipient",
    )
    assert changed.status == "review_requested"
    assert task.recipients is None
    assert delivery.prepare.await_args.kwargs["draft_payload"]["_connection_recipient_ids"] == []


@pytest.mark.asyncio
async def test_draft_open_or_identity_input_cannot_approve_send_but_new_yes_can(
    compose, input_guard
):
    runtime, ctx, delivery = compose
    ref, revision = await ready(compose)
    ctx.prepared = runtime.prepare_send(ref, revision).snapshot
    assert ctx.prepared["proposal_input_generation"] == input_guard.generation
    refused = await runtime.send(ctx, ref, revision)
    assert refused.reason_code == "send_approval_required"
    delivery.execute.assert_not_awaited()
    input_guard.generation += 1
    sent = await runtime.send(ctx, ref, revision)
    assert sent.status == "sent"
    assert delivery.execute.await_args.kwargs["authorization_check"]() is True
    delivery.execute.assert_awaited_once()


@pytest.mark.asyncio
async def test_unfinished_new_input_and_missing_proposal_generation_cannot_send(
    compose, input_guard
):
    runtime, ctx, delivery = compose
    ref, revision = await ready(compose)
    ctx.prepared = runtime.prepare_send(ref, revision).snapshot
    input_guard.generation += 1
    input_guard.active = True
    assert (await runtime.send(ctx, ref, revision)).reason_code == "send_approval_required"
    input_guard.active = False
    ctx.prepared.pop("proposal_input_generation")
    assert (await runtime.send(ctx, ref, revision)).reason_code == "send_approval_required"
    delivery.execute.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("admission", ["earlier_completed", "unfinished", "missing"])
async def test_send_uses_admitted_approval_not_later_completed_input(
    compose, input_guard, admission
):
    runtime, ctx, delivery = compose
    ref, revision = await ready(compose)
    ctx.prepared = runtime.prepare_send(ref, revision).snapshot
    input_guard.generation += 1
    admitted = (input_guard.generation, admission == "unfinished")
    runtime.approval_input = lambda: None if admission == "missing" else admitted
    if admission == "earlier_completed":
        # A new utterance both starts and finishes while executor confirmation
        # or proof/storage checks await. It cannot become this call's approval.
        input_guard.generation += 1
    input_guard.active = False
    refused = await runtime.send(ctx, ref, revision)
    assert refused.reason_code == "send_approval_required"
    delivery.execute.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["recipients", "claim"])
@pytest.mark.parametrize("change", ["generation", "active", "typed_edit"])
async def test_new_input_during_await_blocks_claim_until_fresh_review(
    compose, input_guard, monkeypatch, phase, change
):
    from hushh_mcp.one_voice.tools import mail_recipients

    runtime, ctx, delivery = compose
    ref, revision = await ready(compose)
    ctx.prepared = runtime.prepare_send(ref, revision).snapshot
    input_guard.generation += 1  # the answer to this send-specific proposal
    waiting, release = asyncio.Event(), asyncio.Event()
    provider_send = AsyncMock()
    callback_results = []

    async def check_recipients(*_):
        if phase == "recipients":
            waiting.set()
            await release.wait()
        return runtime.tasks[ref].recipients

    async def execute(*, authorization_check, **_):
        if phase == "claim":
            waiting.set()
            await release.wait()
        allowed = authorization_check()
        callback_results.append(allowed)
        if not allowed:
            raise GmailDeliveryError("VOICE_APPROVAL_SUPERSEDED", "New input replaced approval.")
        await provider_send()
        return {"action_id": "a" * 36, "state": "sent"}

    runtime.tasks[ref].recipients = SimpleNamespace(sources=[])
    monkeypatch.setattr(mail_recipients, "revalidate_recipient_sources", check_recipients)
    delivery.execute.side_effect = execute
    sending = asyncio.create_task(runtime.send(ctx, ref, revision))
    await asyncio.wait_for(waiting.wait(), timeout=2)
    typed_edit = None
    if change == "generation":
        input_guard.generation += 1
    elif change == "active":
        input_guard.active = True
    else:
        typed_edit = asyncio.create_task(runtime.invalidate(ctx, ref, revision))
        await asyncio.sleep(0)
    release.set()
    refused = await sending
    if typed_edit is not None:
        await typed_edit
    assert refused.status != "sent"
    assert not any(callback_results)
    provider_send.assert_not_awaited()

    # Finishing the new input does not reuse the consumed approval. A new
    # rendered review and a later explicit answer must be issued first.
    input_guard.active = False
    prior_attempts = delivery.execute.await_count
    await runtime.send(ctx, ref, revision)
    assert delivery.execute.await_count == prior_attempts
    assert runtime.prepare_send(ref, revision).reason_code == "draft_not_reviewed"
    renewed = await runtime.edit(ctx, ref, revision, {}, operation_id="fresh-review")
    assert renewed.status == "review_requested"
    assert runtime.prepare_send(ref, renewed.revision).reason_code == "draft_not_reviewed"
    assert runtime.mark_reviewed(ref, renewed.revision, "a" * 36)
    ctx.prepared = runtime.prepare_send(ref, renewed.revision).snapshot
    input_guard.generation += 1
    delivery.execute.side_effect = None
    sent = await runtime.send(ctx, ref, renewed.revision)
    assert sent.status == "sent"
