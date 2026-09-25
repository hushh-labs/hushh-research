"""Live Drive search speaks the Drive MCP query language the way Claude does.

Measured 2026-09-24 against the Drive MCP: a multi-word term is an AND match
(`fullText contains 'bank statement'` == `'bank' and 'statement'`), file types
belong in `mimeType` clauses (the tool says never inside title/fullText), Meet
recordings are `video/mp4` named "... - 2026/09/18 10:00 PDT - Recording", and
`list_recent_files` returns the same file shape as `search_files`.
"""

import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from pydantic import ValidationError

from hushh_mcp.services import drive_chat_service, drive_live_reader
from hushh_mcp.services.drive_chat_service import DriveChatService
from hushh_mcp.services.drive_live_reader import DriveLiveReader
from hushh_mcp.services.drive_long_range_listing import parse_long_range_listing
from hushh_mcp.services.drive_suggestion_service import LiveSearchPlan
from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult
from hushh_mcp.services.google_drive_adapter import LIVE_POLICY_HASH, DriveReadError
from hushh_mcp.services.google_drive_mcp_service import _search_metadata

NOW = datetime(2026, 9, 24, 17, 0, tzinfo=UTC)


def file(file_id, title, *, mime="application/pdf", modified="2026-09-20T10:00:00Z", created=None):
    return {
        "id": file_id,
        "title": title,
        "mimeType": mime,
        "modifiedTime": modified,
        "createdTime": created or modified,
        "viewUrl": f"https://drive.google.com/file/d/{file_id}/view",
    }


def reader_with(responses):
    """responses: {(tool_name, query_or_None): [files]}; unknown calls fail the test."""
    row = {
        "status": "connected",
        "validation_state": "verified",
        "verified_policy_hash": LIVE_POLICY_HASH,
        "connection_generation": 7,
    }
    calls = []

    async def read(*, user_id, tool_name, arguments):
        calls.append((tool_name, arguments.get("query"), arguments))
        key = (tool_name, arguments.get("query"))
        if key not in responses:
            raise AssertionError(f"unexpected provider call {key}")
        pages = responses[key]
        page = pages if not pages or isinstance(pages[0], dict) else pages[0]
        payload = {"files": page, "nextPageToken": None}
        if pages and not isinstance(pages[0], dict):
            # A list of pages: serve them in order, with a token until the last.
            index = int(arguments.get("pageToken") or 0)
            payload = {
                "files": pages[index],
                "nextPageToken": str(index + 1) if index + 1 < len(pages) else None,
            }
        # The production provider projection runs before the reader sees a page.
        return ExternalMcpToolResult(False, _search_metadata(payload), False)

    reader = DriveLiveReader(
        user_id="owner",
        require_access=AsyncMock(),
        oauth=SimpleNamespace(
            current_credential=AsyncMock(return_value=(row, {"accessToken": "synthetic"}))
        ),
        mcp=SimpleNamespace(read_tool=AsyncMock(side_effect=read)),
        adapter=SimpleNamespace(get_share_metadata=AsyncMock(), get_metadata=AsyncMock()),
    )
    reader.require_current = AsyncMock()
    return reader, calls


TERM = "(title contains '{0}' or fullText contains '{0}')"


async def test_multi_word_terms_must_all_match_before_any_term_may():
    both = TERM.format("bank") + " and " + TERM.format("statement")
    reader, calls = reader_with({("search_files", both): [file("f1", "SBI bank statement.pdf")]})
    found = await reader.find(query=["bank", "statement"])
    assert [item["name"] for item in found["matches"]] == ["SBI bank statement.pdf"]
    assert [call[1] for call in calls] == [both]


async def test_any_term_is_only_a_fallback_when_all_terms_find_nothing():
    both = TERM.format("salary slip") + " and " + TERM.format("payslip")
    either = "(" + TERM.format("salary slip") + " or " + TERM.format("payslip") + ")"
    reader, calls = reader_with(
        {("search_files", both): [], ("search_files", either): [file("f2", "payslip-aug.pdf")]}
    )
    found = await reader.find(query=["salary slip", "payslip"])
    assert [item["name"] for item in found["matches"]] == ["payslip-aug.pdf"]
    assert [call[1] for call in calls] == [both, either]


async def test_compilation_folder_children_use_validated_parent_scope_and_bound_pages():
    query = "'meeting-folder' in parents"
    reader, calls = reader_with(
        {("search_files", query): [file("gemini-note", "2026-09-23 Notes by Gemini")]}
    )
    found = await reader.find_compilation_folder_children(folder_ids=["meeting-folder"])
    assert [item["file_id"] for item in found["matches"]] == ["gemini-note"]
    assert calls[0][1] == query
    assert calls[0][2]["orderBy"] == "createdTime desc"
    assert calls[0][2]["pageSize"] == 25


