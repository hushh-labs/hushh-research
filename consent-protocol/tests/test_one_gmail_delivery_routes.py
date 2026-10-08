from __future__ import annotations

import asyncio
from collections.abc import Iterator
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, create_autospec, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes.one import gmail_delivery as module
from hushh_mcp.services import gmail_reply_source_service as reply_source
from hushh_mcp.services.gmail_delivery_service import (
    GmailDeliveryError,
    GmailDeliveryService,
    GmailReplyContext,
)
from hushh_mcp.services.gmail_reply_source_service import resolve_source_bound_reply


def _app(*, owner_user_id: str = "firebase-user") -> FastAPI:
    app = FastAPI()
    app.include_router(module.router)
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase-user"
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": owner_user_id,
        "token": "vault-owner-token",
    }
    return app


def _envelope() -> dict[str, object]:
    return {
        "to": ["recipient@example.com"],
        "cc": [],
        "bcc": [],
        "subject": "Hello",
        "body": "Message",
        "html_body": "<p>Message</p>",
    }


def test_prepare_derives_user_from_matching_firebase_and_vault_owner():
    service = MagicMock()
    service.prepare = AsyncMock(return_value={"action_id": "action", "state": "prepared"})
    with patch.object(module, "get_gmail_delivery_service", return_value=service):
        response = TestClient(_app()).post(
            "/api/one/email/prepare",
            json={
                **_envelope(),
                "to": "recipient@example.com",
                "cc": "",
                "bcc": "",
                "idempotency_key": "x" * 16,
            },
        )

    assert response.status_code == 200
    assert service.prepare.await_args.kwargs["user_id"] == "firebase-user"
    assert service.prepare.await_args.kwargs["draft_payload"] == {
        **_envelope(),
        "to": "recipient@example.com",
        "cc": "",
        "bcc": "",
    }


def test_delivery_rejects_firebase_vault_owner_mismatch_without_caller_user_id():
    response = TestClient(_app(owner_user_id="other-user")).post(
        "/api/one/email/draft",
        json={"instruction": "Draft a greeting."},
    )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "GMAIL_DELIVERY_USER_MISMATCH"


def test_prepare_accepts_one_drive_reference_and_returns_reviewable_descriptor():
    descriptor = {
        "revision": "revision-1",
        "sha256": "a" * 64,
        "filename": "note.txt",
        "mime_type": "text/plain",
        "size": 12,
        "source_account_label": "owner@example.com",
    }
    service = MagicMock()
    service.prepare = AsyncMock(
        return_value={
            "action_id": "action",
            "state": "prepared",
            "drive_attachment": descriptor,
            "attachment_token": "opaque-token",
        }
    )
    with patch.object(module, "get_gmail_delivery_service", return_value=service):
        response = TestClient(_app()).post(
            "/api/one/email/prepare",
            json={
                **_envelope(),
                "idempotency_key": "x" * 16,
                "drive_attachment": {"file_id": "drive-file-1"},
            },
        )
    assert response.status_code == 200
    assert response.json()["drive_attachment"] == descriptor
    assert response.json()["attachment_token"] == "opaque-token"
    assert "file_id" not in response.json()["drive_attachment"]
    assert service.prepare.await_args.kwargs["draft_payload"]["drive_attachment"] == {
        "file_id": "drive-file-1",
    }
    service.execute.assert_not_called()


def test_send_passes_opaque_attachment_token_to_owner_service():
    token = "opaque-token" * 4
    sender_token = "sealed-sender-review" * 4
    service = MagicMock()
    service.execute = AsyncMock(return_value={"action_id": "action", "state": "sent"})
    with patch.object(module, "get_gmail_delivery_service", return_value=service):
        response = TestClient(_app()).post(
            "/api/one/email/send",
            json={
                **_envelope(),
                "action_id": "action",
                "attachment_token": token,
                "sender_token": sender_token,
                "draft_ref": "voice-review",
                "revision": 2,
            },
        )
    assert response.status_code == 200
    assert service.execute.await_args.kwargs["user_id"] == "firebase-user"
    assert service.execute.await_args.kwargs["draft_payload"]["attachment_token"] == token
    assert service.execute.await_args.kwargs["draft_payload"]["sender_token"] == sender_token
    assert service.execute.await_args.kwargs["draft_payload"]["draft_ref"] == "voice-review"
    assert service.execute.await_args.kwargs["draft_payload"]["revision"] == 2


