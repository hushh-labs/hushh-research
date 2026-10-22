"""Drive four-group organizing aid: dark by default, precision first, private by construction.

The shelf logic runs against a tiny hand-made bundle so no result depends on the
learned data; one test reads the packaged data to guard the failure that actually
happened (words that fooled hand-weighted rules). Nothing here touches Google or a
model: ports are fakes and every document is invented.
"""

from __future__ import annotations

import csv
import io
import json
import logging
import math
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from zoneinfo import ZoneInfo

import pytest

from hushh_mcp.services.drive_groups import (
    CLASSES,
    GROUP_IDS,
    FileEvidence,
    GroupIndexDisabled,
    ModelBundle,
    capture_head,
    index_files,
    load_bundle,
    models,
    place,
)
from hushh_mcp.services.drive_groups.adapters import IsolatedHeadEmbedder, TransportHeadSource
from hushh_mcp.services.drive_groups.contract import EMBEDDING_DIMENSIONS, FLAG
from hushh_mcp.services.drive_groups.embedding_model import EmbeddingModel
from hushh_mcp.services.drive_groups.export import COLUMNS, csv_text, placement_rows
from hushh_mcp.services.drive_groups.features import metadata_features, text_features
from hushh_mcp.services.drive_groups.folders import FolderNames, load_folders, summarize_folders
from hushh_mcp.services.drive_groups.fusion import FusionPolicy
from hushh_mcp.services.drive_groups.indexer import IndexedFile
from hushh_mcp.services.drive_groups.linear_model import LinearModel
from hushh_mcp.services.drive_groups.models import DATA_FILES, version_of
from hushh_mcp.services.drive_groups.period import deciding_day, fiscal_quarter, title_day
from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from hushh_mcp.services.google_drive_adapter import DriveReadError

PDF = "application/pdf"
KEYWORDS = {"statement": 0, "utility": 1, "policy": 2, "passport": 3, "homework": 4}


def basis(index: int) -> tuple[float, ...]:
    return tuple(1.0 if position == index else 0.0 for position in range(EMBEDDING_DIMENSIONS))


def linear(features: dict[str, int]) -> dict:
    return {
        "kind": "linear_v1",
        "classes": list(CLASSES),
        "intercept": [0.0] * len(CLASSES),
        "features": {
            f"w:{word}": [1.0, *[4.0 if column == klass else 0.0 for column in range(5)]]
            for word, klass in features.items()
        },
    }


def tiny_bundle(min_confidence=0.9, min_margin=0.2, min_agreement=2) -> ModelBundle:
    """Words, name words and unit vectors each point at one class."""
    embedding = {
        "kind": "embedding_v1",
        "classes": list(CLASSES),
        "centroids": [list(basis(i)) for i in range(5)],
        "definitions": [list(basis(i)) for i in range(4)],
        "mean": [0.0] * 9,
        "scale": [1.0] * 9,
        "weights": [[6.0 if column == row else 0.0 for column in range(9)] for row in range(5)],
        "intercept": [0.0] * 5,
    }
    payloads = {
        "groups.json": {
            "kind": "groups_v1",
            "head_chars": 400,
            "groups": {group: f"definition of {group}" for group in GROUP_IDS},
        },
        "text_model.json": linear(KEYWORDS),
        "metadata_model.json": linear(KEYWORDS),
        "embedding_model.json": embedding,
        "fusion.json": {
            "weights": {"text": 1.0, "embedding": 1.0, "metadata": 1.0},
            "calibration": {"slope": 1.0, "intercept": 0.0},
            "min_confidence": min_confidence,
            "min_margin": min_margin,
            "min_agreement": min_agreement,
        },
    }
    return ModelBundle.from_payloads(payloads, "tiny")


class Heads:
    """A head source that answers from a table and records what it was asked."""

    def __init__(self, table: dict[str, str | None]):
        self.table, self.asked = table, []

    async def head(self, row):
        self.asked.append(row["id"])
        return self.table.get(row["id"])


class Vectors:
    def __init__(self, table: dict[str, tuple[float, ...]]):
        self.table = table

    async def embed(self, heads):
        return [self.table.get(head) for head in heads]


@pytest.fixture
def on(monkeypatch):
    monkeypatch.setenv(FLAG, "true")


def row(identity: str, name: str, mime: str = PDF, **extra) -> dict:
    return {"id": identity, "title": name, "mimeType": mime, **extra}


async def test_the_aid_is_dark_unless_its_flag_is_on(monkeypatch):
    monkeypatch.delenv(FLAG, raising=False)
    heads = Heads({})
    with pytest.raises(GroupIndexDisabled):
        await index_files([row("f1", "a.pdf")], heads=heads, embedder=Vectors({}))
    assert heads.asked == []
    monkeypatch.setenv(FLAG, "true")
    run = await index_files(
        [row("f1", "a.pdf")], heads=heads, embedder=Vectors({}), bundle=tiny_bundle()
    )
    assert len(run.files) == 1 and heads.asked == ["f1"]


async def test_a_placed_file_keeps_nothing_and_a_kept_file_keeps_its_head_and_vector(on):
    rows = [row("fin", "Statement Mar.pdf"), row("odd", "Statement Mar.pdf")]
    heads = Heads({"fin": "statement of account", "odd": "homework on utility"})
    vectors = Vectors({"statement of account": basis(0), "homework on utility": basis(2)})
    run = await index_files(rows, heads=heads, embedder=vectors, bundle=tiny_bundle())
    placed, kept = run.files
    assert placed.placement.group == "financial_statements" and placed.placement.reason == "placed"
    assert placed.head is None and placed.vector is None
    # Three signals point at three different classes, so the aid declines to guess.
    assert kept.placement.group is None and kept.placement.shelf == "kept"
    assert kept.placement.reason in {"low_confidence", "low_margin", "disagreement"}
    assert kept.head == "homework on utility" and kept.vector == basis(2)
    # A wrong inclusion is worse than a miss: even the best candidate is only offered.
    assert kept.placement.candidate in GROUP_IDS


