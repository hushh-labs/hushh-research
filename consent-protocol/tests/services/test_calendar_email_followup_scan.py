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

    async def refresh_meeting_reminders(self, monitor, *, now=None):
        return 0


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
async def test_paged_scan_resumes_failed_section_without_dropping_tail(monkeypatch):
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
    for _ in range(15):
        result = await scan.scan_once(
            user_id="synthetic-owner",
            account_id="account-b",
            store=store,
            now=datetime(2026, 10, 11, tzinfo=UTC),
            transport=transport,
            max_sections=1,
        )
        outcomes.append(result["state"])
        if result["state"] == "complete":
            break
    assert "partial" in outcomes
    assert outcomes[-1] == "complete"
    assert assessed.count(0) == 1
    assert assessed.count(1) == 2
    assert len(store.committed) == 1
    message, assessment, at = store.committed[0]
    assert at == datetime(2026, 10, 11, tzinfo=UTC)
    assert message.body.endswith("Please send the document before 26 October.")
    assert assessment.completed_sections == assessment.expected_sections == len(message.sections)
    assert page_tokens == [None, "cursor-two"]


async def _grant(value):
    return value


@pytest.mark.asyncio
async def test_reassessment_queues_the_next_stale_threads_instead_of_idling():
    """Earlier follow-ups used to be reassessed two threads per five minutes."""
    from hushh_mcp.services.calendar_email_followup_scan_checkpoint import _initial_checkpoint
    from hushh_mcp.services.calendar_email_followup_scan_navigation import _step_thread

    class Stale(_Store):
        def __init__(self) -> None:
            super().__init__()
            self.batches = [["thread-b", "thread-c"], []]

        async def stale_assessment_threads(
            self, monitor, *, cutoff_ms, limit=2, exclude=frozenset()
        ):
            return self.batches.pop(0)

    store = Stale()
    checkpoint = _initial_checkpoint(store.current, snapshot_ms=0, history_id="100")
    checkpoint.update(
        mode="reassess", pending_threads=["thread-a"], thread_index=1, history_current_id="105"
    )
    common = {
        "monitor": store.current,
        "store": store,
        "grant": None,
        "client": None,
        "sections_left": 2,
        "now": None,
    }
    # The first batch is done and more threads wait: the pass keeps going.
    assert await _step_thread(checkpoint=checkpoint, **common) == (0, 0, False)
    assert (checkpoint["mode"], checkpoint["pending_threads"]) == (
        "reassess",
        ["thread-b", "thread-c"],
    )
    assert checkpoint["history_id"] == "105"
    # Nothing is left after that batch: the pass ends and the scan is complete.
    checkpoint["thread_index"] = 2
    assert await _step_thread(checkpoint=checkpoint, **common) == (0, 0, True)
    assert (checkpoint["mode"], store.state) == ("history", "complete")


@pytest.mark.parametrize("prior_version", [None, 3])
def test_assessment_upgrade_restarts_only_the_partial_message(prior_version):
    from hushh_mcp.services.calendar_email_followup_relevance import ASSESSMENT_VERSION
    from hushh_mcp.services.calendar_email_followup_scan_checkpoint import (
        _initial_checkpoint,
        _upgrade_checkpoint,
    )

    checkpoint = _initial_checkpoint(_Store().current, snapshot_ms=0, history_id="100")
    cursors = {
        "mode": "reassess",
        "page_token": "current-page",
        "next_page_token": "next-page",
        "pending_threads": ["thread-a", "thread-b"],
        "thread_index": 1,
        "thread_messages": ["message-a", "message-b"],
        "message_index": 1,
        "retry_cursor": 2,
        "incomplete_sources": {"thread-a": {"retry_at_ms": 500}},
    }
    checkpoint.update(
        cursors,
        section_index=2,
        partial_candidates=[{"title": "old-format"}],
        partial_updates=[{"kind": "old-update"}],
        partial_drops={"old": 1},
        partial_body_digest="old-digest",
        reassess_seen={"thread-b": 2},
    )
    if prior_version is None:
        checkpoint.pop("assessment_version")
    else:
        checkpoint["assessment_version"] = prior_version

    upgraded = _upgrade_checkpoint(checkpoint)
    assert {key: upgraded[key] for key in cursors} == cursors
    assert upgraded["assessment_version"] == ASSESSMENT_VERSION
    assert upgraded["section_index"] == 0
    assert upgraded["partial_candidates"] == upgraded["partial_updates"] == []
    assert upgraded["partial_drops"] == upgraded["reassess_seen"] == {}
    assert upgraded["partial_body_digest"] is None
    upgraded["section_index"] = 1
    assert _upgrade_checkpoint(upgraded)["section_index"] == 1