def test_save_gmail_draft_is_explicit_and_rejects_attachments():
    draft = AsyncMock(return_value={"status": "saved", "draft_id": "draft-1"})
    with patch.object(module, "create_reviewed_gmail_draft", draft):
        client = TestClient(_app())
        response = client.post("/api/one/email/draft/save", json=_envelope())
        rejected = client.post(
            "/api/one/email/draft/save",
            json={**_envelope(), "drive_attachment": {"file_id": "private-file"}},
        )
    assert response.status_code == 200
    assert response.json() == {"status": "saved", "draft_id": "draft-1"}
    assert rejected.status_code == 422
    draft.assert_awaited_once()
    assert draft.await_args.kwargs["user_id"] == "firebase-user"


def test_save_gmail_draft_rejects_malformed_service_acknowledgement():
    draft = AsyncMock(return_value={"status": "saved", "draft_id": ""})
    with patch.object(module, "create_reviewed_gmail_draft", draft):
        response = TestClient(_app()).post("/api/one/email/draft/save", json=_envelope())
    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "GMAIL_SEND_NOT_READY"


def test_source_bound_delivery_uses_the_common_routes_without_trusting_the_browser_envelope():
    delivery = MagicMock()
    delivery.prepare = AsyncMock(return_value={"action_id": "action", "state": "prepared"})
    delivery.execute = AsyncMock(return_value={"action_id": "action", "state": "sent"})
    reply_context = type("ReplyContext", (), {"thread_id": "thread-1"})()
    source = MagicMock()
    source.resolve_reply_delivery = AsyncMock(
        return_value=(
            {
                "to": ["verified@example.com"],
                "cc": [],
                "bcc": [],
                "subject": "Re: Verified request",
                "body": "Approved details",
            },
            reply_context,
        )
    )
    source.record_reply_delivery = AsyncMock(return_value={"action_id": "action", "state": "sent"})

    with (
        patch.object(module, "get_gmail_delivery_service", return_value=delivery),
        patch.object(
            module,
            "get_personal_gmail_information_request_service",
            return_value=source,
        ),
    ):
        client = TestClient(_app())
        prepared = client.post(
            "/api/one/email/prepare",
            json={
                **_envelope(),
                "to": "attacker@example.com",
                "idempotency_key": "x" * 16,
                "source_workflow_id": "workflow-1",
            },
        )
        sent = client.post(
            "/api/one/email/send",
            json={
                **_envelope(),
                "to": "attacker@example.com",
                "action_id": "action",
                "source_workflow_id": "workflow-1",
                "sender_token": "sealed-source-sender" * 4,
            },
        )

    assert prepared.status_code == 200
    assert sent.status_code == 200
    # The information-request card keeps its thread id; an offered-mail reply's
    # preview omits it (test_offered_mail_reply_takes_only_its_body_...).
    assert prepared.json()["preview"]["gmail_thread_id"] == "thread-1"
    assert source.resolve_reply_delivery.await_args_list[0].kwargs == {
        "user_id": "firebase-user",
        "workflow_id": "workflow-1",
        "body": "Message",
        "html_body": "<p>Message</p>",
    }
    assert delivery.prepare.await_args.kwargs["draft_payload"]["to"] == ["verified@example.com"]
    assert delivery.prepare.await_args.kwargs["reply_context"] is reply_context
    assert delivery.execute.await_args.kwargs["draft_payload"]["to"] == ["verified@example.com"]
    assert delivery.execute.await_args.kwargs["reply_context"] is reply_context
    assert (
        delivery.execute.await_args.kwargs["draft_payload"]["sender_token"]
        == "sealed-source-sender" * 4
    )
    assert source.record_reply_delivery.await_args.kwargs == {
        "user_id": "firebase-user",
        "workflow_id": "workflow-1",
        "result": {"action_id": "action", "state": "sent"},
    }


