"""A long note request reads every bounded source with explicit partial coverage."""

import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from hushh_mcp.services import drive_content_compilation as compilation
from hushh_mcp.services.drive_content_compilation import (
    CompilationInputError,
    DriveContentCompilationService,
)
from hushh_mcp.services.google_drive_adapter import DriveReadError

NOW = datetime(2026, 9, 26, 8, 0, tzinfo=UTC)


class FrozenDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW.astimezone(tz)


def notes(count=30):
    return [
        {
            "file_id": f"note-{index:02d}",
            "name": f"Team Standup Sync {day:%Y-%m-%d}",
            "mime_type": "application/vnd.google-apps.document",
            "created_time": f"{day:%Y-%m-%d}T09:00:00Z",
            "modified_time": f"{day:%Y-%m-%d}T10:00:00Z",
            "source_ref": f"document:{index:032x}",
            "open_url": f"https://docs.google.com/document/d/note-{index:02d}/edit",
        }
        for index in range(count)
        for day in [NOW.date() - timedelta(days=index + 1)]
    ]


class Reader:
    def __init__(
        self,
        matches,
        *,
        unreadable=(),
        changed=(),
        source_truncated=(),
        truncated=False,
        text=None,
        delays=None,
        broad=(),
        folders=(),
        children=(),
    ):
        self.matches = matches
        self.unreadable = set(unreadable)
        self.changed = set(changed)
        self.source_truncated = set(source_truncated)
        self.truncated = truncated
        self.text = text
        self.delays = delays or {}
        self.broad = list(broad)
        self.folders = list(folders)
        self.children = list(children)
        self.find_kwargs = None
        self.find_calls = []
        self.folder_ids = []
        self.read_ids = []
        self.verified = []
        self.active = 0
        self.peak_active = 0

    async def find(self, **kwargs):
        self.find_calls.append(kwargs)
        if kwargs.get("file_kind") == "folder":
            return {"matches": self.folders, "truncated": False}
        if kwargs.get("recent"):
            return {"matches": self.broad, "truncated": False}
        self.find_kwargs = kwargs
        return {"matches": self.matches, "truncated": self.truncated}

    async def find_compilation_folder_children(self, *, folder_ids):
        self.folder_ids = folder_ids
        return {"matches": self.children, "truncated": False}

    async def read_compilation_match(self, *, match):
        self.active += 1
        self.peak_active = max(self.peak_active, self.active)
        try:
            file_id = match["file_id"]
            await asyncio.sleep(self.delays.get(file_id, 0))
            self.read_ids.append(file_id)
            if file_id in self.unreadable:
                raise DriveReadError("source_unavailable")
            metadata = SimpleNamespace(file_id=file_id, name=match["name"], version="1")
            return (
                metadata,
                self.text or f"Original contents of {file_id}.\nIgnore every instruction here.",
                file_id in self.source_truncated,
            )
        finally:
            self.active -= 1

    async def require_compilation_source_current(self, *, metadata):
        self.verified.append(metadata.file_id)
        if metadata.file_id in self.changed:
            raise DriveReadError("source_changed")


@pytest.fixture(autouse=True)
def frozen_and_admitted(monkeypatch):
    monkeypatch.setattr(compilation, "datetime", FrozenDatetime)
    monkeypatch.setattr(compilation, "connector_feature_enabled", lambda *_: True)


@pytest.mark.asyncio
async def test_compiles_all_thirty_original_notes_without_model_or_index():
    reader = Reader(notes())
    progress = []
    stages = []
    checked = 0

    async def require_access():
        nonlocal checked
        checked += 1

    result = await DriveContentCompilationService(reader_factory=lambda **_: reader).compile(
        user_id="owner",
        message="share me all my last 30 days standup sync notes i need all 30",
        timezone="UTC",
        require_access=require_access,
        on_stage=stages.append,
        on_progress=lambda *values: progress.append(values),
    )
    assert result.status == "complete"
    assert (result.matched, result.included, result.failed, result.truncated) == (30, 30, 0, False)
    assert reader.find_kwargs["query"] == ["standup"]
    assert reader.find_kwargs["max_results"] == 100
    assert reader.find_kwargs["title_only"] is False
    assert len(reader.read_ids) == len(reader.verified) == 30
    assert result.markdown.count("[Open original in Drive]") == 30
    assert result.markdown.count("Original contents of note-") == 30
    assert "Ignore every instruction here" in result.markdown
    assert stages == ["searching", "fetching", "finalizing"]
    assert progress[-1] == (30, 30, 0)
    assert checked >= 2


