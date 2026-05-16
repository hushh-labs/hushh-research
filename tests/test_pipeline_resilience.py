"""Pipeline step-isolation resilience tests.

Verifies that a ValueError in a middle step does NOT contaminate surrounding
healthy steps, and that the final pipeline output preserves successfully
processed data.

[Pipeline Guard by Abdul Gaffar]
"""

from __future__ import annotations

from typing import Any


from hushh_mcp.services.pipeline import (
    ExecutionPipeline,
    FunctionStep,
    PipelineResult,
    StepResult,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _add_field(key: str, value: Any):
    def _step(data: dict[str, Any]) -> dict[str, Any]:
        return {**data, key: value}

    return _step


def _raise_value_error(msg: str = "intentional failure"):
    def _step(_data: dict[str, Any]) -> dict[str, Any]:
        raise ValueError(msg)

    return _step


def _raise_runtime_error(msg: str = "runtime failure"):
    def _step(_data: dict[str, Any]) -> dict[str, Any]:
        raise RuntimeError(msg)

    return _step


# ---------------------------------------------------------------------------
# TestSingleStepPipeline
# ---------------------------------------------------------------------------


class TestSingleStepPipeline:
    def test_single_healthy_step_succeeds(self):
        step = FunctionStep("add_x", _add_field("x", 1))
        pipeline = ExecutionPipeline([step])
        result = pipeline.run({})
        assert result.final_output == {"x": 1}
        assert result.failed_steps == []

    def test_single_failing_step_records_failure(self):
        step = FunctionStep("fail", _raise_value_error())
        pipeline = ExecutionPipeline([step])
        result = pipeline.run({})
        assert result.final_output == {}
        assert result.failed_steps == ["fail"]

    def test_single_step_result_has_correct_name(self):
        step = FunctionStep("named_step", _add_field("k", "v"))
        result = ExecutionPipeline([step]).run({})
        assert result.step_results[0].step_name == "named_step"

    def test_single_step_result_success_flag(self):
        step = FunctionStep("ok", _add_field("a", 1))
        result = ExecutionPipeline([step]).run({})
        assert result.step_results[0].success is True

    def test_single_failing_step_result_success_flag(self):
        step = FunctionStep("bad", _raise_value_error())
        result = ExecutionPipeline([step]).run({})
        assert result.step_results[0].success is False


# ---------------------------------------------------------------------------
# TestMiddleStepFailureIsolation  ← core requirement
# ---------------------------------------------------------------------------


class TestMiddleStepFailureIsolation:
    """Middle step raises ValueError; surrounding healthy steps must succeed."""

    def _build_pipeline(self) -> ExecutionPipeline:
        return ExecutionPipeline(
            [
                FunctionStep("step_one", _add_field("from_step_one", True)),
                FunctionStep("step_two_bad", _raise_value_error("intentional ValueError")),
                FunctionStep("step_three", _add_field("from_step_three", True)),
            ]
        )

    def test_final_output_contains_step_one_data(self):
        result = self._build_pipeline().run({})
        assert result.final_output.get("from_step_one") is True

    def test_final_output_contains_step_three_data(self):
        result = self._build_pipeline().run({})
        assert result.final_output.get("from_step_three") is True

    def test_failed_steps_contains_only_middle_step(self):
        result = self._build_pipeline().run({})
        assert result.failed_steps == ["step_two_bad"]

    def test_successful_outputs_excludes_failed_step(self):
        result = self._build_pipeline().run({})
        names = [r.step_name for r in result.step_results if r.success]
        assert "step_two_bad" not in names

    def test_step_results_length_equals_total_steps(self):
        result = self._build_pipeline().run({})
        assert len(result.step_results) == 3

    def test_middle_step_result_captures_exception(self):
        result = self._build_pipeline().run({})
        bad = next(r for r in result.step_results if r.step_name == "step_two_bad")
        assert isinstance(bad.error, ValueError)

    def test_step_three_output_is_superset_of_step_one_output(self):
        result = self._build_pipeline().run({"initial": 0})
        final = result.final_output
        assert "initial" in final
        assert "from_step_one" in final
        assert "from_step_three" in final

    def test_initial_data_preserved_through_failure(self):
        result = self._build_pipeline().run({"seed": "root"})
        assert result.final_output.get("seed") == "root"


# ---------------------------------------------------------------------------
# TestMultipleFailures
# ---------------------------------------------------------------------------


class TestMultipleFailures:
    def test_all_failing_steps_returns_empty_final_output(self):
        pipeline = ExecutionPipeline(
            [
                FunctionStep("f1", _raise_value_error()),
                FunctionStep("f2", _raise_value_error()),
                FunctionStep("f3", _raise_value_error()),
            ]
        )
        result = pipeline.run({"seed": 1})
        assert result.final_output == {}

    def test_all_failing_steps_records_all_in_failed_steps(self):
        pipeline = ExecutionPipeline(
            [
                FunctionStep("f1", _raise_value_error()),
                FunctionStep("f2", _raise_value_error()),
            ]
        )
        result = pipeline.run({})
        assert set(result.failed_steps) == {"f1", "f2"}

    def test_first_and_last_fail_middle_succeeds(self):
        pipeline = ExecutionPipeline(
            [
                FunctionStep("bad_first", _raise_value_error()),
                FunctionStep("ok_mid", _add_field("mid", True)),
                FunctionStep("bad_last", _raise_value_error()),
            ]
        )
        result = pipeline.run({})
        assert result.final_output.get("mid") is True
        assert "bad_first" in result.failed_steps
        assert "bad_last" in result.failed_steps

    def test_consecutive_failures_do_not_cascade(self):
        pipeline = ExecutionPipeline(
            [
                FunctionStep("ok", _add_field("v", 42)),
                FunctionStep("bad1", _raise_value_error()),
                FunctionStep("bad2", _raise_runtime_error()),
                FunctionStep("ok2", _add_field("w", 99)),
            ]
        )
        result = pipeline.run({})
        assert result.final_output.get("v") == 42
        assert result.final_output.get("w") == 99

    def test_successful_outputs_list_length(self):
        pipeline = ExecutionPipeline(
            [
                FunctionStep("ok1", _add_field("a", 1)),
                FunctionStep("bad", _raise_value_error()),
                FunctionStep("ok2", _add_field("b", 2)),
            ]
        )
        result = pipeline.run({})
        assert len(result.successful_outputs) == 2


# ---------------------------------------------------------------------------
# TestEmptyPipeline
# ---------------------------------------------------------------------------


class TestEmptyPipeline:
    def test_empty_pipeline_returns_empty_final_output(self):
        result = ExecutionPipeline([]).run({"x": 1})
        assert result.final_output == {}

    def test_empty_pipeline_no_failed_steps(self):
        result = ExecutionPipeline([]).run({})
        assert result.failed_steps == []

    def test_empty_pipeline_no_step_results(self):
        result = ExecutionPipeline([]).run({})
        assert result.step_results == []


# ---------------------------------------------------------------------------
# TestInitialDataPassthrough
# ---------------------------------------------------------------------------


class TestInitialDataPassthrough:
    def test_initial_data_available_to_first_step(self):
        step = FunctionStep("s", lambda d: {**d, "appended": True})
        result = ExecutionPipeline([step]).run({"existing": 7})
        assert result.final_output["existing"] == 7
        assert result.final_output["appended"] is True

    def test_step_output_does_not_mutate_initial_data(self):
        initial = {"x": 1}
        step = FunctionStep("mutator", lambda d: {**d, "x": 999})
        ExecutionPipeline([step]).run(initial)
        assert initial["x"] == 1

    def test_failed_step_does_not_mutate_data_for_next_step(self):
        results_seen: list[dict] = []

        def capturing_step(data: dict[str, Any]) -> dict[str, Any]:
            results_seen.append(dict(data))
            return data

        pipeline = ExecutionPipeline(
            [
                FunctionStep("ok1", _add_field("a", 1)),
                FunctionStep("bad", _raise_value_error()),
                FunctionStep("capture", capturing_step),
            ]
        )
        pipeline.run({})
        assert results_seen[0].get("a") == 1
        assert "bad_marker" not in results_seen[0]


# ---------------------------------------------------------------------------
# TestStepResultDataclass
# ---------------------------------------------------------------------------


class TestStepResultDataclass:
    def test_step_result_success_has_no_error(self):
        step = FunctionStep("ok", _add_field("x", 1))
        result = ExecutionPipeline([step]).run({})
        sr = result.step_results[0]
        assert sr.error is None

    def test_step_result_failure_has_error(self):
        step = FunctionStep("bad", _raise_value_error("boom"))
        result = ExecutionPipeline([step]).run({})
        sr = result.step_results[0]
        assert sr.error is not None
        assert "boom" in str(sr.error)

    def test_step_result_failure_has_no_output(self):
        step = FunctionStep("bad", _raise_value_error())
        result = ExecutionPipeline([step]).run({})
        sr = result.step_results[0]
        assert sr.output is None

    def test_step_result_success_has_output(self):
        step = FunctionStep("ok", _add_field("y", 2))
        result = ExecutionPipeline([step]).run({})
        sr = result.step_results[0]
        assert sr.output == {"y": 2}


# ---------------------------------------------------------------------------
# TestPipelineResultDataclass
# ---------------------------------------------------------------------------


class TestPipelineResultDataclass:
    def test_pipeline_result_is_dataclass(self):
        result = ExecutionPipeline([]).run({})
        assert isinstance(result, PipelineResult)

    def test_successful_outputs_is_list(self):
        result = ExecutionPipeline([]).run({})
        assert isinstance(result.successful_outputs, list)

    def test_failed_steps_is_list(self):
        result = ExecutionPipeline([]).run({})
        assert isinstance(result.failed_steps, list)

    def test_step_results_is_list_of_step_result(self):
        step = FunctionStep("ok", _add_field("z", 3))
        result = ExecutionPipeline([step]).run({})
        assert all(isinstance(r, StepResult) for r in result.step_results)


# ---------------------------------------------------------------------------
# TestRuntimeErrorIsolation
# ---------------------------------------------------------------------------


class TestRuntimeErrorIsolation:
    def test_runtime_error_is_isolated_same_as_value_error(self):
        pipeline = ExecutionPipeline(
            [
                FunctionStep("ok", _add_field("a", 1)),
                FunctionStep("runtime_bad", _raise_runtime_error()),
                FunctionStep("ok2", _add_field("b", 2)),
            ]
        )
        result = pipeline.run({})
        assert result.final_output.get("a") == 1
        assert result.final_output.get("b") == 2

    def test_runtime_error_recorded_in_failed_steps(self):
        pipeline = ExecutionPipeline(
            [
                FunctionStep("runtime_bad", _raise_runtime_error("rt fail")),
            ]
        )
        result = pipeline.run({})
        assert "runtime_bad" in result.failed_steps

    def test_mixed_exception_types_all_isolated(self):
        pipeline = ExecutionPipeline(
            [
                FunctionStep("ve", _raise_value_error()),
                FunctionStep("re", _raise_runtime_error()),
                FunctionStep("te", FunctionStep("_", lambda _: (_ for _ in ()).throw(TypeError("t"))).execute),
            ]
        )
        result = pipeline.run({})
        assert len(result.failed_steps) == 3


# ---------------------------------------------------------------------------
# TestTrustBoundaryProof
# ---------------------------------------------------------------------------


class TestTrustBoundaryProof:
    """Canonical trust-boundary proof — pipeline isolation chain.

    Caller chain:
        test suite
        → ExecutionPipeline.run()
        → FunctionStep.execute()  [per-step isolated try/except]
        → hushh_mcp.services.pipeline
        [Pipeline Guard by Abdul Gaffar]
    """

    def test_canonical_three_step_sequence_with_middle_failure(self):
        """Golden-path proof: healthy → ValueError → healthy produces correct output."""
        pipeline = ExecutionPipeline(
            [
                FunctionStep("healthy_first", _add_field("healthy_first_ran", True)),
                FunctionStep("failing_middle", _raise_value_error("intentional ValueError")),
                FunctionStep("healthy_last", _add_field("healthy_last_ran", True)),
            ]
        )
        result = pipeline.run({"initial_seed": "proof"})

        # Healthy steps must be present in final output
        assert result.final_output["healthy_first_ran"] is True
        assert result.final_output["healthy_last_ran"] is True
        assert result.final_output["initial_seed"] == "proof"

        # Middle step must be recorded as failed
        assert result.failed_steps == ["failing_middle"]

        # Exactly one failed step across three-step sequence
        failed_results = [r for r in result.step_results if not r.success]
        assert len(failed_results) == 1
        assert isinstance(failed_results[0].error, ValueError)

        # Two successful outputs collected
        assert len(result.successful_outputs) == 2

    def test_pipeline_guard_signature_in_module_docstring(self):
        import hushh_mcp.services.pipeline as pipeline_mod

        assert "[Pipeline Guard by Abdul Gaffar]" in (pipeline_mod.__doc__ or "")