def test_route_rejects_multiple_attachments_and_caller_supplied_bytes():
    client = TestClient(_app())
    for payload in (
        {"drive_attachment": [{"file_id": "a", "revision": "r"}]},
        {"attachments": [{"file_id": "a", "revision": "r"}]},
        {"drive_attachment": {"file_id": "a", "revision": "r", "content": "raw"}},
    ):
        response = client.post(
            "/api/one/email/prepare",
            json={**_envelope(), "idempotency_key": "x" * 16, **payload},
        )
        assert response.status_code == 422


def test_send_rejects_file_reference_instead_of_opaque_token():
    response = TestClient(_app()).post(
        "/api/one/email/send",
        json={
            **_envelope(),
            "action_id": "action",
            "drive_attachment": {"file_id": "drive-file-1", "revision": "revision-1"},
        },
    )
    assert response.status_code == 422


def test_mailbox_execute_runs_only_the_vault_owners_reviewed_proposal():
    service = MagicMock()
    service.execute = AsyncMock(
        return_value={"status": "executed", "action": "archive", "count": 2}
    )
    with patch.object(module, "get_gmail_mailbox_actions", return_value=service):
        ok = TestClient(_app()).post(
            "/api/one/email/mailbox/execute", json={"proposal_id": "gmod_reviewed"}
        )
        mismatch = TestClient(_app(owner_user_id="other-user")).post(
            "/api/one/email/mailbox/execute", json={"proposal_id": "gmod_reviewed"}
        )
        # The caller names only a proposal; ids, actions and labels come from the server.
        smuggled = TestClient(_app()).post(
            "/api/one/email/mailbox/execute",
            json={"proposal_id": "gmod_reviewed", "action": "trash", "message_ids": ["m"]},
        )
    assert ok.status_code == 200
    assert mismatch.status_code == 403
    assert smuggled.status_code == 422
    service.execute.assert_awaited_once_with(user_id="firebase-user", proposal_id="gmod_reviewed")


# A reply to an email One offered travels as an opaque ``source_mail_ref``; the
# server re-derives its recipient, subject and thread on every prepare and send.
_REPLY_REF = "rs1." + "A" * 40
_REPLY_CONTEXT = GmailReplyContext(
    thread_id="thread-offered",
    in_reply_to="<offered@example.com>",
    references="<offered@example.com>",
)
_DERIVED_REPLY = {
    "to": ["sender@example.com"],
    "cc": [],
    "bcc": [],
    "subject": "Re: Quarterly numbers",
    "body": "Message",
    "html_body": "<p>Message</p>",
}
# What a browser trying to retarget the reviewed reply would submit.
_SPOOFED = {
    "to": "attacker@example.com",
    "cc": "spy@example.com",
    "bcc": "hidden@example.com",
    "subject": "Wire the funds",
}


def _request(path: str) -> dict[str, object]:
    return {"idempotency_key": "x" * 16} if path == "prepare" else {"action_id": "action"}


def _minted_reply_ref(monkeypatch: pytest.MonkeyPatch) -> str:
    """A reference exactly as the voice tool mints it, so the route schema must accept it."""
    monkeypatch.setattr(
        reply_source,
        "get_core_security_settings",
        lambda: SimpleNamespace(app_signing_key="test-signing-key"),
    )
    source = reply_source.GmailReplySource(
        account="google-account-1",
        message_id="18f1c2d3e4a5b6c7",
        thread_id=_REPLY_CONTEXT.thread_id,
        recipient_email="sender@example.com",
        recipient_display="Sender",
        subject="Re: Quarterly numbers",
        reply_context=_REPLY_CONTEXT,
        fingerprint="f" * 64,
    )
    return reply_source.seal_reply_source_ref(
        source, owner_user_id="firebase-user", now=1_800_000_000
    )