def test_old_exhausted_source_is_retried_without_delaying_mail_history():
    from datetime import timedelta

    from hushh_mcp.services.calendar_email_followup_coverage import (
        MAX_SOURCE_ATTEMPTS,
        SLOW_SOURCE_RETRY_SECONDS,
    )
    from hushh_mcp.services.calendar_email_followup_scan_checkpoint import (
        _earliest_retry_in,
        _next_retry_batch,
    )

    now = datetime(2026, 11, 9, tzinfo=UTC)
    source = {"attempts": MAX_SOURCE_ATTEMPTS, "retry_at_ms": 0}
    checkpoint = {"incomplete_sources": {"old-thread": source}}

    assert _next_retry_batch(checkpoint, now) == ["old-thread"]
    assert source["retry_at_ms"] == (int(now.timestamp()) + SLOW_SOURCE_RETRY_SECONDS) * 1000
    assert _earliest_retry_in(checkpoint, now) is None
    assert _next_retry_batch(checkpoint, now + timedelta(minutes=5)) == []
    assert _next_retry_batch(checkpoint, now + timedelta(seconds=SLOW_SOURCE_RETRY_SECONDS)) == [
        "old-thread"
    ]


def test_first_scan_reads_only_the_most_recent_month():
    """Dated follow-ups rarely look past a month; later passes are incremental."""
    from datetime import timedelta

    from hushh_mcp.services.calendar_email_followup_scan_checkpoint import (
        _initial_checkpoint,
        bootstrap_window_is_stale,
    )

    snapshot = datetime(2026, 11, 11, tzinfo=UTC)
    snapshot_ms = int(snapshot.timestamp() * 1000)
    thirty_days_ms = 30 * 86_400_000

    # A 90-day approval is capped at the most recent 30 days.
    wide = replace(_Store().current, historical_start_at=snapshot - timedelta(days=90))
    capped = _initial_checkpoint(wide, snapshot_ms=snapshot_ms, history_id="100")
    assert capped["cutoff_ms"] == snapshot_ms - thirty_days_ms
    assert not bootstrap_window_is_stale(capped)

    # A shorter approval is never widened.
    narrow = replace(_Store().current, historical_start_at=snapshot - timedelta(days=10))
    assert _initial_checkpoint(narrow, snapshot_ms=snapshot_ms, history_id="100")["cutoff_ms"] == (
        snapshot_ms - 10 * 86_400_000
    )

    # A first scan sealed before the cap restarts inside it; history mode does not.
    legacy = dict(capped, cutoff_ms=snapshot_ms - 90 * 86_400_000)
    assert bootstrap_window_is_stale(legacy)
    assert not bootstrap_window_is_stale(dict(legacy, mode="history"))


@pytest.mark.asyncio
async def test_a_time_budgeted_pass_does_what_took_several_calls_and_stops_on_time(monkeypatch):
    """The 2-section pass needed many 25-60 s requests; a budget does it in one."""
    body = ("Earlier context. " * 1600) + "\n\nPlease send the document before 26 October."

    async def current():
        return None

    grant = SimpleNamespace(epoch_digest="synthetic-epoch", require_current=current)
    grant.token = _SYNTHETIC_TOKEN
    monkeypatch.setattr(scan, "open_selected_mail_grant", lambda **_: _grant(grant))

    async def assess_section(**_kwargs):
        return [], []

    monkeypatch.setattr(scan, "assess_section", assess_section)
    common = {
        "user_id": "synthetic-owner",
        "account_id": "account-b",
        "now": datetime(2026, 10, 11, tzinfo=UTC),
        "transport": _transport(body, []),
    }

    store = _Store()
    done = await scan.scan_once(**common, store=store, max_sections=40, budget_seconds=30)
    assert done["state"] == "complete"
    assert len(store.committed) == 1

    # Negative control: the same pass with no time left stops after one step.
    store = _Store()
    stopped = await scan.scan_once(**common, store=store, max_sections=40, budget_seconds=1e-9)
    assert stopped["state"] == "pending"
    assert store.committed == []

    with pytest.raises(ValueError, match="invalid_scan_budget"):
        await scan.scan_once(**common, store=_Store(), budget_seconds=0)
