"""The owner confirms what their own agent prepared: Calendar, Gmail, Drive, once each.

``POST /api/one/pod/actions/{proposal_id}/confirm`` is the only way a prepared change
reaches Google from an owner-cloud agent. It opens on the owner's own app session with
scope ``pod.act`` and a held incarnation, refuses a hub consent token even when valid,
exists only in an owner-cloud agent, and claims the proposal in the owner's own log
before anything is sent, so a repeat confirmation runs nothing.
"""

from __future__ import annotations

import base64
from email import policy
from email.parser import BytesParser

# ruff: noqa: S106 -- token strings below name test fixtures, not credentials.
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.one import pod_actions, pod_session, pod_turn
from hushh_mcp.agents.calendar import tools as calendar_tools
from hushh_mcp.services import google_calendar_service, pod_consent_client
from hushh_mcp.services.pod_consent_client import ConsentVerdict
from hushh_mcp.services.pod_session_authority import LOCAL_TOKEN_PREFIX, SCOPE_POD_ACT
from tests import pod_connector_harness as h

OWNER_SESSION = {"Authorization": "Bearer pod-session-fixture"}
_CLAIMS = {"role": "app", "scopes": [SCOPE_POD_ACT], "user_id": h.OWNER_UID}
EVENTS = f"{h.CALENDAR}/calendars/primary/events"


async def _verifier(_token: str, *, expected_scope: str) -> ConsentVerdict:
    return ConsentVerdict(True, True, h.OWNER_UID, h.OWNER_HUSHH, expected_scope)


class _Session:
    held = 0

    def local_token(self, _claims: dict) -> str:
        return LOCAL_TOKEN_PREFIX + "fixture"

    def local_verifier(self, _claims: dict) -> Any:
        return _verifier

    async def require_held(self) -> None:
        type(self).held += 1


@pytest.fixture
def agent(monkeypatch, tmp_path):
    log, tokens, google = h.install(
        monkeypatch,
        tmp_path,
        connectors={
            "calendar": h.credential("calendar", h.SCOPES["calendar"]),
            "gmail": h.credential("gmail", h.SCOPES["gmail_manage"]),
            "drive": h.credential("drive", h.SCOPES["drive"]),
        },
    )
    monkeypatch.setattr(pod_turn, "pod_mode", lambda: True)
    monkeypatch.setattr(pod_turn, "pod_turn_enabled", lambda: True)
    monkeypatch.setattr(pod_consent_client, "verify_consent", _verifier)
    monkeypatch.setattr(google_calendar_service, "_singleton", None)

    def _verified(authorization: Any, *, role: str, scope: Any = None) -> tuple:
        assert authorization == OWNER_SESSION["Authorization"] and role == "app"
        assert scope == SCOPE_POD_ACT
        return _Session(), _CLAIMS

    monkeypatch.setattr(pod_session, "verified_session", _verified)
    google.on("POST", f"{h.CALENDAR}/freeBusy", {"calendars": {"primary": {"busy": []}}})
    google.on("GET", EVENTS, {"items": []})
    google.on(
        "POST",
        EVENTS,
        {"id": "evt1", "status": "confirmed", "summary": "Lunch", "start": {}, "end": {}},
    )
    _Session.held = 0
    yield log, tokens, google
    h.uninstall()


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(pod_actions.router)
    return TestClient(app, raise_server_exceptions=False)


async def _propose_lunch() -> str:
    result = await calendar_tools.propose_calendar_event(
        h.tool_context(),
        title="Lunch",
        start_at="2026-10-07T12:00:00Z",
        end_at="2026-10-07T13:00:00Z",
    )
    assert result["status"] == "confirmation_required", result
    return str(result["proposal_id"])


