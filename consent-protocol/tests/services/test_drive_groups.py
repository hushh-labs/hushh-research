"""Drive four-group organizing aid: dark by default, precision first, private by construction.

The shelf logic runs against a tiny hand-made bundle so no result depends on the
learned data; one test reads the packaged data to guard the failure that actually
happened (words that fooled hand-weighted rules). Nothing here touches Google or a
model: ports are fakes and every document is invented.
"""

from __future__ import annotations

import logging
import math
from dataclasses import replace
from datetime import UTC, date, datetime
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
from hushh_mcp.services.drive_groups.features import metadata_features, text_features
from hushh_mcp.services.drive_groups.folders import FolderNames, load_folders, summarize_folders
from hushh_mcp.services.drive_groups.fusion import FusionPolicy
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