@contextmanager
def _reply_routes(*, enabled: bool) -> Iterator[SimpleNamespace]:
    """The delivery routes with signature-checked doubles for every Gmail dependency."""
    delivery = create_autospec(GmailDeliveryService, instance=True)
    delivery.prepare.return_value = {"action_id": "action", "state": "prepared"}
    delivery.execute.return_value = {"action_id": "action", "state": "sent"}
    resolve = create_autospec(resolve_source_bound_reply)
    resolve.return_value = (dict(_DERIVED_REPLY), _REPLY_CONTEXT)
    kyc = MagicMock()
    kyc.resolve_reply_delivery = AsyncMock(
        return_value=(
            {
                "to": ["verified@example.com"],
                "cc": [],
                "bcc": [],
                "subject": "Re: Verified request",
                "body": "Message",
            },
            GmailReplyContext(thread_id="thread-kyc"),
        )
    )
    receipts = object()
    with (
        patch.object(module, "voice_mail_reply_enabled", return_value=enabled),
        patch.object(module, "resolve_source_bound_reply", resolve),
        patch.object(
            module, "get_gmail_receipts_service", return_value=receipts
        ) as receipts_accessor,
        patch.object(module, "get_gmail_delivery_service", return_value=delivery),
        patch.object(
            module, "get_personal_gmail_information_request_service", return_value=kyc
        ) as kyc_accessor,
    ):
        yield SimpleNamespace(
            client=TestClient(_app()),
            delivery=delivery,
            resolve=resolve,
            receipts=receipts,
            receipts_accessor=receipts_accessor,
            kyc=kyc,
            kyc_accessor=kyc_accessor,
        )


def test_offered_mail_reply_takes_only_its_body_from_the_browser_on_prepare_and_send(
    monkeypatch,
):
    ref = _minted_reply_ref(monkeypatch)
    with _reply_routes(enabled=True) as h:
        prepared = h.client.post(
            "/api/one/email/prepare",
            json={**_envelope(), **_SPOOFED, **_request("prepare"), "source_mail_ref": ref},
        )
        sent = h.client.post(
            "/api/one/email/send",
            json={**_envelope(), **_SPOOFED, **_request("send"), "source_mail_ref": ref},
        )
        # The access check handed to the source read is the reply switch itself,
        # so turning it off withdraws a read already in flight.
        require_access = h.resolve.await_args.kwargs["require_access"]
        asyncio.run(require_access())
        with (
            patch.object(module, "voice_mail_reply_enabled", return_value=False),
            pytest.raises(PermissionError),
        ):
            asyncio.run(require_access())

    assert prepared.status_code == 200
    assert sent.status_code == 200
    # Derived again from the source for the send, never carried over from prepare.
    assert [call.kwargs for call in h.resolve.await_args_list] == [
        {
            "gmail": h.receipts,
            "user_id": "firebase-user",
            "source_mail_ref": ref,
            "body": "Message",
            "html_body": "<p>Message</p>",
            "require_access": require_access,
        }
    ] * 2
    assert h.delivery.prepare.await_args.kwargs == {
        "user_id": "firebase-user",
        "draft_payload": _DERIVED_REPLY,
        "idempotency_key": "x" * 16,
        "reply_context": _REPLY_CONTEXT,
    }
    assert h.delivery.execute.await_args.kwargs == {
        "user_id": "firebase-user",
        "action_id": "action",
        "draft_payload": _DERIVED_REPLY,
        "reply_context": _REPLY_CONTEXT,
    }
    # The person reviews the derived envelope; the thread id stays server-side.
    assert prepared.json() == {
        "action_id": "action",
        "state": "prepared",
        "preview": {
            "to": ["sender@example.com"],
            "cc": [],
            "bcc": [],
            "subject": "Re: Quarterly numbers",
        },
    }
    assert _REPLY_CONTEXT.thread_id not in prepared.text
    # Not an information-request reply: that workflow's ledger is never touched.
    h.kyc_accessor.assert_not_called()
    assert sent.json() == {"action_id": "action", "state": "sent"}


def test_reply_switch_off_refuses_an_offered_mail_reply_before_any_gmail_read():
    with _reply_routes(enabled=False) as h:
        refused = [
            h.client.post(
                f"/api/one/email/{path}",
                json={**_envelope(), **_request(path), "source_mail_ref": _REPLY_REF},
            )
            for path in ("prepare", "send")
        ]
        h.delivery.prepare.assert_not_awaited()
        # Negative control: information-request replies do not answer to this switch.
        kyc_reply = h.client.post(
            "/api/one/email/prepare",
            json={**_envelope(), **_request("prepare"), "source_workflow_id": "workflow-1"},
        )

    for response in refused:
        assert response.status_code == 403
        assert response.json()["detail"]["code"] == "MAIL_REPLY_UNAVAILABLE"
    h.resolve.assert_not_awaited()
    h.receipts_accessor.assert_not_called()
    h.delivery.execute.assert_not_awaited()
    assert kyc_reply.status_code == 200
    h.kyc.resolve_reply_delivery.assert_awaited_once()
    assert h.delivery.prepare.await_args.kwargs["draft_payload"]["to"] == ["verified@example.com"]