async def test_prefix_index_abstains_before_classification_when_content_is_unavailable(on):
    inputs = [row("fin", "statement.pdf")]
    bundle = tiny_bundle(min_confidence=0.5)
    # Negative control: this metadata-only input otherwise produces a group.
    normal = await index_files(inputs, heads=Heads({}), embedder=Vectors({}), bundle=bundle)
    assert normal.files[0].placement.group == "financial_statements"
    prefix = await index_files(
        inputs, heads=Heads({}), embedder=Vectors({}), bundle=bundle, require_head=True
    )
    placement = prefix.files[0].placement
    assert placement.group is None and placement.candidate is None
    assert placement.reason == "no_evidence" and placement.readings == ()
    # A decoded prefix still reaches the existing classifier without substitution.
    decoded = await index_files(
        inputs,
        heads=Heads({"fin": "statement"}),
        embedder=Vectors({}),
        bundle=bundle,
        require_head=True,
    )
    assert decoded.files[0].placement.group == "financial_statements"


async def test_folders_and_shortcuts_are_skipped_and_every_other_file_gets_one_shelf(on):
    rows = [
        row("d", "Folder", "application/vnd.google-apps.folder"),
        row("s", "Link", "application/vnd.google-apps.shortcut"),
        row("a", "a.pdf"),
        {"id": "bad"},
    ]
    run = await index_files(rows, heads=Heads({}), embedder=Vectors({}), bundle=tiny_bundle())
    assert [file.file_id for file in run.files] == ["a"] and run.skipped == 3


async def test_logs_and_reprs_carry_no_name_head_or_id(on, caplog):
    caplog.set_level(logging.DEBUG)
    rows = [
        row("private-file-id", "Private Salary Slip.pdf", owners=[{"emailAddress": "o@x.invalid"}])
    ]
    heads = Heads({"private-file-id": "private statement text of ravi"})
    vectors = Vectors({"private statement text of ravi": basis(0)})
    run = await index_files(
        rows, heads=heads, embedder=vectors, bundle=tiny_bundle(), owner_email="o@x.invalid"
    )
    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert "drive_groups.index files=1" in logged and "version=tiny" in logged
    for private in ("private-file-id", "Salary", "ravi", "o@x.invalid", "statement text"):
        assert private not in logged
    shown = repr(run.files[0])
    assert "ravi" not in shown and "statement text" not in shown and "0.0, 0.0" not in shown


async def test_the_head_source_only_reads_text_through_the_live_text_tool():
    transport = SimpleNamespace(
        read_tool=AsyncMock(
            return_value=SimpleNamespace(
                payload={"fileContent": "  Policy\n\n schedule " + "x" * 900}
            )
        )
    )
    source = TransportHeadSource(transport, "owner-1", limit=300)
    head = await source.head({"id": "f1", "mimeType": PDF})
    assert head is not None and head.startswith("Policy schedule x") and len(head) <= 300
    transport.read_tool.assert_awaited_once_with(
        user_id="owner-1", tool_name="read_file_content", arguments={"fileId": "f1"}
    )
    # No OCR: an image has no text layer to read, so it costs no Drive call.
    assert await source.head({"id": "f2", "mimeType": "image/png"}) is None
    assert transport.read_tool.await_count == 1


@pytest.mark.parametrize(
    ("failure", "reads_as"),
    [
        (DriveReadError("source_unavailable"), None),
        (DriveReadError("file_too_large"), None),
        (DriveReadError("provider_unavailable", retryable=True), DriveReadError),
        (DriveReadError("processor_unavailable"), DriveReadError),
        (DriveOAuthError("connection_changed", status_code=409), DriveOAuthError),
    ],
)
async def test_one_file_may_lack_text_but_a_systemic_failure_ends_the_run(on, failure, reads_as):
    transport = SimpleNamespace(read_tool=AsyncMock(side_effect=failure))
    source = TransportHeadSource(transport, "owner-1")
    rows = [row("a", "a.pdf"), row("b", "b.pdf"), row("c", "c.pdf")]
    if reads_as is None:
        assert await source.head(rows[0]) is None
        return
    # The error leaves as itself, not as an ExceptionGroup, and no head is guessed.
    with pytest.raises(reads_as):
        await index_files(rows, heads=source, embedder=Vectors({}), bundle=tiny_bundle())


@pytest.mark.parametrize("fail", [False, True])
async def test_parallel_heads_preserve_order_and_cancel_siblings_on_failure(on, fail):
    import asyncio

    started, release = asyncio.Event(), asyncio.Event()
    active = peak = cancelled = 0

    class Source:
        async def head(self, item):
            nonlocal active, peak, cancelled
            active += 1
            peak = max(peak, active)
            if active == 6:
                started.set()
            try:
                await release.wait()
                if fail:
                    if item["id"] == "0":
                        raise DriveReadError("connection_changed")
                    await asyncio.Event().wait()
                return "statement" if int(item["id"]) % 2 else "homework"
            except asyncio.CancelledError:
                cancelled += 1
                raise
            finally:
                active -= 1

    rows = [row(str(index), "statement.pdf") for index in range(12)]
    vectors = Vectors({"statement": basis(0), "homework": basis(4)})
    task = asyncio.create_task(
        index_files(
            rows, heads=Source(), embedder=vectors, bundle=tiny_bundle(), read_concurrency=6
        )
    )
    try:
        await asyncio.wait_for(started.wait(), 2)
        assert peak == active == 6
        release.set()
        if fail:
            with pytest.raises(DriveReadError, match="connection_changed"):
                await asyncio.wait_for(task, 2)
            assert active == 0 and cancelled >= 5
        else:
            parallel = await asyncio.wait_for(task, 2)
            serial = await index_files(
                rows,
                heads=Heads(
                    {
                        item["id"]: "statement" if int(item["id"]) % 2 else "homework"
                        for item in rows
                    }
                ),
                embedder=vectors,
                bundle=tiny_bundle(),
                read_concurrency=1,
            )
            assert parallel == serial and peak == 6 and active == 0
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.parametrize("concurrency", [0, 33, True, 1.5])
async def test_invalid_read_concurrency_never_reads(on, concurrency):
    heads = Heads({})
    with pytest.raises(ValueError, match="invalid read concurrency"):
        await index_files(
            [row("f", "statement.pdf")],
            heads=heads,
            embedder=Vectors({}),
            read_concurrency=concurrency,
        )
    assert heads.asked == []