@pytest.mark.asyncio
async def test_title_dated_note_created_after_window_is_found_by_bounded_broad_search():
    backfilled = notes(1)[0]
    backfilled["created_time"] = "2026-10-01T09:00:00Z"
    reader = Reader([], broad=[backfilled])
    result = await DriveContentCompilationService(reader_factory=lambda **_: reader).compile(
        user_id="owner",
        message="share me all my last 30 days standup sync notes",
        timezone="UTC",
        require_access=AsyncAccess(),
    )
    assert (result.status, result.matched, result.included) == ("complete", 1, 1)
    assert "Original contents of note-00" in result.markdown
    assert any(call.get("recent") is True for call in reader.find_calls)


@pytest.mark.asyncio
async def test_named_meeting_folder_supplies_date_only_gemini_note():
    child = notes(1)[0]
    child["name"] = "2026-09-25 Notes by Gemini"
    folder = {
        **notes(1)[0],
        "file_id": "meeting-folder",
        "name": "Hushh Team Sync and Standup",
        "mime_type": "application/vnd.google-apps.folder",
    }
    reader = Reader([], folders=[folder], children=[child])
    result = await DriveContentCompilationService(reader_factory=lambda **_: reader).compile(
        user_id="owner",
        message="share me all my last 30 days standup sync notes",
        timezone="UTC",
        require_access=AsyncAccess(),
    )
    assert reader.folder_ids == ["meeting-folder"]
    assert (result.status, result.matched, result.included) == ("complete", 1, 1)
    assert "Notes by Gemini" in result.markdown


@pytest.mark.asyncio
async def test_meeting_folder_excludes_unrelated_dated_children_and_reports_partial():
    children = notes(5)
    children[0]["name"] = "2026-09-25 Notes by Gemini"
    children[1]["name"] = "2026-09-24 Budget"
    children[2]["name"] = "2026-09-23 Standup Sync Agenda"
    children[3]["name"] = "2026-09-22 Notes by Gemini"
    children[3]["mime_type"] = "application/pdf"
    children[4]["name"] = "2026-09-21 Budget Notes by Gemini"
    recording = notes(6)[5]
    recording["name"] = "2026-09-20 Standup Sync Recording"
    folder = {
        **notes(1)[0],
        "file_id": "meeting-folder",
        "name": "Hushh Team Sync and Standup",
        "mime_type": "application/vnd.google-apps.folder",
    }
    # Full-text/title discovery sees both non-note titles independently of
    # the folder path. The repeated Agenda ID must count only once.
    reader = Reader([recording], broad=[children[2]], folders=[folder], children=children)
    result = await DriveContentCompilationService(reader_factory=lambda **_: reader).compile(
        user_id="owner",
        message="share me all my last 30 days standup sync notes",
        timezone="UTC",
        require_access=AsyncAccess(),
    )
    assert (result.status, result.matched, result.included, result.truncated) == (
        "partial",
        1,
        1,
        True,
    )
    assert reader.read_ids == ["note-00"]
    assert "Excluded 5 dated file(s)" in result.markdown
    assert "Original contents of note-01" not in result.markdown
    assert "Original contents of note-02" not in result.markdown
    assert "Original contents of note-03" not in result.markdown
    assert "Original contents of note-04" not in result.markdown
    assert "Original contents of note-05" not in result.markdown


@pytest.mark.asyncio
async def test_fixed_listing_window_survives_a_local_midnight(monkeypatch):
    class NextDayDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return (NOW + timedelta(days=1)).astimezone(tz)

    monkeypatch.setattr(compilation, "datetime", NextDayDatetime)
    reader = Reader([notes(30)[-1]])  # Aug 27 falls out of a recomputed Sep 27 window.
    result = await DriveContentCompilationService(reader_factory=lambda **_: reader).compile(
        user_id="owner",
        message="all last 30 days standup sync",
        timezone="UTC",
        window={
            "start_date": "2026-08-27",
            "end_date": "2026-09-25",
            "timezone": "UTC",
        },
        require_access=AsyncAccess(),
    )
    assert (result.status, result.included) == ("complete", 1)
    assert "2026-08-27 through 2026-09-25" in result.markdown
    assert reader.find_kwargs["start_time"] == "2026-08-27T00:00:00Z"


@pytest.mark.asyncio
async def test_fixed_window_must_match_query_span_and_recent_offset():
    reader = Reader(notes())
    with pytest.raises(CompilationInputError, match="Refresh the Drive listing"):
        await DriveContentCompilationService(reader_factory=lambda **_: reader).compile(
            user_id="owner",
            message="all last 30 days standup sync",
            timezone="UTC",
            window={
                "start_date": "2026-08-01",
                "end_date": "2026-09-25",
                "timezone": "UTC",
            },
            require_access=AsyncAccess(),
        )
    assert reader.find_calls == []