async def test_a_calendar_change_runs_once_on_the_owners_own_confirmation(agent):
    _log, tokens, google = agent
    proposal_id = await _propose_lunch()
    assert proposal_id.startswith("gcal_")
    assert google.calls("POST", EVENTS) == [], "nothing reaches Google before confirmation"

    client = _client()
    first = client.post(f"/api/one/pod/actions/{proposal_id}/confirm", headers=OWNER_SESSION)
    again = client.post(f"/api/one/pod/actions/{proposal_id}/confirm", headers=OWNER_SESSION)

    assert first.status_code == 200, first.text
    assert first.json()["kind"] == "calendar"
    assert again.status_code == 409 and again.json()["detail"]["code"] == "CALENDAR_ACTION_REFUSED"
    assert len(google.calls("POST", EVENTS)) == 1, "a repeat confirmation sends nothing"
    assert ("calendar", "manage") in tokens.asks
    assert _Session.held >= 2, "every confirmation requires a held incarnation"


async def test_a_hub_consent_token_never_confirms(agent):
    proposal_id = await _propose_lunch()
    response = _client().post(
        f"/api/one/pod/actions/{proposal_id}/confirm", headers={"X-Consent-Token": "hub-token"}
    )
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "OWNER_SESSION_REQUIRED"


async def test_only_an_owner_cloud_agent_has_the_door(agent, monkeypatch):
    proposal_id = await _propose_lunch()
    monkeypatch.delenv("HUSSH_POD_KMS_KEY")
    response = _client().post(f"/api/one/pod/actions/{proposal_id}/confirm", headers=OWNER_SESSION)
    assert response.status_code == 404
    for headers in ({}, {"X-Consent-Token": "hub-token"}):
        anonymous = _client().post(f"/api/one/pod/actions/{proposal_id}/confirm", headers=headers)
        assert anonymous.status_code == 404, "no answer that tells a caller the door exists"


async def test_a_session_for_another_person_is_refused(agent, monkeypatch):
    proposal_id = await _propose_lunch()
    monkeypatch.setitem(_CLAIMS, "user_id", "someone-else")

    async def other(_token: str, *, expected_scope: str) -> ConsentVerdict:
        return ConsentVerdict(True, True, "someone-else", h.OWNER_HUSHH, expected_scope)

    monkeypatch.setattr(_Session, "local_verifier", lambda self, claims: other)
    response = _client().post(f"/api/one/pod/actions/{proposal_id}/confirm", headers=OWNER_SESSION)
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "OWNER_MISMATCH"


async def test_an_id_this_agent_never_minted_is_unknown(agent):
    response = _client().post(
        "/api/one/pod/actions/gxyz_abcdefghijklmnopqrstu/confirm", headers=OWNER_SESSION
    )
    assert response.status_code == 404


async def test_a_reviewed_gmail_change_is_applied_once(agent):
    _log, tokens, google = agent
    h.route_inbox(google)
    google.on("POST", f"{h.GMAIL}/messages/batchModify", {})
    from hushh_mcp.agents.email.mailbox_tools import propose_gmail_mailbox_change

    prepared = await propose_gmail_mailbox_change(
        h.tool_context(), action="archive", query="from:ravi", limit=2
    )
    assert prepared["status"] == "confirmation_required", prepared
    assert {r.url.host for r in google.requests} == {"gmail.googleapis.com"}
    assert google.calls("POST", f"{h.GMAIL}/messages/batchModify") == []
    # The id travels only in the owner's review card; the model never sees it.
    assert "proposal_id" not in prepared
    from hushh_mcp.services.pod_action_proposals import RECORD_KIND

    records = [r for r in await agent[0].replay() if r["kind"] == RECORD_KIND]
    directive_id = records[-1]["payload"]["proposalId"]
    assert directive_id.startswith("gmod_")

    client = _client()
    first = client.post(f"/api/one/pod/actions/{directive_id}/confirm", headers=OWNER_SESSION)
    again = client.post(f"/api/one/pod/actions/{directive_id}/confirm", headers=OWNER_SESSION)

    assert first.status_code == 200, first.text
    assert first.json()["result"] == {"status": "executed", "action": "archive", "count": 2}
    assert again.status_code == 409
    (modify,) = google.calls("POST", f"{h.GMAIL}/messages/batchModify")
    assert h.body(modify) == {"ids": ["m1", "m2"], "addLabelIds": [], "removeLabelIds": ["INBOX"]}
    assert modify.headers["authorization"] == "Bearer ya29.gmail.manage"