@pytest.mark.parametrize("oversize", [0, 1, 2])
async def test_group_inventory_uses_large_pages_and_retries_oversize_at_the_same_cursor(oversize):
    from hushh_mcp.services.drive_group_index_job import DriveGroupIndexJob

    def page(identity, **extra):
        return SimpleNamespace(
            is_error=False,
            truncated=False,
            payload={
                "files": [
                    row(identity, "statement.pdf", version="1", modifiedTime="2026-04-01T00:00:00Z")
                ],
                **extra,
            },
        )

    read = AsyncMock(
        side_effect=[
            *[DriveReadError("file_too_large") for _ in range(oversize)],
            page("a", nextPageToken="next"),
            page("b"),
        ]
    )
    files, complete, limited = await DriveGroupIndexJob.list_files(
        SimpleNamespace(read_tool=read), "owner"
    )
    calls = [call.kwargs["arguments"] for call in read.await_args_list]
    sizes = (1000, 100, 25)
    assert [call["pageSize"] for call in calls] == [*sizes[: oversize + 1], sizes[oversize]]
    assert all("pageToken" not in call for call in calls[:-1])
    assert calls[-1]["pageToken"] == "next"
    assert [file["id"] for file in files] == ["a", "b"] and complete and not limited


async def test_group_inventory_does_not_overrun_its_file_budget_inside_a_large_page(monkeypatch):
    from hushh_mcp.services import drive_group_index_job as job

    monkeypatch.setattr(job, "MAX_INDEXED_FILES", 2)
    read = AsyncMock(
        return_value=SimpleNamespace(
            is_error=False,
            truncated=False,
            payload={
                "files": [
                    row(str(index), "a.pdf", version="1", modifiedTime="2026-04-01T00:00:00Z")
                    for index in range(3)
                ]
            },
        )
    )
    files, complete, limited = await job.DriveGroupIndexJob.list_files(
        SimpleNamespace(read_tool=read), "owner"
    )
    assert len(files) == 2 and not complete and limited and read.await_count == 1


async def test_the_embedder_maps_each_head_to_its_own_vector_even_when_one_is_split():
    chunk = lambda page, vector: SimpleNamespace(page=page, embedding=vector)  # noqa: E731
    prepared = SimpleNamespace(
        chunks=(chunk(1, basis(0)), chunk(3, basis(1)), chunk(3, basis(2)), chunk(2, basis(3)))
    )
    child = SimpleNamespace(prepare=AsyncMock(return_value=prepared))
    vectors = await IsolatedHeadEmbedder(child).embed(["one", "two", "three"])
    assert vectors == [basis(0), basis(3), basis(1)]
    (parsed,), _ = child.prepare.await_args
    assert parsed.pages == ("one", "two", "three") and parsed.truncated is False


def test_model_data_rejects_malformed_numbers_and_shapes():
    good = tiny_bundle()
    assert good.version == "tiny"
    base = linear(KEYWORDS)
    bad_linear = [
        {**base, "classes": list(CLASSES[:-1])},
        {**base, "intercept": [math.nan] * 5},
        {**base, "features": {"w:x": [0.0, 1, 1, 1, 1, 1]}},
        {**base, "features": {"w:x": [1.0, 1, 1, 1, 1]}},
        {**base, "features": {}},
    ]
    for payload in bad_linear:
        with pytest.raises(ValueError, match="linear model"):
            LinearModel.from_payload(payload)
    with pytest.raises(ValueError, match="unit length"):
        EmbeddingModel.from_payload(
            {
                "kind": "embedding_v1",
                "classes": list(CLASSES),
                "centroids": [[0.5] * EMBEDDING_DIMENSIONS] * 5,
                "definitions": [list(basis(0))] * 4,
                "mean": [0.0] * 9,
                "scale": [1.0] * 9,
                "weights": [[0.0] * 9] * 5,
                "intercept": [0.0] * 5,
            }
        )
    for fusion in (
        {"weights": {"text": -1, "embedding": 1, "metadata": 1}},
        {"weights": {"text": 1, "embedding": 1, "metadata": 1}, "min_agreement": 4},
        {"weights": {"text": 1, "embedding": 1, "metadata": 1}, "min_confidence": 0},
    ):
        with pytest.raises(ValueError, match="fusion policy"):
            FusionPolicy.from_payload(
                {
                    "calibration": {"slope": 1.0, "intercept": 0.0},
                    "min_confidence": 0.9,
                    "min_margin": 0.1,
                    "min_agreement": 2,
                    **fusion,
                }
            )


def test_data_version_is_the_same_on_every_platform_checkout():
    """A placement records the data version; Windows and Linux checkouts must agree on it."""
    raw = {name: f'{{"kind":"{name}"}}\n'.encode() for name in DATA_FILES}
    crlf = {name: data.replace(b"\n", b"\r\n") for name, data in raw.items()}
    assert version_of(raw) == version_of(crlf) and len(version_of(raw)) == 12
    assert version_of(raw) != version_of({**raw, "fusion.json": b"{}\n"})
    assert load_bundle().version == version_of(
        {name: (Path(models.__file__).parent / "data" / name).read_bytes() for name in DATA_FILES}
    )


