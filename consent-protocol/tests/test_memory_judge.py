"""The memory-learning queue can be graded, and a tampered run publishes nothing.

The drill writes a blinded, sealed review queue. Before this, nothing on this
side could read one back: verdicts had to be appended with a shell redirect and
no code turned them into a score or refused to, so the judged quality number
could not be produced honestly at all.

These pin the two halves. The writer rejects a verdict the contract does not
allow while the judge can still fix it, and ingest either scores the run or
voids it. Every void condition in
`.codex/skills/puppy-one-harness/references/judging-contract.md` gets its own
case, because a void check that is never exercised is the same as no check: the
first time it matters is the day a grader is wrong, and that is the worst moment
to discover the condition was never wired.

Two of those cases exist because the first version of this file got them wrong,
and both are the same mistake: a control that reads as protection while the
grader still holds the shortcut. An uncited `wrong` was dropped from the
DENOMINATOR, so appending one to a row you could not defend raised your own
accuracy; and the manifest published the seal's filename, so a grader holding
only the manifest could open the answer key. A harness that can be gamed by the
party it measures is worse than no harness, because it produces a number
everyone believes.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

import pytest

_OPS = Path(__file__).resolve().parents[1] / "scripts" / "ops"


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, _OPS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    # Registered before exec so dataclass annotations (strings under
    # ``from __future__ import annotations``) resolve via ``sys.modules``.
    sys.modules[name] = module
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


drill = _load("pod_lifecycle_drill")
memory_judge = _load("memory_judge")


# --------------------------------------------------------------------------- #
# Fixtures: issue a real queue, then grade it the way a diligent judge would.
# --------------------------------------------------------------------------- #


def _issue(
    tmp_path: Path,
    *,
    seed: int = 7,
    harness: Path | None = None,
    judge_source: Path | None = None,
) -> tuple[Path, dict]:
    """A real issued run: six answers, four negative and two positive controls."""
    rows = [
        {"question": fact.ask, "answer": f"Answer about {fact.key}.", "case": fact.key}
        for fact in drill.MEMORY_HORIZON
    ]
    run_dir = tmp_path / "runs" / "memory-1"
    summary = drill.write_judge_queue(
        rows,
        run_dir=run_dir,
        seed=seed,
        harness_path=harness,
        judge_path=judge_source,
        run_id="run-0001",
        created_at="2026-09-10T00:00:00+00:00",
        answerer_model="pod-text-runtime",
    )
    return run_dir, summary


def _seal(run_dir: Path) -> Path:
    """The seal for this run, found the way ingest has to find it.

    There is no name to compute: the filename is a salted hash, so the only way
    in is to list the seal directory and ask each candidate which run it was
    issued for. A test that could compute the path from the manifest would be
    demonstrating the hole rather than the protection.
    """
    root = run_dir.parent / ".judge-seals"
    issued_for = memory_judge._sha(run_dir.resolve().as_posix())
    found = [
        path
        for path in sorted(root.glob("*.seal.json"))
        if json.loads(path.read_text()).get("run_dir_sha256") == issued_for
    ]
    assert len(found) == 1, found
    return found[0]


def _controls(seal_path: Path) -> dict[str, dict[str, str]]:
    return json.loads(seal_path.read_text())["controls"]


def _quotable(output: str) -> str:
    """A verbatim span of the row's own output: its last word."""
    return str(output).rstrip(".").split()[-1]


def _grade_all(run_dir: Path, seal_path: Path, *, skip: set[str] | None = None) -> None:
    """Catch every planted failure, pass everything else. The diligent grader."""
    controls = _controls(seal_path)
    queue = memory_judge.load_queue(run_dir)
    for row_id in sorted(queue):
        if skip and row_id in skip:
            continue
        control = controls.get(row_id) or {}
        if control.get("kind") == "negative":
            memory_judge.record(
                run_dir=run_dir,
                row_id=row_id,
                verdict="wrong",
                rule=control["rule"],
                citation=_quotable(queue[row_id]["output"]),
                note="the value is not what the owner said",
            )
        else:
            memory_judge.record(run_dir=run_dir, row_id=row_id, verdict="correct")


