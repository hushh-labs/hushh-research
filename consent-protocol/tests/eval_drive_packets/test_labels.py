"""Ground truth is independent of runtime output, routed to a human slice, and
versioned so stale scores are refused."""

import pytest

from hushh_eval.drive_packets import cli
from hushh_eval.drive_packets.contracts import LabelRow
from hushh_eval.drive_packets.gates import listing_gate, load_thresholds
from hushh_eval.drive_packets.labels import (
    LABEL_VERSION,
    disagreements,
    human_slice,
    prelabel_payload,
    regex_periods,
    resolved,
    silver,
    terminal_label,
)


def label(subject, field, value, source, version=LABEL_VERSION):
    return LabelRow(
        subject=subject, field=field, value=value, source=source, labeler="t", label_version=version
    )


def test_prelabel_payload_is_blind_to_runtime_output():
    payload = prelabel_payload(
        pages={1: "Statement"},
        metadata={"modifiedTime": "2026-10-01", "mime_type": "application/pdf"},
    )
    assert set(payload) == {"task", "instruction", "file_metadata", "pages"}
    for runtime_field in ("facts", "assessment_score", "canonical_packets", "verification"):
        with pytest.raises(ValueError, match="runtime_output_in_prelabel_payload"):
            prelabel_payload(pages={1: "x"}, metadata={runtime_field: {}})


def test_human_slice_math():
    subjects = [f"c{index:03d}" for index in range(100)]
    chosen = human_slice(subjects, disagreed={"x1", "x2"}, high_risk_ready={"packet:p1"}, seed=1)
    reasons = list(chosen.values())
    # 10% random with a floor of 30, plus every disagreement and high-risk Ready.
    assert reasons.count("high_risk_ready") == 1 and reasons.count("disagreement") == 2
    assert reasons.count("random") == 30
    assert human_slice(subjects, disagreed=set(), high_risk_ready=set(), seed=1) == {
        key: "random" for key in list(chosen)[3:]
    }
    many = {f"packet:p{index}" for index in range(80)}
    capped = human_slice(subjects, disagreed=set(), high_risk_ready=many, seed=1)
    assert len(capped) == 60 and set(capped.values()) == {"high_risk_ready"}
    small = human_slice(
        [f"c{index}" for index in range(500)], disagreed=set(), high_risk_ready=set(), seed=1
    )
    assert len(small) == 50  # 10% of 500


def test_human_label_overrides_silver_and_silver_needs_agreement():
    rows = [
        label("c1", "page_count", 3, "deterministic"),
        label("c1", "page_count", 3, "prelabel"),
        label("c2", "page_count", 4, "deterministic"),
        label("c2", "page_count", 5, "prelabel"),
    ]
    agreed = silver(rows)
    assert [(row.subject, row.value) for row in agreed] == [("c1", 3)]
    assert disagreements(rows) == {"c2"}
    best = resolved(rows + agreed + [label("c1", "page_count", 2, "human")])
    assert best[("c1", "page_count")].source == "human"
    assert best[("c1", "page_count")].value == 2
    # Labels under another version are ignored, never mixed.
    assert ("c3", "issuer") not in resolved(
        [label("c3", "issuer", "x", "human", version="labels.v0")]
    )


def test_scores_under_a_stale_label_version_are_refused(tmp_path, monkeypatch):
    card = {"label_version": "labels.v0", "scores": []}
    assert listing_gate(card, load_thresholds()).reasons == ["stale_label_version"]
    batch = type("Batch", (), {"private_json": lambda self, name: card})()
    with pytest.raises(cli.UsageError, match="stale_label_version"):
        cli._scores(batch)


def test_period_phrase_rule_and_terminal_labeler():
    pages = {
        1: "Statement period September 1, 2026 to September 30, 2026\nfor the period 09/01/26 - 09/30/26"
    }
    assert regex_periods(pages) == [("2026-09-01", "2026-09-30")]
    answers = iter(["y", "e", "2026-10-31", "n"])
    rows = terminal_label(
        "c9",
        {"issuer": "Bank", "period_end": "2026-10-30", "account": "1234"},
        ask=lambda _prompt: next(answers),
        show=lambda _text: None,
        labeler="owner",
    )
    assert [(row.field, row.value, row.source) for row in rows] == [
        ("issuer", "Bank", "human"),
        ("period_end", "2026-10-31", "human"),
        ("account", None, "human"),
    ]
