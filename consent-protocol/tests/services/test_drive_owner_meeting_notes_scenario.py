"""A "3 month meeting notes" request over a realistic Drive, end to end.

B asked A for "3 month meeting notes" and picked 2 Sep - 2 Oct 2026. It is an
ordinary (non-Trusted) request and A taps Allow at $0.50. The 69 files below
are a realistic Drive for that phrase: A's own Gemini notes, a colleague's
recurring sync notes shared with A, other owners' files, recordings, and
documents that only mention meetings. Every title is a synthetic stand-in that
keeps what the pipeline reads: the meeting and notes words, the
" - Notes by Gemini" ending, title dates in their written formats, created and
modified times, the owner, Drive's canShare answer, the file kind, and the side
of the period each date falls on. No rule reads a name. The file bodies are
synthetic and every document says "meeting notes", so Drive's full-text search
returns all of them: only the pipeline's own rules decide what is shared (title
evidence, the picked dates by title date, else created, else modified time, the
file kind, and Drive's canShare answer for A).

Real stages, driven by the Drive worker: request planning (the deterministic
brain; a Gemini planner raises if asked), the compiled Drive queries,
GoogleDriveRestTransport and GoogleDriveAdapter against an httpx fake of Drive
v3, the owner name index, the candidate checks, the autoshare classification,
frozen 25-file batches and their approval after payment. The request, search,
results, batches and payment order live in disposable PostgreSQL. Faked: Google
(httpx), Firebase (B's identity) and the Stripe charge itself (the order is
marked paid, as a settled webhook would).
"""

# ruff: noqa: F401, F811 -- isolated PostgreSQL fixtures imported from their owners

import json
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import text

from hushh_mcp.services import drive_owner_metadata_index as gear1
from hushh_mcp.services import drive_request_bulk_service as bulk_module
from hushh_mcp.services import google_drive_rest_transport as rest
from hushh_mcp.services.drive_owner_index_port import MetadataOwnerIndex
from hushh_mcp.services.drive_owner_search_service import DriveOwnerSearchService
from hushh_mcp.services.drive_owner_search_store import DriveOwnerSearchStore
from hushh_mcp.services.drive_owner_search_worker import DriveOwnerSearchWorker
from hushh_mcp.services.drive_request_payment_service import DriveRequestPaymentService
from hushh_mcp.services.drive_sharing_contract import (
    DriveSharingError,
    ShareRequestPurpose,
    VerifiedGoogleRecipient,
)
from hushh_mcp.services.drive_trusted_auto_service import DriveTrustedAutoService
from hushh_mcp.services.google_drive_adapter import (
    LIVE_POLICY_HASH,
    GoogleDriveAdapter,
    query_has_full_text_term,
)
from tests.services.test_drive_request_bulk_postgres import request_bulk
from tests.services.test_drive_search_performance_proof import drive_query
from tests.services.test_drive_sharing_store import (
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    sharing,
)

