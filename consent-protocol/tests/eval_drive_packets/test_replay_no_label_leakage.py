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


async def test_replay_builds_packets_through_the_production_worker(monkeypatch):
    def refuse_runtime_sql(_owner):
        raise AssertionError("Offline replay touched runtime lifecycle SQL")

    monkeypatch.setattr(
        "hushh_mcp.services.account_deletion_lifecycle_service.AccountDeletionLifecycleService.is_tombstoned",
        refuse_runtime_sql,
    )
    runner = ReplayRunner(
        interpret=replay.FakeInterpret(), model="fixture-interpret", budget=Budget(max_usd=50)
    )
    result = await runner.run_owner_path(batch_id="B", cases=cases(3), runtime=RUNTIME)
    assert {row.status for row in result.observations} == {"completed"}
    # One canonical key for identical headings: one packet with all three members.
    assert len(result.packets) == 1
    assert result.packets[0].state == "ready"
    assert result.packets[0].member_case_ids == ["c0", "c1", "c2"]


@pytest.mark.parametrize("method", ["run_facts_one", "run_packet_one"])
async def test_replay_refuses_foreign_owners_before_content_or_registry_reads(monkeypatch, method):
    from unittest.mock import AsyncMock

    from fastapi import HTTPException

    monkeypatch.setenv("HUSSH_POD_MODE", "0")
    registry = AsyncMock(side_effect=AssertionError("Synthetic replay reached real placement"))
    monkeypatch.setattr("hushh_mcp.services.owner_placement_guard.get_owner_hosting_mode", registry)
    runner = ReplayRunner(
        interpret=replay.FakeInterpret(), model="fixture-interpret", budget=Budget(max_usd=50)
    )
    facts = replay.InMemoryFactsStore(cases(1), policy="policy-1", profile="fixture")
    facts.enqueue = AsyncMock(side_effect=AssertionError("Foreign owner reached content"))
    facts.packets.claim_packet = AsyncMock(
        side_effect=AssertionError("Foreign owner reached packet claim")
    )
    worker = runner._worker(facts, "policy-1")
    with pytest.raises(HTTPException) as refused:
        await getattr(worker, method)(user_id="foreign-owner")
    assert refused.value.status_code == 503
    assert refused.value.detail["code"] == "AGENT_HOSTING_UNAVAILABLE"
    registry.assert_not_awaited()
    facts.enqueue.assert_not_awaited()
    facts.packets.claim_packet.assert_not_awaited()


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


async def test_runtime_validation_retries_are_counted_as_codes_only():
    class FlakyOnce(replay.FakeInterpret):
        def __init__(self):
            super().__init__()
            self.failed = False

        async def __call__(self, *, prompt, user_id, output_schema):
            if not self.failed and json.loads(prompt).get("package_mode") == "page_facts":
                self.failed = True
                return {"pages": "not-a-list"}
            return await super().__call__(
                prompt=prompt, user_id=user_id, output_schema=output_schema
            )

    runner = ReplayRunner(
        interpret=FlakyOnce(), model="fixture-interpret", budget=Budget(max_usd=50)
    )
    result = await runner.run_owner_path(batch_id="B", cases=cases(1), runtime=RUNTIME)
    assert result.observations[0].status == "completed"
    # The runtime regenerated once; the retry is visible as a code, never as text.
    [(code, count)] = result.runtime_codes.items()
    assert code.startswith("drive_packet_model_validation:page_facts:model_") and code.endswith(
        ":1"
    )
    assert count == 1


class NamedHolder(replay.FakeInterpret):
    """The fixture model, reading every document as an account record of one
    synthetic holder, and a checker that never certifies a nonready proposal."""

    def _document_facts(self, request):
        answer = super()._document_facts(request)
        refs = [item["ref"] for item in request["citation_evidence"]][:1]
        if refs:
            answer["subject"] = {"value": "Jordan Sample", "citation_refs": refs}
            answer["account"] = {"value": "Account ending 4417", "citation_refs": refs}
        return answer

    def _verdict(self, request):
        answer = super()._verdict(request)
        if request["proposed_packet"].get("state") != "ready":
            answer.update(state="incomplete", issues=["Fixture proposal is not Ready."])
        return answer


async def test_owner_name_reaches_both_authored_assessments_in_replay():
    seen = []

    class Recording(NamedHolder):
        async def __call__(self, *, prompt, user_id, output_schema):
            request = json.loads(prompt)
            if "owner_identity" in request:
                seen.append(request["owner_identity"])
            return await super().__call__(
                prompt=prompt, user_id=user_id, output_schema=output_schema
            )

    owner = {"names": ["Avery Quill"]}
    runner = ReplayRunner(
        interpret=Recording(), model="fixture-interpret", budget=Budget(max_usd=50)
    )
    checked = await runner.run_owner_path(
        batch_id="B", cases=cases(1), runtime=RUNTIME, owner=owner
    )
    assert len(seen) >= 2 and all(value == owner for value in seen)
    # All-Ready fixtures do not establish semantic identity assurance. Their
    # judgments stay observable for independent evaluation, without host edits.
    assert [item.state for item in checked.packets] == ["ready"]


def test_run_batch_owner_listing_prefers_an_explicit_name():
    class Source:
        def owner_identity(self):
            return {"names": ["Name On File"]}

    explicit = cli.parser().parse_args(
        ["run-batch", "--workdir", "w", "--batch-id", "B", "--owner-name", " Avery Quill "]
    )
    plain = cli.parser().parse_args(["run-batch", "--workdir", "w", "--batch-id", "B"])
    assert cli._owner_listing(explicit, Source()) == ({"names": ["Avery Quill"]}, "explicit_name")
    assert cli._owner_listing(plain, Source()) == ({"names": ["Name On File"]}, "name_on_file")
    assert cli._owner_listing(plain, object()) == (None, "none")
