"""Continuation reuses evidence, never fallback meaning or action authority."""

from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.pkm_preview_continuation import (
    PREFIX_AGENTS,
    PreviewContinuation,
)

SCHEMA = {"type": "OBJECT", "properties": {"value": {"type": "STRING"}}, "required": ["value"]}


def arguments(agent="agent_memory_intent"):
    return dict(
        manifest=SimpleNamespace(id=agent, model="test", system_instruction="instruction"),
        prompt="synthetic context",
        response_schema=deepcopy(SCHEMA),
        execution_trace=[],
    )


@pytest.mark.asyncio
async def test_reuses_exact_validated_output_with_honest_trace_and_deep_copy():
    runner = AsyncMock(return_value={"value": "synthetic"})
    first = PreviewContinuation(run=runner, resolve_model=lambda *_: "test")
    args = arguments()
    result = await first.run(**args)
    result["value"] = "mutated"
    second = PreviewContinuation(run=runner, resolve_model=lambda *_: "test", records=first.records)
    assert await second.run(**args) == {"value": "synthetic"}
    assert runner.await_count == 1
    assert args["execution_trace"][-1]["status"] == "reused"
    assert args["execution_trace"][-1]["attempts"] == 0
    assert args["execution_trace"][-1]["latency_ms"] == 0
    assert "original_latency_ms" in args["execution_trace"][-1]
    assert "synthetic" not in str(args["execution_trace"])


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["prompt", "model", "instruction", "schema", "invalid_value"])
async def test_changed_contract_or_invalid_cached_value_runs_model_again(change):
    runner = AsyncMock(return_value={"value": "synthetic"})
    first = PreviewContinuation(run=runner, resolve_model=lambda *_: "test")
    args = arguments()
    await first.run(**args)
    model = "test"
    if change == "prompt":
        args["prompt"] += " changed"
    elif change == "model":
        model = "other"
    elif change == "instruction":
        args["manifest"].system_instruction += " changed"
    elif change == "schema":
        args["response_schema"]["additionalProperties"] = False
    else:
        first.records["agent_memory_intent"]["value"] = {"value": 42}
    second = PreviewContinuation(run=runner, resolve_model=lambda *_: model, records=first.records)
    await second.run(**args)
    assert runner.await_count == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("result", [None, {}, {"value": 42}])
async def test_invalid_model_output_is_never_retained(result):
    continuation = PreviewContinuation(
        run=AsyncMock(return_value=result), resolve_model=lambda *_: "test"
    )
    await continuation.run(**arguments())
    assert not continuation.records


@pytest.mark.asyncio
async def test_structure_always_runs_fresh():
    runner = AsyncMock(return_value={"value": "synthetic"})
    continuation = PreviewContinuation(run=runner, resolve_model=lambda *_: "test")
    await continuation.run(**arguments("agent_pkm_structure"))
    await continuation.run(**arguments("agent_pkm_structure"))
    assert runner.await_count == 2
    assert not continuation.records


def checkpoint_fixture():
    intent = {
        "save_class": "durable",
        "intent_class": "profile_fact",
        "mutation_intent": "create",
        "candidate_domain_choices": [{"domain_key": "professional"}],
    }
    merge = {
        "merge_mode": "create_entity",
        "target_domain": "professional",
        "target_entity_id": "synthetic",
        "target_entity_path": "profile.synthetic",
        "match_reason": "New synthetic fact",
    }
    records = {agent: {"value": {}} for agent in PREFIX_AGENTS}
    records["agent_memory_segmentation"]["value"] = {
        "segments": [{"source_text": "synthetic"}],
        "has_more_candidates": False,
    }
    records["agent_financial_guard"]["value"] = {"routing_decision": "non_financial_or_ephemeral"}
    records["agent_memory_intent"]["value"] = deepcopy(intent)
    records["agent_memory_merge"]["value"] = deepcopy(merge)
    response = {
        "routing_decision": "non_financial_or_ephemeral",
        "intent_frame": intent,
        "merge_decision": merge,
        "preview_cards": [{}],
        "error": "pkm_structure_agent_fallback",
    }
    trace = [{"agent_id": "agent_pkm_structure", "status": "timeout"}]
    return records, response, trace