def test_text_start_is_clean_bounded_and_absent_when_a_scan_has_no_text():
    messy = "ﬁnancial​  state\x00ment\n\n" + "word " * 200
    head = capture_head([messy, "second page"], 200)
    assert head is not None and head.startswith("financial statement word") and len(head) <= 200
    assert not head.endswith(" ") and "\x00" not in head and "​" not in head
    assert capture_head(["  \n ", "·  ·"]) is None
    with pytest.raises(ValueError, match="out of range"):
        capture_head(["text"], 100)


def test_account_numbers_and_dates_leave_no_digit_in_any_feature_name():
    counts = text_features("Account 123456789012 opened 14 Mar 2026 ref AB12-CD34")
    counts.update(metadata_features("Stmt_2026-03_9876.pdf", PDF, owned_by_me=True))
    assert counts
    assert not any(char in "123456789" for feature in counts for char in feature)
    assert any("0000" in feature for feature in counts)


def test_words_that_fooled_hand_weighted_rules_are_kept_not_placed():
    """The lab's rules sent coursework and essays to a packet; the learned text signal must not.

    The text signal runs alone at full weight, the harshest case for it, on phrasing it
    was not trained on. The genuine documents are the control: a model that places
    nothing, or everything, fails one half of this test.
    """
    bundle = load_bundle()
    alone = replace(bundle, fusion=replace(bundle.fusion, weights=(1.0, 0.0, 0.0), min_agreement=1))
    trap = {
        "Lab 7.pdf": "University of Elm Department of Computer Science Lab 7 CV project report "
        "Enrollment No. 21BCE0420 Aim train a convolutional network for object detection on a "
        "small image set Observations the loss decreased after epoch 4",
        "SOP draft.docx": "Statement of Purpose I want to pursue a research degree because my "
        "internship taught me to ask careful questions about data and to measure the answers",
        "Holidays.pdf": "Circular Bank holidays Branches will remain closed on the following "
        "dates Customers are requested to plan their visits Internet banking stays available",
        "FA notes.pdf": "Financial Accounting Lecture 4 The income statement, the balance sheet "
        "and the cash flow statement Learning objectives define assets liabilities and equity",
        "Soup.txt": "Weeknight lentil soup serves four ingredients red lentils onion carrot "
        "garlic cumin lemon method soften the onion add spices then lentils and stock",
    }
    genuine = {
        "financial_statements": "Fabrikam Savings Statement of Account Account Number XXXXXX4812 "
        "Statement Period 01 Mar 2026 to 31 Mar 2026 Opening Balance 12,400.00 Closing Balance "
        "18,250.10 Date Narration Withdrawals Deposits Balance",
        "insurance_statements": "Wingtip Insurance Health Insurance Policy Schedule Policy Number "
        "1234/56789012 Period of Insurance 01 Apr 2026 to 31 Mar 2027 Sum Insured 500,000 Premium "
        "Payable 18,400 Insured Members 3",
    }
    kept = {name: place(FileEvidence(name, PDF, head=head), alone) for name, head in trap.items()}
    assert {name: result.group for name, result in kept.items()} == dict.fromkeys(trap)
    for group, head in genuine.items():
        assert place(FileEvidence("statement.pdf", PDF, head=head), alone).group == group


IST = ZoneInfo("Asia/Kolkata")


@pytest.mark.parametrize(
    ("day", "start", "expected"),
    [
        (date(2025, 4, 1), 4, "FY 26 Q1"),
        (date(2025, 6, 30), 4, "FY 26 Q1"),
        (date(2025, 7, 1), 4, "FY 26 Q2"),
        (date(2025, 12, 31), 4, "FY 26 Q3"),
        (date(2026, 1, 1), 4, "FY 26 Q4"),
        (date(2026, 3, 31), 4, "FY 26 Q4"),
        (date(2026, 4, 1), 4, "FY 27 Q1"),
        (date(2026, 10, 21), 4, "FY 27 Q3"),
        (date(2026, 1, 1), 1, "FY 26 Q1"),
        (date(2026, 12, 31), 1, "FY 26 Q4"),
    ],
)
def test_the_fiscal_quarter_follows_the_owners_year_on_every_boundary(day, start, expected):
    assert fiscal_quarter(day, start).label == expected
    for bad in (0, 13, True, "4"):
        with pytest.raises(ValueError, match="out of range"):
            fiscal_quarter(day, bad)


def test_a_files_quarter_comes_from_its_title_then_created_then_modified_in_the_owners_zone():
    def decide(name, created=None, modified=None):
        reference = created.astimezone(IST).date() if created else None
        title = title_day(name, zone=IST, reference=reference)
        return deciding_day(title=title, created=created, modified=modified, zone=IST)

    late_march_utc = datetime(2025, 3, 31, 20, 0, tzinfo=UTC)
    # A title date outranks the file's own times, and a month alone is its last day.
    assert decide("Northwind_Statement_Mar2026.pdf", late_march_utc) == (date(2026, 3, 31), "title")
    assert decide("Account statement 14 Sep 2025.pdf") == (date(2025, 9, 14), "title")
    # A title that names several dates files under the latest: the quarter it ends in.
    assert decide("Statement 15 Mar 2025 to 14 Apr 2025.pdf")[0] == date(2025, 4, 14)
    # No title date: created time, read in the owner's zone (1 April in India, not 31 March).
    assert decide("scan_0042.pdf", late_march_utc) == (date(2025, 4, 1), "created")
    assert deciding_day(
        title=None, created=late_march_utc, modified=None, zone=ZoneInfo("UTC")
    ) == (
        date(2025, 3, 31),
        "created",
    )
    # Then modified time, then nothing at all.
    modified = datetime(2026, 10, 21, 10, 0, tzinfo=UTC)
    assert decide("Untitled document", None, modified) == (date(2026, 10, 21), "modified")
    assert decide("Untitled document") == (None, "none")
    # A numeric date that reads two ways is not trusted, so created time decides.
    assert title_day("Statement 03-04-2026.pdf", zone=IST) is None
    assert decide("Statement 03-04-2026.pdf", late_march_utc)[1] == "created"