@pytest.mark.parametrize("reply_switch", [False, True])
def test_fresh_compose_passes_its_envelope_through_whatever_the_reply_switch(reply_switch):
    with _reply_routes(enabled=reply_switch) as h:
        prepared = h.client.post(
            "/api/one/email/prepare", json={**_envelope(), **_request("prepare")}
        )
        sent = h.client.post("/api/one/email/send", json={**_envelope(), **_request("send")})

    assert prepared.status_code == 200
    assert sent.status_code == 200
    assert prepared.json() == {"action_id": "action", "state": "prepared"}
    for call in (h.delivery.prepare.await_args, h.delivery.execute.await_args):
        assert call.kwargs["draft_payload"] == _envelope()
        assert call.kwargs["reply_context"] is None
    h.resolve.assert_not_awaited()
    h.receipts_accessor.assert_not_called()
    h.kyc_accessor.assert_not_called()


@pytest.mark.parametrize(
    ("path", "extra", "code"),
    [
        pytest.param(
            "prepare",
            {"source_workflow_id": "workflow-1"},
            "SOURCE_BINDING_CONFLICT",
            id="prepare-two-sources",
        ),
        pytest.param(
            "send",
            {"source_workflow_id": "workflow-1"},
            "SOURCE_BINDING_CONFLICT",
            id="send-two-sources",
        ),
        pytest.param(
            "prepare",
            {"drive_attachment": {"file_id": "drive-file-1"}},
            "SOURCE_BOUND_ATTACHMENT_UNSUPPORTED",
            id="prepare-drive-attachment",
        ),
        pytest.param(
            "send",
            {"attachment_token": "opaque-token" * 4},
            "SOURCE_BOUND_ATTACHMENT_UNSUPPORTED",
            id="send-attachment-token",
        ),
    ],
)
def test_offered_mail_reply_with_a_second_source_or_an_attachment_is_refused(path, extra, code):
    with _reply_routes(enabled=True) as h:
        response = h.client.post(
            f"/api/one/email/{path}",
            json={**_envelope(), **_request(path), "source_mail_ref": _REPLY_REF, **extra},
        )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == code
    # Refused outright: never resolved, blended with the other source, or sent
    # with the reviewed attachment silently dropped.
    h.resolve.assert_not_awaited()
    h.kyc_accessor.assert_not_called()
    h.delivery.prepare.assert_not_awaited()
    h.delivery.execute.assert_not_awaited()


@pytest.mark.parametrize("path", ["prepare", "send"])
def test_source_mail_ref_must_have_the_sealed_reference_shape(path):
    malformed = (
        "18f1c2d3e4a5b6c7d8e9",  # a bare Gmail message id
        "rs2." + "A" * 40,  # another reference version
        'rs1.{"to":"attacker@example.com"}',  # an envelope smuggled as a reference
        "rs1." + "A" * 2045,  # past the length bound
    )
    with _reply_routes(enabled=True) as h:
        responses = [
            h.client.post(
                f"/api/one/email/{path}",
                json={**_envelope(), **_request(path), "source_mail_ref": ref},
            )
            for ref in malformed
        ]

    for response in responses:
        assert response.status_code == 422
        assert [error["loc"][-1] for error in response.json()["detail"]] == ["source_mail_ref"]
    h.resolve.assert_not_awaited()
    h.delivery.prepare.assert_not_awaited()
    h.delivery.execute.assert_not_awaited()