@pytest.mark.parametrize("domain", ["general", "!!!", "professional"])
def test_checkpoint_rejects_domain_substitution_by_actual_intent_normalizer(domain):
    from hushh_mcp.services.pkm_agent_lab_service import PKMAgentLabService

    records, response, trace = checkpoint_fixture()
    registry = [
        {
            "domain_key": "professional",
            "display_name": "Professional",
            "description": "Work details",
        }
    ]
    intent = records["agent_memory_intent"]["value"]
    intent.update(
        requires_confirmation=False,
        confirmation_reason="",
        confidence=0.95,
        source_agent="memory_intent_agent",
        contract_version=1,
    )
    intent["candidate_domain_choices"] = [{"domain_key": domain, "recommended": True}]
    fallback = deepcopy(intent)
    fallback["candidate_domain_choices"] = [{"domain_key": "professional", "recommended": True}]
    response["intent_frame"] = PKMAgentLabService._sanitize_intent_frame(
        message="My synthetic project is Cedar Lantern.",
        raw=intent,
        fallback=fallback,
        registry_choices=registry,
        current_domains=[],
    )
    continuation = PreviewContinuation(
        run=AsyncMock(), resolve_model=lambda *_: "test", records=records
    )
    checkpoint = continuation.checkpoint(message="synthetic", response=response, trace=trace)
    assert (checkpoint is not None) is (domain == "professional")


def test_checkpoint_only_accepts_exact_single_segment_final_timeout():
    records, response, trace = checkpoint_fixture()
    continuation = PreviewContinuation(
        run=AsyncMock(), resolve_model=lambda *_: "test", records=records
    )
    assert continuation.checkpoint(message="synthetic", response=response, trace=trace) == records
    assert continuation.checkpoint(message=" synthetic", response=response, trace=trace) is None
    assert continuation.checkpoint(message="synthetic", response=response, trace=[]) is None


@pytest.mark.parametrize(
    "sources, selected",
    [
        (["synthetic", "other"], "absent"),
        (["synthetic", "synthetic"], "synthetic"),
        (["synthetic", "invented"], "synthetic"),
    ],
)
def test_segment_checkpoint_rejects_ambiguous_or_ungrounded_spans(sources, selected):
    records, response, trace = checkpoint_fixture()
    records["agent_memory_segmentation"]["value"]["segments"] = [
        {"source_text": source} for source in sources
    ]
    continuation = PreviewContinuation(
        run=AsyncMock(), resolve_model=lambda *_: "test", records=records
    )
    assert (
        continuation.checkpoint(
            message="synthetic other", segment_source=selected, response=response, trace=trace
        )
        is None
    )


def test_merge_timeout_retains_only_validated_pre_merge_decisions():
    records, response, _ = checkpoint_fixture()
    del records["agent_memory_merge"]
    response.update(
        merge_used_fallback=True,
        error="memory_merge_agent_fallback; pkm_structure_agent_fallback",
    )
    trace = [
        {"agent_id": "agent_memory_merge", "status": "timeout"},
        {"agent_id": "agent_pkm_structure", "status": "budget_exhausted"},
    ]
    continuation = PreviewContinuation(
        run=AsyncMock(), resolve_model=lambda *_: "test", records=records
    )
    checkpoint = continuation.checkpoint(message="synthetic", response=response, trace=trace)
    assert checkpoint == records
    assert "agent_memory_merge" not in checkpoint

    response["routing_decision"] = "financial_core"
    assert continuation.checkpoint(message="synthetic", response=response, trace=trace) is None
    response["routing_decision"] = "non_financial_or_ephemeral"
    response["error"] = "memory_merge_agent_fallback; memory_intent_agent_fallback"
    assert continuation.checkpoint(message="synthetic", response=response, trace=trace) is None
    response["error"] = "memory_merge_agent_fallback; pkm_structure_agent_fallback"
    assert continuation.checkpoint(message="synthetic", response=response, trace=trace[:1]) is None


def test_intent_timeout_retains_only_validated_pre_intent_decisions():
    records, response, _ = checkpoint_fixture()
    del records["agent_memory_intent"]
    del records["agent_memory_merge"]
    response.update(
        used_fallback=True,
        intent_used_fallback=True,
        error="memory_intent_agent_fallback; memory_merge_agent_fallback; pkm_structure_agent_fallback",
    )
    trace = [{"agent_id": "agent_memory_intent", "status": "timeout"}]
    continuation = PreviewContinuation(
        run=AsyncMock(), resolve_model=lambda *_: "test", records=records
    )
    assert continuation.checkpoint(message="synthetic", response=response, trace=trace) == records
    assert continuation.checkpoint(message=" synthetic", response=response, trace=trace) is None
    assert continuation.checkpoint(message="synthetic", response=response, trace=[]) is None
    trace[0]["status"] = "invalid_response"
    assert continuation.checkpoint(message="synthetic", response=response, trace=trace) is None
    trace[0]["status"] = "timeout"
    response["routing_decision"] = "financial_core"
    assert continuation.checkpoint(message="synthetic", response=response, trace=trace) is None
    response["routing_decision"] = "non_financial_or_ephemeral"
    response["error"] += "; financial_guard_agent_fallback"
    assert continuation.checkpoint(message="synthetic", response=response, trace=trace) is None


