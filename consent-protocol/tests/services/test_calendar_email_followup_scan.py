"""Synthetic page/section recovery without a live mailbox or model call."""

from __future__ import annotations

import base64
import json
from dataclasses import replace
from datetime import UTC, datetime
from types import SimpleNamespace

import httpx
import pytest

from hushh_mcp.services import calendar_email_followup_scan as scan
from hushh_mcp.services.calendar_email_followup_store import Monitor

_SYNTHETIC_TOKEN = "synthetic-account-b-token"


class _Store:
    def __init__(self) -> None:
        self.current = Monitor(
            user_id="synthetic-owner",
            account_id="account-b",
            generation="00000000-0000-0000-0000-000000000001",
            grant_epoch_digest="synthetic-epoch",
            provider_subject_sha256="a" * 64,
            mail_generation="00000000-0000-0000-0000-000000000003",
            calendar_connected_at=datetime(2026, 10, 1, tzinfo=UTC),
            calendar_grant_revision=None,
            historical_start_at=datetime(2026, 10, 1, tzinfo=UTC),
            time_zone="Asia/Kolkata",
            reminder_lead_days=1,
            reminder_hour=9,
            notifications_enabled=True,
            checkpoint=None,
            scan_state="pending",
            lease_id="00000000-0000-0000-0000-000000000002",
        )
        self.state = "pending"
        self.committed = []
        self.cipher = SimpleNamespace(evidence_key=lambda *_: b"synthetic-evidence")

    async def acquire_scan(self, **kwargs):
        assert kwargs == {"user_id": "synthetic-owner", "account_id": "account-b"}
        return self.current

    async def release_scan(self, monitor):
        assert monitor.lease_id == self.current.lease_id

    async def require_monitor_current(self, monitor):
        assert monitor.generation == self.current.generation

    async def save_checkpoint(self, monitor, checkpoint, *, state, error_code=None, retry_in=None):
        assert monitor.generation == self.current.generation
        self.current = replace(
            self.current, checkpoint=json.loads(json.dumps(checkpoint)), scan_state=state
        )
        self.state = state
        self.error_code = error_code

    async def scanned_state(self, monitor, message_id):
        return None

    async def stale_assessment_threads(self, monitor, *, cutoff_ms, limit=2, exclude=frozenset()):
        return []

    async def retire_unlisted_stale(self, monitor, thread_id, listed_message_ids):
        return 0

    async def prior_requests(self, monitor, thread_id):
        return []

    async def commit_message(self, monitor, message, assessment, *, now=None, reassess=False):
        self.committed.append((message, assessment, now))


def _transport(body: str, page_tokens: list[str | None]):
    encoded = base64.urlsafe_b64encode(body.encode()).decode().rstrip("=")
    received = str(int(datetime(2026, 10, 10, tzinfo=UTC).timestamp() * 1000))

    def respond(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/profile"):
            return httpx.Response(200, json={"historyId": "100"})
        if path.endswith("/messages"):
            token = request.url.params.get("pageToken")
            page_tokens.append(token)
            if token is None:
                return httpx.Response(
                    200,
                    json={
                        "messages": [{"id": "msg-one", "threadId": "thread-one"}],
                        "nextPageToken": "cursor-two",
                    },
                )
            return httpx.Response(200, json={"messages": []})
        if path.endswith("/threads/thread-one"):
            return httpx.Response(
                200,
                json={
                    "id": "thread-one",
                    "messages": [
                        {
                            "id": "msg-one",
                            "threadId": "thread-one",
                            "internalDate": received,
                            "labelIds": ["INBOX"],
                        }
                    ],
                },
            )
        if path.endswith("/messages/msg-one"):
            return httpx.Response(
                200,
                json={
                    "id": "msg-one",
                    "threadId": "thread-one",
                    "internalDate": received,
                    "payload": {
                        "mimeType": "text/plain",
                        "body": {"data": encoded, "size": len(body)},
                        "headers": [
                            {"name": "Subject", "value": "Synthetic request"},
                            {"name": "From", "value": "Jhumma"},
                        ],
                    },
                },
            )
        if path.endswith("/history"):
            return httpx.Response(200, json={"historyId": "101", "history": []})
        return httpx.Response(404)

    return httpx.MockTransport(respond)


@pytest.mark.asyncio
@pytest.mark.parametrize("legacy_partial", [False, True])
async def test_paged_scan_resumes_failed_section_without_dropping_tail(monkeypatch, legacy_partial):
    body = ("Earlier context. " * 1600) + "\n\nPlease send the document before 26 October."
    store = _Store()
    page_tokens: list[str | None] = []
    assessed: list[int] = []
    failed_once = False

    async def current():
        return None

    grant = SimpleNamespace(epoch_digest="synthetic-epoch", require_current=current)
    grant.token = _SYNTHETIC_TOKEN
    monkeypatch.setattr(scan, "open_selected_mail_grant", lambda **_: _grant(grant))

    async def assess_section(**kwargs):
        nonlocal failed_once
        index = kwargs["section"].index
        assessed.append(index)
        if index == 1 and not failed_once:
            failed_once = True
            raise RuntimeError("synthetic transient model failure")
        return [], []

    monkeypatch.setattr(scan, "assess_section", assess_section)
    transport = _transport(body, page_tokens)
    outcomes = []
    for step in range(15):
        result = await scan.scan_once(
            user_id="synthetic-owner",
            account_id="account-b",
            store=store,
            now=datetime(2026, 10, 11, tzinfo=UTC),
            transport=transport,
            max_sections=1,
        )
        outcomes.append(result["state"])
        if legacy_partial and step == 0:
            # A sealed pre-relevance checkpoint already assessed section zero.
            # Its old candidate must not receive the new verdict/version merely
            # by resuming the remaining sections. The current model drops it.
            checkpoint = store.current.checkpoint
            assert checkpoint["section_index"] == 1
            checkpoint.pop("assessment_version", None)
            checkpoint["partial_candidates"] = [
                {
                    "evidence_key": "legacy-evidence",
                    "message_id": "msg-one",
                    "thread_id": "thread-one",
                    "body_digest": checkpoint["partial_body_digest"],
                    "source_internal_date_ms": 1791590400000,
                    "kind": "action",
                    "global_quote_start": 0,
                    "quote": "Earlier context.",
                    "title": "Legacy false positive",
                    "original_due_wording": None,
                    "due_date": None,
                    "due_relation": None,
                    "proposed_date": None,
                    "proposed_at": None,
                    "time_zone": None,
                    "responsibility": "owner",
                    "ambiguities": [],
                }
            ]
        if result["state"] == "complete":
            break
    assert "partial" in outcomes
    assert outcomes[-1] == "complete"
    assert assessed.count(0) == (2 if legacy_partial else 1)
    assert assessed.count(1) == 2
    assert len(store.committed) == 1
    message, assessment, at = store.committed[0]
    assert at == datetime(2026, 10, 11, tzinfo=UTC)
    assert message.body.endswith("Please send the document before 26 October.")
    assert assessment.completed_sections == assessment.expected_sections == len(message.sections)
    assert assessment.candidates == ()
    assert page_tokens == [None, "cursor-two"]


async def _grant(value):
    return value