async def test_owner_email_prepare_keeps_exact_terms_until_one_confirmation(agent):
    _log, _tokens, google = agent
    google.on("POST", f"{h.GMAIL}/messages/send", {"id": "synthetic-sent"})
    client = _client()
    body = {
        "action": "send_email",
        "draft": {"to": ["synthetic@example.test"], "subject": "Fixture", "body": "Synthetic"},
    }
    refused = client.post(
        "/api/one/pod/actions/gmail/proposals",
        json=body,
        headers={"X-Consent-Token": "hub-consent"},
    )
    assert refused.status_code == 403
    prepared = client.post("/api/one/pod/actions/gmail/proposals", json=body, headers=OWNER_SESSION)
    assert prepared.status_code == 200, prepared.text
    assert google.calls("POST", f"{h.GMAIL}/messages/send") == []
    assert prepared.json()["preview"]["body"] == "Synthetic"
    proposal = prepared.json()["proposal_id"]
    first = client.post(f"/api/one/pod/actions/{proposal}/confirm", headers=OWNER_SESSION)
    again = client.post(f"/api/one/pod/actions/{proposal}/confirm", headers=OWNER_SESSION)
    assert first.status_code == 200, first.text
    assert again.status_code == 409
    assert len(google.calls("POST", f"{h.GMAIL}/messages/send")) == 1


async def test_a_reviewed_drive_share_runs_once_and_refuses_after_a_reconnect(agent):
    from hushh_mcp.services import pod_connector_credentials as store
    from hushh_mcp.services.pod_drive import PodDriveReview, propose_drive_review

    review = await propose_drive_review(
        owner_id=h.OWNER_UID,
        action="share",
        tool_name="share_file",
        arguments={
            "fileId": "f1",
            "email": "a@b.com",
            "role": "reader",
            "notify": True,
            "message": "",
        },
    )
    assert isinstance(review, PodDriveReview) and review.directive_id.startswith("gdrv_")

    class _Writer:
        calls: list[dict] = []

        async def write_tool(self, *, user_id: str, tool_name: str, arguments: dict) -> Any:
            type(self).calls.append({"user": user_id, "tool": tool_name, **arguments})
            from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult

            return ExternalMcpToolResult(is_error=False, payload={"shared": True}, truncated=False)

    result = await pod_actions.run_action_confirm(
        review.directive_id,
        consent_token=LOCAL_TOKEN_PREFIX + "fixture",
        verifier=_verifier,
        session=_CLAIMS,
        ports={"drive": _Writer()},
    )
    assert result["result"]["status"] == "ok" and len(_Writer.calls) == 1
    assert _Writer.calls[0]["tool"] == "share_file" and _Writer.calls[0]["email"] == "a@b.com"

    second = await propose_drive_review(
        owner_id=h.OWNER_UID, action="trash", tool_name="trash_file", arguments={"fileId": "f2"}
    )
    store.set_active_connector_credentials(
        {
            "drive": h.credential(
                "drive", h.SCOPES["drive"], credential_id="77777777-2222-4333-8444-555555555555"
            )
        }
    )
    with pytest.raises(Exception) as refused:
        await pod_actions.run_action_confirm(
            second.directive_id,
            consent_token=LOCAL_TOKEN_PREFIX + "fixture",
            verifier=_verifier,
            session=_CLAIMS,
            ports={"drive": _Writer()},
        )
    assert getattr(refused.value, "status_code", None) == 409
    assert len(_Writer.calls) == 1, "reviewed under another login: nothing is sent"