def test_guard_timeout_retains_only_exact_validated_segmentation():
    records, response, _ = checkpoint_fixture()
    records = {"agent_memory_segmentation": records["agent_memory_segmentation"]}
    response.update(
        used_fallback=True, error="financial_guard_agent_fallback; memory_intent_agent_fallback"
    )
    trace = [{"agent_id": "agent_financial_guard", "status": "timeout"}]
    continuation = PreviewContinuation(
        run=AsyncMock(), resolve_model=lambda *_: "test", records=records
    )
    checkpoint = continuation.checkpoint(message="synthetic", response=response, trace=trace)
    assert checkpoint == records
    assert set(checkpoint) == {"agent_memory_segmentation"}
    assert continuation.checkpoint(message="changed", response=response, trace=trace) is None
    assert continuation.checkpoint(message="synthetic", response=response, trace=[]) is None
    for status in ("invalid_response", "success", "error"):
        assert (
            continuation.checkpoint(
                message="synthetic",
                response=response,
                trace=[
                    {
                        "agent_id": "agent_financial_guard",
                        "status": status,
                    }
                ],
            )
            is None
        )
    for change in (
        {"used_fallback": False},
        {"error": "memory_intent_agent_fallback"},
        {"error": "financial_guard_agent_fallback; memory_segmentation_agent_fallback"},
        {"preview_cards": [{}, {}]},
    ):
        assert (
            continuation.checkpoint(
                message="synthetic", response={**response, **change}, trace=trace
            )
            is None
        )
    checkpoint["agent_memory_segmentation"]["value"]["segments"].clear()
    assert len(continuation.records["agent_memory_segmentation"]["value"]["segments"]) == 1


