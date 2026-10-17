"""Deterministic provider-work proof; this is not a network latency benchmark.

Run with ``pytest -q -s tests/services/test_drive_search_performance_proof.py``.
Synthetic corpora contain 10,000 originals and never call Drive or an LLM.
"""

import copy
import json
import re
import time
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest

from hushh_mcp.services import drive_owner_search_service as search_module
from hushh_mcp.services import drive_trusted_auto_service as trusted_module
from hushh_mcp.services import google_drive_rest_transport as rest
from hushh_mcp.services.drive_owner_search_service import (
    DriveOwnerSearchService,
    compile_request_queries,
)
from hushh_mcp.services.drive_owner_search_store import MAX_RESULTS
from hushh_mcp.services.drive_request_bulk_service import (
    DriveRequestBulkService,
    _deterministic_meeting_note_plan,
)
from hushh_mcp.services.drive_request_review_policy import checkpoint_requires_owner_review
from hushh_mcp.services.drive_trusted_auto_service import DriveTrustedAutoService
from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult
from hushh_mcp.services.google_drive_adapter import (
    LIVE_POLICY_HASH,
    DriveReadError,
    GoogleDriveAdapter,
    query_has_full_text_term,
)


def synthetic_corpora(*, tied_boundary=False, rejected_newest=False):
    now = datetime(2026, 9, 1, tzinfo=UTC)
    corpora = {"user": [], "shared-drive": []}
    for number in range(10_000):
        # Interleave corpora: the globally newest 100 includes both sources.
        # Boundary ties cross provider pages and must be exhausted before
        # pruning, irrespective of provider tie ordering.
        at_boundary = tied_boundary and 75 <= number < 350
        age = 75 if at_boundary else number
        timestamp = (now - timedelta(seconds=age)).isoformat()
        corpus = "user" if number % 2 == 0 else "shared-drive"
        name = (
            "Historical 2020-01-01"
            if rejected_newest and number < 250
            else f"Synthetic document {number}"
        )
        corpora[corpus].append(
            {
                # Reverse the tied IDs: globally preferred tie winners arrive
                # on the second page, so stopping at the first N is incorrect.
                "id": f"synthetic-tie-{10_000 - number:05}"
                if at_boundary
                else f"synthetic-{number:05}",
                "title": name,
                "mimeType": "application/pdf",
                "createdTime": timestamp,
                "modifiedTime": timestamp,
                "capabilities": {"canShare": True},
            }
        )
    return corpora


class SyntheticDrive:
    def __init__(self, corpora):
        self.corpora = corpora
        self.calls = 0
        self.rows = 0

    async def read_tool(self, *, user_id, tool_name, arguments):
        assert user_id == "synthetic-owner"
        self.calls += 1
        if tool_name == "list_shared_drives":
            payload = {"drives": [{"id": "shared-drive"}]}
        else:
            assert tool_name == "search_files"
            assert arguments["orderBy"] == "modifiedTime desc"
            assert "folderId" not in arguments
            corpus = arguments.get("driveId", "user")
            offset = int(arguments.get("pageToken", "0"))
            end = offset + arguments["pageSize"]
            files = self.corpora[corpus][offset:end]
            self.rows += len(files)
            payload = {"files": copy.deepcopy(files), "incompleteSearch": False}
            if end < len(self.corpora[corpus]):
                payload["nextPageToken"] = str(end)
        return ExternalMcpToolResult(payload=payload, is_error=False, truncated=False)


async def collect(corpora, *, authority, bounded):
    plan = {
        "mode": "find",
        "file_kind": "document",
        "file_time_field": "modifiedTime",
        "sort": "recent",
        **({"result_limit": 100} if bounded else {}),
    }
    queries, period = compile_request_queries(
        plan,
        {
            "purpose": "Latest 100 documents",
            "periodStart": "2026-01-01",
            "periodEnd": "2026-12-31",
        },
        "UTC",
    )
    checkpoint = {
        "arguments": queries[0]["arguments"],
        "queries": queries,
        "query_index": 0,
        "request_origin_id": "synthetic-request",
        "request_explicit_dates": True,
        "request_file_kind": "document",
        "request_subject_terms": [],
        "request_exact_title": None,
        "request_notes": False,
        "request_result_limit": 100 if bounded else None,
        "request_order_field": "modifiedTime",
        "request_direct_originals": bounded,
        "requested_period": period,
        "authority_mode": authority,
        "coverage_counts": {},
        "folder_queue": [],
        "folder_digests": [],
        "phase": "user",
        "page_token": None,
        "drive_page_token": None,
        "drives": [],
        "drive_index": 0,
        "seen_tokens": [],
        "drive_tokens": [],
    }
    transport = SyntheticDrive(corpora)
    service = DriveOwnerSearchService(store=SimpleNamespace(), transport=transport)
    files = {}
    for _ in range(110):
        checkpoint, page, incomplete, done = await service._page(
            {"user_id": "synthetic-owner", "checkpoint": checkpoint}
        )
        assert not incomplete
        files.update((item["id"], item) for item in page)
        if done:
            return list(files.values()), checkpoint, transport
    pytest.fail("Synthetic scan did not terminate within expected provider calls")