async def test_owner_title_only_search_excludes_full_text_from_both_query_passes():
    both = "title contains 'standup' and title contains 'sync'"
    either = "(title contains 'standup' or title contains 'sync')"
    reader, calls = reader_with(
        {("search_files", both): [], ("search_files", either): [file("f2", "Standup sync notes")]}
    )
    found = await reader.find(query=["standup", "sync"], title_only=True)
    assert [item["name"] for item in found["matches"]] == ["Standup sync notes"]
    assert [call[1] for call in calls] == [both, either]
    assert all("fullText" not in call[1] for call in calls)


async def test_transient_metadata_failure_retries_once_inside_owner_read(monkeypatch):
    query = "title contains 'Explain For Product'"
    reader, calls = reader_with({("search_files", query): [file("f1", "Explain For Product")]})
    original = reader.mcp.read_tool.side_effect
    attempts = 0

    async def flaky(**kwargs):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise DriveReadError("provider_unavailable", retryable=True)
        return await original(**kwargs)

    reader.mcp.read_tool.side_effect = flaky
    sleep = AsyncMock()
    monkeypatch.setattr(drive_live_reader.asyncio, "sleep", sleep)

    found = await reader.find(query=["Explain For Product"], title_only=True)

    assert [item["name"] for item in found["matches"]] == ["Explain For Product"]
    assert [call[1] for call in calls] == [query]
    assert attempts == 2
    assert reader.require_access.await_count == 3
    sleep.assert_awaited_once_with(0.5)


async def test_persistent_metadata_failure_stops_after_one_retry(monkeypatch):
    reader, _ = reader_with({})
    reader.mcp.read_tool.side_effect = DriveReadError("provider_unavailable", retryable=True)
    monkeypatch.setattr(drive_live_reader.asyncio, "sleep", AsyncMock())

    with pytest.raises(DriveReadError, match="provider_unavailable"):
        await reader.find(query=["Explain For Product"], title_only=True)

    assert reader.mcp.read_tool.await_count == 2


async def test_metadata_retry_rechecks_owner_authority(monkeypatch):
    reader, _ = reader_with({})
    reader.mcp.read_tool.side_effect = DriveReadError("provider_unavailable", retryable=True)
    reader.require_access.side_effect = [None, None, PermissionError("owner authority ended")]
    monkeypatch.setattr(drive_live_reader.asyncio, "sleep", AsyncMock())

    with pytest.raises(PermissionError, match="owner authority ended"):
        await reader.find(query=["Explain For Product"], title_only=True)

    assert reader.mcp.read_tool.await_count == 1


async def test_metadata_retry_refuses_a_reconnected_drive_grant(monkeypatch):
    reader, _ = reader_with({})
    reader.mcp.read_tool.side_effect = DriveReadError("provider_unavailable", retryable=True)
    first, credential = reader.oauth.current_credential.return_value
    reader.oauth.current_credential.side_effect = [
        (first, credential),
        ({**first, "connection_generation": first["connection_generation"] + 1}, credential),
    ]
    monkeypatch.setattr(drive_live_reader.asyncio, "sleep", AsyncMock())

    with pytest.raises(DriveReadError, match="connection_changed"):
        await reader.find(query=["Explain For Product"], title_only=True)

    assert reader.mcp.read_tool.await_count == 1


@pytest.mark.parametrize("value", [None, 0, 1, "true", []])
async def test_title_only_requires_a_boolean_before_provider_call(value):
    reader, calls = reader_with({})
    with pytest.raises(DriveReadError, match="narrow_selection_required"):
        await reader.find(query=["standup"], title_only=value)
    assert calls == []


@pytest.mark.parametrize(
    "kind,clause",
    [
        ("pdf", "mimeType = 'application/pdf'"),
        ("video", "mimeType contains 'video/'"),
        (
            "spreadsheet",
            "(mimeType = 'application/vnd.google-apps.spreadsheet'"
            " or mimeType contains 'spreadsheetml' or mimeType = 'text/csv')",
        ),
        ("folder", "mimeType = 'application/vnd.google-apps.folder'"),
    ],
)
async def test_file_kinds_become_mime_clauses_not_title_words(kind, clause):
    query = TERM.format("budget") + " and " + clause
    reader, calls = reader_with({("search_files", query): [file("f3", "Budget")]})
    await reader.find(query=["budget"], file_kind=kind)
    assert calls[0][1] == query
    assert "'pdf'" not in calls[0][1] and "'spreadsheet'" not in calls[0][1]


async def test_a_file_kind_alone_is_a_bounded_search():
    reader, calls = reader_with({("search_files", "mimeType = 'application/pdf'"): []})
    await reader.find(query=[], file_kind="pdf")
    assert calls[0][1] == "mimeType = 'application/pdf'"