PHRASE = "3 month meeting notes"
PERIOD = {"periodStart": "2026-09-02", "periodEnd": "2026-10-02"}
RECIPIENT = ("recipient", "1234567", "b@example.invalid")
MIME = {
    "gdoc": "application/vnd.google-apps.document",
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "mp4": "video/mp4",
}
# A's Drive for the phrase: My Drive ("me"), then Shared with me (the
# colleague, then other owners). Titles are synthetic. Times are UTC; an empty
# modified time means the file was last saved when it was created. A Gemini
# note is created when its meeting ends, 30 minutes after the start in its
# title. A title cut off with "..." keeps that ending.
DRIVE_FILES = """
a-0902              | me        | gdoc | 2026-09-02T18:49 | 2026-09-02T18:51 | Meeting started 2026/09/02 23:49 IST - Notes by Gemini
a-0603              | me        | gdoc | 2026-06-03T13:31 |                  | Meeting started 2026/06/03 18:31 IST - Notes by Gemini
a-0903-late         | me        | gdoc | 2026-09-02T20:27 | 2026-09-02T20:29 | Meeting started 2026/09/03 01:27 IST - Notes by Gemini
a-0630              | me        | gdoc | 2026-06-30T17:13 |                  | Meeting started 2026/06/30 22:13 IST - Notes by Gemini
a-0728              | me        | gdoc | 2026-07-28T18:13 | 2026-09-29T07:19 | Meeting started 2026/07/28 23:13 IST - Notes by Gemini
a-0622              | me        | gdoc | 2026-06-22T14:13 | 2026-09-29T07:17 | Meeting started 2026/06/22 19:13 IST - Notes by Gemini
a-0903-early        | me        | gdoc | 2026-09-02T19:27 | 2026-09-02T19:29 | Meeting started 2026/09/03 00:27 IST - Notes by Gemini
a-2025-0703         | me        | gdoc | 2025-07-03T18:49 | 2026-09-29T07:15 | Meeting started 2025/07/03 23:49 GMT+05:30 - Notes by Gemini
a-0512              | me        | gdoc | 2026-05-11T20:13 |                  | Meeting started 2026/05/12 01:13 IST - Notes by Gemini
a-0407              | me        | gdoc | 2026-04-07T12:00 |                  | Meeting started 2026/04/07 17:00 IST - Notes by Gemini
a-untitled          | me        | gdoc | 2025-10-30T09:00 |                  | Untitled document
a-2025-0720         | me        | gdoc | 2025-07-19T21:44 |                  | Meeting started 2025/07/20 02:44 GMT+05:30 - Notes by Gemini
a-review-1          | me        | gdoc | 2026-09-30T10:00 | 2026-10-07T11:00 | Draft Review - Item A (Second Pass) | Shared Workspace Pl...
a-review-2          | me        | gdoc | 2026-10-01T09:00 | 2026-10-06T10:00 | Draft Review - Item B ...
a-review-3          | me        | gdoc | 2026-10-05T09:00 | 2026-10-05T10:00 | Draft Review - Item B ...
a-vendor-0602       | me        | gdoc | 2026-06-01T19:02 | 2026-09-29T07:05 | Project X Vendor P - 2026/06/02 00:02 IST - Notes by Gemini
a-guest-recording   | me        | mp4  | 2025-11-05T12:00 |                  | guest X studio - 2025/11/05 - Recording
a-intro-call        | me        | gdoc | 2026-10-12T22:59 | 2026-10-13T05:00 | Vendor Q Intro Call - 2026/10/13 03:59 IST - Notes by Gemini
a-huddle            | me        | gdoc | 2026-02-11T18:46 |                  | huddle crew - 2026/02/11 23:46 GMT+05:30 - Notes by Gemini
a-design-review     | me        | gdoc | 2026-02-09T17:49 |                  | Design Review - 2026/02/09 22:49 GMT+05:30 - Notes by Gemini
a-standup-copy      | me        | gdoc | (parametrized)   | 2026-09-29T07:00 | Copy of Stand Up Notes and Project Status
a-vendor-0427       | me        | gdoc | 2026-04-27T16:16 |                  | Vendor R X Project - 2026/04/27 21:16 IST - Notes by Gemini
a-newsletter        | me        | gdoc | 2026-06-03T09:00 |                  | Newsletter Text - Project Q - Overview
a-recording-0710    | me        | mp4  | 2024-07-10T13:33 |                  | aaa-bbbb-ccc (2024-07-10)
a-recording-1010    | me        | mp4  | 2025-10-10T10:00 |                  | ddd-eeee-fff (2025-10-10)
a-scanned-form      | me        | pdf  | 2026-09-25T04:00 |                  | ScannedForm.pdf
c-vendor-welcome    | colleague | gdoc | 2026-09-21T22:48 | 2026-09-21T22:50 | Vendor Q Welcome with Colleague - 2026/09/21 15:18 PDT - Notes by Gemini
c-sync-0828         | colleague | gdoc | 2026-08-28T17:00 | 2026-08-28T17:02 | Project Sync and Standup - 2026/08/28 09:30 PDT - Notes by Gemini
c-sync-0615         | colleague | gdoc | 2026-06-15T17:00 | 2026-06-15T17:02 | Project Sync and Standup - 2026/06/15 09:30 PDT - Notes by Gemini
c-sync-1009         | colleague | gdoc | 2026-10-09T17:00 | 2026-10-09T17:02 | Project Sync and Standup - 2026/10/09 09:30 PDT - Notes by Gemini
c-sync-0429         | colleague | gdoc | 2026-04-29T17:00 | 2026-04-29T17:02 | Project Sync and Standup - 2026/04/29 09:30 PDT - Notes by Gemini
c-sync-0806         | colleague | gdoc | 2026-08-06T17:00 | 2026-08-06T17:02 | Project Sync and Standup - 2026/08/06 09:30 PDT - Notes by Gemini
c-sync-0915         | colleague | gdoc | 2026-09-15T17:00 | 2026-09-15T17:02 | Project Sync and Standup - 2026/09/15 09:30 PDT - Notes by Gemini
c-sync-0427         | colleague | gdoc | 2026-04-27T17:00 | 2026-04-27T17:02 | Project Sync and Standup - 2026/04/27 09:30 PDT - Notes by Gemini
c-sync-0428         | colleague | gdoc | 2026-04-28T17:00 | 2026-04-28T17:02 | Project Sync and Standup - 2026/04/28 09:30 PDT - Notes by Gemini
c-sync-0513         | colleague | gdoc | 2026-05-13T17:00 | 2026-05-13T17:02 | Project Sync and Standup - 2026/05/13 09:30 PDT - Notes by Gemini
c-sync-0928         | colleague | gdoc | 2026-09-28T17:00 | 2026-09-28T17:02 | Project Sync and Standup - 2026/09/28 09:30 PDT - Notes by Gemini
c-sync-0811         | colleague | gdoc | 2026-08-11T17:00 | 2026-08-11T17:02 | Project Sync and Standup - 2026/08/11 09:30 PDT - Notes by Gemini
c-sync-0911         | colleague | gdoc | 2026-09-11T17:00 | 2026-09-11T17:02 | Project Sync and Standup - 2026/09/11 09:30 PDT - Notes by Gemini
c-sync-0324         | colleague | gdoc | 2026-03-24T17:00 | 2026-03-24T17:02 | Project Sync and Standup - 2026/03/24 09:30 PDT - Notes by Gemini
c-sync-0903         | colleague | gdoc | 2026-09-03T17:00 | 2026-09-03T17:02 | Project Sync and Standup - 2026/09/03 09:30 PDT - Notes by Gemini
c-sync-0707         | colleague | gdoc | 2026-07-07T17:00 | 2026-07-07T17:02 | Project Sync and Standup - 2026/07/07 09:30 PDT - Notes by Gemini
c-sync-1012         | colleague | gdoc | 2026-10-12T17:00 | 2026-10-12T17:02 | Project Sync and Standup - 2026/10/12 09:30 PDT - Notes by Gemini
c-sync-0318         | colleague | gdoc | 2026-03-18T17:00 | 2026-03-18T17:02 | Project Sync and Standup - 2026/03/18 09:30 PDT - Notes by Gemini
c-sync-0309         | colleague | gdoc | 2026-03-09T17:00 | 2026-03-09T17:02 | Project Sync and Standup - 2026/03/09 09:30 PDT - Notes by Gemini
c-sync-0602         | colleague | gdoc | 2026-06-02T17:00 | 2026-06-02T17:02 | Project Sync and Standup - 2026/06/02 09:30 PDT - Notes by Gemini
c-sync-0715         | colleague | gdoc | 2026-07-15T17:00 | 2026-07-15T17:02 | Project Sync and Standup - 2026/07/15 09:30 PDT - Notes by Gemini
c-sync-0424         | colleague | gdoc | 2026-04-24T17:00 | 2026-04-24T17:02 | Project Sync and Standup - 2026/04/24 09:30 PDT - Notes by Gemini
c-early-sync        | colleague | gdoc | 2025-06-25T16:00 |                  | Early Sync and Standup - 2025/06/25
c-vendor-0526       | colleague | gdoc | 2026-05-26T18:00 |                  | Vendor S and Project - 2026/05/26 - Notes by Gemini
c-study-sync        | colleague | gdoc | 2025-11-13T10:00 |                  | Study Group X Project Sync - 2025/11/13
c-transfer          | colleague | gdoc | 2025-06-18T17:00 |                  | Transfer meeting 1 with Vendor T - Colleague - 2025/06/18
c-shared-space-1216 | colleague | gdoc | 2025-12-16T16:00 |                  | project shared space - 2025/12/16
c-shared-space-0704 | colleague | gdoc | 2025-07-04T16:00 |                  | project shared space - 2025/07/04
c-timeline          | colleague | gdoc | 2026-09-10T15:00 |                  | project Timeline and Layout
c-requirements      | colleague | gdoc | 2026-09-18T15:00 |                  | Requirements Draft — Sample Helper Concept
c-quarterly-letter  | colleague | gdoc | 2026-09-24T15:00 |                  | Quarterly Letter - Example Org
c-intake-form       | colleague | pdf  | 2026-09-12T15:00 |                  | Sample_Intake_Form_Clean.pdf
c-brochure          | colleague | pdf  | 2026-09-08T15:00 |                  | Example Brochure.pdf
c-filing-outline    | colleague | docx | 2026-09-16T15:00 |                  | Project Q Filing Outline.docx
c-quick-question    | colleague | gdoc | 2026-09-20T15:00 |                  | Quick question, any thoughts? Who owns the li...
c-pricing-table     | colleague | gdoc | 2026-09-22T15:00 |                  | Pricing table for Project Q...
c-terms-wording     | colleague | docx | 2026-09-26T15:00 |                  | Project_Q_Terms_Wording.docx
c-reference-pack    | colleague | pdf  | 2026-09-30T15:00 |                  | Project_Q_Reference_Pack_Draft_v2.pdf
o-invoice-a         | other     | pdf  | 2026-02-02T10:00 |                  | Vendor K Invoice Batch A.pdf
o-invoice-b         | other     | pdf  | 2026-05-02T10:00 |                  | Vendor K Invoice Batch B.pdf
o-panel-review      | other     | gdoc | 2026-01-29T12:00 |                  | Project X Panel Review - 2026/01/29 - Notes by Gemini
o-sector-outlook    | other     | pdf  | 2026-09-19T10:00 |                  | Sector Outlook Sample.pdf
o-concept-brief     | other     | docx | 2026-09-27T10:00 |                  | Helper Concept Brief ... .docx
"""

