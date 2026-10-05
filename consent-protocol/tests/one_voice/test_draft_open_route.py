"""POST /api/one/voice/draft/open: a tap and "open the second one" end here.

The drafts twin of the mail open route. The position is resolved against the
offer this server minted, fenced to the account the drafts were listed in, and
nothing is fetched for a position that was never offered, a replaced list, or a
mail list. The drafts service is replaced at its module seam.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from hushh_mcp.one_voice.config import (
    ONE_VOICE_MAIL_DRAFTS_ENABLED_ENV,
    ONE_VOICE_MAIL_READS_ENABLED_ENV,
)
from hushh_mcp.services.gmail_receipts_service import GmailApiError

USER = "firebase-uid-owner"
ACCOUNT = "google-sub-owner"
CONV = "22222222-2222-4222-8222-222222222222"
DRAFT_IDS = ["r-draftAlpha", "r-draftBravo"]
BODY = "Dinner at 7? Bring the photos."


class DraftReads:
    """Stands in for ``get_gmail_draft``; records what it was asked for."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.error: GmailApiError | None = None

    async def __call__(self, *, user_id: str, draft_id: str, expect_account: str = ""):
        self.calls.append({"user_id": user_id, "draft_id": draft_id, "account": expect_account})
        if self.error is not None:
            raise self.error
        return {
            "draft_id": draft_id,
            "message_id": "msg-secret-id",
            "thread_id": "thread-secret-id",
            "to_label": "Priya Sharma",
            "to_list": ["priya@example.com"],
            "cc_list": [],
            "bcc_list": ["hidden@example.com"],
            "recipient_count": 2,
            "subject": "Diwali plans",
            "body_text": BODY,
            "body_truncated": False,
            "updated_at_iso": "2026-10-04T10:00:00+00:00",
        }


@pytest.fixture
def app(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from api.middleware import require_vault_owner_token
    from api.routes.one import voice
    from hushh_mcp.one_voice.tools.base import EntityContext

    monkeypatch.setenv(ONE_VOICE_MAIL_DRAFTS_ENABLED_ENV, "true")
    monkeypatch.delenv(ONE_VOICE_MAIL_READS_ENABLED_ENV, raising=False)
    entities = EntityContext()
    entities.offer_mail(DRAFT_IDS, account=ACCOUNT, mailbox="drafts")

    class _Conversation:
        def __init__(self) -> None:
            self.entity_context = entities.model_dump(mode="json")
            self.screen_context: dict[str, Any] = {}

    class _Conversations:
        async def get(self, *, user_id, conversation_id):
            return _Conversation()

    reads = DraftReads()
    monkeypatch.setattr(
        "hushh_mcp.one_voice.conversations.ConversationStore", lambda: _Conversations()
    )
    monkeypatch.setattr("hushh_mcp.services.gmail_drafts_service.get_gmail_draft", reads)
    monkeypatch.setattr(
        "hushh_mcp.services.connector_feature_admission.connector_feature_enabled",
        lambda *_a, **_k: True,
    )
    application = FastAPI()
    application.include_router(voice.router)
    application.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": USER,
        "token": "vault-fixture",
    }
    return TestClient(application), entities, reads


def _open(client, *, ordinal: int, revision: int, path: str = "/api/one/voice/draft/open"):
    return client.post(
        path, json={"conversation_id": CONV, "ordinal": ordinal, "offer_revision": revision}
    )


def test_a_tap_opens_the_offered_draft_fenced_to_its_account(app):
    client, entities, reads = app

    response = _open(client, ordinal=2, revision=entities.offered_mail.revision)

    assert response.status_code == 200, response.text
    draft = response.json()["draft"]
    assert draft["body"] == BODY
    assert (draft["to_label"], draft["subject"]) == ("Priya Sharma", "Diwali plans")
    # Every recipient the send would reach is on screen, Bcc included.
    assert (draft["to"], draft["cc"], draft["bcc"]) == (
        ["priya@example.com"],
        [],
        ["hidden@example.com"],
    )
    # The id came from the offer, and the read is fenced to the listing account.
    assert reads.calls == [{"user_id": USER, "draft_id": DRAFT_IDS[1], "account": ACCOUNT}]
    # No provider id reaches the surface.
    rendered = json.dumps(response.json())
    for secret in (DRAFT_IDS[1], "msg-secret-id", "thread-secret-id"):
        assert secret not in rendered


@pytest.mark.parametrize("ordinal", [3, 25])
def test_a_position_that_was_never_offered_is_refused_without_a_read(app, ordinal):
    client, entities, reads = app

    response = _open(client, ordinal=ordinal, revision=entities.offered_mail.revision)

    assert response.status_code == 409
    assert response.json()["detail"] == {"code": "MAIL_OFFER_UNRESOLVED", "offered": 2}
    assert reads.calls == []


def test_a_row_from_a_replaced_list_is_refused_not_reinterpreted(app):
    client, entities, reads = app
    old = entities.offered_mail.revision
    newer = entities.offer_mail(["r-newOne", "r-newTwo"], account=ACCOUNT, mailbox="drafts")

    stale = _open(client, ordinal=2, revision=old)

    assert stale.status_code == 409
    assert stale.json()["detail"] == {"code": "MAIL_OFFER_SUPERSEDED", "current_revision": newer}
    assert reads.calls == []
    assert _open(client, ordinal=2, revision=newer).status_code == 200
    assert reads.calls[-1]["draft_id"] == "r-newTwo"


def test_a_mail_list_is_never_opened_as_drafts_and_drafts_never_as_mail(app):
    client, entities, reads = app
    drafts_revision = entities.offered_mail.revision

    # A drafts offer through the mail route: refused before any reader is built.
    mail_route = _open(client, ordinal=1, revision=drafts_revision, path="/api/one/voice/mail/open")
    assert mail_route.status_code == 409
    assert mail_route.json()["detail"]["code"] == "MAIL_OFFER_UNRESOLVED"

    # A mail offer through the drafts route: a message id is not a draft id.
    mail_revision = entities.offer_mail(["msg-1", "msg-2"], account=ACCOUNT, mailbox="inbox")
    drafts_route = _open(client, ordinal=1, revision=mail_revision)
    assert drafts_route.status_code == 409
    assert drafts_route.json()["detail"] == {"code": "MAIL_OFFER_UNRESOLVED", "offered": 0}
    assert reads.calls == []


def test_a_draft_gone_from_gmail_is_410(app):
    client, entities, reads = app
    reads.error = GmailApiError("gone", status_code=404, code="GMAIL_DRAFT_NOT_FOUND")

    response = _open(client, ordinal=1, revision=entities.offered_mail.revision)

    assert response.status_code == 410
    assert response.json()["detail"] == {"code": "DRAFT_GONE"}


def test_the_drafts_switch_closes_the_route(app, monkeypatch):
    client, entities, reads = app
    monkeypatch.setenv(ONE_VOICE_MAIL_DRAFTS_ENABLED_ENV, "false")

    response = _open(client, ordinal=1, revision=entities.offered_mail.revision)

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "VOICE_MAIL_DRAFTS_DISABLED"
    assert reads.calls == []