def test_folders_are_counted_by_group_and_quarter_with_kept_files_last():
    names = load_folders()
    rows = [
        ("financial_statements", date(2025, 5, 2), None, None),
        ("financial_statements", date(2025, 6, 9), None, None),
        ("financial_statements", date(2025, 8, 1), None, None),
        ("financial_statements", None, None, None),
        ("insurance_statements", None, datetime(2026, 1, 5, tzinfo=UTC), None),
        ("kept", date(2025, 5, 2), None, None),
    ]
    summary = summarize_folders(rows, zone=IST, names=names)
    assert [(item.name, item.count) for item in summary] == [
        ("Financial Assets (FY 26 Q2)", 1),
        ("Financial Assets (FY 26 Q1)", 2),
        ("Financial Assets", 1),
        ("Insurance (FY 26 Q4)", 1),
        ("Not sorted yet", 1),
    ]
    with pytest.raises(ValueError, match="folders file"):
        FolderNames.from_payload(
            {"kind": "folders_v1", "names": {}, "kept": "x", "fiscal_year_start_month": 4}
        )
    assert load_folders().names["personal_documents"] == "Personal Documents"


def test_csv_exports_placements_and_periods_without_private_index_payloads():
    placement = place(
        FileEvidence("statement", PDF, head="statement", vector=basis(0)), tiny_bundle()
    )
    assert placement.group == "financial_statements"
    rows = [
        {
            "id": "file-one",
            "title": '=HYPERLINK("https://invalid.example","open")',
            "mimeType": PDF,
            "createdTime": "2025-03-31T20:00:00Z",
            "viewUrl": "https://drive.google.com/file/d/file-one/view",
        }
    ]
    indexed = IndexedFile("file-one", placement, "PRIVATE-HEAD-SENTINEL", basis(0))
    projected = placement_rows(rows, [indexed], zone=IST)
    exported = list(csv.DictReader(io.StringIO(csv_text(projected))))
    assert tuple(exported[0]) == COLUMNS
    assert exported[0]["file_name"] == "'" + rows[0]["title"]
    assert exported[0]["folder"] == "Financial Assets (FY 26 Q1)"
    assert exported[0]["date"] == "2025-04-01"
    assert "PRIVATE-HEAD-SENTINEL" not in csv_text(projected)
    kept = replace(placement, group=None)
    assert (
        placement_rows(rows, [replace(indexed, placement=kept)], zone=IST)[0]["fiscal_quarter"]
        == ""
    )
    assert csv_text([{"file_name": " normal"}]).splitlines()[1].startswith(" normal,")


@pytest.mark.asyncio
async def test_local_export_refuses_a_different_connected_drive_owner(monkeypatch):
    from firebase_admin import auth

    from api.utils import firebase_admin as firebase_setup
    from hushh_mcp.services import external_connector_oauth_service, google_drive_rest_transport
    from scripts.export_drive_groups import export

    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.delenv(FLAG, raising=False)
    monkeypatch.setattr(firebase_setup, "get_firebase_auth_app", lambda: None)
    monkeypatch.setattr(
        auth,
        "get_user_by_email",
        lambda *args, **kwargs: SimpleNamespace(
            uid="authorized-owner", email="owner@example.com", disabled=False
        ),
    )
    oauth = SimpleNamespace(
        lifecycle=SimpleNamespace(
            read=AsyncMock(), db=SimpleNamespace(engine=SimpleNamespace(dispose=lambda: None))
        ),
        current_credential=AsyncMock(
            return_value=(
                {"validation_state": "verified"},
                {"accountLabel": "someone-else@example.com"},
            )
        ),
    )
    monkeypatch.setattr(
        external_connector_oauth_service,
        "get_external_connector_oauth_service",
        lambda: SimpleNamespace(drive=lambda: oauth),
    )
    constructed = []
    monkeypatch.setattr(
        google_drive_rest_transport,
        "GoogleDriveRestTransport",
        lambda **kwargs: constructed.append(True),
    )
    with pytest.raises(RuntimeError, match="drive_identity_mismatch"):
        await export(SimpleNamespace(email="owner@example.com", time_zone="Asia/Kolkata"))
    assert not constructed
    assert not __import__("os").environ.get(FLAG)