async def test_shared_with_me_and_a_day_window_combine():
    window = "(createdTime >= '2026-09-23T18:30:00Z' and createdTime < '2026-09-24T18:30:00Z')"
    query = (
        TERM.format("recording")
        + " and mimeType contains 'video/' and sharedWithMe = true and "
        + window
    )
    reader, calls = reader_with({("search_files", query): []})
    await reader.find(
        query=["recording"],
        file_kind="video",
        shared_with_me=True,
        time_field="createdTime",
        start_time="2026-09-23T18:30:00Z",
        end_time="2026-09-24T18:30:00Z",
    )
    assert calls[0][1] == query


async def test_most_recent_files_use_the_recency_listing():
    reader, calls = reader_with(
        {
            ("list_recent_files", None): [
                file("n", "Newest notes", modified="2026-09-24T10:00:00Z"),
                file("o", "Older deck", modified="2026-09-20T10:00:00Z"),
            ]
        }
    )
    found = await reader.find(query=[], recent=True)
    assert [item["name"] for item in found["matches"]] == ["Newest notes", "Older deck"]
    assert calls[0][0] == "list_recent_files"
    assert calls[0][2]["orderBy"] == "recency"
    assert calls[0][2]["excludeContentSnippets"] is True


async def test_latest_sorts_search_matches_newest_first():
    reader, calls = reader_with(
        {
            ("search_files", TERM.format("statement")): [
                file("a", "Jan statement.pdf", modified="2026-01-31T00:00:00Z"),
                file("c", "Aug statement.pdf", modified="2026-08-31T00:00:00Z"),
                file("b", "Mar statement.pdf", modified="2026-03-31T00:00:00Z"),
            ]
        }
    )
    found = await reader.find(query=["statement"], recent=True)
    assert [item["name"] for item in found["matches"]][0] == "Aug statement.pdf"
    assert calls[0][2]["orderBy"] == "modifiedTime desc"


async def test_nothing_to_bound_a_search_never_reaches_the_provider():
    reader, calls = reader_with({})
    with pytest.raises(Exception, match="narrow_selection_required"):
        await reader.find(query=[])
    assert calls == []


def test_a_calendar_day_is_the_owners_day_not_a_rolling_window():
    plan = LiveSearchPlan.model_validate(
        {
            "terms": ["recording"],
            "file_kind": "video",
            "date_from": "2026-09-24",
            "date_to": "2026-09-24",
            "file_time_field": "createdTime",
            "time_intent": "file_activity",
        }
    )
    assert plan.time_bounds(now_utc=NOW, timezone="Asia/Kolkata") == (
        "2026-09-23T18:30:00Z",
        "2026-09-24T18:30:00Z",
    )
    assert plan.time_bounds(now_utc=NOW) == ("2026-09-24T00:00:00Z", "2026-09-25T00:00:00Z")


@pytest.mark.parametrize(
    "payload",
    [
        {},  # nothing bounds the search
        {"date_from": "2026-09-24", "time_intent": "document_coverage"},
        {"date_from": "2026-09-24", "relative_days": 3, "time_intent": "file_activity"},
        {"date_from": "2026-09-25", "date_to": "2026-09-24", "time_intent": "file_activity"},
        {"date_from": "2024-01-01", "date_to": "2026-09-24", "time_intent": "file_activity"},
        {"date_from": "24/09/2026", "time_intent": "file_activity"},
        {"file_kind": "spreadsheet'"},
    ],
)
def test_plan_rejects_unbounded_or_contradictory_windows(payload):
    with pytest.raises(ValidationError):
        LiveSearchPlan.model_validate(payload)


@pytest.mark.parametrize(
    "payload",
    [
        {"sort": "recent"},
        {"file_kind": "pdf"},
        {"shared_with_me": True},
        {"date_from": "2026-09-10", "time_intent": "file_activity"},
    ],
)
def test_plan_accepts_each_claude_style_boundary_on_its_own(payload):
    LiveSearchPlan.model_validate(payload)