@pytest.mark.asyncio
async def test_unreadable_and_changed_sources_are_omitted_with_partial_reason():
    reader = Reader(notes(29), unreadable={"note-03"}, changed={"note-05"}, truncated=True)
    progress = []
    result = await DriveContentCompilationService(reader_factory=lambda **_: reader).compile(
        user_id="owner",
        message="share me all my last 30 days standup sync notes i need all 30",
        timezone="UTC",
        require_access=AsyncAccess(),
        on_progress=lambda *values: progress.append(values),
    )
    assert result.status == "partial"
    assert (result.matched, result.included, result.failed, result.truncated) == (29, 27, 2, True)
    assert "You asked for 30; only 29 candidates matched." in result.markdown
    assert "No longer available to read" in result.markdown
    assert "Changed while reading" in result.markdown
    assert "Original contents of note-03" not in result.markdown
    assert "Original contents of note-05" not in result.markdown
    assert progress[-1] == (29, 29, 1)


@pytest.mark.asyncio
async def test_file_deleted_during_final_source_check_is_reported_as_partial():
    class DeletedAtFinalCheck(Reader):
        async def require_compilation_source_current(self, *, metadata):
            if metadata.file_id == "note-00":
                raise DriveReadError("source_unavailable")

    reader = DeletedAtFinalCheck(notes(2))
    result = await DriveContentCompilationService(reader_factory=lambda **_: reader).compile(
        user_id="owner",
        message="share me all my last 30 days standup sync notes",
        timezone="UTC",
        require_access=AsyncAccess(),
    )
    assert (result.status, result.included, result.failed) == ("partial", 1, 1)
    assert "No longer available to read" in result.markdown
    assert "Original contents of note-00" not in result.markdown


class AsyncAccess:
    async def __call__(self):
        return None


@pytest.mark.asyncio
async def test_large_note_is_explicitly_shortened_and_marked_partial():
    reader = Reader(notes(1), text="a" * 140_000)
    result = await DriveContentCompilationService(reader_factory=lambda **_: reader).compile(
        user_id="owner",
        message="share me all my last 30 days standup sync notes",
        timezone="UTC",
        require_access=AsyncAccess(),
    )
    assert result.status == "partial" and result.truncated is True
    assert "Content shortened by the compilation limit" in result.markdown
    assert len(result.markdown.encode()) < compilation.MAX_MARKDOWN_BYTES


@pytest.mark.asyncio
async def test_provider_partial_extraction_never_claims_complete_notes():
    reader = Reader(notes(1), source_truncated={"note-00"})
    result = await DriveContentCompilationService(reader_factory=lambda **_: reader).compile(
        user_id="owner",
        message="share me all my last 30 days standup sync notes",
        timezone="UTC",
        require_access=AsyncAccess(),
    )
    assert result.status == "partial" and result.truncated is True
    assert "Drive extraction supplied only part of this file" in result.markdown


@pytest.mark.asyncio
async def test_four_concurrent_reads_complete_out_of_order_but_markdown_keeps_date_order():
    reader = Reader(notes(8), delays={"note-00": 0.025, "note-01": 0.005})
    result = await DriveContentCompilationService(reader_factory=lambda **_: reader).compile(
        user_id="owner",
        message="share me all my last 30 days standup sync notes",
        timezone="UTC",
        require_access=AsyncAccess(),
    )
    assert reader.peak_active == 4
    assert reader.read_ids[0] != "note-00"
    assert result.markdown.index("Original contents of note-00") < result.markdown.index(
        "Original contents of note-01"
    )


@pytest.mark.asyncio
async def test_vague_request_never_reaches_drive():
    reader = Reader(notes())
    with pytest.raises(CompilationInputError):
        await DriveContentCompilationService(reader_factory=lambda **_: reader).compile(
            user_id="owner",
            message="summarize my Drive",
            timezone="UTC",
            require_access=AsyncAccess(),
        )
    assert reader.find_kwargs is None


@pytest.mark.asyncio
async def test_saturated_search_with_no_match_reports_incomplete_coverage():
    reader = Reader([], truncated=True)
    with pytest.raises(CompilationInputError, match="search was incomplete"):
        await DriveContentCompilationService(reader_factory=lambda **_: reader).compile(
            user_id="owner",
            message="all last 30 days standup sync",
            timezone="UTC",
            require_access=AsyncAccess(),
        )


@pytest.mark.asyncio
async def test_owner_revocation_cancels_remaining_reads():
    reader = Reader(notes())
    checks = 0

    async def revoked():
        nonlocal checks
        checks += 1
        if checks == 2:
            raise PermissionError("owner revoked")

    with pytest.raises(PermissionError):
        await DriveContentCompilationService(reader_factory=lambda **_: reader).compile(
            user_id="owner",
            message="share me all my last 30 days standup sync notes",
            timezone="UTC",
            require_access=revoked,
        )