# In the picked dates by title date, and named a meeting note.
A_IN_PERIOD_NOTES = {"a-0902", "a-0903-early", "a-0903-late"}
COLLEAGUE_IN_PERIOD_NOTES = {
    "c-vendor-welcome",
    "c-sync-0903",
    "c-sync-0911",
    "c-sync-0915",
    "c-sync-0928",
}
# Drive returns these and their date is inside the period, but no title word
# names a meeting note: the owner's possible matches, never an automatic grant.
IN_PERIOD_WITHOUT_TITLE_EVIDENCE = {
    "a-review-1",
    "a-review-2",
    "a-scanned-form",
    "c-timeline",
    "c-requirements",
    "c-quarterly-letter",
    "c-intake-form",
    "c-brochure",
    "c-filing-outline",
    "c-quick-question",
    "c-pricing-table",
    "c-terms-wording",
    "c-reference-pack",
    "o-sector-outlook",
    "o-concept-brief",
}
RECORDINGS = {"a-guest-recording", "a-recording-0710", "a-recording-1010"}
OUT_OF_PERIOD_NOTES = {
    # Edited on 29 Sep: the title date decides, not the edit.
    *("a-0728", "a-0622", "a-2025-0703", "a-vendor-0602"),
    *("a-intro-call", "a-0603", "a-0630", "a-0512", "a-0407", "a-2025-0720"),
    *("a-huddle", "a-design-review", "a-vendor-0427", "c-sync-0828", "c-sync-1009", "c-sync-1012"),
    *("c-vendor-0526", "o-panel-review"),
}