@pytest.mark.parametrize("path", ["prepare", "send"])
@pytest.mark.parametrize(
    ("error", "status_code", "code"),
    [
        pytest.param(
            GmailDeliveryError(
                "REPLY_SOURCE_CHANGED",
                "That email changed. Review the reply again.",
                status_code=409,
            ),
            409,
            "REPLY_SOURCE_CHANGED",
            id="source-changed",
        ),
        pytest.param(
            GmailDeliveryError(
                "REPLY_TARGET_IS_OWNER",
                "That email is from you, so its reply would come back to you.",
                status_code=422,
            ),
            422,
            "REPLY_TARGET_IS_OWNER",
            id="target-is-owner",
        ),
        pytest.param(
            GmailDeliveryError(
                "MAIL_REPLY_UNAVAILABLE", "Replying from One is switched off.", status_code=403
            ),
            403,
            "MAIL_REPLY_UNAVAILABLE",
            id="switched-off-mid-read",
        ),
        # Negative control: an unexpected failure is the generic outage, with no
        # provider text reflected.
        pytest.param(
            RuntimeError("provider said sender@example.com"),
            503,
            "GMAIL_DELIVERY_UNAVAILABLE",
            id="unexpected",
        ),
    ],
)
def test_reply_source_failure_keeps_its_code_and_never_reaches_delivery(
    path, error, status_code, code
):
    with _reply_routes(enabled=True) as h:
        h.resolve.side_effect = error
        response = h.client.post(
            f"/api/one/email/{path}",
            json={**_envelope(), **_request(path), "source_mail_ref": _REPLY_REF},
        )

    assert response.status_code == status_code
    assert response.json()["detail"]["code"] == code
    assert "sender@example.com" not in response.text
    h.delivery.prepare.assert_not_awaited()
    h.delivery.execute.assert_not_awaited()


@pytest.mark.parametrize(
    ("path", "payload", "method", "refusal"),
    [
        (
            "/api/one/email/prepare",
            {"idempotency_key": "x" * 16},
            "prepare",
            GmailDeliveryError("INVALID_RECIPIENTS", "To contains an invalid email address."),
        ),
        (
            "/api/one/email/send",
            {"action_id": "action-1"},
            "execute",
            GmailDeliveryError(
                "ACTION_NOT_SENDABLE", "This email confirmation can no longer be sent.", 409
            ),
        ),
        (
            "/api/one/email/send",
            {"action_id": "action-1"},
            "execute",
            GmailDeliveryError("GMAIL_SEND_FAILED", "Gmail could not send this email.", 502),
        ),
    ],
)
def test_a_delivery_refusal_keeps_its_own_code_through_the_latency_span(
    path, payload, method, refusal
):
    """Regression: the refusal used to leave the route as 503 "temporarily unavailable".

    `GmailDeliveryError` was a frozen dataclass, and leaving the
    `@contextmanager` latency span assigns `__traceback__`, so every authored
    refusal raised by prepare or execute became `FrozenInstanceError`. The card
    then read a definite Gmail rejection as "could not confirm delivery".
    """
    service = MagicMock()
    setattr(service, method, AsyncMock(side_effect=refusal))
    with patch.object(module, "get_gmail_delivery_service", return_value=service):
        response = TestClient(_app()).post(path, json={**_envelope(), **payload})

    assert response.status_code == refusal.status_code
    assert response.json()["detail"] == {"code": refusal.code, "message": refusal.message}


def test_an_unexpected_delivery_failure_is_still_the_generic_503():
    """Negative control: only authored refusals carry their own code."""
    service = MagicMock()
    service.execute = AsyncMock(side_effect=RuntimeError("provider said something private"))
    with patch.object(module, "get_gmail_delivery_service", return_value=service):
        response = TestClient(_app()).post(
            "/api/one/email/send", json={**_envelope(), "action_id": "action-1"}
        )

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "GMAIL_DELIVERY_UNAVAILABLE"
    assert "private" not in response.text


def test_withdrawing_voice_mail_reads_also_stops_offered_mail_replies():
    """A reply re-reads the email it answers, so the voice read switch withdraws it too."""
    with (
        _reply_routes(enabled=True) as h,
        patch.object(module, "voice_mail_reads_enabled", return_value=False),
    ):
        refused = h.client.post(
            "/api/one/email/send",
            json={**_envelope(), **_request("send"), "source_mail_ref": _REPLY_REF},
        )
        # Negative control: information-request replies do not answer to it.
        kyc_reply = h.client.post(
            "/api/one/email/prepare",
            json={**_envelope(), **_request("prepare"), "source_workflow_id": "workflow-1"},
        )

    assert refused.status_code == 403
    assert refused.json()["detail"]["code"] == "MAIL_REPLY_UNAVAILABLE"
    h.resolve.assert_not_awaited()
    h.delivery.execute.assert_not_awaited()
    assert kyc_reply.status_code == 200
