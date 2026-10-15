"""JSONL rows are strict, round-trip exactly, append idempotently, and a missing
observation is a failed attempt, never a dropped one."""

import pytest
from pydantic import ValidationError

from hushh_eval.drive_packets import metrics
from hushh_eval.drive_packets.contracts import (
    CaseRow,
    FrameRow,
    GateRow,
    JudgmentRow,
    LabelRow,
    ObservationRow,
    PacketRow,
    QueueRow,
    ScoreRow,
    append_rows,
    read_rows,
)

ROWS = [
    FrameRow(
        frame_id="f",
        file_key="0" * 32,
        mime_family="pdf",
        size_bucket="lt100k",
        age_bucket="le2019",
        modified_year=2019,
        created_year=None,
        folder_key=None,
        top_folder_key=None,
        system_stage="pending",
        in_system=True,
        in_independent_listing=False,
    ),
    CaseRow(
        batch_id="B",
        case_id="c1",
        file_key="0" * 32,
        document_uuid="u",
        partition="dev",
        family_key=None,
        content_sha256=None,
        source_revision=None,
        stratum="pdf|lt100k|le2019",
        design_stratum="loose",
        cluster_key=None,
        design_weight=2.5,
        anchor=False,
        burned=False,
    ),
    ObservationRow(batch_id="B", case_id="c1", mode="replay", stage="facts", status="timeout"),
    PacketRow(
        batch_id="B",
        packet_key="p",
        mode="served",
        state="ready",
        member_case_ids=["c1"],
        selected_case_ids=["c1"],
        excluded=[],
        periods=[["2026-09-01", "2026-09-30"]],
        temporal_scope="document_period",
        gaps_count=0,
        pricing={"useful_scope": "period"},
        price_cents=500,
        assessment_score=90,
        importance=10,
        standalone_value="supported",
        visible={},
        record_statuses=["unknown"],
        verification=None,
        digest="d",
    ),
    LabelRow(
        subject="c1",
        field="page_count",
        value=3,
        source="deterministic",
        labeler="r",
        label_version="labels.v1",
    ),
    JudgmentRow(
        batch_id="B",
        packet_key="p",
        judge_id="J1",
        model_version="m",
        prompt_sha256="h",
        seed=1,
        variant="primary",
        verdict="unknown",
        failed_checks=[],
        severity=None,
        citations_valid=None,
    ),
    ScoreRow(
        metric="m",
        successes=1,
        trials=2,
        rate=0.5,
        cp_lower_95=0.02,
        wilson_lower_95=0.09,
        unit="u",
        independence="i",
        n_unknown=0,
        label_version="labels.v1",
    ),
    GateRow(
        gate="listing",
        status="insufficient",
        reasons=["r"],
        thresholds_version="gates.v1",
        exit_code=2,
    ),
    QueueRow(batch_id="B", subject="c1", reason="random"),
]


@pytest.mark.parametrize("row", ROWS, ids=lambda row: type(row).__name__)
def test_every_row_type_round_trips_and_rejects_unknown_fields(row):
    model = type(row)
    assert model.model_validate_json(row.model_dump_json()) == row
    with pytest.raises(ValidationError):
        model.model_validate({**row.model_dump(), "unexpected": 1})


def test_appends_are_idempotent_by_row_identity(tmp_path):
    path = tmp_path / "observations.jsonl"
    row = ROWS[2]
    assert append_rows(path, [row, row]) == 1
    assert append_rows(path, [row]) == 0
    assert read_rows(path, ObservationRow) == [row]
    assert oct(path.stat().st_mode & 0o777) == "0o600"


def test_missing_and_failed_attempts_stay_in_denominators():
    rows = [
        {"status": "completed", "true_pages": 2, "extracted_pages": 2, "claimed_complete": True},
        {"status": "missing", "true_pages": 3},
        {"status": "timeout", "true_pages": 1},
        {"status": "completed", "true_pages": None},
    ]
    accuracy = next(
        row for row in metrics.extraction(rows) if row["metric"] == "extraction_accuracy"
    )
    assert (accuracy["successes"], accuracy["trials"], accuracy["n_unknown"]) == (1, 3, 1)