@pytest.fixture
def local_export_setup(monkeypatch):
    from contextlib import asynccontextmanager, nullcontext

    from firebase_admin import auth

    from api.utils import firebase_admin as firebase_setup
    from hushh_mcp.services import (
        drive_group_index_job,
        drive_live_preferences,
        external_connector_oauth_service,
        google_drive_rest_transport,
    )
    from hushh_mcp.services.drive_groups import indexer
    from hushh_mcp.services.google_drive_adapter import LIVE_POLICY_HASH
    from scripts import drive_group_local_adapters, drive_group_local_inventory

    monkeypatch.setenv("ENVIRONMENT", "development")
    for key in (
        FLAG,
        "GOOGLE_DRIVE_LIVE",
        "CONNECTOR_INTERNAL_OWNER_COHORT",
        "CONNECTOR_UAT_ALL_USERS",
    ):
        monkeypatch.setenv(key, "")
    monkeypatch.setattr(firebase_setup, "get_firebase_auth_app", lambda: None)
    monkeypatch.setattr(
        auth,
        "get_user_by_email",
        lambda *args, **kwargs: SimpleNamespace(
            uid="owner", email="owner@example.com", disabled=False
        ),
    )
    engine = SimpleNamespace(begin=lambda: nullcontext(object()), dispose=lambda: None)
    oauth = SimpleNamespace(
        lifecycle=SimpleNamespace(read=AsyncMock(), db=SimpleNamespace(engine=engine)),
        current_credential=AsyncMock(
            return_value=(
                {
                    "validation_state": "verified",
                    "verified_policy_hash": LIVE_POLICY_HASH,
                    "connection_generation": 1,
                },
                {"accountLabel": "owner@example.com"},
            )
        ),
    )
    monkeypatch.setattr(
        external_connector_oauth_service,
        "get_external_connector_oauth_service",
        lambda: SimpleNamespace(drive=lambda: oauth),
    )
    state = {"changed": False, "change": None, "session_active": False, "session_closed": False}

    @asynccontextmanager
    async def session():
        state["session_active"] = True
        try:
            yield
        finally:
            state["session_active"] = False
            state["session_closed"] = True

    monkeypatch.setattr(
        google_drive_rest_transport,
        "GoogleDriveRestTransport",
        lambda **kwargs: SimpleNamespace(owner_search_session=session),
    )
    listing = AsyncMock(
        return_value=(
            [
                {
                    "id": "file-one",
                    "title": "statement.pdf",
                    "mimeType": PDF,
                    "version": "1",
                    "createdTime": "2025-04-01T00:00:00Z",
                }
            ],
            True,
            False,
        )
    )
    monkeypatch.setattr(
        drive_group_index_job.DriveGroupIndexJob,
        "list_files",
        listing,
    )

    async def inventory(reads, user, **kwargs):
        rows, complete, limited = await listing(reads, user)
        return drive_group_local_inventory.LocalInventory(
            rows, complete, limited, "before-cursor", "after-cursor"
        )

    monkeypatch.setattr(drive_group_local_inventory, "load_inventory", inventory)
    monkeypatch.setattr(
        drive_group_local_adapters, "LocalHeadEmbedder", lambda: SimpleNamespace(embed=AsyncMock())
    )

    async def embed(*args, **kwargs):
        assert state["session_active"]
        state["changed"] = True
        placement = place(FileEvidence("statement.pdf", PDF), tiny_bundle())
        return SimpleNamespace(files=(IndexedFile("file-one", placement),), skipped=0)

    def current(*args, **kwargs):
        assert kwargs == {"user_id": "owner", "generation": 1, "read_only": True}
        if state["changed"] and state["change"] == "connection_validation":
            raise DriveReadError("connection_changed")
        return {"revision": int(state["changed"])}

    monkeypatch.setattr(indexer, "index_files", embed)
    monkeypatch.setattr(drive_live_preferences.DriveLivePreferences, "background_current", current)
    return SimpleNamespace(listing=listing, state=state, indexer=indexer, engine=engine)


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["preference_revision", "connection_validation"])
async def test_local_export_rechecks_canonical_authority_after_embedding(
    tmp_path, change, local_export_setup
):
    from scripts.export_drive_groups import export

    local_export_setup.state["change"] = change
    output = tmp_path / "index.csv"
    with pytest.raises(DriveReadError, match="background_preparation_required|connection_changed"):
        await export(
            SimpleNamespace(
                email="owner@example.com", time_zone="Asia/Kolkata", format="csv", output=output
            )
        )
    saved = list(csv.DictReader(io.StringIO(output.read_text(encoding="utf-8-sig"))))
    assert saved[0]["index_status"] == "pending"
    assert saved[0]["confidence"] == ""
    assert local_export_setup.state["session_closed"]
    assert not local_export_setup.state["session_active"]


@pytest.mark.asyncio
async def test_local_export_preserves_completed_batches_and_resumes_only_current_versions(
    monkeypatch, tmp_path, local_export_setup
):
    from scripts.export_drive_groups import export

    setup = local_export_setup
    original = setup.listing.return_value[0][0]
    rows = [{**original, "id": f"file-{index}"} for index in range(26)]
    setup.listing.return_value = (rows, True, False)
    placement = place(FileEvidence("statement.pdf", PDF), tiny_bundle())
    batches = []

    async def interrupted(batch, **kwargs):
        batches.append([row["id"] for row in batch])
        if len(batches) == 2:
            raise DriveReadError("provider_unavailable")
        return SimpleNamespace(
            files=tuple(
                IndexedFile(row["id"], placement, "PRIVATE-HEAD-SENTINEL", basis(0))
                for row in batch
            ),
            skipped=0,
        )

    monkeypatch.setattr(setup.indexer, "index_files", interrupted)
    output = tmp_path / "index.json"
    args = SimpleNamespace(
        email="owner@example.com", time_zone="Asia/Kolkata", format="json", output=output
    )
    with pytest.raises(DriveReadError, match="provider_unavailable"):
        await export(args)
    checkpoint = output.with_name(output.name + ".checkpoint.json")
    saved_text = checkpoint.read_text(encoding="utf-8-sig")
    assert json.loads(saved_text)["inventory"]["cursor"] == "before-cursor"
    saved = json.loads(output.read_text(encoding="utf-8-sig"))
    assert sum(row["index_status"] == "indexed" for row in saved) == 25
    assert saved[-1]["index_status"] == "pending" and saved[-1]["confidence"] == ""
    assert "PRIVATE-HEAD-SENTINEL" not in saved_text
    assert not any(key in saved_text for key in ('"head"', '"vector"', '"embedding"'))

    # An old owner's/connection's/revision's cache must never be republished.
    args.resume = True
    for key in ("owner", "generation", "revision"):
        changed = json.loads(saved_text)
        changed["context"][key] = "stale"
        checkpoint.write_text(json.dumps(changed), encoding="utf-8")
        before = output.read_bytes()
        with pytest.raises(RuntimeError, match="checkpoint_context_changed"):
            await export(args)
        assert output.read_bytes() == before
    checkpoint.write_text(saved_text, encoding="utf-8-sig")

    rows[0]["version"] = "2"

    async def resumed(batch, **kwargs):
        batches.append([row["id"] for row in batch])
        return SimpleNamespace(
            files=tuple(IndexedFile(row["id"], placement) for row in batch), skipped=0
        )

    monkeypatch.setattr(setup.indexer, "index_files", resumed)
    result = await export(args)
    assert batches[-1] == ["file-0", "file-25"]
    assert result["files"] == 26
    assert all(
        row["index_status"] == "indexed"
        for row in json.loads(output.read_text(encoding="utf-8-sig"))
    )
    assert (
        json.loads(checkpoint.read_text(encoding="utf-8-sig"))["inventory"]["cursor"]
        == "after-cursor"
    )


