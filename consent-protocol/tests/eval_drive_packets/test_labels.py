"""Ground truth is independent of runtime output, routed to a human slice, and
versioned so stale scores are refused."""

import pytest

from hushh_eval.drive_packets import batch as ops
from hushh_eval.drive_packets import cli
from hushh_eval.drive_packets.contracts import (
    JudgmentRow,
    LabelRow,
    PacketRow,
    QueueRow,
    read_rows,
    replace_rows,
)
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
    terminal_verdict,
)
from hushh_eval.drive_packets.privacy import PrivateWorkdir


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


def test_terminal_verdict_records_a_person_and_skips_anything_unclear():
    def run(*answers):
        replies = iter(answers)
        return terminal_verdict(
            "p1",
            ["packet p1"],
            batch_id="B",
            labeler="ops",
            ask=lambda _prompt: next(replies),
            show=lambda _line: None,
        )

    passed = run("p")
    assert (passed.judge_id, passed.verdict, passed.severity, passed.model_version) == (
        "human",
        "pass",
        None,
        "human:ops",
    )
    failed = run("f", "s2")
    assert (failed.verdict, failed.severity, failed.failed_checks) == (
        "fail",
        "S2",
        ["human_review"],
    )
    assert run("s") is None and run("") is None
    assert run("f", "x", "y", "z") is None  # a fail needs a severity


def test_a_person_decides_queued_ready_packets_and_the_score_follows(tmp_path):
    common = ["--workdir", str(tmp_path / "work"), "--batch-id", "H1"]
    for command, extra in [
        ("plan-batch", ["--seed", "7", "--n-clusters", "4", "--n-loose", "3"]),
        ("run-batch", []),
        ("judge", ["--judge", "fake"]),
        ("label", ["--judge", "fake"]),
    ]:
        assert cli.main([command, *common, *extra]) == 0, command
    batch = ops.Batch(PrivateWorkdir((tmp_path / "work").resolve()), "H1")
    packets = {row.packet_key: row for row in read_rows(batch.file("packets.jsonl"), PacketRow)}
    judgments = read_rows(batch.file("judgments.jsonl"), JudgmentRow)
    queue = read_rows(batch.file("queue.jsonl"), QueueRow)
    ready = sorted(key for key, row in packets.items() if row.state == "ready")
    assert ready and {f"packet:{key}" for key in ready} <= {row.subject for row in queue}
    assert ops.scorecard(batch)["human_confirmed_ready"] == 0

    # A person fails the first packet shown (S1) and passes every other one.
    answers = iter(["f", "S1"] + ["p"] * (len(ready) - 1))
    shown = []
    written = cli.review_packets(
        batch,
        queue,
        packets,
        judgments,
        labeler="tester",
        ask=lambda _prompt: next(answers),
        show=shown.append,
    )
    assert written == len(ready)
    assert any("consensus/consensus: pass" in line for line in shown)
    again = read_rows(batch.file("judgments.jsonl"), JudgmentRow)
    assert (
        cli.review_packets(
            batch,
            queue,
            packets,
            again,
            labeler="tester",
            ask=lambda _prompt: pytest.fail("a decided packet was asked again"),
            show=shown.append,
        )
        == 0
    )

    card = ops.scorecard(batch)
    gated = next(row for row in card["scores"] if row["metric"] == "ready_correct_one_per_family")
    assert card["human_confirmed_ready"] == gated["trials"] > 0
    assert gated["trials"] - gated["successes"] == 1 and gated["extra"]["open_s1"] == 1
    gate = listing_gate(card, load_thresholds())
    assert gate.status == "fail" and gate.reasons[0] == "open_s1"


def test_rejudging_provider_errors_keeps_a_persons_verdict(tmp_path):
    common = ["--workdir", str(tmp_path / "work"), "--batch-id", "R1"]
    for command, extra in [
        ("plan-batch", ["--seed", "7", "--n-clusters", "4", "--n-loose", "3"]),
        ("run-batch", []),
        ("judge", ["--judge", "fake"]),
    ]:
        assert cli.main([command, *common, *extra]) == 0, command
    batch = ops.Batch(PrivateWorkdir((tmp_path / "work").resolve()), "R1")
    path = batch.file("judgments.jsonl")
    key = read_rows(path, JudgmentRow)[0].packet_key
    person = terminal_verdict(
        key, [], batch_id="R1", labeler="ops", ask=lambda _prompt: "p", show=lambda _line: None
    )
    error = JudgmentRow(
        batch_id="R1",
        packet_key=key,
        judge_id="J1",
        model_version="fake-j1",
        prompt_sha256=None,
        seed=None,
        variant="rerun",
        verdict="unknown",
        failed_checks=[],
        severity=None,
        citations_valid=None,
        error_code="judge_ClientError",
    )
    replace_rows(path, [*read_rows(path, JudgmentRow), person, error])
    assert cli.main(["judge", *common, "--judge", "fake", "--retry-provider-errors"]) == 0
    rows = [row for row in read_rows(path, JudgmentRow) if row.packet_key == key]
    assert [row.verdict for row in rows if row.judge_id == "human"] == ["pass"]
    assert any(row.judge_id == "consensus" for row in rows)  # judged again