def top_hundred(files):
    by_id = sorted(files, key=lambda item: item["id"])
    return [
        item["id"]
        for item in sorted(
            by_id,
            key=lambda item: datetime.fromisoformat(item["modifiedTime"]),
            reverse=True,
        )[:100]
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("authority", ["owner", "trusted_auto"])
@pytest.mark.parametrize("case", ["normal", "boundary_ties", "rejected_newest"])
async def test_latest_hundred_retains_global_results_with_less_provider_work(authority, case):
    corpora = synthetic_corpora(
        tied_boundary=case == "boundary_ties", rejected_newest=case == "rejected_newest"
    )
    exhaustive, _, baseline = await collect(corpora, authority=authority, bounded=False)
    bounded, checkpoint, optimized = await collect(corpora, authority=authority, bounded=True)

    # Independent full-corpus oracle verifies correctness, not just fewer calls.
    expected = [
        item
        for files in corpora.values()
        for item in files
        if not item["title"].startswith("Historical")
    ]
    assert top_hundred(bounded) == top_hundred(expected) == top_hundred(exhaustive)
    assert checkpoint["coverage_counts"]["boundedCorporaCompleted"] == 2
    assert baseline.calls == 101 and baseline.rows == 10_000
    expected_calls, expected_rows = (7, 600) if case == "rejected_newest" else (5, 400)
    assert (optimized.calls, optimized.rows) == (expected_calls, expected_rows)
    print(
        json.dumps(
            {
                "proof": "synthetic_provider_work_not_wall_clock",
                "authority": authority,
                "case": case,
                "requested": 100,
                "corpus_size": 10_000,
                "baseline_calls": baseline.calls,
                "optimized_calls": optimized.calls,
                "baseline_rows": baseline.rows,
                "optimized_rows": optimized.rows,
                "same_global_top_100": True,
            },
            sort_keys=True,
        )
    )


# A 40,000-file Drive, streamed into share batches slice by slice. The fake
# answers at the HTTP boundary, so the real search service, REST transport and
# adapter fence run unchanged; only Postgres and the grant worker are replaced.
STREAM_OWNER = "synthetic-owner"
STREAM_REQUEST = "5f3c2a10-0000-4000-8000-000000000001"
STREAM_JOB = "5f3c2a10-0000-4000-8000-000000000002"
STREAM_PERIOD = {"periodStart": "2026-09-02", "periodEnd": "2026-10-02"}
SHARED_DRIVE = "sharedDriveA"
ARCHIVE_FOLDER = "folderMeetingArchive"
PDF = "application/pdf"
SHORTCUT = "application/vnd.google-apps.shortcut"
FOLDER = "application/vnd.google-apps.folder"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
# Day 334 after the corpus start is 2026-09-02; day 364 is 2026-10-02.
CORPUS_START = datetime(2025, 10, 3, 12, tzinfo=UTC)
NEVER_SHARED = {
    "out_of_period",
    "non_shareable",
    "trashed",
    "wrong_kind",
    "no_title_evidence",
    "agenda",
    "shortcut_missing",
    "shortcut",
    "folder",
    "unrelated",
}


def _stamp(day):
    return (CORPUS_START + timedelta(days=day)).isoformat().replace("+00:00", "Z")


def streamed_corpus():
    """Exactly 40,000 files, each labelled with whether it may ever be shared."""
    files, labels = {}, {}

    def add(file_id, name, label, *, day, mime=PDF, drive=None, content="meeting notes", **extra):
        files[file_id] = {
            "id": file_id,
            "name": name,
            "mimeType": mime,
            "modifiedTime": _stamp(day),
            "createdTime": _stamp(day),
            "driveId": drive,
            "parents": [],
            "trashed": False,
            "canShare": True,
            "content": content,
            **extra,
        }
        labels[file_id] = label

    for number in range(40_000):
        drive = SHARED_DRIVE if number % 10 == 0 else None
        file_id = f"{'sd' if drive else 'f'}{number:05d}"
        day = (number * 7) % 365
        in_period = 334 <= day <= 364
        dated = "qualifying" if in_period else "out_of_period"
        if number % 4 == 3:
            add(
                file_id,
                f"Invoice {number}.pdf",
                "unrelated",
                day=day,
                drive=drive,
                content="invoice",
            )
            continue
        category = (number // 4) % 10
        if category == 0:
            add(file_id, f"Meeting Notes {number}.pdf", dated, day=day, drive=drive)
        elif category == 1:
            add(file_id, f"MeetingNotes_{number}.pdf", dated, day=day, drive=drive)
        elif category == 2:
            add(file_id, f"2026_09_MeetingNotes {number}.pdf", dated, day=day, drive=drive)
        elif category == 3:
            add(file_id, f"meeting-notes-{number}.docx", dated, day=day, drive=drive, mime=DOCX)
        elif category == 4:
            add(
                file_id,
                f"Meeting Notes {number}.pdf",
                "non_shareable" if in_period else "out_of_period",
                day=day,
                drive=drive,
                canShare=False,
            )
        elif category == 5:
            add(file_id, f"Meeting Notes {number}.pdf", "trashed", day=day, drive=drive)
            files[file_id]["trashed"] = True
        elif category == 6:
            add(file_id, f"Meeting Notes {number}.png", "wrong_kind", day=day, mime="image/png")
        elif category == 7:
            add(file_id, f"Weekly sync {number}.pdf", "no_title_evidence", day=day, drive=drive)
        elif category == 8:
            add(file_id, f"Meeting agenda notes {number}.pdf", "agenda", day=day, drive=drive)
        else:
            # A title date decides the period before file activity does.
            title_day = 340 if number % 8 < 4 else 100
            add(
                file_id,
                f"Meeting Notes {_stamp(title_day)[:10]} {number}.pdf",
                "qualifying" if title_day == 340 else "out_of_period",
                day=350 if title_day == 100 else 10,
                drive=drive,
            )
    qualifying = sorted(identity for identity, label in labels.items() if label == "qualifying")
    # Shortcuts replace ordinary files so the corpus stays at 40,000. Their
    # targets are already-qualifying originals in My Drive or the shared drive.
    for index, number in enumerate(range(1, 40_000, 200)):
        file_id = f"f{number:05d}"
        missing = index % 10 == 0
        target = f"gone{number:05d}" if missing else qualifying[(index * 37) % len(qualifying)]
        add(
            file_id,
            f"Meeting Notes link {number}",
            "shortcut_missing" if missing else "shortcut",
            day=340,
            mime=SHORTCUT,
            shortcutDetails={"targetId": target, "targetMimeType": PDF},
        )
    add(ARCHIVE_FOLDER, "Meeting Notes Archive", "folder", day=340, mime=FOLDER)
    del files[f"f{39_999:05d}"], labels[f"f{39_999:05d}"]
    for identity in qualifying[:3]:
        files[identity]["parents"] = [ARCHIVE_FOLDER]
    assert len(files) == 40_000
    return files, labels


_Q_TOKEN = re.compile(r"\s*(?:(\(|\))|('(?:\\.|[^'\\])*')|(!=|>=|<=|=|<|>)|([A-Za-z]+))")


def _words(text):
    # Letters and digits in any script; punctuation and underscores separate.
    return re.findall(r"[^\W_]+", text.lower())


def drive_query(q):
    """Emulate the Drive q subset the search compiles.

    name contains is token-prefix matching; fullText contains matches whole
    tokens (a double-quoted value is a phrase). "MeetingNotes" is one token.
    """
    tokens = []
    position = 0
    while position < len(q):
        match = _Q_TOKEN.match(q, position)
        assert match, q[position:]
        tokens.append(next(group for group in match.groups() if group is not None))
        position = match.end()
        if not q[position:].strip():
            break
    cursor = [0]

    def take(expected=None):
        token = tokens[cursor[0]]
        assert expected is None or token == expected, (token, expected)
        cursor[0] += 1
        return token

    def literal(token):
        return re.sub(r"\\(.)", r"\1", token[1:-1])

    def expression():
        left = conjunction()
        while cursor[0] < len(tokens) and tokens[cursor[0]] == "or":
            take()
            right = conjunction()
            left = (lambda a, b: lambda f: a(f) or b(f))(left, right)
        return left

    def conjunction():
        left = factor()
        while cursor[0] < len(tokens) and tokens[cursor[0]] == "and":
            take()
            right = factor()
            left = (lambda a, b: lambda f: a(f) and b(f))(left, right)
        return left

    def factor():
        token = take()
        if token == "(":
            inner = expression()
            take(")")
            return inner
        if token.startswith("'"):
            take("in")
            take("parents")
            parent = literal(token)
            return lambda f: parent in f["parents"]
        operator = take()
        value = take()
        if operator == "contains":
            text = literal(value)
            if token == "name":
                prefix = _words(text)
                return lambda f: any(
                    words[i : i + len(prefix) - 1] == prefix[:-1]
                    and words[i + len(prefix) - 1].startswith(prefix[-1])
                    for words in [_words(f["name"])]
                    for i in range(len(words) - len(prefix) + 1)
                )
            if token == "fullText":
                phrase = _words(text.strip('"'))
                return lambda f: any(
                    words[i : i + len(phrase)] == phrase
                    for words in [_words(f["name"] + " " + f["content"])]
                    for i in range(len(words) - len(phrase) + 1)
                )
            assert token == "mimeType"
            return lambda f: text in f["mimeType"]
        expected = value == "true" if value in {"true", "false"} else literal(value)
        field = {"trashed": "trashed", "mimeType": "mimeType"}[token]
        if operator == "=":
            return lambda f: f[field] == expected
        assert operator == "!="
        return lambda f: f[field] != expected

    predicate = expression()
    assert cursor[0] == len(tokens), q
    return predicate


class StreamedDrive:
    """files.list, files.get and drives.list over one synthetic owner Drive."""

    def __init__(self, files, *, incomplete_page=None):
        self.files = files
        self.incomplete_page = incomplete_page
        self.events = []
        self.served = 0
        # The kth successful list page first fails with these statuses; the
        # search must retry the same cursor without skipping or duplicating.
        self.faults = {6: [429, 403], 12: [503]}
        self.empty_pages = {3, 9}
        self.target_faults = {"once"}
        self.listings = {}
        self.page_sizes = []

    def _listing(self, q, drive, ordered):
        key = (q, drive, ordered)
        if key not in self.listings:
            predicate = drive_query(q)
            rows = [
                item for item in self.files.values() if item["driveId"] == drive and predicate(item)
            ]
            rows.sort(key=lambda item: item["id"])
            if ordered:
                rows.sort(key=lambda item: item["modifiedTime"], reverse=True)
            self.listings[key] = rows
        return self.listings[key]

    @staticmethod
    def _json(status, payload):
        return httpx.Response(status, stream=httpx.ByteStream(json.dumps(payload).encode()))

    def _listed(self, item):
        result = {
            key: item[key] for key in ("id", "name", "mimeType", "modifiedTime", "createdTime")
        }
        result["webViewLink"] = f"https://drive.google.com/file/d/{item['id']}/view"
        result["capabilities"] = {"canShare": item["canShare"]}
        if item["driveId"]:
            result["driveId"] = item["driveId"]
        if item.get("shortcutDetails"):
            result["shortcutDetails"] = item["shortcutDetails"]
        return result

    def __call__(self, request):
        path = request.url.path.removeprefix("/drive/v3")
        params = dict(request.url.params)
        if path == "/drives":
            return self._json(200, {"drives": [{"id": SHARED_DRIVE, "name": "Team"}]})
        if path != "/files":
            identity = path.removeprefix("/files/")
            if identity in self.target_faults or (
                self.target_faults == {"once"} and identity.startswith("sd")
            ):
                self.target_faults = set()
                return self._json(429, {"error": {"code": 429}})
            item = self.files.get(identity)
            if item is None or item["trashed"]:
                return self._json(404, {"error": {"code": 404}})
            return self._json(
                200,
                {
                    **self._listed(item),
                    "version": "7",
                    "trashed": False,
                    "capabilities": {
                        "canShare": item["canShare"],
                        "canDownload": True,
                        "canAccessViaGenAi": True,
                    },
                },
            )
        q = params["q"]
        assert "trashed = false" in q
        # Drive answers 400 to a sort on a fullText query.
        assert not (query_has_full_text_term(q) and "orderBy" in params), q
        size = int(params["pageSize"])
        assert 1 <= size <= 1000
        self.page_sizes.append(size)
        page = self.served + 1
        statuses = self.faults.get(page)
        if statuses:
            status = statuses.pop(0)
            self.events.append(("provider_error", status))
            if status == 403:
                return self._json(
                    403, {"error": {"code": 403, "errors": [{"reason": "userRateLimitExceeded"}]}}
                )
            return self._json(status, {"error": {"code": status}})
        token = params.get("pageToken", "o0")
        drive = params.get("driveId") if params["corpora"] == "drive" else None
        rows = self._listing(q, drive, "orderBy" in params)
        offset = int(token[1:])
        self.served = page
        self.events.append(("list", (drive, q, token)))
        if page in self.empty_pages and token.startswith("o"):
            return self._json(200, {"files": [], "nextPageToken": f"e{offset}"})
        chunk = rows[offset : offset + size]
        payload = {
            "files": [self._listed(item) for item in chunk],
            "incompleteSearch": page == self.incomplete_page,
        }
        if offset + size < len(rows):
            payload["nextPageToken"] = f"o{offset + size}"
        return self._json(200, payload)


class StreamedSearchStore:
    """The owner-search store contract the service relies on, in memory.

    Each claim reloads the JSON checkpoint, so every slice resumes only from
    what the previous slice durably committed.
    """

    def __init__(self, events):
        self.events = events
        self.row = None
        self.results = {}
        self.commits_in_slice = 0

    def view(self):
        row = self.row
        checkpoint = json.loads(row["checkpoint"])
        counts = checkpoint.get("coverage_counts", {})
        return {
            "jobId": STREAM_JOB,
            "status": row["status"],
            "matched": row["matched"],
            "unshareableCount": row["unshareable"],
            "pagesScanned": row["pages"],
            "incompleteSearch": row["incomplete"],
            "errorCode": row["error"],
            "coverage": {
                "providerRowsScanned": counts.get("providerRowsScanned", 0),
                "deduplicatedCount": counts.get("deduplicatedCount", 0),
                "resolvedShortcutCount": counts.get("resolvedShortcutCount", 0),
                "unavailableShortcutCount": counts.get("unavailableShortcutCount", 0),
                "excludedByDateCount": counts.get("excludedByDateCount", 0),
            },
        }

    async def by_client(self, **kwargs):
        return self.view() if self.row else None

    async def create(self, *, checkpoint, **kwargs):
        self.row = {
            "status": "queued",
            "matched": 0,
            "unshareable": 0,
            "pages": 0,
            "incomplete": False,
            "error": None,
            "retries": 0,
            "lease": None,
            "checkpoint": json.dumps(checkpoint),
        }
        return self.view(), True

    async def align_request_expiry(self, **kwargs):
        return None

    async def status(self, **kwargs):
        return self.view()

    async def claim(self, *, user_id, job_id):
        if self.row["status"] not in {"queued", "running"} or self.row["lease"]:
            return None
        lease = str(uuid4())
        self.row.update(status="running", lease=lease)
        return {
            "job_id": job_id,
            "user_id": user_id,
            "generation": 1,
            "lease_id": lease,
            "checkpoint": json.loads(self.row["checkpoint"]),
            "v1_statement_search": False,
        }

    async def require_current(self, job):
        assert self.row["lease"] == job["lease_id"]

    async def commit_page(self, job, *, checkpoint, files, incomplete=False, done=False):
        # Only a V1 request may commit a 1000-row provider page.
        v1 = checkpoint.get("v1_live_request") is True
        assert self.row["lease"] == job["lease_id"] and len(files) <= (1000 if v1 else 100)
        shareable = 0
        limited = False
        for item in files:
            if item["id"] in self.results:
                counts = checkpoint.setdefault("coverage_counts", {})
                counts["deduplicatedCount"] = counts.get("deduplicatedCount", 0) + 1
                continue
            if self.row["matched"] == MAX_RESULTS:
                # DriveOwnerSearchStore's 10,000-candidate storage ceiling.
                limited = True
                break
            self.row["matched"] += 1
            self.results[item["id"]] = (self.row["matched"], item)
            self.row["unshareable"] += int(item.get("shareable") is False)
            shareable += int(item.get("shareable") is True)
        limited = limited or self.row["matched"] == MAX_RESULTS and not done
        incomplete = incomplete or self.row["incomplete"] or limited
        state = "limited" if limited or done and incomplete else "completed" if done else "running"
        self.row.update(
            status=state,
            pages=self.row["pages"] + 1,
            incomplete=incomplete,
            retries=0,
            error="search_limit" if limited else None,
            checkpoint=json.dumps(checkpoint),
            lease=self.row["lease"] if state == "running" else None,
        )
        self.commits_in_slice += 1
        self.events.append(("commit", shareable))
        return self.view()

    async def release(self, job, *, error=None, retryable=False):
        if self.row["status"] != "running" or self.row["lease"] != job["lease_id"]:
            return self.row["status"]
        retries = self.row["retries"] + int(error is not None)
        state = "queued" if error is None or retryable and retries < 3 else "failed"
        self.row.update(status=state, error=error, retries=min(retries, 3), lease=None)
        return state


class StreamedBatches:
    """Unclaimed shareable positions and frozen 25-file batches."""

    def __init__(self, store, events):
        self.store = store
        self.events = events
        self.batches = []

    def claimed(self):
        return {position for batch in self.batches for position in batch}

    async def unclaimed_positions(self, *, limit, **kwargs):
        row = self.store.row
        # Same gate as DriveBulkShareStore: an incomplete search shares nothing more.
        if row["status"] not in {"queued", "running", "completed"} or row["incomplete"]:
            return []
        claimed = self.claimed()
        return [
            position
            for position, item in sorted(self.store.results.values(), key=lambda pair: pair[0])
            if position not in claimed and item.get("shareable") is True
        ][:limit]

    async def create_review(self, *, selected_positions, **kwargs):
        assert len(selected_positions) <= 25
        assert not set(selected_positions) & self.claimed()
        self.batches.append(list(selected_positions))
        return {"shareId": str(uuid4()), "revision": 0, "reviewDigest": "exact-batch"}

    async def pending_request_reviews(self, **kwargs):
        return []

    async def refresh_request(self, **kwargs):
        return None


async def stream_request(monkeypatch, *, incomplete_page=None, v1=False):
    files, labels = streamed_corpus()
    drive = StreamedDrive(files, incomplete_page=incomplete_page)
    events = drive.events
    original_client = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kw: original_client(**kw, transport=httpx.MockTransport(drive)),
    )
    monkeypatch.setattr(rest, "connector_feature_enabled", lambda *_: True)
    monkeypatch.setattr(search_module, "wake_drive_work", AsyncMock())
    connection = {
        "status": "connected",
        "validation_state": "verified",
        "verified_policy_hash": LIVE_POLICY_HASH,
        "connection_generation": 1,
    }
    transport = rest.GoogleDriveRestTransport(
        oauth=SimpleNamespace(
            current_credential=AsyncMock(
                return_value=(connection, {"accessToken": "synthetic-grant"})
            ),
            lifecycle=SimpleNamespace(read=AsyncMock(return_value=connection)),
        ),
        adapter=GoogleDriveAdapter(),
    )
    store = StreamedSearchStore(events)
    scanner = DriveOwnerSearchService(store=store, transport=transport)
    batches = StreamedBatches(store, events)
    approved = []

    class BulkShareService:
        def __init__(self, **kwargs):
            self.require_owner = kwargs["require_owner"]

        async def approve(self, *, share_id, **kwargs):
            await self.require_owner()
            approved.append(share_id)
            events.append(("batch_started", len(batches.batches[-1])))

    def request_bulk(**kwargs):
        return DriveRequestBulkService(
            **kwargs,
            search=scanner,
            recipient_identity=AsyncMock(
                return_value=SimpleNamespace(
                    user_id="requester",
                    subject="requester-subject",
                    email="requester@example.com",
                    kind="google_provider",
                )
            ),
        )

    monkeypatch.setattr(trusted_module, "DriveRequestBulkService", request_bulk)
    monkeypatch.setattr(trusted_module, "DriveBulkShareService", BulkShareService)
    purpose = {"purpose": "meeting notes", **STREAM_PERIOD}
    context = {
        "purpose": purpose,
        "status": "pending",
        "searchStarted": True,
        "revision": 1,
        "trustedAuto": True,
        "recipientUserId": "requester",
        "recipient": {
            "subject": "requester-subject",
            "email": "requester@example.com",
            "kind": "google_provider",
        },
    }

    async def owner_review_required(**kwargs):
        # The real consent rule decides; only a file-activity selection
        # under the request's own revision may skip the owner's review.
        return checkpoint_requires_owner_review(
            json.loads(store.row["checkpoint"]), request_id=STREAM_REQUEST, revision=1
        )

    sharing = SimpleNamespace(
        db=object(),
        trusted_request_for_job=AsyncMock(return_value=STREAM_REQUEST),
        request_bulk_context=AsyncMock(return_value=context),
        trusted_request_authority=AsyncMock(return_value={}),
        request_owner_review_required=owner_review_required,
        defer_trusted_search=AsyncMock(),
    )
    payment = SimpleNamespace(
        ensure_payment_for_frozen_batch=AsyncMock(return_value={"status": "paid"})
    )
    auto = DriveTrustedAutoService(sharing=sharing, bulk=batches, payment=payment, wake=AsyncMock())
    authority = AsyncMock()
    started = time.perf_counter()
    # V1 is the content-evaluated package lane: its search hands nothing to
    # sharing; the evaluator and an exact paid package come first.
    after_page = None if v1 else auto.after_search_page
    await scanner.create_for_request(
        user_id=STREAM_OWNER,
        request_id=STREAM_REQUEST,
        request_revision=1,
        purpose=purpose,
        plan=_deterministic_meeting_note_plan(purpose).model_dump(mode="json")
        if v1
        else {
            "mode": "find",
            "terms": ["meeting", "notes"],
            "file_kind": "document",
            "time_intent": "file_activity",
            "file_time_field": "modifiedTime",
        },
        require_current=authority,
        authority_mode="agent_package" if v1 else "trusted_auto",
        requested_at=datetime(2026, 10, 3, tzinfo=UTC),
        **({"v1_live_request": True} if v1 else {"after_page": after_page}),
    )

    def progress():
        # What a status read would show after this slice.
        return {
            **store.view(),
            "commits": store.commits_in_slice,
            "batches": len(approved),
            "shared": len(batches.claimed()),
            "shareable": sum(item.get("shareable") is True for _, item in store.results.values()),
        }

    slices = [progress()]
    while store.row["status"] in {"queued", "running"}:
        assert len(slices) < 500, "the search did not terminate"
        store.commits_in_slice = 0
        await scanner.run_one(
            user_id=STREAM_OWNER,
            job_id=STREAM_JOB,
            **({} if v1 else {"require_current": authority, "after_page": after_page}),
        )
        if not v1:
            # The worker hands off once more after each slice, as in production.
            await auto.after_search_slice(user_id=STREAM_OWNER, job_id=STREAM_JOB)
        slices.append(progress())
    # continue_batches: a completed search keeps draining its committed rows.
    drains = 0
    while not v1 and await auto.share_available(user_id=STREAM_OWNER, request_id=STREAM_REQUEST):
        drains += 1
        assert drains < 500, "continue_batches did not terminate"
    return {
        "elapsed": time.perf_counter() - started,
        "drive": drive,
        "store": store,
        "batches": batches,
        "labels": labels,
        "files": files,
        "slices": slices,
        "events": events,
        "approved": approved,
        "sharing": sharing,
    }


def _shared_ids(run):
    by_position = {position: identity for identity, (position, _) in run["store"].results.items()}
    return [by_position[position] for batch in run["batches"].batches for position in batch]


@pytest.mark.asyncio
async def test_forty_thousand_file_drive_streams_batches_slice_by_slice(monkeypatch):
    run = await stream_request(monkeypatch)
    store, labels, events, slices = run["store"], run["labels"], run["events"], run["slices"]
    assert run["elapsed"] < 60
    assert store.row["status"] == "completed" and not store.row["incomplete"]

    # The first batch starts right after the first page that confirms a
    # shareable file, before Drive is asked for the next page.
    first = next(
        index for index, event in enumerate(events) if event[0] == "commit" and event[1] > 0
    )
    assert events[first + 1][0] == "batch_started"
    assert [event[0] for event in events[: first + 1]].count("batch_started") == 0
    # Every later slice ends with all of its confirmed files already in
    # started batches: sharing keeps pace with the scan instead of waiting.
    running = [item for item in slices if item["status"] in {"queued", "running"}]
    assert all(item["shared"] == item["shareable"] for item in running)
    assert len({item["batches"] for item in running}) > 10
    expected = {identity for identity, label in labels.items() if label == "qualifying"}
    assert running[-1]["shared"] >= len(expected) // 2
    # Per-slice progress for the status payload, and a bounded slice.
    assert all(item["commits"] <= 4 for item in slices)
    assert slices[0]["commits"] == 1
    scanned = [item["coverage"]["providerRowsScanned"] for item in slices]
    # Every row Drive matched was scanned exactly once across all corpora,
    # through empty pages, retries and the topical folder's children.
    assert scanned == sorted(scanned)
    assert scanned[-1] == sum(len(rows) for rows in run["drive"].listings.values()) > 24_000
    assert [item["pagesScanned"] for item in slices] == sorted(
        item["pagesScanned"] for item in slices
    )

    # Rate limits and a 5xx were retried on the same cursor, never skipped.
    assert [event for event in events if event[0] == "provider_error"] == [
        ("provider_error", 429),
        ("provider_error", 403),
        ("provider_error", 503),
    ]
    # A page whose shortcut-target read was rate limited is not committed and
    # is listed again; a committed page is never listed twice.
    flow = [event for event in events if event[0] in {"list", "commit"}]
    committed = [
        event[1]
        for event, after in zip(flow, flow[1:] + [("end",)], strict=True)
        if event[0] == "list" and after[0] == "commit"
    ]
    listed = {event[1] for event in flow if event[0] == "list"}
    assert len(committed) == len(set(committed)) and set(committed) == listed
    assert sum(event[0] == "list" for event in flow) == len(committed) + 1

    # Every qualifying file is shared exactly once; nothing else ever is.
    shared = _shared_ids(run)
    assert len(shared) == len(set(shared))
    assert set(shared) == expected
    assert len(expected) > 900
    assert not {labels[identity] for identity in shared} & NEVER_SHARED
    assert any(identity.startswith("sd") for identity in shared)
    assert any("MeetingNotes" in run["files"][identity]["name"] for identity in shared)
    # Shortcuts resolved to their originals and deduplicated against them;
    # a deleted target is kept with a reason and never shared.
    coverage = store.view()["coverage"]
    assert coverage["resolvedShortcutCount"] > 0 and coverage["deduplicatedCount"] > 0
    unavailable = [
        item
        for _, item in store.results.values()
        if item.get("unavailableReason") == "shortcut_target_unavailable"
    ]
    assert unavailable and all(item["shareable"] is False for item in unavailable)
    assert {
        item["unavailableReason"] for _, item in store.results.values() if not item["shareable"]
    } == {"source_not_shareable", "shortcut_target_unavailable"}
    run["sharing"].defer_trusted_search.assert_not_awaited()
    print(
        json.dumps(
            {
                "proof": "streamed_batches_synthetic_drive",
                "corpus_size": 40_000,
                "slices": len(slices),
                "provider_rows_scanned": scanned[-1],
                "qualifying_shared": len(shared),
                "batches": len(run["batches"].batches),
                "elapsed_seconds": round(run["elapsed"], 2),
            },
            sort_keys=True,
        )
    )


@pytest.mark.asyncio
async def test_incomplete_drive_search_is_surfaced_and_stops_automatic_batches(monkeypatch):
    run = await stream_request(monkeypatch, incomplete_page=15)
    store, events = run["store"], run["events"]
    # Drive's incompleteSearch is never reported as a complete or empty result.
    assert store.row["status"] == "limited" and store.row["incomplete"]
    assert store.view()["incompleteSearch"] is True
    commits = [index for index, event in enumerate(events) if event[0] == "commit"]
    incomplete_commit = commits[14]
    started = [index for index, event in enumerate(events) if event[0] == "batch_started"]
    # Batches confirmed before Drive reported incompleteness went out once;
    # the current policy stops automatic sharing after it (owner decision).
    assert started and max(started) < incomplete_commit
    shared = _shared_ids(run)
    assert len(shared) == len(set(shared))
    assert not {run["labels"][identity] for identity in shared} - {"qualifying"}


@pytest.mark.parametrize(
    "term,name",
    [
        ("O'Brien", "O'Brien minutes.pdf"),
        ("C:\\Notes", "C:\\Notes archive.pdf"),
        ("Café", "Café minutes.pdf"),
        ("会議", "会議 notes.pdf"),
        ("a" * 50, "a" * 50 + " notes.pdf"),
    ],
)
def test_compiled_literals_round_trip_through_drive_q_grammar(term, name):
    from hushh_mcp.services.google_drive_rest_transport import compile_search_terms, rest_query

    q = rest_query(compile_search_terms([term]))
    matches = drive_query(q)
    item = {"name": name, "content": "", "mimeType": PDF, "trashed": False, "parents": []}
    # The escaped value parses back to the requester's exact characters.
    assert matches(item)
    assert not matches({**item, "name": "unrelated.pdf"})
    assert not matches({**item, "trashed": True})


@pytest.mark.parametrize(
    "request_text,terms,compound",
    [
        ("meeting notes", ["meeting", "notes"], "'meetingnotes'"),
        ("standup notes", ["standup", "notes"], "'standupnotes'"),
        # Separate subjects are a union; no single title needs both words.
        ("contracts and invoices", ["contracts", "invoices"], None),
    ],
)
def test_compound_titles_reach_the_live_query_within_its_budget(request_text, terms, compound):
    from hushh_mcp.services.google_drive_rest_transport import rest_query

    queries, _ = compile_request_queries(
        {"mode": "find", "terms": terms, "file_kind": "document", "time_intent": "file_activity"},
        {"purpose": request_text, **STREAM_PERIOD},
        "UTC",
        requested_at=datetime(2026, 10, 3, tzinfo=UTC),
    )
    q = rest_query(queries[0]["arguments"]["query"])
    assert len(q) <= 1800 + len("() and trashed = false")
    title = "".join(term.title() for term in terms) + ".pdf"
    compact = {
        "name": title,
        "content": "sprint review",
        "mimeType": PDF,
        "trashed": False,
        "parents": [],
    }
    spaced = {**compact, "name": " ".join(terms) + ".pdf"}
    assert drive_query(q)(compact) and drive_query(q)(spaced)
    if compound is None:
        assert " or name contains 'contractsinvoices'" not in q
        return
    # The body never repeats the second word, so without the compound clause
    # Drive would not return this title at all.
    clause = f" or name contains {compound}"
    assert clause in q
    assert not drive_query(q.replace(clause, ""))(compact)


def test_compound_clause_never_costs_a_near_budget_query_its_search(monkeypatch):
    real = rest.compile_search_terms
    padding = {"length": 0}

    def padded(terms, **kwargs):
        # Longer compiled subjects push the query toward Drive's 1800-character budget.
        return real(terms, **kwargs)[:-1] + " or name contains '" + "z" * padding["length"] + "')"

    monkeypatch.setattr(rest, "compile_search_terms", padded)

    def primary_query():
        queries, _ = compile_request_queries(
            {"mode": "find", "terms": ["meeting", "notes"], "file_kind": "document"},
            {"purpose": "meeting notes", **STREAM_PERIOD},
            "UTC",
            requested_at=datetime(2026, 10, 3, tzinfo=UTC),
        )
        return queries[0]["arguments"]["query"]

    clause = " or name contains 'meetingnotes'"
    with_compound = None
    for length in range(0, 1000, 4):
        padding["length"] = length
        query = primary_query()
        if clause in query:
            with_compound = query
            continue
        # The first length the clause no longer fits: the request still searches,
        # within budget, exactly as it would without the optional clause.
        assert with_compound is not None
        assert len(query) <= 1800 < len(query) + len(clause) + len("()")
        break
    else:
        pytest.fail("the compound clause never reached the query budget")
    # A query too long even without the optional clause is still refused.
    padding["length"] = 2000
    with pytest.raises(DriveReadError, match="invalid_argument"):
        primary_query()


@pytest.mark.asyncio
async def test_v1_lane_scans_thousand_row_pages_and_shares_nothing_mid_search(monkeypatch):
    run = await stream_request(monkeypatch, v1=True)
    store, slices, drive = run["store"], run["slices"], run["drive"]
    assert run["elapsed"] < 60
    # Large owner-search pages, at most four per slice, resumed slice by slice.
    # A page with more than eight shortcuts is reread at 100 rows and the job
    # keeps that size, so shortcut reads stay bounded.
    assert set(drive.page_sizes) <= {25, 100, 1000} and 1000 in drive.page_sizes
    assert all(item["commits"] <= 4 for item in slices)
    # V1 never starts a batch from the search itself.
    assert run["approved"] == [] and run["batches"].batches == []
    # Every meeting-like document is a content candidate (no metadata date
    # cut), so a large Drive reaches the 10,000-candidate ceiling. That ends
    # as limited and incomplete, never as completed or "no match".
    assert store.row["matched"] == MAX_RESULTS
    assert store.row["status"] == "limited" and store.row["incomplete"]
    assert store.row["error"] == "search_limit"