@pytest.mark.parametrize(
    "question, field",
    [
        ("Which files were modified in the last two days?", "modifiedTime"),
        ("What Drive files were created within the past 2 days?", "createdTime"),
    ],
)
async def test_simple_file_activity_listing_skips_model_and_content(monkeypatch, question, field):
    class _FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return NOW if tz is None else NOW.astimezone(tz)

    monkeypatch.setattr(drive_chat_service, "datetime", _FrozenDatetime)
    listed = {
        "file_id": "1AbCdEfGhIjKlMnOpQrStUvWxYz012345",
        "name": "Recent budget.pdf",
        "mime_type": "application/pdf",
        "modified_time": "2026-09-24T10:00:00Z",
        "created_time": "2026-09-24T09:00:00Z",
        "source_ref": "document:" + "a" * 32,
        "open_url": "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view",
    }
    reader = SimpleNamespace(
        find=AsyncMock(return_value={"matches": [listed], "truncated": False}),
        read_matches=AsyncMock(side_effect=AssertionError("content read")),
        require_current=AsyncMock(),
    )
    monkeypatch.setattr(drive_chat_service, "DriveLiveReader", lambda **kwargs: reader)
    planner = AsyncMock(side_effect=AssertionError("model planner reached"))
    selector = AsyncMock(side_effect=AssertionError("candidate selector reached"))
    interpreter = AsyncMock(side_effect=AssertionError("content interpreter reached"))
    chat = DriveChatService(
        oauth=SimpleNamespace(current_credential=AsyncMock(return_value=({}, {"profile": "live"}))),
        search_planner=planner,
        candidate_selector=selector,
        interpreter=interpreter,
    )

    outcome = await chat.run_live_query(
        user_id="owner",
        consent_token="",
        query=question,
        require_access=AsyncMock(),
        timezone="Asia/Kolkata",
    )

    assert reader.find.await_args.kwargs == {
        "query": [],
        "file_kind": "any",
        "shared_with_me": False,
        "recent": True,
        "time_field": field,
        "start_time": "2026-09-22T17:00:00Z",
        "end_time": "2026-09-24T17:00:00Z",
    }
    assert outcome["status"] == "ok"
    assert outcome["titles"] == ["Recent budget.pdf"]
    assert outcome["metadata_only"] is True
    assert outcome["selection"]["stage"] == "metadata_listing"
    shown = drive_chat_service._found_files(
        outcome["files"],
        truncated=outcome["found_truncated"],
        time_window=outcome["time_window"],
        date_field=outcome["date_field"],
        timezone=outcome["timezone"],
    )
    assert "Recent budget" in shown and "2026-09-24" in shown
    assert "Asia/Kolkata" in shown
    planner.assert_not_awaited()
    selector.assert_not_awaited()
    interpreter.assert_not_awaited()
    reader.read_matches.assert_not_awaited()


@pytest.mark.parametrize(
    "question",
    [
        "Which files were modified in the last two days and what changed?",
        "Which files were modified in the last two days for the sales team?",
        "Which file was modified on September 24?",
    ],
)
async def test_ambiguous_file_activity_question_keeps_model_planning(monkeypatch, question):
    reader = SimpleNamespace(
        find=AsyncMock(return_value={"matches": [], "truncated": False}),
        require_current=AsyncMock(),
    )
    monkeypatch.setattr(drive_chat_service, "DriveLiveReader", lambda **kwargs: reader)
    planner = AsyncMock(
        return_value={"mode": "find", "relative_days": 2, "time_intent": "file_activity"}
    )
    chat = DriveChatService(
        oauth=SimpleNamespace(current_credential=AsyncMock(return_value=({}, {"profile": "live"}))),
        search_planner=planner,
    )

    await chat.run_live_query(
        user_id="owner", consent_token="", query=question, require_access=AsyncMock()
    )

    planner.assert_awaited_once()


async def test_the_chat_turn_passes_type_sharing_recency_and_the_owners_day(monkeypatch):
    class _FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return NOW if tz is None else NOW.astimezone(tz)

    monkeypatch.setattr(drive_chat_service, "datetime", _FrozenDatetime)
    reader = SimpleNamespace(
        find=AsyncMock(
            return_value={
                "matches": [
                    {
                        "file_id": "1AbCdEfGhIjKlMnOpQrStUvWxYz012345",
                        "name": "Standup - 2026/09/24 10:00 PDT - Recording",
                        "mime_type": "video/mp4",
                        "modified_time": "2026-09-24T17:30:00Z",
                        "created_time": "2026-09-24T17:28:00Z",
                        "source_ref": "document:" + "a" * 32,
                        "open_url": "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view",
                    }
                ],
                "truncated": False,
            }
        ),
        read_matches=AsyncMock(side_effect=AssertionError("content read")),
        require_current=AsyncMock(),
    )
    monkeypatch.setattr(drive_chat_service, "DriveLiveReader", lambda **kwargs: reader)
    monkeypatch.setattr(drive_chat_service, "DriveDocumentReader", Mock(side_effect=AssertionError))
    chat = DriveChatService(
        oauth=SimpleNamespace(current_credential=AsyncMock(return_value=({}, {"profile": "live"}))),
        search_planner=AsyncMock(
            return_value={
                "terms": ["recording"],
                "file_kind": "video",
                "shared_with_me": False,
                "sort": "recent",
                "date_from": "2026-09-24",
                "date_to": "2026-09-24",
                "file_time_field": "createdTime",
                "time_intent": "file_activity",
            }
        ),
        candidate_selector=AsyncMock(return_value={"selected": ["c1"]}),
    )
    outcome = await chat.run_live_query(
        user_id="owner",
        consent_token="",
        query="find my recording of 24th september",
        require_access=AsyncMock(),
        timezone="Asia/Kolkata",
    )
    kwargs = reader.find.await_args.kwargs
    assert kwargs["query"] == ["recording"]
    assert kwargs["file_kind"] == "video" and kwargs["recent"] is True
    assert kwargs["shared_with_me"] is False
    assert kwargs["title_dates"] == ["2026-09-24"]
    assert (kwargs["time_field"], kwargs["start_time"], kwargs["end_time"]) == (
        "createdTime",
        "2026-09-23T18:30:00Z",
        "2026-09-24T18:30:00Z",
    )
    assert outcome["status"] == "ok" and outcome["titles"] == [
        "Standup - 2026/09/24 10:00 PDT - Recording"
    ]
    assert outcome["selection"] == {"stage": "completed", "candidates": 1, "selected": 1}
    # The owner sees the day the recording was made, in their own window text.
    text = drive_chat_service._found_files(
        outcome["files"],
        truncated=False,
        time_window=outcome["time_window"],
        date_field="created_time",
    )
    assert "2026-09-24" in text and "Asia/Kolkata" in text
    json.dumps(outcome)  # the outcome stays plain data