def owner_files(*, colleague_can_share, standup_copy_created):
    """A's Drive as files.list sees it: My Drive plus Shared with me."""
    files = {}
    for line in DRIVE_FILES.strip().splitlines():
        file_id, owner, kind, created, modified, title = (
            part.strip() for part in line.split("|", 5)
        )
        if file_id == "a-standup-copy":
            created = standup_copy_created
        files[file_id] = {
            "id": file_id,
            "name": title,
            "mimeType": MIME[kind],
            "createdTime": f"{created}:00.000Z",
            "modifiedTime": f"{modified or created}:00.000Z",
            # Drive's own answer for A: an owner can always share, a viewer
            # never can, and an editor can when the owner lets editors share.
            "canShare": owner == "me" or owner == "colleague" and colleague_can_share,
            "content": "" if kind == "mp4" else "Meeting notes, attendees and action items.",
            "parents": [],
            "trashed": False,
        }
    return files


class OwnerDrive:
    """Drive v3 files.list, drives.list and changes over A's files.

    files.list filters with the Drive q emulator. Drive's relevance order for
    a fullText query is unspecified: such pages keep the table order, and an
    orderBy with fullText is refused as Drive refuses it (HTTP 400).
    """

    def __init__(self, files):
        self.files = files
        self.searched = set()
        self.pages = 0
        self.rows = 0

    @staticmethod
    def _json(status, payload):
        return httpx.Response(status, stream=httpx.ByteStream(json.dumps(payload).encode()))

    def __call__(self, request):
        assert request.url.host == "www.googleapis.com"
        path = request.url.path.removeprefix("/drive/v3")
        params = dict(request.url.params)
        if path == "/drives":
            return self._json(200, {"drives": []})
        if path == "/changes/startPageToken":
            return self._json(200, {"startPageToken": "1"})
        if path == "/changes":
            return self._json(200, {"changes": [], "newStartPageToken": params["pageToken"]})
        assert path == "/files", path
        q = params["q"]
        assert params["corpora"] == "user" and "trashed = false" in q
        assert not (query_has_full_text_term(q) and "orderBy" in params), q
        predicate = drive_query(q)
        rows = [item for item in self.files.values() if predicate(item)]
        if "orderBy" in params:
            field, direction = params["orderBy"].split()
            assert direction == "desc"
            rows.sort(key=lambda item: (item[field], item["id"]), reverse=True)
        offset = int(params.get("pageToken", "0"))
        chunk = rows[offset : offset + int(params["pageSize"])]
        if "name contains" in q:
            # The request's own searches; the name index's listing has no subject.
            self.pages += 1
            self.rows += len(chunk)
            self.searched.update(item["id"] for item in chunk)
        payload = {
            "files": [
                {
                    **{
                        key: item[key]
                        for key in ("id", "name", "mimeType", "createdTime", "modifiedTime")
                    },
                    "webViewLink": f"https://drive.google.com/file/d/{item['id']}/view",
                    "capabilities": {"canShare": item["canShare"]},
                }
                for item in chunk
            ],
            "incompleteSearch": False,
        }
        if offset + len(chunk) < len(rows):
            payload["nextPageToken"] = str(offset + len(chunk))
        return self._json(200, payload)