@pytest.mark.asyncio
async def test_local_export_revocation_during_backoff_prevents_another_provider_read(
    monkeypatch, tmp_path, local_export_setup
):
    import asyncio
    from contextlib import nullcontext

    from hushh_mcp.services import drive_live_preferences, google_drive_rest_transport
    from scripts.export_drive_groups import export

    setup = local_export_setup
    read = AsyncMock(side_effect=DriveReadError("provider_unavailable"))
    monkeypatch.setattr(
        google_drive_rest_transport,
        "GoogleDriveRestTransport",
        lambda **kwargs: SimpleNamespace(
            read_group_index_tool=read, owner_search_session=nullcontext
        ),
    )

    def preference(*args, **kwargs):
        return SimpleNamespace(
            mappings=lambda: SimpleNamespace(
                first=lambda: {
                    "revision": int(setup.state["changed"]),
                    "background_enabled": not setup.state["changed"],
                    "disclosure_version": drive_live_preferences.LIVE_BACKGROUND_DISCLOSURE,
                }
            )
        )

    setup.engine.connect = lambda: nullcontext(SimpleNamespace(execute=preference))

    async def revoke(*args):
        setup.state["changed"] = True

    monkeypatch.setattr(asyncio, "sleep", revoke)

    async def listing(reads, user_id):
        await reads.read_tool(user_id=user_id, tool_name="list_files", arguments={})

    setup.listing.side_effect = listing
    with pytest.raises(DriveReadError, match="background_preparation_required"):
        await export(
            SimpleNamespace(
                email="owner@example.com",
                time_zone="Asia/Kolkata",
                format="csv",
                output=tmp_path / "index.csv",
            )
        )
    assert read.await_count == 1


async def test_local_prefix_export_labels_missing_content_and_cannot_resume_full_mode(
    monkeypatch, tmp_path, local_export_setup
):
    from contextlib import nullcontext

    from scripts import drive_group_local_adapters, drive_group_local_authority, export_drive_groups

    setup = local_export_setup
    inputs = [
        row("good", "statement.pdf", version="1"),
        row("bad", "statement.pdf", version="1"),
        row("native", "statement", "application/vnd.google-apps.document", version="1"),
    ]
    setup.listing.return_value = (inputs, True, False)
    monkeypatch.setattr(
        drive_group_local_authority,
        "FreshDriveReadAuthority",
        lambda oauth, **kw: SimpleNamespace(oauth=oauth, operation=nullcontext, close=lambda: None),
    )
    monkeypatch.setattr(setup.indexer, "index_files", index_files)
    monkeypatch.setattr(drive_group_local_adapters, "LocalHeadEmbedder", lambda: Vectors({}))
    monkeypatch.setattr(
        export_drive_groups,
        "ProgressHeads",
        lambda source, count: SimpleNamespace(
            head=Heads({"good": "statement"}).head, text_files={"good"}
        ),
    )
    args = SimpleNamespace(
        email="owner@example.com",
        time_zone="UTC",
        format="csv",
        output=tmp_path / "prefix.csv",
        raw_prefix_kib=200,
    )
    result = await export_drive_groups.export(args)
    exported = list(csv.DictReader(args.output.read_text(encoding="utf-8-sig").splitlines()))
    assert result["reusedFiles"] == 0 and result["evidenceMode"] == "raw_prefix_204800"
    assert [item["index_status"] for item in exported] == [
        "indexed_raw_prefix",
        "prefix_unreadable",
        "prefix_unavailable",
    ]
    for item in exported[1:]:
        assert item["group"] == load_folders().kept and not item["fiscal_quarter"]
        for key in (
            "confidence",
            "model_top_class",
            "candidate_group",
            "group_source",
            "model_version",
        ):
            assert item[key] == ""
    args.resume, args.raw_prefix_kib = True, None
    with pytest.raises(RuntimeError, match="checkpoint_context_changed"):
        await export_drive_groups.export(args)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure,retried",
    [
        (DriveOAuthError("refresh_in_progress"), True),
        (DriveReadError("provider_unavailable"), True),
        (DriveOAuthError("provider_unavailable"), False),
        (DriveOAuthError("reconnect_required"), False),
    ],
)
async def test_local_export_retries_only_safe_transient_reads(monkeypatch, failure, retried):
    import asyncio

    from scripts.drive_group_local_adapters import retry_read

    sleep = AsyncMock()
    monkeypatch.setattr(asyncio, "sleep", sleep)
    operation = AsyncMock(side_effect=[failure, "ready"])
    if retried:
        assert await retry_read(operation) == "ready"
        assert operation.await_count == 2 and sleep.await_count == 1
    else:
        with pytest.raises(type(failure)):
            await retry_read(operation)
        assert operation.await_count == 1 and sleep.await_count == 0


@pytest.mark.parametrize("expired_initially", [False, True])
async def test_local_fresh_credentials_overlap_but_expired_credentials_refresh_once(
    expired_initially,
):
    import asyncio

    from scripts.drive_group_local_adapters import LocalCredentialReader

    ready = asyncio.Event()
    reads = refreshes = 0
    expired = expired_initially

    async def current(*, refresh=True, **kwargs):
        nonlocal reads, refreshes, expired
        if not refresh:
            reads += 1
            snapshot = expired
            if reads == 6:
                ready.set()
            await ready.wait()
            return {
                "credential_expires_at": datetime.now(UTC)
                + timedelta(seconds=-1 if snapshot else 3600)
            }, {"generation": 1}
        if expired:
            refreshes += 1
            await asyncio.sleep(0)
            expired = False
        return {"credential_expires_at": datetime.now(UTC) + timedelta(hours=1)}, {"generation": 1}

    reader = LocalCredentialReader(current)
    results = await asyncio.wait_for(
        asyncio.gather(*(reader(user_id="owner") for _ in range(6))), 2
    )
    assert reads == 6 and refreshes == int(expired_initially)
    assert all(result[1] == {"generation": 1} for result in results)