async def test_a_meeting_named_for_the_day_is_found_across_timezones():
    """Meet names recordings in the meeting's zone: "2026/09/10 15:48 PDT" was
    created at 22:55Z, which is already the 11th in Asia/Kolkata. Drive tokenizes
    `title contains '2026/09/10'` loosely (it also matched 09/18 and 06/09 on a
    real Drive), so the title-date search is filtered here to the exact date.
    """
    window = "(createdTime >= '2026-09-09T18:30:00Z' and createdTime < '2026-09-10T18:30:00Z')"
    reader, calls = reader_with(
        {
            ("search_files", "mimeType contains 'video/' and " + window): [
                file("s9", "Standup - 2026/09/09 10:01 PDT - Recording", mime="video/mp4")
            ],
            ("search_files", "mimeType contains 'video/' and title contains '2026/09/10'"): [
                file("s18", "Standup - 2026/09/18 10:00 PDT - Recording", mime="video/mp4"),
                file(
                    "a10",
                    "Anoushka and Manish - 2026/09/10 15:48 PDT - Recording",
                    mime="video/mp4",
                ),
                file("j9", "Standup - 2026/06/09 10:02 PDT - Recording", mime="video/mp4"),
            ],
        }
    )
    found = await reader.find(
        query=[],
        file_kind="video",
        time_field="createdTime",
        start_time="2026-09-09T18:30:00Z",
        end_time="2026-09-10T18:30:00Z",
        title_dates=["2026-09-10"],
    )
    names = [item["name"] for item in found["matches"]]
    assert names == [
        "Anoushka and Manish - 2026/09/10 15:48 PDT - Recording",
        "Standup - 2026/09/09 10:01 PDT - Recording",
    ]


async def test_title_dates_are_validated_before_any_provider_call():
    reader, calls = reader_with({})
    with pytest.raises(Exception, match="narrow_selection_required"):
        await reader.find(
            query=["notes"],
            time_field="createdTime",
            start_time="2026-09-09T18:30:00Z",
            end_time="2026-09-10T18:30:00Z",
            title_dates=["2026/09/10' or title contains 'x"],
        )
    assert calls == []


async def test_latest_recording_sorts_by_the_creation_time_the_provider_keeps():
    reader, _ = reader_with(
        {
            (
                "search_files",
                "mimeType contains 'video/' and (createdTime >= '2026-08-01T00:00:00Z'"
                " and createdTime < '2026-09-25T00:00:00Z')",
            ): [
                file(
                    "old",
                    "Old - Recording",
                    mime="video/mp4",
                    modified="2026-09-24T00:00:00Z",
                    created="2026-09-01T00:00:00Z",
                ),
                file(
                    "new",
                    "New - Recording",
                    mime="video/mp4",
                    modified="2026-09-02T00:00:00Z",
                    created="2026-09-20T00:00:00Z",
                ),
            ]
        }
    )
    found = await reader.find(
        query=[],
        file_kind="video",
        recent=True,
        time_field="createdTime",
        start_time="2026-08-01T00:00:00Z",
        end_time="2026-09-25T00:00:00Z",
    )
    # modifiedTime says "old" is newer; createdTime (what the owner asked) says "new".
    assert [item["name"] for item in found["matches"]] == ["New - Recording", "Old - Recording"]
    assert found["matches"][0]["created_time"] == "2026-09-20T00:00:00Z"