def _rest_transport(monkeypatch, drive_fake):
    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: real_client(**kwargs, transport=httpx.MockTransport(drive_fake)),
    )
    connection = {
        "status": "connected",
        "validation_state": "verified",
        "verified_policy_hash": LIVE_POLICY_HASH,
        "connection_generation": 1,
    }
    return rest.GoogleDriveRestTransport(
        oauth=SimpleNamespace(
            current_credential=AsyncMock(return_value=(connection, {"accessToken": "synthetic"})),
            lifecycle=SimpleNamespace(read=AsyncMock(return_value=connection)),
        ),
        adapter=GoogleDriveAdapter(),
    )


def _sql(db, statement, params):
    with db.engine.begin() as connection:
        return [dict(row) for row in connection.execute(text(statement), params).mappings()]


async def run_owner_request(monkeypatch, sharing, bulk, files):
    """B asks, A allows, the Drive worker runs the request, and B pays."""
    drive_fake = OwnerDrive(files)
    transport = _rest_transport(monkeypatch, drive_fake)
    # The Drive worker deployment wires the owner name index (Gear 1).
    index = MetadataOwnerIndex(
        indexer=gear1.OwnerMetadataIndexer(transport=transport),
        generation=AsyncMock(return_value=1),
    )
    store = DriveOwnerSearchStore(db=sharing.db)
    scanner = DriveOwnerSearchService(store=store, transport=transport, owner_index=index)
    planner_calls = []

    async def unavailable_planner(*args, **kwargs):
        planner_calls.append("gemini")
        raise RuntimeError("403 CONSUMER_SUSPENDED")

    async def verified_recipient(user_id):
        return VerifiedGoogleRecipient(user_id, *RECIPIENT[1:], datetime.now(UTC))

    monkeypatch.setattr(bulk_module, "plan_live_search", unavailable_planner)
    monkeypatch.setattr(bulk_module, "DriveOwnerSearchService", lambda: scanner)
    monkeypatch.setattr(bulk_module, "default_owner_index", lambda: index)
    monkeypatch.setattr(bulk_module, "recipient_identity_for_user", verified_recipient)

    created = await sharing.create_request(
        recipient=VerifiedGoogleRecipient(*RECIPIENT, datetime.now(UTC)),
        owner_user_id="owner",
        client_request_id=str(uuid4()),
        expected_quote_version=1,
        request_time_zone="Asia/Kolkata",
        purpose=ShareRequestPurpose(purpose=PHRASE, **PERIOD),
    )
    request_id = created["requestId"]
    review = await sharing.owner_review(user_id="owner", request_id=request_id)
    assert review["trustedAuto"] is False  # ordinary: nothing runs before Allow
    await sharing.allow_request(
        user_id="owner", request_id=request_id, revision=created["revision"], amount_cents=50
    )
    payment = DriveRequestPaymentService(db=sharing.db)
    auto = DriveTrustedAutoService(sharing=sharing, bulk=bulk, payment=payment, wake=AsyncMock())
    worker = DriveOwnerSearchWorker(scanner, trusted_auto=auto)
    for _ in range(30):
        outcome = await worker.run(max_jobs=1, deadline_seconds=200)
        assert not outcome["outcomes"].get("unavailable"), outcome
        search = await store.by_client(user_id="owner", client_request_id=request_id)
        if search is not None and search["status"] not in {"queued", "running"}:
            break
    # The worker's batch drain after the search: a frozen batch waits for payment.
    await worker.run(max_jobs=1, deadline_seconds=200)
    search = await store.by_client(user_id="owner", client_request_id=request_id)
    job_id = search["jobId"]
    [job] = _sql(
        sharing.db,
        "SELECT checkpoint_envelope FROM drive_owner_search_jobs WHERE job_id=:job",
        {"job": job_id},
    )
    checkpoint = store.search_cipher.open(
        job["checkpoint_envelope"],
        user_id="owner",
        resource_id=job_id,
        purpose="owner-search-checkpoint",
    )
    committed = {
        row["position"]: store.search_cipher.open(
            row["metadata_envelope"],
            user_id="owner",
            resource_id=f"{job_id}:{row['position']}",
            purpose="owner-search-result",
        )
        for row in _sql(
            sharing.db,
            """SELECT position,metadata_envelope FROM drive_owner_search_results
               WHERE job_id=:job ORDER BY position""",
            {"job": job_id},
        )
    }

    def batches():
        grouped = {}
        for row in _sql(
            sharing.db,
            """SELECT b.share_id,b.approved_at IS NOT NULL AS approved,f.source_position
               FROM drive_bulk_share_files f JOIN drive_bulk_shares b ON b.share_id=f.share_id
               WHERE f.user_id='owner' AND f.origin_request_id=:request
               ORDER BY b.created_at,b.share_id,f.source_position""",
            {"request": request_id},
        ):
            grouped.setdefault((row["share_id"], row["approved"]), []).append(
                committed[row["source_position"]]["id"]
            )
        return [{"approved": approved, "files": ids} for (_, approved), ids in grouped.items()]

    before_payment = batches()
    # The gate the checkout worker passes before B sees a Pay button.
    try:
        held = await bulk.legacy_checkout_sources(user_id="owner", request_id=request_id)
        checkout_gate = sorted(item["id"] for item in held)
    except DriveSharingError as error:
        checkout_gate = str(error)
    # B pays: the settled order is the authority every later batch approves under.
    _sql(
        sharing.db,
        """UPDATE drive_request_payment_orders SET status='paid',paid_at=clock_timestamp()
           WHERE request_id=:request RETURNING request_id""",
        {"request": request_id},
    )
    for _ in range(10):
        if not await auto.share_available(user_id="owner", request_id=request_id):
            break
    after_payment = batches()
    run = {
        "status": search["status"],
        "incompleteSearch": search["incompleteSearch"],
        "matched": search["matched"],
        "unshareableCount": search["unshareableCount"],
        "coverage": search["coverage"],
        "planSource": checkpoint.get("request_plan_source"),
        "plannerFallback": checkpoint.get("planner_fallback"),
        "plannerCalls": planner_calls,
        "foundByDrive": sorted(drive_fake.searched),
        "drivePages": drive_fake.pages,
        "driveRows": drive_fake.rows,
        "committed": sorted(item["id"] for item in committed.values()),
        "unshareable": {
            item["id"]: item.get("unavailableReason")
            for item in committed.values()
            if item.get("shareable") is not True
        },
        "batchesBeforePayment": before_payment,
        "checkoutGate": checkout_gate,
        "batchesAfterPayment": after_payment,
        "preparationError": (
            await sharing.owner_review(user_id="owner", request_id=request_id)
        ).get("preparationError"),
    }
    # Synthetic file IDs and counts only: this run's audit trail under pytest -s.
    print(json.dumps(run, sort_keys=True, default=str))
    return run


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "colleague_can_share,standup_copy_created,standup_copy_in_period",
    [
        # A is a viewer on the colleague's notes; the stand-up copy was made long ago.
        (False, "2026-01-15T06:00", False),
        # A is an editor the colleague lets reshare; the copy was made on 29 Sep.
        (True, "2026-09-29T06:30", True),
    ],
    ids=["colleague_viewer", "colleague_editor_reshare"],
)
async def test_meeting_notes_request_shares_exactly_the_in_period_notes_a_may_share(
    request_bulk,
    sharing,
    monkeypatch,
    colleague_can_share,
    standup_copy_created,
    standup_copy_in_period,
):
    files = owner_files(
        colleague_can_share=colleague_can_share, standup_copy_created=standup_copy_created
    )
    run = await run_owner_request(monkeypatch, sharing, request_bulk, files)

    # Planned without a model; the picked dates bound the search, and the
    # longer span in the phrase is surfaced, never used.
    assert run["plannerCalls"] == []
    assert run["planSource"] == "deterministic_brain"
    assert run["status"] == "completed" and run["incompleteSearch"] is False
    assert run["coverage"]["requestedPeriod"] == {
        "start": "2026-09-02",
        "end": "2026-10-02",
        "timezone": "Asia/Kolkata",
    }
    assert run["coverage"]["periodConflict"] == "request_mentions_longer_span"
    assert run["coverage"]["dateBasis"] == "title_date_then_created_then_modified"
    assert run["coverage"]["ownerReviewRequired"] is False

    # Drive's own search reached every document, so the pipeline's rules alone
    # kept each possible match out.
    possible_matches = IN_PERIOD_WITHOUT_TITLE_EVIDENCE | (
        {"a-standup-copy"} if standup_copy_in_period else set()
    )
    documents = {file_id for file_id, item in files.items() if file_id not in RECORDINGS}
    assert set(run["foundByDrive"]) == documents >= possible_matches

    # Candidates: the in-period meeting notes, whoever owns them. A viewer's
    # copy is a candidate Drive will not let A share.
    in_period_notes = A_IN_PERIOD_NOTES | COLLEAGUE_IN_PERIOD_NOTES
    assert set(run["committed"]) == in_period_notes
    assert run["unshareable"] == (
        {}
        if colleague_can_share
        else dict.fromkeys(COLLEAGUE_IN_PERIOD_NOTES, "source_not_shareable")
    )
    assert run["unshareableCount"] == len(run["unshareable"])

    # Batches: before payment frozen files only wait; after it every shareable
    # candidate is in exactly one approved batch, and nothing else ever is.
    expected_shared = in_period_notes if colleague_can_share else A_IN_PERIOD_NOTES
    held = [file_id for batch in run["batchesBeforePayment"] for file_id in batch["files"]]
    assert set(held) <= expected_shared
    assert not any(batch["approved"] for batch in run["batchesBeforePayment"])
    shared = [file_id for batch in run["batchesAfterPayment"] for file_id in batch["files"]]
    assert set(shared) == expected_shared and len(shared) == len(set(shared))
    assert all(batch["approved"] for batch in run["batchesAfterPayment"])
    assert run["preparationError"] is None

    never_shared = set(files) - expected_shared
    assert possible_matches | RECORDINGS | OUT_OF_PERIOD_NOTES <= never_shared
    assert {"a-standup-copy", "a-review-3", "a-untitled", "c-transfer"} <= never_shared