@pytest.mark.parametrize(
    "defect",
    [
        "empty_choices",
        "empty_domain",
        "empty_path",
        "substituted_reason",
        "intent_changed",
        "extra_card",
        "other_failure",
        "missing_stage",
    ],
)
def test_checkpoint_rejects_fallback_meaning_and_incomplete_prefix(defect):
    records, response, trace = checkpoint_fixture()
    if defect == "empty_choices":
        records["agent_memory_intent"]["value"]["candidate_domain_choices"] = []
    elif defect in {"empty_domain", "empty_path"}:
        records["agent_memory_merge"]["value"][
            "target_domain" if defect == "empty_domain" else "target_entity_path"
        ] = ""
    elif defect == "substituted_reason":
        response["merge_decision"]["match_reason"] = "fallback"
    elif defect == "intent_changed":
        response["intent_frame"]["mutation_intent"] = "extend"
    elif defect == "extra_card":
        response["preview_cards"].append({})
    elif defect == "other_failure":
        response["error"] += ";memory_intent_agent_fallback"
    else:
        del records["agent_memory_intent"]
    continuation = PreviewContinuation(
        run=AsyncMock(), resolve_model=lambda *_: "test", records=records
    )
    assert continuation.checkpoint(message="synthetic", response=response, trace=trace) is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "changed,failure_mode",
    [
        (change, "intent_merge")
        for change in [None, "owner", "credential", "message", "state", "expired", "retry_timeout"]
    ]
    + [(None, "guard"), (None, "mixed")],
)
async def test_multiple_candidates_keep_independent_retry_prefixes(
    monkeypatch, changed, failure_mode
):
    from collections import Counter

    from hushh_mcp.services import pkm_agent_lab_service as module

    module._PREVIEW_CACHE.clear()
    module._PREVIEW_INFLIGHT.clear()
    service = module.PKMAgentLabService()
    sources = ["My synthetic project is Cedar Lantern.", "My synthetic project is Harbor Light."]
    calls = Counter()

    async def run(**kwargs):
        agent = kwargs["manifest"].id
        if agent == "agent_memory_segmentation":
            calls[(agent, "batch")] += 1
            return {
                "segments": [
                    {"source_text": text, "confidence": 0.95, "reason": "Distinct fact"}
                    for text in sources
                ],
                "has_more_candidates": False,
                "source_agent": "memory_segmentation_agent",
                "contract_version": 1,
            }
        source = next(text for text in sources if text in kwargs["prompt"])
        index = sources.index(source)
        calls[(agent, source)] += 1
        first = calls[(agent, source)] == 1
        failure = (
            (changed == "retry_timeout" and agent == "agent_pkm_structure")
            or first
            and (
                agent == "agent_pkm_structure"
                or agent == "agent_memory_merge"
                or (index == 0 and agent == "agent_memory_intent")
            )
        )
        if failure_mode == "guard":
            failure = first
        elif failure_mode == "mixed" and index == 0:
            failure = False
        if failure:
            kwargs["execution_trace"].append(
                {
                    "agent_id": agent,
                    "status": "budget_exhausted" if agent == "agent_pkm_structure" else "timeout",
                }
            )
            return None
        if agent == "agent_financial_guard":
            return {
                "routing_decision": "non_financial_or_ephemeral",
                "confidence": 0.95,
                "reason": "Work detail",
                "source_agent": "financial_guard_agent",
                "contract_version": 1,
            }
        records, _, _ = checkpoint_fixture()
        if agent == "agent_memory_intent":
            value = records[agent]["value"]
            value.update(
                requires_confirmation=False,
                confirmation_reason="",
                confidence=0.95,
                source_agent="memory_intent_agent",
                contract_version=1,
            )
            value["candidate_domain_choices"][0].update(
                display_name="Professional", description="Work", recommended=True
            )
            return value
        if agent == "agent_memory_merge":
            value = records[agent]["value"]
            value.update(
                target_entity_id=f"project_{index}",
                target_entity_path=f"profile.project_{index}",
                match_confidence=0.95,
                source_agent="memory_merge_agent",
                contract_version=1,
            )
            return value
        return {
            "candidate_payload": {"profile": {f"project_{index}": {"summary": source}}},
            "structure_decision": {
                "action": "create_domain",
                "target_domain": "professional",
                "json_paths": [f"profile.project_{index}.summary"],
                "top_level_scope_paths": ["profile"],
                "externalizable_paths": [f"profile.project_{index}.summary"],
                "summary_projection": {},
                "sensitivity_labels": {},
                "confidence": 0.95,
                "source_agent": "pkm_structure_agent",
                "contract_version": 1,
            },
            "write_mode": "confirm_first",
            "primary_json_path": "profile",
            "target_entity_scope": "profile",
            "validation_hints": [],
        }

    monkeypatch.setattr(service, "_run_agent_contract", run)
    request = {
        "user_id": "synthetic-owner",
        "message": " ".join(sources),
        "continuation_scope": "credential-hash",
    }
    first = await service.generate_structure_preview(**request)
    assert first["used_fallback"] is True
    cached = next(iter(module._PREVIEW_CACHE.values()))
    assert len(cached[1]["__validated_preparation_prefix"]["__segments"]) == (
        1 if failure_mode == "mixed" else 2
    )
    assert all("candidate_index" in row for row in first["performance"]["agent_execution"])
    if changed == "owner":
        request["user_id"] = "other-owner"
    elif changed == "credential":
        request["continuation_scope"] = "other-credential"
    elif changed == "message":
        request["message"] += " "
    elif changed == "state":
        request["simulated_state"] = {"revision": 2}
    elif changed == "expired":
        key = next(iter(module._PREVIEW_CACHE))
        module._PREVIEW_CACHE[key] = (0, module._PREVIEW_CACHE[key][1])
    second = await service.generate_structure_preview(**request)
    reusable = changed in {None, "retry_timeout"}
    assert second["used_fallback"] is (changed == "retry_timeout")
    assert calls[("agent_memory_segmentation", "batch")] == (1 if reusable else 2)
    for index, source in enumerate(sources):
        guard_reused = (
            reusable and failure_mode != "guard" and not (failure_mode == "mixed" and index == 0)
        )
        assert calls[("agent_financial_guard", source)] == (1 if guard_reused else 2)
        assert calls[("agent_memory_merge", source)] == 2
    assert calls[("agent_memory_intent", sources[0])] == 2
    assert calls[("agent_memory_intent", sources[1])] == (
        1 if reusable and failure_mode != "guard" else 2
    )
    for index, card in enumerate(second["preview_cards"]):
        assert card["source_text"] == sources[index]
        assert sources[index] in str(card["resulting_domain_patch"])
        assert sources[1 - index] not in str(card["resulting_domain_patch"])
    assert "__segments" not in second
    if changed == "retry_timeout":
        assert next(iter(module._PREVIEW_CACHE.values()))[0] == cached[0]
    module._PREVIEW_CACHE.clear()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "changed",
    [
        None,
        "owner",
        "credential",
        "message",
        "state",
        "trace",
        "success",
        "merge_timeout",
        "intent_timeout",
        "guard_timeout",
        "expired",
        "unbound",
    ],
)
async def test_real_preview_retry_reuses_only_same_request_validated_prefix(monkeypatch, changed):
    from hushh_mcp.services import pkm_agent_lab_service as module

    module._PREVIEW_CACHE.clear()
    module._PREVIEW_INFLIGHT.clear()
    service = module.PKMAgentLabService()
    message = "My synthetic project is Cedar Lantern."
    records, _, _ = checkpoint_fixture()
    intent = records["agent_memory_intent"]["value"]
    intent.update(
        requires_confirmation=False,
        confirmation_reason="",
        confidence=0.95,
        source_agent="memory_intent_agent",
        contract_version=1,
    )
    intent["candidate_domain_choices"][0].update(
        display_name="Professional", description="Work details", recommended=True
    )
    merge = records["agent_memory_merge"]["value"]
    merge.update(match_confidence=0.95, source_agent="memory_merge_agent", contract_version=1)
    responses = {
        "agent_memory_segmentation": {
            "segments": [
                {"source_text": message, "confidence": 0.95, "reason": "One synthetic fact"}
            ],
            "has_more_candidates": False,
            "source_agent": "memory_segmentation_agent",
            "contract_version": 1,
        },
        "agent_financial_guard": {
            "routing_decision": "non_financial_or_ephemeral",
            "confidence": 0.95,
            "reason": "Work detail",
            "source_agent": "financial_guard_agent",
            "contract_version": 1,
        },
        "agent_memory_intent": intent,
        "agent_memory_merge": merge,
    }
    calls = []

    async def run(**kwargs):
        agent = kwargs["manifest"].id
        calls.append(agent)
        if (
            changed == "guard_timeout"
            and agent != "agent_memory_segmentation"
            and calls.count(agent) == 1
        ):
            kwargs["execution_trace"].append(
                {
                    "agent_id": agent,
                    "status": "timeout" if agent == "agent_financial_guard" else "budget_exhausted",
                    "attempts": 1 if agent == "agent_financial_guard" else 0,
                    "latency_ms": 1,
                }
            )
            return None
        if (
            changed == "intent_timeout"
            and agent == "agent_memory_intent"
            and calls.count(agent) == 1
        ):
            kwargs["execution_trace"].append(
                {"agent_id": agent, "status": "timeout", "attempts": 1, "latency_ms": 1}
            )
            return None
        if (
            changed == "intent_timeout"
            and agent == "agent_memory_merge"
            and calls.count(agent) == 1
        ):
            kwargs["execution_trace"].append(
                {"agent_id": agent, "status": "budget_exhausted", "attempts": 0, "latency_ms": 1}
            )
            return None
        if changed == "merge_timeout" and agent == "agent_memory_merge" and calls.count(agent) == 1:
            kwargs["execution_trace"].append(
                {"agent_id": agent, "status": "timeout", "attempts": 1, "latency_ms": 1}
            )
            return None
        if (
            changed in {"success", "merge_timeout", "intent_timeout", "guard_timeout"}
            and agent == "agent_pkm_structure"
            and (
                changed == "success"
                and len(calls) == 6
                or changed == "merge_timeout"
                and len(calls) == 7
                or changed == "intent_timeout"
                and len(calls) == 8
                or changed == "guard_timeout"
                and len(calls) == 9
            )
        ):
            return {
                "candidate_payload": {"profile": {"synthetic": {"project": "Cedar Lantern"}}},
                "structure_decision": {
                    "action": "create_domain",
                    "target_domain": "professional",
                    "json_paths": ["profile.synthetic.project"],
                    "top_level_scope_paths": ["profile"],
                    "externalizable_paths": ["profile.synthetic.project"],
                    "summary_projection": {},
                    "sensitivity_labels": {},
                    "confidence": 0.95,
                    "source_agent": "pkm_structure_agent",
                    "contract_version": 1,
                },
                "write_mode": "can_save",
                "primary_json_path": "profile",
                "target_entity_scope": "profile",
                "validation_hints": [],
            }
        kwargs["execution_trace"].append(
            {
                "agent_id": agent,
                "status": (
                    "budget_exhausted"
                    if changed in {"merge_timeout", "intent_timeout"}
                    and agent == "agent_pkm_structure"
                    else "timeout"
                    if agent == "agent_pkm_structure"
                    else "success"
                ),
                "attempts": 1,
                "latency_ms": 1,
                "error_type": "",
            }
        )
        return deepcopy(responses.get(agent))

    monkeypatch.setattr(service, "_run_agent_contract", run)
    request = dict(
        user_id="synthetic-owner",
        message=message,
        current_domains=[],
        continuation_scope="credential-hash",
    )
    if changed == "unbound":
        request["continuation_scope"] = None
    first = await service.generate_structure_preview(**request)
    assert first["error"] == (
        "financial_guard_agent_fallback; memory_intent_agent_fallback; memory_merge_agent_fallback; pkm_structure_agent_fallback"
        if changed == "guard_timeout"
        else "memory_merge_agent_fallback; pkm_structure_agent_fallback"
        if changed == "merge_timeout"
        else "memory_intent_agent_fallback; memory_merge_agent_fallback; pkm_structure_agent_fallback"
        if changed == "intent_timeout"
        else "pkm_structure_agent_fallback"
    )
    assert len(calls) == 5
    assert len(module._PREVIEW_CACHE) == (0 if changed == "unbound" else 1)
    expiry = next(iter(module._PREVIEW_CACHE.values()))[0] if module._PREVIEW_CACHE else None
    if changed == "owner":
        request["user_id"] = "other-owner"
    elif changed == "credential":
        request["continuation_scope"] = "other-hash"
    elif changed == "message":
        request["message"] += " "
    elif changed == "state":
        request["simulated_state"] = {"revision": 2}
    elif changed == "trace":
        request["capture_execution_trace"] = True
    elif changed == "expired":
        key = next(iter(module._PREVIEW_CACHE))
        module._PREVIEW_CACHE[key] = (0, module._PREVIEW_CACHE[key][1])
    second = await service.generate_structure_preview(**request)
    assert len(calls) == (
        9
        if changed == "guard_timeout"
        else 8
        if changed == "intent_timeout"
        else 7
        if changed == "merge_timeout"
        else 6
        if changed in {None, "success"}
        else 10
    )
    assert "__validated_preparation_prefix" not in second
    if changed is None:
        assert next(iter(module._PREVIEW_CACHE.values()))[0] == expiry
        assert calls[-1] == "agent_pkm_structure"
        outcomes = second["performance"]["agent_execution"]
        assert [row["status"] for row in outcomes] == ["reused"] * 4 + ["timeout"]
    if changed == "success":
        assert second["used_fallback"] is False
        assert second["error"] is None
        assert second["candidate_payload"]["profile"]["synthetic"]["project"] == "Cedar Lantern"
        assert "__validated_preparation_prefix" not in next(iter(module._PREVIEW_CACHE.values()))[1]
    if changed == "merge_timeout":
        assert calls[-2:] == ["agent_memory_merge", "agent_pkm_structure"]
        assert [row["status"] for row in second["performance"]["agent_execution"][:3]] == [
            "reused",
            "reused",
            "reused",
        ]
        assert second["used_fallback"] is False
        assert second["error"] is None
    if changed == "intent_timeout":
        assert calls[-3:] == ["agent_memory_intent", "agent_memory_merge", "agent_pkm_structure"]
        assert [row["status"] for row in second["performance"]["agent_execution"][:2]] == [
            "reused",
            "reused",
        ]
        assert second["used_fallback"] is False
        assert second["error"] is None
    if changed == "guard_timeout":
        assert calls.count("agent_memory_segmentation") == 1
        assert calls[-4:] == [
            "agent_financial_guard",
            "agent_memory_intent",
            "agent_memory_merge",
            "agent_pkm_structure",
        ]
        assert second["performance"]["agent_execution"][0]["status"] == "reused"
        assert second["used_fallback"] is False
        assert second["error"] is None
    module._PREVIEW_CACHE.clear()