async def test_local_refresh_waiter_rechecks_revoked_authority():
    import asyncio

    from scripts.drive_group_local_adapters import LocalCredentialReader

    refreshing, release = asyncio.Event(), asyncio.Event()
    revoked = False

    async def current(*, refresh=True, **kwargs):
        if refresh:
            refreshing.set()
            await release.wait()
        if revoked:
            raise DriveOAuthError("reconnect_required")
        return {"credential_expires_at": datetime.now(UTC) - timedelta(seconds=1)}, {}

    reader = LocalCredentialReader(current)
    first = asyncio.create_task(reader(user_id="owner"))
    await asyncio.wait_for(refreshing.wait(), 2)
    second = asyncio.create_task(reader(user_id="owner"))
    await asyncio.sleep(0)
    revoked = True
    release.set()
    results = await asyncio.wait_for(asyncio.gather(first, second, return_exceptions=True), 2)
    assert all(
        isinstance(result, DriveOAuthError) and str(result) == "reconnect_required"
        for result in results
    )


def inventory_row(identity, version="1"):
    return row(identity, "statement.pdf", version=version, modifiedTime="2026-04-01T00:00:00Z")


def changes_page(changes, *, following=None, terminal="next-cursor"):
    return SimpleNamespace(
        is_error=False,
        truncated=False,
        payload={
            "changes": changes,
            "nextPageToken": following,
            "newStartPageToken": terminal,
        },
    )


def file_change(identity, *, version="1", removed=False):
    return {
        "changeType": "file",
        "fileId": identity,
        "removed": removed,
        "trashed": False,
        **({} if removed else {"file": inventory_row(identity, version)}),
    }


@pytest.mark.parametrize("oversize", [False, True])
async def test_incremental_inventory_reuses_snapshot_and_applies_updates_and_removals(
    monkeypatch, oversize
):
    from scripts import drive_group_local_inventory as inventory

    listing = AsyncMock()
    monkeypatch.setattr(inventory.DriveGroupIndexJob, "list_files", listing)
    saved = inventory.LocalInventory(
        [inventory_row("unchanged"), inventory_row("edited"), inventory_row("deleted")],
        True,
        False,
        "old-cursor",
        "old-cursor",
    ).checkpoint(completed=True)
    read = AsyncMock(
        side_effect=[
            *([DriveReadError("file_too_large")] if oversize else []),
            changes_page(
                [file_change("edited", version="2"), file_change("deleted", removed=True)],
                following="page-two",
                terminal=None,
            ),
            changes_page([file_change("new")]),
        ]
    )
    result = await inventory.load_inventory(SimpleNamespace(read_tool=read), "owner", saved=saved)
    assert [(item["id"], item["version"]) for item in result.rows] == [
        ("unchanged", "1"),
        ("edited", "2"),
        ("new", "1"),
    ]
    assert result.mode == "changes" and result.complete and not result.limited
    assert result.checkpoint(completed=False)["cursor"] == "old-cursor"
    assert result.checkpoint(completed=True)["cursor"] == "next-cursor"
    assert [call.kwargs["arguments"]["pageToken"] for call in read.await_args_list] == [
        *(["old-cursor"] if oversize else []),
        "old-cursor",
        "page-two",
    ]
    assert read.await_args_list[-1].kwargs["arguments"]["pageSize"] == (25 if oversize else 200)
    listing.assert_not_awaited()
    assert saved["rows"][-1]["id"] == "deleted"  # Failed publication may retain the old checkpoint.


@pytest.mark.parametrize("reset", [None, "expired", "membership"])
async def test_incremental_inventory_bootstrap_captures_cursor_before_listing_and_catches_up(
    monkeypatch, reset
):
    from scripts import drive_group_local_inventory as inventory

    calls = []

    async def listing(*args):
        calls.append("listing")
        return [inventory_row("edited")], True, False

    monkeypatch.setattr(inventory.DriveGroupIndexJob, "list_files", listing)

    async def read(*, tool_name, **kwargs):
        calls.append(tool_name)
        if tool_name == "changes_start_token":
            return SimpleNamespace(
                is_error=False, truncated=False, payload={"startPageToken": "start"}
            )
        if len(calls) == 1:
            if reset == "expired":
                raise DriveReadError("source_unavailable")
            return changes_page([{"changeType": "drive"}])
        return changes_page([file_change("edited", version="2")])

    saved = (
        None
        if reset is None
        else inventory.LocalInventory([inventory_row("old")], True, False, "old", "old").checkpoint(
            completed=True
        )
    )
    result = await inventory.load_inventory(SimpleNamespace(read_tool=read), "owner", saved=saved)
    assert calls[-3:] == ["changes_start_token", "listing", "list_changes"]
    assert result.rows == [inventory_row("edited", "2")] and result.mode == "full"


@pytest.mark.parametrize("failure", ["truncated", "cycle", "revoked"])
async def test_incremental_inventory_refuses_incomplete_or_revoked_delta_without_advancing(failure):
    from scripts import drive_group_local_inventory as inventory

    saved = inventory.LocalInventory([inventory_row("old")], True, False, "old", "old").checkpoint(
        completed=True
    )
    before = json.dumps(saved)
    if failure == "revoked":
        read = AsyncMock(side_effect=DriveReadError("connection_changed"))
    else:
        page = changes_page([], following="old", terminal=None)
        page.truncated = failure == "truncated"
        read = AsyncMock(return_value=page)
    with pytest.raises(DriveReadError, match="provider_response_invalid|connection_changed"):
        await inventory.load_inventory(SimpleNamespace(read_tool=read), "owner", saved=saved)
    assert json.dumps(saved) == before