async def test_the_exact_title_date_is_found_on_a_later_page():
    window = "(createdTime >= '2026-09-09T18:30:00Z' and createdTime < '2026-09-10T18:30:00Z')"
    noise = [
        file(f"n{day}", f"Standup - 2026/09/{day:02d} 10:00 PDT - Recording", mime="video/mp4")
        for day in range(11, 19)
    ]
    reader, calls = reader_with(
        {
            ("search_files", "mimeType contains 'video/' and " + window): [],
            ("search_files", "mimeType contains 'video/' and title contains '2026/09/10'"): [
                noise,
                [file("a10", "Anoushka - 2026/09/10 15:48 PDT - Recording", mime="video/mp4")],
            ],
        }
    )
    found = await reader.find(
        query=[],
        file_kind="video",
        time_field="createdTime",
        start_time="2026-09-09T18:30:00Z",
        end_time="2026-09-10T18:30:00Z",
        title_dates=["2026-09-10"],
    )
    assert [item["name"] for item in found["matches"]] == [
        "Anoushka - 2026/09/10 15:48 PDT - Recording"
    ]


def test_since_a_day_means_through_today_and_a_long_since_is_bounded_and_shown():
    since = LiveSearchPlan.model_validate(
        {
            "date_from": "2026-09-01",
            "time_intent": "file_activity",
            "file_time_field": "createdTime",
        }
    )
    assert since.time_bounds(now_utc=NOW, timezone="Asia/Kolkata") == (
        "2026-08-31T18:30:00Z",
        "2026-09-24T18:30:00Z",
    )
    assert since.title_dates(now_utc=NOW, timezone="Asia/Kolkata") == []
    long_since = LiveSearchPlan.model_validate(
        {"date_from": "2020-01-01", "time_intent": "file_activity"}
    )
    start, end = long_since.time_bounds(now_utc=NOW, timezone="UTC")
    span = datetime.fromisoformat(end.replace("Z", "+00:00")) - datetime.fromisoformat(
        start.replace("Z", "+00:00")
    )
    assert span.days == 366


def test_file_dates_show_in_the_owners_timezone():
    text = drive_chat_service._found_files(
        [
            {
                "name": "Standup - Recording",
                "mime_type": "video/mp4",
                "modified_time": "2026-09-23T19:05:00Z",
                "created_time": "2026-09-23T19:00:00Z",
                "open_url": "https://drive.google.com/file/d/x/view",
            }
        ],
        truncated=False,
        date_field="created_time",
        timezone="Asia/Kolkata",
    )
    assert "2026-09-24" in text and "2026-09-23" not in text


async def test_a_date_only_listing_states_the_owners_window_and_names_each_file(monkeypatch):
    """S1: "what did I change on 21 September" lists files, states the owner's
    own window, and never reads content (metadata-only find)."""
    open_url = "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view"
    reader = SimpleNamespace(
        find=AsyncMock(
            return_value={
                "matches": [
                    {
                        "file_id": "1AbCdEfGhIjKlMnOpQrStUvWxYz012345",
                        "name": "Budget review",
                        "mime_type": "application/vnd.google-apps.document",
                        "modified_time": "2026-09-21T05:00:00Z",
                        "created_time": "2026-09-01T05:00:00Z",
                        "source_ref": "document:" + "c" * 32,
                        "open_url": open_url,
                    }
                ],
                "truncated": False,
            }
        ),
        # A spy, not a raising stub: run_live_query's broad except would swallow a raise.
        read_matches=AsyncMock(),
        require_current=AsyncMock(),
    )
    monkeypatch.setattr(drive_chat_service, "DriveLiveReader", lambda **kwargs: reader)
    chat = DriveChatService(
        oauth=SimpleNamespace(current_credential=AsyncMock(return_value=({}, {"profile": "live"}))),
        search_planner=AsyncMock(
            return_value={
                "mode": "find",
                "date_from": "2026-09-21",
                "date_to": "2026-09-21",
                "time_intent": "file_activity",
            }
        ),
    )
    response = await chat.handle_delegated_turn(
        user_id="owner",
        consent_token="",
        conversation_id="conversation",
        message="what did I change on 21 September",
        require_access=AsyncMock(),
        timezone="Asia/Kolkata",
    )
    kwargs = reader.find.await_args.kwargs
    assert kwargs["query"] == []
    assert kwargs["time_field"] == "modifiedTime"
    assert (kwargs["start_time"], kwargs["end_time"]) == (
        "2026-09-20T18:30:00Z",
        "2026-09-21T18:30:00Z",
    )
    assert kwargs["title_dates"] == ["2026-09-21"]
    text = response["response"]
    assert text.splitlines()[1] == (
        "Files modified from 2026-09-21 00:00 through 2026-09-22 00:00 (Asia/Kolkata)."
    )
    assert f"1. Budget review · file · 2026-09-21 — [Open in Drive]({open_url})" in text
    assert reader.read_matches.called is False
    assert response["structured"]["metadata_only"] is True


