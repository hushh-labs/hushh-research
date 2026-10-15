"""Replay runs production code on pages only: labels never reach a prompt, the cost
cap stops work with budget_exhausted rows, and resumes refuse mixed runtimes."""

import json
import shutil
from pathlib import Path

import pytest

from hushh_eval.drive_packets import cli, replay
from hushh_eval.drive_packets.contracts import ObservationRow
from hushh_eval.drive_packets.replay import (
    MixedRuntimeError,
    ReplayCase,
    ReplayRunner,
    check_resumable,
)
from hushh_eval.drive_packets.usage import Budget

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures/drive_pipeline_eval"
LABEL_CANARY = "LABEL-CANARY-5521"


def planted_corpus(tmp_path):
    data = tmp_path / "corpus"
    shutil.copytree(FIXTURES, data)
    manifest = json.loads((data / "manifest-v2.json").read_text())
    for case in manifest["cases"]:
        for document in case["documents"]:
            document.setdefault("facts", {})["issuer"] = LABEL_CANARY
        case["expected_packet"]["coverage"]["canary"] = LABEL_CANARY
    (data / "manifest-v2.json").write_text(json.dumps(manifest))
    return data / "manifest-v2.json"


async def test_label_canary_never_reaches_a_prompt(tmp_path, monkeypatch):
    prompts = []

    class Recording(replay.FakeInterpret):
        async def __call__(self, *, prompt, user_id, output_schema):
            prompts.append(prompt)
            return await super().__call__(
                prompt=prompt, user_id=user_id, output_schema=output_schema
            )

    monkeypatch.setattr(replay, "FakeInterpret", Recording)
    monkeypatch.setattr(cli, "ROOT", tmp_path)
    manifest = planted_corpus(tmp_path)
    common = ["--workdir", str(tmp_path / "work"), "--batch-id", "L1"]
    assert (
        cli.main(["plan-batch", *common, "--seed", "3", "--fixture-manifest", str(manifest)]) == 0
    )
    assert await cli._run(cli.parser().parse_args(["run-batch", *common])) == 0
    assert prompts, "the fixture model was never called"
    joined = "\n".join(prompts)
    assert LABEL_CANARY not in joined
    # Positive control: prompts do carry original page text.
    assert "Statement" in joined or "statement" in joined


def cases(count):
    page = {
        "page_number": 1,
        "text": "Example Bank\nMonthly statement\n",
        "method": "native_text",
        "status": "extracted",
        "error_code": None,
        "quality": {},
    }
    return [
        ReplayCase(
            case_id=f"c{index}",
            document_uuid=f"00000000-0000-0000-0000-00000000000{index}",
            pages=[page],
            unit_kind="page",
            total_pages=1,
            has_gaps=False,
            source_version="1",
            extraction_source="local",
        )
        for index in range(count)
    ]


RUNTIME = {"code_sha": "abc", "facts_policy_version": "policy-1"}


async def test_budget_cap_records_budget_exhausted_and_stops():
    runner = ReplayRunner(
        interpret=replay.FakeInterpret(), model="fixture-interpret", budget=Budget(max_usd=0.0001)
    )
    result = await runner.run_owner_path(batch_id="B", cases=cases(3), runtime=RUNTIME)
    assert result.budget_exhausted
    assert {row.status for row in result.observations} == {"budget_exhausted"}
    assert result.usage == []


async def test_replay_builds_packets_through_the_production_worker():
    runner = ReplayRunner(
        interpret=replay.FakeInterpret(), model="fixture-interpret", budget=Budget(max_usd=50)
    )
    result = await runner.run_owner_path(batch_id="B", cases=cases(3), runtime=RUNTIME)
    assert {row.status for row in result.observations} == {"completed"}
    # One canonical key for identical headings: one packet with all three members.
    assert len(result.packets) == 1
    assert result.packets[0].state == "ready"
    assert result.packets[0].member_case_ids == ["c0", "c1", "c2"]


def test_resume_skips_completed_cases_and_refuses_mixed_runtimes():
    done = ObservationRow(
        batch_id="B",
        case_id="c1",
        mode="replay",
        stage="facts",
        status="completed",
        runtime=RUNTIME,
    )
    failed = ObservationRow(
        batch_id="B", case_id="c2", mode="replay", stage="facts", status="error", runtime=RUNTIME
    )
    assert check_resumable([done, failed], RUNTIME) == {"c1"}
    with pytest.raises(MixedRuntimeError, match="mixed_runtime_sha"):
        check_resumable([done], {**RUNTIME, "code_sha": "def"})


def test_vertex_concurrency_is_capped_at_eight():
    with pytest.raises(ValueError, match="vertex_concurrency"):
        ReplayRunner(
            interpret=replay.FakeInterpret(), model="m", budget=Budget(max_usd=1), concurrency=9
        )