def _append_raw(run_dir: Path, entry: dict, *, through_ledger: bool = True) -> None:
    """Append past the validating writer, chain intact. What a shell can do.

    ``through_ledger`` also forges the write-ledger line, which is what keeps
    each case below sharp: without it every raw append would void on
    ``verdict_appended_past_writer`` and no test would ever reach the check it
    was written for.
    """
    existing = memory_judge.read_verdicts(run_dir)
    entry = dict(entry)
    entry["chain"] = memory_judge.chain_head([*existing, entry])
    with (run_dir / "verdicts.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, sort_keys=True) + "\n")
    if through_ledger:
        ledger = memory_judge.read_write_ledger(run_dir)
        with (run_dir / memory_judge.WRITE_LEDGER_FILENAME).open("a", encoding="utf-8") as handle:
            handle.write(
                json.dumps({"sequence": len(ledger) + 1, "head": entry["chain"]}, sort_keys=True)
                + "\n"
            )


def _real_rows(run_dir: Path, seal_path: Path) -> list[str]:
    controls = _controls(seal_path)
    return [row_id for row_id in sorted(memory_judge.load_queue(run_dir)) if row_id not in controls]


def _kinds(report: dict) -> list[str]:
    return [violation["kind"] for violation in report["violations"]]


def _assert_void(report: dict, kind: str) -> None:
    """Void means no number at all, not a number with a caveat."""
    assert report["void"] is True, report
    assert kind in _kinds(report), _kinds(report)
    assert report["accuracy"] is None
    assert report["quality_judged_independently"] is False
    for forbidden in ("graded", "correct", "wrong", "unsure", "failures"):
        assert forbidden not in report, forbidden


# --------------------------------------------------------------------------- #
# The manifest the grading half needs, and the one thing it must never carry
# --------------------------------------------------------------------------- #


def test_the_manifest_carries_the_run_id_created_at_and_answering_model(tmp_path):
    """An accuracy with no answering model beside it cannot be compared to
    anything, and a report with no issue time cannot be placed in a series."""
    run_dir, summary = _issue(tmp_path)
    manifest = json.loads((run_dir / "run-manifest.json").read_text())
    assert manifest["run_id"] == summary["run_id"] == "run-0001"
    assert manifest["created_at"] == "2026-09-10T00:00:00+00:00"
    assert manifest["answerer_model"] == "pod-text-runtime"
    # The seal commits to the rule vocabulary and to the scoring module.
    seal = json.loads(_seal(run_dir).read_text())
    assert seal["run_id"] == "run-0001"
    assert seal["rules_sha256"] and seal["judge_sha256"]


def _assert_seal_is_not_derivable(run_dir: Path, summary: dict) -> Path:
    seal_file = _seal(run_dir)
    published = (
        (run_dir / "run-manifest.json").read_text(),
        (run_dir / "review-queue.jsonl").read_text(),
        json.dumps(summary),
    )
    assert seal_file.name != f"{summary['run_id']}.seal.json"
    for text in published:
        assert seal_file.stem not in text
        assert seal_file.name not in text
        assert ".judge-seals" not in text
    # And the seal really does hold what that protects.
    assert len(_controls(seal_file)) == 6
    return seal_file


def test_nothing_the_grader_is_given_can_name_the_seal(tmp_path):
    """The seal holds the plaintext control map: which rows are planted, and
    which rule each breaks. A grader that can compute its path is a grader
    holding the answer key, so the run id must not be the filename and the
    filename must not appear in anything the run directory publishes."""
    run_dir, summary = _issue(tmp_path)
    seal_file = _assert_seal_is_not_derivable(run_dir, summary)
    # Ingest still finds it, with nothing but the run directory.
    _grade_all(run_dir, seal_file)
    assert memory_judge.ingest(run_dir=run_dir)["void"] is False


def _replay_planted_rows(manifest: dict, seed: int) -> dict[str, str]:
    """Which rows are planted, recomputed from the shuffle the way a grader would.

    Nothing here reads the seal or the harness. It needs the seed, the row
    count and the control counts, and the last two are published in the
    manifest itself. The construction the replay assumes -- the real rows
    first, then four negative controls, then two positive -- is stated in the
    judging contract every grader is handed.
    """
    import random

    total = int(manifest["rows"])
    positives = int(manifest["controls"]["positive"])
    planted = positives + int(manifest["controls"]["negative"])
    slots = list(range(total))
    # The point of the replay is that it is exactly the harness's own shuffle.
    random.Random(int(seed)).shuffle(slots)  # noqa: S311
    return {
        f"m{position + 1:03d}": ("positive" if slots[position] >= total - positives else "negative")
        for position in range(total)
        if slots[position] >= total - planted
    }


def test_the_manifest_does_not_publish_the_shuffle_seed(tmp_path):
    """The seed IS the control map, so it is sealed rather than published.

    It reads like a reproducibility field, which is how it came to sit in the
    file the grader is told it may read. It is not one: the controls are
    appended to the rows in a fixed order, so replaying the permutation over
    the manifest's own ``rows`` and ``controls`` counts names every planted
    position and its kind exactly, with no seal, no harness source and nothing
    but a Python interpreter. That equivalence is asserted here against the
    seal, because a test that only checked the field was absent would not say
    why its absence matters.
    """
    run_dir, _ = _issue(tmp_path, seed=7)
    manifest = json.loads((run_dir / "run-manifest.json").read_text())
    seal = json.loads(_seal(run_dir).read_text())

    assert "seed" not in manifest
    assert "seed" not in json.dumps(manifest)
    # The whole key set is pinned, not just the field that leaked. A grader is
    # told this file is readable, so the next field added to it has to be a
    # deliberate act with this assertion in front of it.
    assert set(manifest) == {
        "suite",
        "run_id",
        "created_at",
        "answerer_model",
        "rules",
        "rows",
        "controls",
        "controls_commitment",
        "hashes",
        "harness_sha256",
        "grading",
    }
    # Kept, where the answer key already is, so an operator can still reproduce
    # an issue: sealing it is not the same as throwing it away.
    assert seal["seed"] == 7

    truth = {row_id: control["kind"] for row_id, control in seal["controls"].items()}
    assert _replay_planted_rows(manifest, seal["seed"]) == truth
    # And the other direction: the manifest alone answers a different question
    # for every seed, so with the seed gone it settles none of them.
    assert _replay_planted_rows(manifest, 8) != truth


def test_a_manifest_that_carries_the_seed_voids_the_run(tmp_path):
    """The sentence "the manifest locates no control" is a control, not prose.

    Four rounds of review have moved this boundary, and each time the only
    thing holding it was a line in a document. A run whose manifest carries a
    field that recomputes the planted rows cannot report blinding it did not
    have, so it voids and says which field.
    """
    run_dir, _ = _issue(tmp_path)
    _grade_all(run_dir, _seal(run_dir))
    assert memory_judge.ingest(run_dir=run_dir)["void"] is False

    manifest_file = run_dir / "run-manifest.json"
    manifest = json.loads(manifest_file.read_text())
    manifest["seed"] = 7
    manifest_file.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    report = memory_judge.ingest(run_dir=run_dir)
    _assert_void(report, "manifest_leaks_controls")
    detail = next(
        v["detail"] for v in report["violations"] if v["kind"] == "manifest_leaks_controls"
    )
    assert "'seed'" in detail


def test_the_seal_is_not_derivable_on_the_path_production_takes(tmp_path):
    """The drill never passes a run id, so the default is the only path that
    ships. It generated the id from the same salted hash of the same run
    directory as the seal's filename, which made the two identical: the
    protection held in every test that supplied an id, and in none of the runs
    anybody would actually issue."""
    rows = [
        {"question": fact.ask, "answer": f"Answer about {fact.key}.", "case": fact.key}
        for fact in drill.MEMORY_HORIZON
    ]
    run_dir = tmp_path / "runs" / "auto"
    summary = drill.write_judge_queue(rows, run_dir=run_dir, seed=7)
    assert not summary["run_id"].startswith("run-")  # generated, not supplied
    _assert_seal_is_not_derivable(run_dir, summary)


def test_an_unsupplied_run_id_and_timestamp_still_produce_a_locatable_seal(tmp_path):
    rows = [{"question": "q?", "answer": "a.", "case": "k"}]
    run_dir = tmp_path / "runs" / "auto"
    summary = drill.write_judge_queue(rows, run_dir=run_dir, seed=3)
    assert _seal(run_dir).exists()
    manifest = json.loads((run_dir / "run-manifest.json").read_text())
    assert manifest["run_id"] == summary["run_id"] and manifest["created_at"]


# --------------------------------------------------------------------------- #
# The happy path
# --------------------------------------------------------------------------- #


def test_a_diligently_graded_run_scores_and_reports_its_answering_model(tmp_path):
    run_dir, _ = _issue(tmp_path)
    _grade_all(run_dir, _seal(run_dir))
    report = memory_judge.ingest(run_dir=run_dir)
    assert report["void"] is False and report["violations"] == []
    assert report["accuracy"] == 1.0
    assert report["graded"] == 6 and report["correct"] == 6
    assert report["negative_controls_caught"] == "4/4"
    assert report["positive_controls_passed"] == "2/2"
    assert report["negative_control_rule_mismatches"] == []
    assert report["answerer_model"] == "pod-text-runtime"
    assert report["created_at"] == "2026-09-10T00:00:00+00:00"
    assert report["quality_judged_independently"] is True
    # Context separation is recorded as the discipline it is, never asserted.
    assert report["context_separation"]["enforced"] is False


def test_scoring_owns_no_clock_so_a_second_ingest_is_byte_identical(tmp_path):
    run_dir, _ = _issue(tmp_path)
    _grade_all(run_dir, _seal(run_dir))
    first = json.dumps(memory_judge.ingest(run_dir=run_dir), sort_keys=True)
    second = json.dumps(memory_judge.ingest(run_dir=run_dir), sort_keys=True)
    assert first == second


def test_an_unsure_counts_against_accuracy(tmp_path):
    """It is not a way to dodge a call the judge could actually make."""
    run_dir, _ = _issue(tmp_path)
    seal_path = _seal(run_dir)
    hedged = _real_rows(run_dir, seal_path)[0]
    _grade_all(run_dir, seal_path, skip={hedged})
    memory_judge.record(run_dir=run_dir, row_id=hedged, verdict="unsure", note="cannot quote it")
    report = memory_judge.ingest(run_dir=run_dir)
    assert report["void"] is False
    assert report["unsure"] == 1 and report["graded"] == 6
    assert report["accuracy"] == 0.8333


def test_a_cited_wrong_on_a_real_row_counts_and_is_reported(tmp_path):
    run_dir, _ = _issue(tmp_path)
    seal_path = _seal(run_dir)
    target = _real_rows(run_dir, seal_path)[0]
    queue = memory_judge.load_queue(run_dir)
    _grade_all(run_dir, seal_path, skip={target})
    memory_judge.record(
        run_dir=run_dir,
        row_id=target,
        verdict="wrong",
        rule="invented",
        citation=_quotable(queue[target]["output"]),
        note="a value the owner never said",
    )
    report = memory_judge.ingest(run_dir=run_dir)
    assert report["void"] is False
    assert report["wrong"] == 1 and report["accuracy"] == 0.8333
    assert report["failures"][0]["id"] == target
    assert report["failures"][0]["rule"] == "invented"


def test_a_citation_may_quote_the_utterance_because_an_omission_has_nothing_to_quote(tmp_path):
    """Checking the output only would silently penalise the one failure class
    that loses the owner's records: the fact that is absent by definition."""
    run_dir, _ = _issue(tmp_path)
    seal_path = _seal(run_dir)
    target = _real_rows(run_dir, seal_path)[0]
    queue = memory_judge.load_queue(run_dir)
    span = " ".join(str(queue[target]["utterance"]).split()[:4])
    assert span.casefold() not in str(queue[target]["output"]).casefold()
    _grade_all(run_dir, seal_path, skip={target})
    memory_judge.record(
        run_dir=run_dir,
        row_id=target,
        verdict="wrong",
        rule="omission",
        citation=span,
        note="the owner said this and it was never recorded",
    )
    report = memory_judge.ingest(run_dir=run_dir)
    assert report["void"] is False and report["wrong"] == 1


# --------------------------------------------------------------------------- #
# The writer refuses what the contract forbids, while the judge can still fix it
# --------------------------------------------------------------------------- #


def test_the_writer_refuses_a_second_verdict_for_one_row(tmp_path):
    run_dir, _ = _issue(tmp_path)
    row_id = _real_rows(run_dir, _seal(run_dir))[0]
    memory_judge.record(run_dir=run_dir, row_id=row_id, verdict="correct")
    with pytest.raises(memory_judge.JudgeError, match="already has a verdict"):
        memory_judge.record(run_dir=run_dir, row_id=row_id, verdict="unsure")
    assert len(memory_judge.read_verdicts(run_dir)) == 1


def test_the_writer_refuses_an_id_that_is_not_in_the_queue(tmp_path):
    run_dir, _ = _issue(tmp_path)
    with pytest.raises(memory_judge.JudgeError, match="not in the queue"):
        memory_judge.record(run_dir=run_dir, row_id="m999", verdict="correct")
    assert memory_judge.read_verdicts(run_dir) == []


def test_the_writer_refuses_an_uncited_wrong(tmp_path):
    run_dir, _ = _issue(tmp_path)
    row_id = _real_rows(run_dir, _seal(run_dir))[0]
    with pytest.raises(memory_judge.JudgeError, match="unsure"):
        memory_judge.record(
            run_dir=run_dir,
            row_id=row_id,
            verdict="wrong",
            rule="invented",
            citation="a value that appears nowhere in this row",
        )
    with pytest.raises(memory_judge.JudgeError, match="must name the rule"):
        memory_judge.record(run_dir=run_dir, row_id=row_id, verdict="wrong", citation="Answer")
    assert memory_judge.read_verdicts(run_dir) == []


def test_the_writer_refuses_a_rule_the_run_never_declared(tmp_path):
    run_dir, _ = _issue(tmp_path)
    row_id = _real_rows(run_dir, _seal(run_dir))[0]
    with pytest.raises(memory_judge.JudgeError, match="not one of the rules"):
        memory_judge.record(
            run_dir=run_dir,
            row_id=row_id,
            verdict="wrong",
            rule="vibes",
            citation="Answer",
        )
    assert memory_judge.read_verdicts(run_dir) == []


def test_a_citation_must_quote_a_span_and_not_a_fragment_of_a_word(tmp_path):
    """A substring test with no floor accepts `a`, which quotes nothing and
    makes `a wrong must quote the offending value` enforce nothing at all."""
    run_dir, _ = _issue(tmp_path)
    row_id = _real_rows(run_dir, _seal(run_dir))[0]
    row = memory_judge.load_queue(run_dir)[row_id]
    # The single character really is in the row: a plain substring test passes.
    assert "a" in str(row["output"]).casefold()
    assert not memory_judge.citation_supports("a", row)
    with pytest.raises(memory_judge.JudgeError, match="unsure"):
        memory_judge.record(
            run_dir=run_dir, row_id=row_id, verdict="wrong", rule="invented", citation="a"
        )
    # A short value that IS a standalone span still cites; the same digits
    # buried inside a longer number do not.
    standalone = {"output": "your account ends in 42.", "utterance": ""}
    buried = {"output": "your account ends in 4269.", "utterance": ""}
    assert memory_judge.citation_supports("42", standalone)
    assert not memory_judge.citation_supports("42", buried)


def test_the_progress_view_names_what_is_still_ungraded(tmp_path):
    run_dir, _ = _issue(tmp_path)
    seal_path = _seal(run_dir)
    target = _real_rows(run_dir, seal_path)[0]
    _grade_all(run_dir, seal_path, skip={target})
    state = memory_judge.progress(run_dir)
    assert state["total"] == 12 and state["graded"] == 11
    assert state["remaining"] == [target] and state["complete"] is False


# --------------------------------------------------------------------------- #
# Every void condition the contract names, one case each
# --------------------------------------------------------------------------- #


def test_an_uncited_wrong_leaves_the_row_ungraded_and_voids_the_run(tmp_path):
    """The denominator is the whole point. The contract discards an uncited
    `wrong`, and a discarded verdict leaves the row ungraded, which voids. Drop
    the row from the denominator instead and every grader has a free way to
    raise its own accuracy: append an uncited `wrong` to any row you cannot
    defend, and 5/6 becomes a clean 1.0 with no caveat to quote."""
    run_dir, _ = _issue(tmp_path)
    seal_path = _seal(run_dir)
    ducked = _real_rows(run_dir, seal_path)[0]
    _grade_all(run_dir, seal_path, skip={ducked})
    _append_raw(
        run_dir,
        {
            "id": ducked,
            "verdict": "wrong",
            "rule": "invented",
            "citation": "nothing in this row says this",
            "note": "",
        },
    )
    report = memory_judge.ingest(run_dir=run_dir)
    _assert_void(report, "uncited_wrong_discarded")
    # The row is ungraded, not merely uncounted, and the run says which one.
    assert "rows_ungraded" in _kinds(report)
    assert any(ducked in violation["detail"] for violation in report["violations"])
    # It was laundered through the ledger, so this is the citation finding and
    # not the append finding standing in for it.
    assert "verdict_appended_past_writer" not in _kinds(report)
    # The honest alternative is still open and still costs the grader.
    assert memory_judge.progress(run_dir)["remaining"] == [ducked]


def test_a_passed_negative_control_voids_the_run(tmp_path):
    """A grader that is not reading has said nothing worth having."""
    run_dir, _ = _issue(tmp_path)
    seal_path = _seal(run_dir)
    planted = next(
        row_id for row_id, c in sorted(_controls(seal_path).items()) if c["kind"] == "negative"
    )
    _grade_all(run_dir, seal_path, skip={planted})
    memory_judge.record(run_dir=run_dir, row_id=planted, verdict="correct")
    _assert_void(memory_judge.ingest(run_dir=run_dir), "negative_control_passed")


def test_a_flagged_positive_control_voids_the_run(tmp_path):
    """A grader that over-flags produces failures nobody can act on."""
    run_dir, _ = _issue(tmp_path)
    seal_path = _seal(run_dir)
    clean = next(
        row_id for row_id, c in sorted(_controls(seal_path).items()) if c["kind"] == "positive"
    )
    queue = memory_judge.load_queue(run_dir)
    _grade_all(run_dir, seal_path, skip={clean})
    memory_judge.record(
        run_dir=run_dir,
        row_id=clean,
        verdict="wrong",
        rule="wrong-value",
        citation=_quotable(queue[clean]["output"]),
    )
    _assert_void(memory_judge.ingest(run_dir=run_dir), "positive_control_flagged")


def test_an_edited_row_voids_the_run_even_when_the_manifest_hashes_are_updated(tmp_path):
    """The salted hash in the seal is why fixing the in-run hashes does not help."""
    run_dir, _ = _issue(tmp_path)
    seal_path = _seal(run_dir)
    _grade_all(run_dir, seal_path)
    queue_file = run_dir / "review-queue.jsonl"
    rows = [json.loads(line) for line in queue_file.read_text().splitlines()]
    rows[0]["output"] = "a softer answer the grader would not flag"
    queue_file.write_text(
        "\n".join(json.dumps(row, sort_keys=True) for row in rows) + "\n", encoding="utf-8"
    )
    _assert_void(memory_judge.ingest(run_dir=run_dir), "row_hash_changed")

    manifest_file = run_dir / "run-manifest.json"
    manifest = json.loads(manifest_file.read_text())
    manifest["hashes"] = {
        row["id"]: memory_judge._sha(json.dumps(row, sort_keys=True)) for row in rows
    }
    manifest_file.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    _assert_void(memory_judge.ingest(run_dir=run_dir), "row_hash_changed")


def test_an_ungraded_row_voids_the_run(tmp_path):
    """A partial pass would let a grader skip the rows it found hard."""
    run_dir, _ = _issue(tmp_path)
    seal_path = _seal(run_dir)
    skipped = _real_rows(run_dir, seal_path)[0]
    _grade_all(run_dir, seal_path, skip={skipped})
    report = memory_judge.ingest(run_dir=run_dir)
    _assert_void(report, "rows_ungraded")
    assert skipped in report["violations"][0]["detail"]


def test_an_unknown_rule_cited_voids_the_run(tmp_path):
    """A rule nobody agreed to produces a failure that looks fully compliant."""
    run_dir, _ = _issue(tmp_path)
    seal_path = _seal(run_dir)
    target = _real_rows(run_dir, seal_path)[0]
    queue = memory_judge.load_queue(run_dir)
    _grade_all(run_dir, seal_path, skip={target})
    _append_raw(
        run_dir,
        {
            "id": target,
            "verdict": "wrong",
            "rule": "tone",
            "citation": _quotable(queue[target]["output"]),
            "note": "",
        },
    )
    _assert_void(memory_judge.ingest(run_dir=run_dir), "unknown_rule_cited")


def test_a_run_with_no_seal_voids(tmp_path):
    """An unsealed run is one where tampering is undetectable by construction."""
    run_dir, _ = _issue(tmp_path)
    seal_path = _seal(run_dir)
    _grade_all(run_dir, seal_path)
    seal_path.unlink()
    _assert_void(memory_judge.ingest(run_dir=run_dir), "no_seal")


def test_a_seal_found_inside_the_run_directory_voids(tmp_path):
    """Inside, it is one more file the judge can regenerate."""
    run_dir, _ = _issue(tmp_path)
    seal_path = _seal(run_dir)
    _grade_all(run_dir, seal_path)
    inside = run_dir / seal_path.name
    inside.write_text(seal_path.read_text(), encoding="utf-8")
    _assert_void(memory_judge.ingest(run_dir=run_dir, seal_path=inside), "seal_inside_run_dir")


def test_two_seals_claiming_one_run_cannot_be_told_apart(tmp_path):
    """Searching for the seal is what keeps its name off the manifest, and the
    cost of a search is that a planted second seal is a candidate too.

    The finding names a recovery, and it is the only finding: scoring against a
    seal picked by sort order would report a row hash mismatch and a changed
    control set as well, which reads as an accusation of tampering rather than
    as "two files claim this run".
    """
    run_dir, _ = _issue(tmp_path)
    seal_path = _seal(run_dir)
    _grade_all(run_dir, seal_path)
    # Shaped like the seal a previous issue left: another run's salted row
    # hashes, claiming this directory. It sorts first, so a scorer that picks a
    # candidate picks this one and reports the fresh queue as edited.
    other_dir = tmp_path / "runs" / "memory-2"
    drill.write_judge_queue(
        [{"question": "q?", "answer": "a.", "case": "k"}],
        run_dir=other_dir,
        seed=3,
        run_id="run-0002",
    )
    stale = json.loads(_seal(other_dir).read_text())
    stale["run_dir_sha256"] = memory_judge._sha(run_dir.resolve().as_posix())
    forged = seal_path.with_name("0000000000000000.seal.json")
    forged.write_text(json.dumps(stale, indent=2), encoding="utf-8")
    report = memory_judge.ingest(run_dir=run_dir)
    _assert_void(report, "ambiguous_seal")
    assert _kinds(report) == ["ambiguous_seal"], _kinds(report)
    detail = report["violations"][0]["detail"]
    assert "issuing the run again" in detail
    assert "Do not remove a seal by hand" in detail


def test_locate_seal_refuses_to_choose_between_two_candidates(tmp_path):
    """A public helper that picks one of two answer keys is the same defect as
    scoring a run whose seal nobody can identify, one level down. Only ingest
    used to raise on the ambiguity, and nothing made the helper honest."""
    run_dir, _ = _issue(tmp_path)
    real = _seal(run_dir)
    assert memory_judge.locate_seal(run_dir) == real

    # Sorts first, so a helper that returns ``matches[0]`` hands back the
    # planted file rather than the issued one.
    forged = real.with_name("0000000000000000.seal.json")
    forged.write_text(real.read_text(), encoding="utf-8")
    assert memory_judge.locate_seal(run_dir) is None

    # An explicit path is still returned whether or not it exists: a seal named
    # on the command line and missing is the loudest finding in the contract,
    # not a reason to skip the check.
    named = tmp_path / "not-there.seal.json"
    assert memory_judge.locate_seal(run_dir, seal_path=named) == named


def test_issuing_again_before_any_grading_scores_and_says_so_in_the_report(tmp_path):
    """Re-running the drill into the same queue directory is an ordinary
    operator action, and it used to make the run permanently unscoreable.

    Two seals claimed the directory, so ingest voided for `ambiguous_seal`, and
    the stale one it opened disagreed with the fresh manifest, so it voided for
    `controls_altered` too: the harness accused the operator of tampering for
    running the drill twice, and the only way out was to delete a seal by hand,
    which is precisely the act the control exists to detect. Issuing supersedes
    instead, at issue time, by the party that owns the seal directory.

    Fixing that footgun then erased the only trace of the re-issue from
    everything a reader of the SCORE can see: the count went to the operator's
    receipt alone. So the seal carries the counter and the report publishes it.
    """
    run_dir, first = _issue(tmp_path, seed=7)
    first_seal = _seal(run_dir)
    assert first["issue_ordinal"] == 1 and first["superseded_artifacts"] == 0

    # The same directory, a second issue, before a single verdict exists.
    _, summary = _issue(tmp_path, seed=11)
    # The stale seal, and the queue and manifest it was issued with.
    assert summary["superseded_artifacts"] == 3
    assert summary["issue_ordinal"] == 2
    assert summary["verdicts_discarded_by_reissue"] == 0

    # Exactly one seal is live, so the fresh run grades and scores normally.
    second_seal = _seal(run_dir)
    assert second_seal != first_seal
    _grade_all(run_dir, second_seal)
    report = memory_judge.ingest(run_dir=run_dir)
    assert report["void"] is False and report["accuracy"] == 1.0
    # And the score itself says the directory was issued twice. Before this the
    # fact lived only in the issue receipt, which no reader of the score sees.
    assert report["issue"]["ordinal"] == 2
    assert report["issue"]["reissued"] is True
    assert report["issue"]["superseded_artifacts"] == 3
    assert report["issue"]["verdicts_discarded_by_reissue"] == 0

    # Nothing was destroyed. The previous run is renamed out of the live set,
    # so no operator ever has to remove a seal.
    assert not first_seal.exists()
    assert (first_seal.parent / f"{first_seal.name}.superseded").exists()
    assert (run_dir / "review-queue.jsonl.superseded").exists()
    assert (run_dir / "run-manifest.json.superseded").exists()


def test_a_first_issue_reports_ordinal_one_and_no_re_issue(tmp_path):
    """The field is on every report, so a reader never has to know whether its
    absence means "issued once" or "an older harness wrote this"."""
    run_dir, _ = _issue(tmp_path)
    _grade_all(run_dir, _seal(run_dir))
    report = memory_judge.ingest(run_dir=run_dir)
    assert report["issue"] == {
        "ordinal": 1,
        "reissued": False,
        "superseded_artifacts": 0,
        "verdicts_discarded_by_reissue": 0,
    }


def test_re_issuing_after_verdicts_were_recorded_voids_and_cannot_be_laundered(tmp_path):
    """The detection the supersede fix removed, restored without the footgun.

    Superseding made a re-issue survivable and, in the same change, left the
    SCORE report unable to see that one had happened. A grading session that
    failed a planted control could re-issue the run and be scored clean, which
    is strictly worse than the void it replaced: the void at least refused to
    publish a number.

    A re-issue BEFORE grading is ordinary and scores (above). One that discards
    recorded verdicts is a different event, and it voids. The count carries
    forward, so issuing a third time over an empty directory does not wash it.
    """
    run_dir, _ = _issue(tmp_path, seed=7)
    _grade_all(run_dir, _seal(run_dir))
    assert memory_judge.ingest(run_dir=run_dir)["void"] is False
    recorded = len(memory_judge.read_verdicts(run_dir))
    assert recorded == 12

    _, second = _issue(tmp_path, seed=11)
    assert second["verdicts_discarded_by_reissue"] == recorded
    assert memory_judge.read_verdicts(run_dir) == []
    assert memory_judge.read_write_ledger(run_dir) == []
    assert (run_dir / "verdicts.jsonl.superseded").exists()
    assert (run_dir / "verdict-writes.jsonl.superseded").exists()

    voided = memory_judge.ingest(run_dir=run_dir)
    _assert_void(voided, "reissued_after_verdicts")
    assert voided["issue"]["verdicts_discarded_by_reissue"] == recorded
    detail = next(
        v["detail"] for v in voided["violations"] if v["kind"] == "reissued_after_verdicts"
    )
    assert "NEW directory" in detail

    # Issue a third time, over a directory now holding no verdicts at all. That
    # is the obvious laundering move, and the counter carries across it.
    _, third = _issue(tmp_path, seed=13)
    assert third["issue_ordinal"] == 3
    assert third["verdicts_discarded_by_reissue"] == recorded
    _grade_all(run_dir, _seal(run_dir))
    report = memory_judge.ingest(run_dir=run_dir)
    _assert_void(report, "reissued_after_verdicts")
    assert _kinds(report) == ["reissued_after_verdicts"], _kinds(report)

    # The remedy the violation names actually works: a new directory is clean.
    fresh, _ = _issue(tmp_path / "second-attempt", seed=11)
    _grade_all(fresh, _seal(fresh))
    assert memory_judge.ingest(run_dir=fresh)["void"] is False


def test_a_seal_that_records_no_issue_counter_voids(tmp_path):
    """The same class of gap as a seal committing to no rule vocabulary: with
    no counter, a directory issued five times reads exactly like one issued
    once, and the control is present on paper only."""
    run_dir, _ = _issue(tmp_path)
    seal_path = _seal(run_dir)
    _grade_all(run_dir, seal_path)
    seal = json.loads(seal_path.read_text())
    assert seal["issue"]["ordinal"] == 1  # the drill really does write it
    del seal["issue"]
    seal_path.write_text(json.dumps(seal, indent=2), encoding="utf-8")
    _assert_void(memory_judge.ingest(run_dir=run_dir), "seal_missing_issue_record")


def test_deleting_one_of_the_two_verdict_files_does_not_reset_the_re_issue_count(tmp_path):
    """The cheap version of laundering a graded directory: remove the verdicts
    before re-issuing, so the counter sees nothing to discard. The count is
    taken from the larger of the verdicts file and the write ledger, which is
    exactly the pair kept apart so one cannot quietly speak for the other."""
    run_dir, _ = _issue(tmp_path, seed=7)
    _grade_all(run_dir, _seal(run_dir))
    (run_dir / "verdicts.jsonl").unlink()

    _, second = _issue(tmp_path, seed=11)
    assert second["verdicts_discarded_by_reissue"] == 12
    _grade_all(run_dir, _seal(run_dir))
    _assert_void(memory_judge.ingest(run_dir=run_dir), "reissued_after_verdicts")


def _tree(*roots: Path) -> dict[str, bytes]:
    """Every file under these roots, by path, with its bytes."""
    snapshot: dict[str, bytes] = {}
    for root in roots:
        for path in sorted(root.rglob("*")):
            if path.is_file():
                snapshot[str(path)] = path.read_bytes()
    return snapshot


def test_an_issue_that_fails_while_committing_leaves_the_run_untouched(tmp_path, monkeypatch):
    """Retiring the previous run used to happen BEFORE the new queue, manifest
    and seal existed anywhere.

    A failure in that gap left a directory whose seal had been renamed away and
    whose replacement was never written, and ingest reports exactly that as
    `no_seal`: "an unsealed run is one where tampering is undetectable by
    construction". The operator's own crash came back wearing the vocabulary of
    an attack, on a graded run that had been fine a moment earlier.

    So the write stages first and commits second, and a failure in the commit
    is rolled back. The only two acceptable end states are the new run, whole,
    or the old one, untouched.
    """
    run_dir, _ = _issue(tmp_path, seed=7)
    _grade_all(run_dir, _seal(run_dir))
    assert memory_judge.ingest(run_dir=run_dir)["void"] is False
    seal_root = run_dir.parent / ".judge-seals"
    before = _tree(run_dir, seal_root)

    real_replace = drill.os.replace

    def _fail_on_the_seal(src, dst):
        if str(dst).endswith(".seal.json"):
            raise OSError("no space left on device")
        return real_replace(src, dst)

    # The worst moment: the queue and the manifest are already in place and the
    # seal is the one thing left to move.
    monkeypatch.setattr(drill.os, "replace", _fail_on_the_seal)
    rows = [{"question": "q?", "answer": "a.", "case": "k"}]
    with pytest.raises(OSError, match="no space left"):
        drill.write_judge_queue(rows, run_dir=run_dir, seed=11)
    monkeypatch.undo()

    # Byte for byte what was there: the old queue, manifest, verdicts, write
    # ledger and seal, with no `.superseded` copies and no staged leftovers.
    assert _tree(run_dir, seal_root) == before
    assert not list(run_dir.glob("*.superseded"))
    assert not list(seal_root.glob("*.superseded"))
    assert not list(run_dir.glob(".*.incoming"))
    assert not list(seal_root.glob(".*.incoming"))
    # And the run that was already graded still scores, which is the point.
    assert memory_judge.ingest(run_dir=run_dir)["void"] is False


def test_an_issue_that_fails_before_staging_never_retires_the_previous_run(tmp_path):
    """The same hazard from the other end. Reading the harness source to seal
    it can fail, and it used to be read AFTER the previous seal had already
    been renamed away."""
    run_dir, _ = _issue(tmp_path, seed=7)
    _grade_all(run_dir, _seal(run_dir))
    seal_root = run_dir.parent / ".judge-seals"
    before = _tree(run_dir, seal_root)

    rows = [{"question": "q?", "answer": "a.", "case": "k"}]
    with pytest.raises(OSError):
        drill.write_judge_queue(
            rows, run_dir=run_dir, seed=11, harness_path=tmp_path / "no-such-harness.py"
        )
    assert _tree(run_dir, seal_root) == before
    assert memory_judge.ingest(run_dir=run_dir)["void"] is False


def test_superseding_never_touches_another_runs_seal(tmp_path):
    """Only the seals issued for THIS run directory are retired. Seals share a
    directory by default, and an issue that swept it would quietly destroy the
    tamper detection of every other run in the fleet."""
    run_dir, _ = _issue(tmp_path, seed=7)
    keep = _seal(run_dir)
    other_dir = tmp_path / "runs" / "memory-2"
    drill.write_judge_queue(
        [{"question": "q?", "answer": "a.", "case": "k"}],
        run_dir=other_dir,
        seed=3,
        run_id="run-0002",
    )
    other_seal = _seal(other_dir)
    assert other_seal.parent == keep.parent  # the same seal directory

    _, summary = _issue(tmp_path, seed=11)  # re-issue the FIRST run only
    # Its own seal, queue and manifest, and no verdicts yet.
    assert summary["superseded_artifacts"] == 3
    assert other_seal.exists()
    assert _seal(other_dir) == other_seal


# --------------------------------------------------------------------------- #
# The other god-mode moves the contract names, made detectable
# --------------------------------------------------------------------------- #


def test_widening_the_rule_vocabulary_voids_the_run(tmp_path):
    """Without the seal's commitment, `an unknown rule voids the run` would
    enforce nothing: the grader could add the rule it wanted to the manifest."""
    run_dir, _ = _issue(tmp_path)
    seal_path = _seal(run_dir)
    target = _real_rows(run_dir, seal_path)[0]
    queue = memory_judge.load_queue(run_dir)
    _grade_all(run_dir, seal_path, skip={target})
    manifest_file = run_dir / "run-manifest.json"
    manifest = json.loads(manifest_file.read_text())
    manifest["rules"] = [*manifest["rules"], "tone"]
    manifest_file.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    # The writer now accepts the invented rule, which is exactly the hole.
    memory_judge.record(
        run_dir=run_dir,
        row_id=target,
        verdict="wrong",
        rule="tone",
        citation=_quotable(queue[target]["output"]),
    )
    _assert_void(memory_judge.ingest(run_dir=run_dir), "rules_altered")


def test_an_edited_harness_voids_the_run(tmp_path):
    """The rules enforced at scoring must be the rules the run was issued under."""
    harness = tmp_path / "harness.py"
    harness.write_text("# the rules as issued\n", encoding="utf-8")
    run_dir, _ = _issue(tmp_path, harness=harness)
    _grade_all(run_dir, _seal(run_dir))
    assert memory_judge.ingest(run_dir=run_dir, harness_path=harness)["void"] is False
    harness.write_text("# the rules, rewritten by the party being measured\n", encoding="utf-8")
    _assert_void(
        memory_judge.ingest(run_dir=run_dir, harness_path=harness),
        "harness_changed",
    )


def test_an_edited_scoring_module_voids_the_run(tmp_path):
    """The contract's threat row is `Edit judge.py -- defeats the rules, the
    controls, the void logic`, and all three live in the scoring module, not in
    the drill. Sealing only the drill answered the wrong row.

    The check is circular, and the module says so: an edit here can delete it.
    What it buys is that an edit made without disarming the checker is caught,
    and that an operator holding the seal can re-verify from outside.
    """
    source = tmp_path / "scoring.py"
    source.write_text("# the void logic as issued\n", encoding="utf-8")
    run_dir, _ = _issue(tmp_path, judge_source=source)
    seal_path = _seal(run_dir)
    _grade_all(run_dir, seal_path)
    assert memory_judge.ingest(run_dir=run_dir, judge_path=source)["void"] is False

    source.write_text("# the void logic, minus the void\n", encoding="utf-8")
    _assert_void(memory_judge.ingest(run_dir=run_dir, judge_path=source), "judge_changed")

    # A seal that commits to no scoring module at all is the same finding: a
    # rewritten rule, control or void check could not be detected.
    source.write_text("# the void logic as issued\n", encoding="utf-8")
    seal = json.loads(seal_path.read_text())
    del seal["judge_sha256"]
    seal_path.write_text(json.dumps(seal, indent=2), encoding="utf-8")
    _assert_void(memory_judge.ingest(run_dir=run_dir, judge_path=source), "judge_changed")


def test_revising_a_verdict_already_given_voids_the_run(tmp_path):
    run_dir, _ = _issue(tmp_path)
    seal_path = _seal(run_dir)
    _grade_all(run_dir, seal_path)
    target = _real_rows(run_dir, seal_path)[0]
    verdicts_file = run_dir / "verdicts.jsonl"
    rewritten = []
    for line in verdicts_file.read_text().splitlines():
        entry = json.loads(line)
        if entry["id"] == target:
            entry["verdict"] = "unsure"
        rewritten.append(json.dumps(entry, sort_keys=True))
    verdicts_file.write_text("\n".join(rewritten) + "\n", encoding="utf-8")
    _assert_void(memory_judge.ingest(run_dir=run_dir), "verdict_chain_broken")


def test_deleting_a_verdict_and_giving_it_again_voids_the_run(tmp_path):
    """A judge changing its mind does not rewrite the file. It drops the last
    line and records again through the sanctioned writer, and the chain that
    remains is genuinely valid, because a prefix of a valid chain is one. The
    write ledger is the second record that sees the line that went missing."""
    run_dir, _ = _issue(tmp_path)
    seal_path = _seal(run_dir)
    _grade_all(run_dir, seal_path)
    assert memory_judge.ingest(run_dir=run_dir)["accuracy"] == 1.0

    verdicts_file = run_dir / "verdicts.jsonl"
    lines = verdicts_file.read_text().splitlines()
    regretted = json.loads(lines[-1])["id"]
    verdicts_file.write_text("\n".join(lines[:-1]) + "\n", encoding="utf-8")
    memory_judge.record(run_dir=run_dir, row_id=regretted, verdict="unsure", note="on reflection")

    report = memory_judge.ingest(run_dir=run_dir)
    _assert_void(report, "verdict_removed")
    # The chain alone could not have seen this: the file it left behind chains.
    assert memory_judge.chain_head(memory_judge.read_verdicts(run_dir)) == str(
        memory_judge.read_verdicts(run_dir)[-1]["chain"]
    )


def test_a_line_appended_past_the_writer_is_seen_even_with_a_recomputed_chain(tmp_path):
    """A shell can append a well-formed verdict with a correct chain. It cannot
    append to a ledger it was never told about."""
    run_dir, _ = _issue(tmp_path)
    seal_path = _seal(run_dir)
    target = _real_rows(run_dir, seal_path)[0]
    queue = memory_judge.load_queue(run_dir)
    _grade_all(run_dir, seal_path, skip={target})
    _append_raw(
        run_dir,
        {
            "id": target,
            "verdict": "correct",
            "rule": "",
            "citation": _quotable(queue[target]["output"]),
            "note": "",
        },
        through_ledger=False,
    )
    _assert_void(memory_judge.ingest(run_dir=run_dir), "verdict_appended_past_writer")


def test_a_duplicate_verdict_appended_past_the_writer_voids_the_run(tmp_path):
    run_dir, _ = _issue(tmp_path)
    seal_path = _seal(run_dir)
    _grade_all(run_dir, seal_path)
    target = _real_rows(run_dir, seal_path)[0]
    _append_raw(
        run_dir, {"id": target, "verdict": "unsure", "rule": "", "citation": "", "note": ""}
    )
    _assert_void(memory_judge.ingest(run_dir=run_dir), "duplicate_verdict")


def test_a_negative_control_caught_under_another_rule_is_reported(tmp_path):
    """The seal knows which rule was planted. Ingest read the control's kind and
    threw its rule away, so a grader could flag the row for a reason that was
    not the planted failure and still report 4/4. It is reported and not voided:
    a row planted as `stale-value` can honestly also read as `wrong-value`, and
    voiding on that would punish judgement rather than measure it."""
    run_dir, _ = _issue(tmp_path)
    seal_path = _seal(run_dir)
    planted_id, planted = next(
        (row_id, c) for row_id, c in sorted(_controls(seal_path).items()) if c["kind"] == "negative"
    )
    queue = memory_judge.load_queue(run_dir)
    other_rule = next(rule for rule in drill.MEMORY_JUDGE_RULES if rule != planted["rule"])
    _grade_all(run_dir, seal_path, skip={planted_id})
    memory_judge.record(
        run_dir=run_dir,
        row_id=planted_id,
        verdict="wrong",
        rule=other_rule,
        citation=_quotable(queue[planted_id]["output"]),
    )
    report = memory_judge.ingest(run_dir=run_dir)
    assert report["void"] is False
    assert report["negative_controls_caught"] == "4/4"
    assert report["negative_control_rule_mismatches"] == [
        {"id": planted_id, "planted": planted["rule"], "cited": other_rule}
    ]


# --------------------------------------------------------------------------- #
# The CLI a grading session actually types
# --------------------------------------------------------------------------- #


def test_the_cli_records_scores_and_exits_nonzero_on_a_void_run(tmp_path, capsys):
    run_dir, _ = _issue(tmp_path)
    seal_path = _seal(run_dir)
    queue = memory_judge.load_queue(run_dir)
    controls = _controls(seal_path)
    for row_id in sorted(queue):
        control = controls.get(row_id) or {}
        argv = ["--run-dir", str(run_dir), "record", "--id", row_id]
        if control.get("kind") == "negative":
            argv += [
                "--verdict",
                "wrong",
                "--rule",
                control["rule"],
                "--citation",
                _quotable(queue[row_id]["output"]),
            ]
        else:
            argv += ["--verdict", "correct"]
        assert memory_judge.main(argv) == 0, row_id
    report_path = tmp_path / "report.json"
    code = memory_judge.main(
        ["--run-dir", str(run_dir), "ingest", "--report-path", str(report_path)]
    )
    capsys.readouterr()
    assert code == 0
    assert json.loads(report_path.read_text())["accuracy"] == 1.0

    # A rejected verdict exits non-zero and says so on stderr, so a grader
    # cannot mistake it for a graded row.
    assert (
        memory_judge.main(
            ["--run-dir", str(run_dir), "record", "--id", "m001", "--verdict", "correct"]
        )
        == 2
    )
    assert "rejected:" in capsys.readouterr().err

    seal_path.unlink()
    assert memory_judge.main(["--run-dir", str(run_dir), "ingest"]) == 1
    printed = json.loads(capsys.readouterr().out)
    assert printed["void"] is True and printed["accuracy"] is None


def test_the_printed_commands_keep_the_seal_directory_out_of_the_graders_hands(tmp_path):
    """Two blocks for two parties. The grading block names only the run, and the
    scoring block is the only one that may carry `--seal-dir`.

    Printing the ingest line without `--seal-dir` is not a harmless omission: a
    run issued with a custom seal directory then scores `no_seal`, which the
    contract calls the loudest possible finding, on a run whose seal is intact.
    """
    grade, score = drill.memory_grading_instructions("/runs/memory-1", "/secrets/seals")
    assert "/secrets/seals" not in grade
    assert "--seal-dir /secrets/seals" in score
    assert "--run-dir /runs/memory-1 ingest" in score
    # With no custom directory there is no flag to print, and nothing to leak.
    plain_grade, plain_score = drill.memory_grading_instructions("/runs/memory-1")
    assert "--seal-dir" not in plain_score and "--seal-dir" not in plain_grade
    assert plain_score.rstrip().endswith("--run-dir /runs/memory-1 ingest")


def test_the_printed_scoring_command_actually_scores_a_run_sealed_elsewhere(tmp_path, capsys):
    """The bug was only visible end to end: every part worked, and the command
    the operator was handed still voided the run for `no_seal`, on a run whose
    seal was intact and whose grader had done nothing wrong. So type it."""
    rows = [
        {"question": fact.ask, "answer": f"Answer about {fact.key}.", "case": fact.key}
        for fact in drill.MEMORY_HORIZON
    ]
    run_dir = tmp_path / "queue"
    seal_dir = tmp_path / "seals"
    drill.write_judge_queue(rows, run_dir=run_dir, seed=7, seal_dir=seal_dir, run_id="r5")
    _grade_all(run_dir, next(seal_dir.glob("*.seal.json")))

    _, score = drill.memory_grading_instructions(str(run_dir), str(seal_dir))
    printed = score.strip().splitlines()[-1].split()
    argv = printed[printed.index("--run-dir") :]
    assert memory_judge.main(argv) == 0, argv
    report = json.loads(capsys.readouterr().out)
    assert report["void"] is False and report["accuracy"] == 1.0


def test_a_seal_issued_for_another_run_cannot_stand_in_for_this_one(tmp_path):
    """And the seal directory can be named, which is how a caller keeps the seal
    somewhere the grading session has no path to at all."""
    run_dir, _ = _issue(tmp_path)
    seal_dir = tmp_path / "runs" / ".judge-seals"
    _grade_all(run_dir, _seal(run_dir))
    assert memory_judge.ingest(run_dir=run_dir, seal_dir=seal_dir)["void"] is False

    other = tmp_path / "elsewhere"
    other_run = other / "runs" / "memory-2"
    drill.write_judge_queue(
        [{"question": "q?", "answer": "a.", "case": "k"}],
        run_dir=other_run,
        seed=7,
        run_id="run-0002",
    )
    stranger = next((other / "runs" / ".judge-seals").glob("*.seal.json"))
    _assert_void(memory_judge.ingest(run_dir=run_dir, seal_path=stranger), "seal_run_mismatch")


def test_a_verdict_for_a_row_that_is_not_in_the_queue_voids_the_run(tmp_path):
    run_dir, _ = _issue(tmp_path)
    _grade_all(run_dir, _seal(run_dir))
    _append_raw(
        run_dir, {"id": "m999", "verdict": "correct", "rule": "", "citation": "", "note": ""}
    )
    _assert_void(memory_judge.ingest(run_dir=run_dir), "unknown_row_graded")


# --------------------------------------------------------------------------- #
# The drill's own memory lane: the call site, not the helpers it calls
# --------------------------------------------------------------------------- #


def _memory_args(tmp_path: Path, **overrides) -> argparse.Namespace:
    """The drill's parsed command line for `--memory`, with nothing live in it."""
    defaults = dict(
        pod_url="https://pod.example",
        hushh_id="HA1MEMORYCALLSITE",
        auth="direct",
        consent_token="",
        hub_url="",
        firebase_token="",
        puppy_device_id="",
        runtime_credential="",
        runtime_credential_transport="developer_api",
        vertex_project="",
        vertex_location="",
        service="",
        project="",
        region="us-central1",
        expect_image_tag="",
        judge_queue_dir=str(tmp_path / "queue"),
        judge_seal_dir=str(tmp_path / "seals"),
        seed=7,
        report_path=None,
        receipt_path=None,
        target_environment="dev",
        image_digest="",
    )
    defaults.update(overrides)
    return argparse.Namespace(**defaults)


@pytest.fixture
def stub_memory_drill(monkeypatch):
    """Run `_memory_main` end to end with the pod replaced, nothing else.

    The call site is what these cases are about: the queue writer and the
    printed commands are covered on their own, and both were reachable only
    through lines in `_memory_main` that no test executed, so either could have
    been deleted with the suite green.
    """

    def _install(*, turn_provider: str) -> None:
        monkeypatch.setattr(drill, "ExistingPodFleet", lambda **kwargs: object())

        async def _run(fleet, *, hushh_id, expect_image_tag=None):
            result = drill.MemoryDrillResult(horizon_size=len(drill.MEMORY_HORIZON))
            result.judge_rows = [
                {"question": fact.ask, "answer": f"Answer about {fact.key}.", "case": fact.key}
                for fact in drill.MEMORY_HORIZON
            ]
            result.turn_provider = turn_provider
            return result

        monkeypatch.setattr(drill, "run_memory_learning_drill", _run)

    return _install


def test_the_memory_lane_hands_the_operator_a_scoring_command_for_its_own_seal_dir(
    tmp_path, capsys, stub_memory_drill
):
    """The queue is worthless without the two commands that grade and score it,
    and the scoring one must carry the seal directory the run was issued with.

    Printed without `--seal-dir`, it voids for `no_seal` -- the loudest finding
    in the contract -- on a run whose seal is intact and whose grader did
    nothing wrong. So this types what the operator is handed, against a run the
    drill lane issued itself.
    """
    args = _memory_args(tmp_path)
    stub_memory_drill(turn_provider="pod-text-runtime")
    # A stub result passes nothing, so the lane exits 1 on the drill's verdict.
    assert drill._memory_main(args) == 1
    printed = capsys.readouterr().out

    # The grading block asks a READ-ONLY lane for verdict lines; the command it
    # prints is the orchestrator's replay, never a `record` aimed at the grader.
    assert "replay --from" in printed
    assert "record --id <row id>" not in printed
    score_line = next(
        line
        for line in printed.splitlines()
        if line.strip().endswith(f"ingest --seal-dir {args.judge_seal_dir}")
    )
    argv = score_line.split()
    argv = argv[argv.index("--run-dir") :]

    run_dir = Path(args.judge_queue_dir)
    _grade_all(run_dir, next(Path(args.judge_seal_dir).glob("*.seal.json")))
    assert memory_judge.main(argv) == 0, argv
    report = json.loads(capsys.readouterr().out)
    assert report["void"] is False and report["accuracy"] == 1.0
    # And the answering model reached the manifest, so the number it scores can
    # be compared to another run at all.
    assert report["answerer_model"] == "pod-text-runtime"


def test_the_memory_lane_records_the_model_that_answered_and_supersedes_a_re_run(
    tmp_path, capsys, stub_memory_drill
):
    """Two runs into one directory, which is what an operator actually does."""
    args = _memory_args(tmp_path)
    stub_memory_drill(turn_provider="hermes-on-device")
    assert drill._memory_main(args) == 1
    manifest = json.loads((Path(args.judge_queue_dir) / "run-manifest.json").read_text())
    assert manifest["answerer_model"] == "hermes-on-device"
    assert "superseded" not in capsys.readouterr().out

    assert drill._memory_main(args) == 1
    printed = capsys.readouterr().out
    assert "superseded 3 artifact(s)" in printed and "(issue 2)" in printed
    # No verdicts had been recorded, so this is the ordinary operator re-run
    # and the lane does not warn about a run that will void.
    assert "WARNING" not in printed
    assert len(list(Path(args.judge_seal_dir).glob("*.seal.json"))) == 1

    # Grade it, then re-issue a third time. Now verdicts are being discarded,
    # and the lane says so at ISSUE time rather than letting a grading session
    # do the work and discover the void afterwards.
    run_dir = Path(args.judge_queue_dir)
    _grade_all(run_dir, next(Path(args.judge_seal_dir).glob("*.seal.json")))
    capsys.readouterr()
    assert drill._memory_main(args) == 1
    warned = capsys.readouterr().out
    assert "verdict(s) discarded by a re-issue" in warned
    assert "NEW run directory" in warned
    _grade_all(run_dir, next(Path(args.judge_seal_dir).glob("*.seal.json")))
    scored = memory_judge.ingest(run_dir=run_dir, seal_dir=args.judge_seal_dir)
    _assert_void(scored, "reissued_after_verdicts")


# --------------------------------------------------------------------------- #
# Blinding: the seed the shipped path draws, and where it may never be written
# --------------------------------------------------------------------------- #


def _horizon_rows() -> list[dict[str, str]]:
    return [
        {"question": fact.ask, "answer": f"Answer about {fact.key}.", "case": fact.key}
        for fact in drill.MEMORY_HORIZON
    ]


def _queue_lines(run_dir: Path) -> list[str]:
    return (run_dir / "review-queue.jsonl").read_text().splitlines()


def test_the_shipped_command_line_carries_no_default_seed(monkeypatch):
    """The blinding lived or died on one argparse default, and it was a constant.

    Every test supplied a seed, so the permutation moved in the suite and never
    in production: `--seed` defaulted to a fixed date literal, so every run an
    operator actually issued shuffled the same fixed corpus the same way. A
    grader who had seen one run, or heard one described, named every planted
    row in every later run with no manifest, no seal and no source read. This
    pins the shipped configuration rather than the helper, because the helper
    was never the thing that was wrong.
    """
    captured: dict[str, argparse.ArgumentParser] = {}

    def _spy(self, *args, **kwargs):
        captured["parser"] = self
        raise SystemExit(0)

    monkeypatch.setattr(drill.argparse.ArgumentParser, "parse_args", _spy)
    with pytest.raises(SystemExit):
        drill.main()
    assert captured["parser"].get_default("seed") is None


def test_the_default_path_mints_an_unpredictable_seed_and_seals_it(tmp_path):
    """Two issues of the same corpus, no seed supplied, and nothing repeats.

    The seed comparison is what carries this: two distinct 64-bit seeds
    producing the same permutation of twelve rows is possible and is about one
    run in a billion, so the row order is asserted as well but is not the
    property under test.
    """
    first = tmp_path / "runs" / "minted-1"
    second = tmp_path / "runs" / "minted-2"
    first_summary = drill.write_judge_queue(_horizon_rows(), run_dir=first)
    drill.write_judge_queue(_horizon_rows(), run_dir=second)

    first_seal = json.loads(_seal(first).read_text())
    second_seal = json.loads(_seal(second).read_text())
    assert first_seal["seed"] != second_seal["seed"]
    assert first_seal["seed_source"] == second_seal["seed_source"] == "minted-at-issue"
    assert first_summary["positions_blinded"] is True
    assert _queue_lines(first) != _queue_lines(second)

    # And the minted seed is in the seal and nowhere the grader is handed: not
    # the manifest, not the queue, not the summary the receipt copies.
    manifest_text = (first / "run-manifest.json").read_text()
    assert "seed" not in json.loads(manifest_text)
    for text in (manifest_text, "\n".join(_queue_lines(first)), json.dumps(first_summary)):
        assert str(first_seal["seed"]) not in text


def test_a_supplied_seed_is_reported_as_a_replay_and_not_as_a_blinded_run(tmp_path):
    """Replaying an issue is legitimate, so it scores; reporting it as blind is
    not, so it does not. The report states which of the two this run was."""
    run_dir, summary = _issue(tmp_path, seed=7)
    assert summary["positions_blinded"] is False
    assert json.loads(_seal(run_dir).read_text())["seed_source"] == "operator-supplied"

    _grade_all(run_dir, _seal(run_dir))
    report = memory_judge.ingest(run_dir=run_dir)
    assert report["void"] is False and report["accuracy"] == 1.0
    assert report["blinding"] == {
        "positions_unpredictable": False,
        "seed_source": "operator-supplied",
        "note": (
            "a seed was supplied, so the planted positions are those of every "
            "other run issued with it; this is a replay, not a blinded run"
        ),
    }

    minted = tmp_path / "runs" / "minted"
    drill.write_judge_queue(_horizon_rows(), run_dir=minted)
    _grade_all(minted, _seal(minted))
    blinded = memory_judge.ingest(run_dir=minted)["blinding"]
    assert blinded["positions_unpredictable"] is True
    assert blinded["seed_source"] == "minted-at-issue"
    # Stated on the blinded run too, because the planted rows' wording is fixed
    # in the harness and an unpredictable shuffle does not change that.
    assert "recognises them" in blinded["note"]


def test_a_seal_that_does_not_say_how_the_seed_was_drawn_claims_no_blinding(tmp_path):
    """Cannot-tell is not the same claim as positions-were-unpredictable."""
    run_dir, _ = _issue(tmp_path)
    seal_path = _seal(run_dir)
    seal = json.loads(seal_path.read_text())
    del seal["seed_source"]
    seal_path.write_text(json.dumps(seal, indent=2), encoding="utf-8")
    _grade_all(run_dir, seal_path)

    blinding = memory_judge.ingest(run_dir=run_dir)["blinding"]
    assert blinding["positions_unpredictable"] is False
    assert blinding["seed_source"] == "unknown"


def test_the_receipt_publishes_neither_the_seed_nor_the_seal_directory(tmp_path, monkeypatch):
    """The receipt is a file a grading session may read, and it recorded the
    command line verbatim: the seed, which replays every planted position, and
    the seal directory, whose only real protection is not being named."""
    argv = [
        "--memory",
        "--seed",
        "20260910",
        "--judge-seal-dir=/var/hushh/private-seals",
        "--consent-token",
        "a-real-grant",
    ]
    assert drill._receipt_commands(argv) == [
        "pod_lifecycle_drill.py --memory --seed <redacted> "
        "--judge-seal-dir=<redacted> --consent-token <redacted>"
    ]

    class _Revision:
        stdout = "0" * 40

    monkeypatch.setattr(drill.subprocess, "run", lambda *args, **kwargs: _Revision())
    (tmp_path / "probe.py").write_text("print('synthetic')\n", encoding="utf-8")
    receipt_path = tmp_path / "receipt.json"
    drill.write_receipt(
        receipt_path,
        result=drill.MemoryDrillResult(horizon_size=6),
        target={"mode": "local", "environment": "synthetic"},
        repo_root=tmp_path,
        source_paths=("probe.py",),
        commands=drill._receipt_commands(argv),
    )
    written = receipt_path.read_text()
    assert "20260910" not in written
    assert "private-seals" not in written
    assert "a-real-grant" not in written


def test_the_memory_lane_writes_a_receipt_that_names_no_seed_and_no_seal_dir(
    tmp_path, capsys, stub_memory_drill
):
    """The call site, not the helper. Both values reach the receipt through
    `sys.argv`, so the only place this is provable is the lane that reads it."""
    args = _memory_args(tmp_path, seed=11, receipt_path=str(tmp_path / "receipt.json"))
    stub_memory_drill(turn_provider="pod-text-runtime")
    original = drill.sys.argv
    drill.sys.argv = [
        "pod_lifecycle_drill.py",
        "--memory",
        "--seed",
        "11",
        "--judge-seal-dir",
        args.judge_seal_dir,
    ]
    try:
        assert drill._memory_main(args) == 1
    finally:
        drill.sys.argv = original
    printed = capsys.readouterr().out
    # The operator is told at issue time, while re-issuing is still cheap.
    assert "NOT BLINDED" in printed

    written = (tmp_path / "receipt.json").read_text()
    assert "--seed <redacted>" in written
    assert args.judge_seal_dir not in written
    assert "11" not in json.loads(written)["commands"][0]


# --------------------------------------------------------------------------- #
# Attribution: the number is a claim about a named model
# --------------------------------------------------------------------------- #


def test_forging_the_manifests_attribution_voids_the_run(tmp_path):
    """The suite, the run id, the issue time and the answering model are
    published as fact beside the accuracy, and nothing bound any of them.

    They live in the manifest, which the grader is told it may read and can
    edit, and editing them broke no row hash and no commitment: a grading
    session could hand back a clean report crediting a different model with
    the number, which is the entire output of this harness.
    """
    run_dir, _ = _issue(tmp_path)
    _grade_all(run_dir, _seal(run_dir))
    clean = memory_judge.ingest(run_dir=run_dir)
    assert clean["void"] is False
    assert clean["identity_verified"] is True
    assert clean["answerer_model"] == "pod-text-runtime"

    path = run_dir / "run-manifest.json"
    issued = path.read_text()
    for field, forged in (
        ("answerer_model", "a-frontier-model"),
        ("run_id", "run-9999"),
        ("created_at", "2020-01-01T00:00:00+00:00"),
        ("suite", "goal_progress"),
    ):
        manifest = json.loads(issued)
        manifest[field] = forged
        path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        report = memory_judge.ingest(run_dir=run_dir)
        _assert_void(report, "identity_altered")
        assert report["identity_verified"] is False, field
        path.write_text(issued, encoding="utf-8")

    assert memory_judge.ingest(run_dir=run_dir)["void"] is False


def test_a_seal_that_does_not_commit_to_the_attribution_voids(tmp_path):
    """A commitment that is absent reads as present until it is asked for."""
    run_dir, _ = _issue(tmp_path)
    _grade_all(run_dir, _seal(run_dir))
    seal_path = _seal(run_dir)
    seal = json.loads(seal_path.read_text())
    del seal["identity_sha256"]
    seal_path.write_text(json.dumps(seal, indent=2), encoding="utf-8")

    report = memory_judge.ingest(run_dir=run_dir)
    _assert_void(report, "identity_unsealed")
    assert report["identity_verified"] is False


# --------------------------------------------------------------------------- #
# The read-only grading lane: the grader emits, the orchestrator replays.
# --------------------------------------------------------------------------- #


def _submission(run_dir: Path, seal_path: Path, *, uncite: str | None = None) -> list[dict]:
    """What a diligent grader RETURNS, now that it cannot write."""
    controls = _controls(seal_path)
    queue = memory_judge.load_queue(run_dir)
    rows: list[dict] = []
    for row_id in sorted(queue):
        control = controls.get(row_id) or {}
        if control.get("kind") == "negative":
            rows.append(
                {
                    "id": row_id,
                    "verdict": "wrong",
                    "rule": control["rule"],
                    "citation": ("" if row_id == uncite else _quotable(queue[row_id]["output"])),
                }
            )
        else:
            rows.append({"id": row_id, "verdict": "correct"})
    return rows


def _write_submission(path: Path, rows: list[dict]) -> Path:
    path.write_text("\n".join(json.dumps(r, sort_keys=True) for r in rows) + "\n", "utf-8")
    return path


def test_a_replayed_submission_scores_exactly_as_a_directly_recorded_one(tmp_path):
    """The grading lane is read-only, so it returns verdicts and this side writes.

    The whole question is whether that changes the result. It must not: the void
    condition is a verdict line that never passed the writer, which is a property
    of the line and not of who typed the command. `replay` is `record` in a loop,
    so the write ledger gets its line per verdict and the run scores normally.
    """
    run_dir, _ = _issue(tmp_path)
    seal_path = _seal(run_dir)
    rows = _submission(run_dir, seal_path)

    outcome = memory_judge.replay(run_dir=run_dir, rows=rows)
    assert len(outcome["recorded"]) == len(rows)
    assert outcome["already_recorded"] == []

    report = memory_judge.ingest(run_dir=run_dir)
    assert report["void"] is False, report["violations"]
    assert report["accuracy"] == 1.0
    assert report["quality_judged_independently"] is True
    # Exactly the audit property that the direct writer gave: one ledger line
    # behind every verdict, and no `verdict_appended_past_writer`.
    assert len(memory_judge.read_write_ledger(run_dir)) == len(memory_judge.read_verdicts(run_dir))
    assert "verdict_appended_past_writer" not in _kinds(report)


def test_the_replay_stops_at_the_first_refused_row_and_names_it(tmp_path):
    """The cost of moving the write is that the grader loses the refusal at its
    own console. A replay that swallowed refusals and carried on would be worse
    than what it replaced, so it stops, says which row, and says how many landed.
    """
    run_dir, _ = _issue(tmp_path)
    seal_path = _seal(run_dir)
    planted = sorted(
        row_id for row_id, c in _controls(seal_path).items() if c["kind"] == "negative"
    )[0]
    rows = _submission(run_dir, seal_path, uncite=planted)

    with pytest.raises(memory_judge.JudgeError) as excinfo:
        memory_judge.replay(run_dir=run_dir, rows=rows)
    message = str(excinfo.value)
    assert planted in message
    assert "quote the offending value verbatim" in message

    # Nothing after the refused row was written, and the row itself is ungraded.
    recorded = {str(e["id"]) for e in memory_judge.read_verdicts(run_dir)}
    assert planted not in recorded
    assert planted in memory_judge.progress(run_dir)["remaining"]

    # The grader fixes that one row; replaying the corrected submission resumes
    # rather than duplicating, because an identical row already on disk is
    # skipped instead of re-written.
    fixed = _submission(run_dir, seal_path)
    outcome = memory_judge.replay(run_dir=run_dir, rows=fixed)
    assert planted in outcome["recorded"]
    assert set(outcome["already_recorded"]) == recorded
    report = memory_judge.ingest(run_dir=run_dir)
    assert report["void"] is False and report["accuracy"] == 1.0


def test_the_replay_refuses_a_verdict_that_tries_to_choose_its_own_chain(tmp_path):
    """`chain` is computed here over what is already on disk. A submitted one is
    either noise or an attempt to pick it, and the replay must not pass it on."""
    run_dir, _ = _issue(tmp_path)
    rows = _submission(run_dir, _seal(run_dir))
    rows[0]["chain"] = "0" * 64
    with pytest.raises(memory_judge.JudgeError, match="unexpected field"):
        memory_judge.replay(run_dir=run_dir, rows=rows)
    assert memory_judge.read_verdicts(run_dir) == []


def test_a_second_submission_that_disagrees_with_the_first_is_refused(tmp_path):
    """What the orchestrator gains it could also abuse: it could alter a verdict
    in transit, which a grader writing directly prevented. The mitigation is
    evidence rather than prevention. The submission is kept verbatim, so a second
    grading session quietly replacing the first's answers is refused and visible.
    """
    run_dir, _ = _issue(tmp_path)
    seal_path = _seal(run_dir)
    rows = _submission(run_dir, seal_path)
    memory_judge.replay(run_dir=run_dir, rows=rows)

    kept = json.loads((run_dir / memory_judge.SUBMISSION_FILENAME).read_text().splitlines()[0])
    assert {r["id"] for r in kept["rows"]} == {r["id"] for r in rows}

    # A second submission is kept BESIDE the first, not in place of it, because
    # the fix-and-resubmit loop produces a differing submission every time and a
    # guard that refused one would refuse the path the design depends on.
    altered = [dict(r) for r in rows]
    altered[-1]["verdict"] = "unsure"
    altered[-1]["rule"] = ""
    altered[-1]["citation"] = ""
    with pytest.raises(memory_judge.JudgeError, match="already has a verdict"):
        memory_judge.replay(run_dir=run_dir, rows=altered)
    # Refused where it was always refused, by the duplicate check, and both
    # submissions are on file for the diff.
    lines = (run_dir / memory_judge.SUBMISSION_FILENAME).read_text().strip().splitlines()
    assert len(lines) == 2
    assert json.loads(lines[0])["rows"][-1]["verdict"] != "unsure"
    assert json.loads(lines[1])["rows"][-1]["verdict"] == "unsure"


def test_replaying_the_same_submission_twice_writes_nothing_the_second_time(tmp_path):
    """Idempotent by construction, so an interrupted replay is simply re-run."""
    run_dir, _ = _issue(tmp_path)
    rows = _submission(run_dir, _seal(run_dir))
    memory_judge.replay(run_dir=run_dir, rows=rows)
    before = (run_dir / memory_judge.WRITE_LEDGER_FILENAME).read_text()
    outcome = memory_judge.replay(run_dir=run_dir, rows=rows)
    assert outcome["recorded"] == []
    assert len(outcome["already_recorded"]) == len(rows)
    assert (run_dir / memory_judge.WRITE_LEDGER_FILENAME).read_text() == before


def test_the_replay_is_reachable_from_the_command_line(tmp_path, capsys):
    """The operator types this, so type it."""
    run_dir, _ = _issue(tmp_path)
    rows = _submission(run_dir, _seal(run_dir))
    path = _write_submission(tmp_path / "grader.jsonl", rows)
    assert memory_judge.main(["--run-dir", str(run_dir), "replay", "--from", str(path)]) == 0
    outcome = json.loads(capsys.readouterr().out)
    assert len(outcome["recorded"]) == len(rows)
    assert memory_judge.progress(run_dir)["complete"] is True

    # The one part of the submission log an auditor can check against something
    # OUTSIDE it: the path replayed and a digest of that file's bytes. The rows
    # cannot serve, because the orchestrator writes them from the same list it
    # records, so an alteration is identical on both sides.
    logged = json.loads((run_dir / memory_judge.SUBMISSION_FILENAME).read_text())
    assert logged["source"] == str(path)
    assert logged["sha256"] == memory_judge._sha(path.read_text(encoding="utf-8"))


def test_the_submission_log_cannot_evidence_what_the_grader_said(tmp_path):
    """Pinned as a LIMIT, not as a control, because it was once claimed as one.

    The docstring offered this log as the thing the recorded verdicts could be
    diffed against to catch an orchestrator altering a verdict in transit. It
    cannot: the orchestrator writes the log from the same rows it records. This
    measures that directly, so the claim cannot come back without going red.
    """
    run_dir, _ = _issue(tmp_path)
    seal_path = _seal(run_dir)
    honest = _submission(run_dir, seal_path)

    # The orchestrator flips one verdict the grader gave, before replaying.
    altered = [dict(r) for r in honest]
    flipped = next(r for r in altered if r["verdict"] == "correct")
    flipped["verdict"] = "unsure"
    memory_judge.replay(run_dir=run_dir, rows=altered)

    logged = json.loads((run_dir / memory_judge.SUBMISSION_FILENAME).read_text())["rows"]
    recorded = {str(e["id"]): str(e["verdict"]) for e in memory_judge.read_verdicts(run_dir)}
    # The prescribed diff finds nothing, which is the point.
    assert all(recorded[r["id"]] == r["verdict"] for r in logged)
    assert recorded[flipped["id"]] == "unsure"
    # And the log carries no digest at all when the caller passed no bytes, so
    # it cannot even name an artifact to check against.
    assert "sha256" not in json.loads(
        (run_dir / memory_judge.SUBMISSION_FILENAME).read_text().splitlines()[0]
    )


def test_the_grading_lane_is_read_only_and_is_not_told_to_write(tmp_path):
    """The contradiction this whole path exists to remove, pinned so it cannot
    come back.

    `agent_fleet_audit.py` hard-fails a lane that is not `read-only`, and the
    judge lane was declared read-only and then told, in its own developer
    instructions, to run a command that appends to two files. Both cannot be
    true, and whichever way a host resolved it, the resolution was silent.
    """
    root = Path(__file__).resolve().parents[2]
    lane = (root / "agents" / "local_model_judge.toml").read_text(encoding="utf-8")
    assert 'sandbox_mode = "read-only"' in lane
    # The specific instruction that contradicted it: a `record` invocation aimed
    # at the grader. `replay` is the orchestrator's command and may be named.
    assert "memory_judge.py --run-dir <dir> record" not in lane
    assert "Emit verdicts; you never write" in lane
    # The Claude-side mirror of the same lane must not drift from it.
    mirror = (root / ".claude" / "agents" / "local_model_judge.md").read_text(encoding="utf-8")
    assert "Emit verdicts; you never write" in mirror
    assert "memory_judge.py --run-dir <dir> record" not in mirror


def test_the_receipt_says_whether_its_own_contents_locate_the_seal(tmp_path):
    """`seal_outside_run_dir: True` was a constant, and it read as a protection.

    The receipt publishes the queue path, so it publishes the run directory, so
    on the default path the seal directory is one `..` away and a grader holding
    the receipt lists it and picks out this run by `run_dir_sha256`. A field that
    is True on every run distinguishes nothing. This one distinguishes the two
    cases, which is the only thing a reader of the receipt can act on.
    """
    rows = [
        {"question": fact.ask, "answer": f"Answer about {fact.key}.", "case": fact.key}
        for fact in drill.MEMORY_HORIZON
    ]
    derivable = drill.write_judge_queue(rows, run_dir=tmp_path / "runs" / "a", seed=7, run_id="r-a")
    assert derivable["seal_location_derivable_from_receipt"] is True
    # And it is genuinely derivable: one `..` from the published queue path.
    default_root = Path(derivable["queue"]).parent.parent / ".judge-seals"
    assert list(default_root.glob("*.seal.json"))

    blinded = drill.write_judge_queue(
        rows,
        run_dir=tmp_path / "runs" / "b",
        seed=7,
        seal_dir=tmp_path / "elsewhere" / "seals",
        run_id="r-b",
    )
    assert blinded["seal_location_derivable_from_receipt"] is False
    # The superseded claim is gone rather than kept alongside.
    assert "seal_outside_run_dir" not in derivable
    assert "seal_outside_run_dir" not in blinded