async def test_a_calendar_review_does_not_survive_a_reconnect_to_the_same_account(agent):
    from hushh_mcp.services import pod_connector_credentials as store

    proposal_id = await _propose_lunch()
    store.set_active_connector_credentials(
        {
            "calendar": h.credential(
                "calendar",
                h.SCOPES["calendar"],
                credential_id="77777777-2222-4333-8444-555555555555",
            )
        }
    )
    response = _client().post(f"/api/one/pod/actions/{proposal_id}/confirm", headers=OWNER_SESSION)
    assert response.status_code == 409
    assert agent[2].calls("POST", EVENTS) == [], "same subject is not the same reviewed custody"


@pytest.mark.parametrize(
    "action,path,key",
    [("save_draft", "/drafts", "draft_id"), ("send_email", "/messages/send", "message_id")],
)
async def test_reviewed_email_saves_or_sends_the_exact_envelope_once(agent, action, path, key):
    from hushh_mcp.services.pod_gmail_mailbox import PodGmailMailboxActions

    async def require_access():
        return None

    google = agent[2]
    google.on("POST", f"{h.GMAIL}{path}", {"id": "provider-id"})
    mailbox = PodGmailMailboxActions(h.OWNER_UID)
    proposal = await mailbox.propose_email(
        user_id=h.OWNER_UID,
        action=action,
        draft_payload={
            "to": ["a@example.com"],
            "cc": ["c@example.com"],
            "bcc": ["b@example.com"],
            "subject": "Reviewed title",
            "body": "Exact text",
        },
        require_access=require_access,
    )
    assert google.requests == [], "preparing the review performs no provider change"
    pid = proposal["proposal_id"]
    first = _client().post(f"/api/one/pod/actions/{pid}/confirm", headers=OWNER_SESSION)
    assert first.status_code == 200, first.text
    assert first.json()["result"][key] == "provider-id"
    again = _client().post(f"/api/one/pod/actions/{pid}/confirm", headers=OWNER_SESSION)
    assert again.status_code == 409
    (request,) = google.calls("POST", f"{h.GMAIL}{path}")
    payload = h.body(request)
    raw = payload["message"]["raw"] if action == "save_draft" else payload["raw"]
    mime = BytesParser(policy=policy.default).parsebytes(base64.urlsafe_b64decode(raw))
    assert mime["To"] == "a@example.com" and mime["Bcc"] == "b@example.com"
    assert mime["Subject"] == "Reviewed title" and mime.get_content().strip() == "Exact text"
    assert request.headers["authorization"] == "Bearer ya29.gmail.manage"


async def test_email_review_refuses_reconnect_and_unknown_delivery_never_retries(agent):
    from hushh_mcp.services import pod_connector_credentials as store
    from hushh_mcp.services.pod_gmail_mailbox import PodGmailMailboxActions

    async def require_access():
        return None

    async def prepare():
        return await PodGmailMailboxActions(h.OWNER_UID).propose_email(
            user_id=h.OWNER_UID,
            action="send_email",
            draft_payload={"to": ["a@example.com"], "subject": "Hi", "body": "Text"},
            require_access=require_access,
        )

    google = agent[2]
    google.on("POST", f"{h.GMAIL}/messages/send", {})  # no provider acknowledgement
    proposal = await prepare()
    pid = proposal["proposal_id"]
    first = _client().post(f"/api/one/pod/actions/{pid}/confirm", headers=OWNER_SESSION)
    assert first.status_code == 502 and "OUTCOME_UNKNOWN" in first.text
    again = _client().post(f"/api/one/pod/actions/{pid}/confirm", headers=OWNER_SESSION)
    assert again.status_code == 409 and len(google.calls("POST", f"{h.GMAIL}/messages/send")) == 1
    second = await prepare()
    store.set_active_connector_credentials(
        {
            "gmail": h.credential(
                "gmail",
                h.SCOPES["gmail_manage"],
                credential_id="77777777-2222-4333-8444-555555555555",
            )
        }
    )
    changed = _client().post(
        f"/api/one/pod/actions/{second['proposal_id']}/confirm", headers=OWNER_SESSION
    )
    assert changed.status_code == 409
    assert len(google.calls("POST", f"{h.GMAIL}/messages/send")) == 1