@pytest.mark.parametrize("time_field", ["modifiedTime", "createdTime"])
async def test_a_file_date_window_asks_drive_to_rank_by_that_date_before_the_cut(time_field):
    """S2: the 25-file cut must keep the newest files by the date the owner asked
    about, so the date-bounded search asks Drive to sort by that field."""
    window = f"({time_field} >= '2026-09-17T00:00:00Z' and {time_field} < '2026-09-24T00:00:00Z')"
    reader, calls = reader_with({("search_files", window): [file("w1", "Weekly notes")]})
    await reader.find(
        query=[],
        time_field=time_field,
        start_time="2026-09-17T00:00:00Z",
        end_time="2026-09-24T00:00:00Z",
    )
    assert calls[0][2]["orderBy"] == f"{time_field} desc"

    day = f"({time_field} >= '2026-09-17T00:00:00Z' and {time_field} < '2026-09-18T00:00:00Z')"
    reader, calls = reader_with(
        {("search_files", day): [], ("search_files", "title contains '2026/09/17'"): []}
    )
    await reader.find(
        query=[],
        time_field=time_field,
        start_time="2026-09-17T00:00:00Z",
        end_time="2026-09-18T00:00:00Z",
        title_dates=["2026-09-17"],
    )
    assert calls[0][2]["orderBy"] == f"{time_field} desc"
    # The title-date lookup is not a time window; it keeps Drive's own order.
    assert calls[-1][1] == "title contains '2026/09/17'"
    assert "orderBy" not in calls[-1][2]

    # Without a date window the transport keeps its own default order.
    reader, calls = reader_with({("search_files", "mimeType = 'application/pdf'"): []})
    await reader.find(query=[], file_kind="pdf")
    assert "orderBy" not in calls[0][2]


@pytest.mark.parametrize(
    "message, offset_days",
    [
        ("share me all my last 30 days standup sync notes i need all 30", 0),
        (
            "share me all my last to last 30 days standup sync notes not recent last 30 "
            "its like 30 before then 30 i need all 30 check my drive",
            30,
        ),
    ],
)
async def test_owner_can_list_all_thirty_dated_standups_without_model_selection(
    monkeypatch, message, offset_days
):
    class FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return NOW if tz is None else NOW.astimezone(tz)

    monkeypatch.setattr(drive_chat_service, "datetime", FrozenDatetime)
    days = [(NOW.date() - timedelta(days=offset_days + offset + 1)) for offset in range(30)]
    older_day = NOW.date() - timedelta(days=offset_days + 31)
    matches = [
        {
            "file_id": f"standup-{index}",
            "name": f"Team Standup Sync Notes - {day:%Y/%m/%d}",
            "mime_type": "application/vnd.google-apps.document",
            "modified_time": "2026-09-24T12:00:00Z",
            "created_time": f"{day:%Y-%m-%d}T12:00:00Z",
            "source_ref": "document:" + f"{index:032x}",
            "open_url": f"https://drive.google.com/open?id=standup-{index}",
        }
        for index, day in enumerate(days)
    ]
    matches.append(
        {
            **matches[0],
            "file_id": "old-standup",
            "name": f"Team Standup Sync Notes - {older_day:%Y/%m/%d}",
            "open_url": "https://drive.google.com/open?id=old-standup",
        }
    )
    reader = SimpleNamespace(
        find=AsyncMock(return_value={"matches": matches, "truncated": False}),
        read_matches=AsyncMock(),
        require_current=AsyncMock(),
    )
    monkeypatch.setattr(drive_chat_service, "DriveLiveReader", lambda **kwargs: reader)
    planner = AsyncMock()
    selector = AsyncMock()
    chat = DriveChatService(
        oauth=SimpleNamespace(current_credential=AsyncMock(return_value=({}, {"profile": "live"}))),
        search_planner=planner,
        candidate_selector=selector,
    )
    response = await chat.handle_delegated_turn(
        user_id="owner",
        consent_token="",
        conversation_id="conversation",
        message=message,
        require_access=AsyncMock(),
        timezone="UTC",
    )
    assert response["structured"]["status"] == "ok"
    assert response["structured"]["metadata_only"] is True
    assert response["structured"]["owner_compile_available"] is True
    assert parse_long_range_listing(response["structured"]["owner_compile_query"]) == (
        parse_long_range_listing(message)
    )
    assert "I found 30 candidate files" in response["response"]
    assert "30. Team Standup Sync Notes" in response["response"]
    assert f"{older_day:%Y/%m/%d}" not in response["response"]
    assert len(response["structured"]["sources"]) == 30
    first_day = NOW.date() - timedelta(days=offset_days + 30)
    end_day = NOW.date() - timedelta(days=offset_days)
    assert response["structured"]["owner_compile_window"] == {
        "start_date": first_day.isoformat(),
        "end_date": (end_day - timedelta(days=1)).isoformat(),
        "timezone": "UTC",
    }
    assert reader.find.await_count == 3
    assert any(
        call.kwargs
        == {
            "query": ["standup"],
            "time_field": "createdTime",
            "start_time": f"{first_day.isoformat()}T00:00:00Z",
            "end_time": f"{end_day.isoformat()}T00:00:00Z",
            "max_results": 100,
            "title_only": False,
        }
        for call in reader.find.await_args_list
    )
    assert any(call.kwargs.get("recent") is True for call in reader.find.await_args_list)
    planner.assert_not_awaited()
    selector.assert_not_awaited()
    reader.read_matches.assert_not_awaited()


async def test_owner_listing_reaches_date_only_note_in_named_meeting_folder(monkeypatch):
    class FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return NOW if tz is None else NOW.astimezone(tz)

    monkeypatch.setattr(drive_chat_service, "datetime", FrozenDatetime)
    folder = {
        "file_id": "meeting-folder",
        "name": "Hushh Team Sync and Standup",
        "mime_type": "application/vnd.google-apps.folder",
    }
    child = {
        "file_id": "gemini-note",
        "name": "2026/09/23 Notes by Gemini",
        "mime_type": "application/vnd.google-apps.document",
        "created_time": "2026-09-23T09:00:00Z",
        "modified_time": "2026-09-23T09:00:00Z",
        "source_ref": "document:" + "f" * 32,
        "open_url": "https://drive.google.com/open?id=gemini-note",
    }
    agenda = {
        **child,
        "file_id": "agenda-file",
        "name": "2026/09/23 Standup Sync Agenda",
        "source_ref": "document:" + "e" * 32,
        "open_url": "https://drive.google.com/open?id=agenda-file",
    }
    budget = {
        **child,
        "file_id": "budget-file",
        "name": "2026/09/23 Budget Notes by Gemini",
        "source_ref": "document:" + "d" * 32,
        "open_url": "https://drive.google.com/open?id=budget-file",
    }

    async def find(**kwargs):
        return {
            "matches": (
                [folder]
                if kwargs.get("file_kind") == "folder"
                else [agenda]
                if kwargs.get("recent")
                else []
            ),
            "truncated": False,
        }

    reader = SimpleNamespace(
        find=AsyncMock(side_effect=find),
        find_compilation_folder_children=AsyncMock(
            return_value={"matches": [child, agenda, budget], "truncated": False}
        ),
        require_current=AsyncMock(),
    )
    monkeypatch.setattr(drive_chat_service, "DriveLiveReader", lambda **kwargs: reader)
    chat = DriveChatService(
        oauth=SimpleNamespace(current_credential=AsyncMock(return_value=({}, {"profile": "live"}))),
        search_planner=AsyncMock(),
        candidate_selector=AsyncMock(),
    )
    response = await chat.handle_delegated_turn(
        user_id="owner",
        consent_token="",
        conversation_id="conversation",
        message="share me all my last 30 days standup sync notes",
        require_access=AsyncMock(),
        timezone="UTC",
    )
    assert response["structured"]["status"] == "ok"
    assert response["structured"]["owner_compile_available"] is True
    assert child["name"] in response["response"]
    assert agenda["name"] not in response["response"]
    assert budget["name"] not in response["response"]
    assert "excluded 2 dated files" in response["response"]
    assert response["structured"]["truncated"] is True
    assert response["structured"]["sources"][0]["source_ref"] == child["source_ref"]
    reader.find_compilation_folder_children.assert_awaited_once_with(folder_ids=["meeting-folder"])


async def test_connection_question_does_not_enter_owner_compilation_listing(monkeypatch):
    parser = Mock(wraps=parse_long_range_listing)
    monkeypatch.setattr(drive_chat_service, "parse_long_range_listing", parser)
    chat = DriveChatService(
        oauth=SimpleNamespace(current_credential=AsyncMock(return_value=({}, {"profile": "live"}))),
        search_planner=AsyncMock(side_effect=RuntimeError("stop after owner gate")),
    )
    outcome = await chat.run_live_query(
        user_id="owner",
        consent_token="",
        query="share me all my last 30 days standup sync notes",
        require_access=AsyncMock(),
        require_live=True,
    )
    parser.assert_not_called()
    assert (outcome.get("selection") or {}).get("stage") != "owner_title_date_listing"
