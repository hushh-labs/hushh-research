"""Native task generation compatibility; the original output validator owns acceptance."""

from __future__ import annotations

import logging
from copy import deepcopy
from typing import TYPE_CHECKING, Any

from google.adk.models.llm_request import LlmRequest
from google.genai import types
from pydantic import ValidationError

from hushh_mcp.one_adk.world_model_contracts import WorldModelReport

if TYPE_CHECKING:
    from hushh_mcp.hushh_adk.turn import SpecialistAdkTurn

logger = logging.getLogger(__name__)


def _generation_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Project schema nodes only, preserving property names and literal information.

    Vertex rejects this nested task schema under forced function calling with
    array bounds. The original FinishTaskTool/Pydantic adapter still enforces
    every bound, including exactly 20 coverage rows, before task completion.
    """
    result = deepcopy(schema)
    result.pop("minItems", None)
    result.pop("maxItems", None)
    for key in ("properties", "$defs"):
        if key in result:
            result[key] = {name: _generation_schema(value) for name, value in result[key].items()}
    if isinstance(result.get("items"), dict):
        result["items"] = _generation_schema(result["items"])
    for key in ("anyOf", "oneOf", "allOf"):
        if key in result:
            result[key] = [_generation_schema(value) for value in result[key]]
    return result


def force_native_completion(request: LlmRequest) -> None:
    """Constrain the existing task call without changing tools or acceptance authority."""
    tools: list[types.Tool] = []
    for tool in request.config.tools or []:
        if not isinstance(tool, types.Tool):
            raise ValueError("Native research completion requires resolved tool declarations")
        tools.append(tool.model_copy(deep=True))
    expected = WorldModelReport.model_json_schema()
    declarations = [
        declaration
        for tool in tools
        for declaration in tool.function_declarations or []
        if declaration.name == "finish_task"
    ]
    if len(declarations) != 1 or declarations[0].parameters_json_schema != expected:
        raise ValueError("Native research completion schema differs from its validator")
    declarations[0].parameters_json_schema = _generation_schema(expected)
    request.config.tools = [tool for tool in tools]
    request.config.tool_config = types.ToolConfig(
        function_calling_config=types.FunctionCallingConfig(
            mode=types.FunctionCallingConfigMode.ANY, allowed_function_names=["finish_task"]
        )
    )
    logger.info("world_model.generation_schema profile=native_finish_arrays_v1")


def _without_null_fields(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _without_null_fields(item) for key, item in value.items() if item is not None}
    if isinstance(value, list):
        return [_without_null_fields(item) for item in value]
    return value


def validated_native_report(turn: SpecialistAdkTurn) -> WorldModelReport:
    """Recover explicit nulls lost by ADK's task output projection from its receipts.

    Only an already successful finish_task receipt can restore them. Every
    non-null value must match event.output, and the original validator reruns.
    No missing model decision or nonempty value can be supplied or replaced.
    """
    from google.adk.agents.llm.task._finish_task_tool import FINISH_TASK_SUCCESS_RESULT

    try:
        return WorldModelReport.model_validate(turn.structured_output)
    except ValidationError:
        calls = [call for call in turn.tool_calls if call.name == "finish_task"]
        call = calls[-1] if calls else None
        if call is None or not any(
            result.name == "finish_task"
            and result.id == call.id
            and result.response == {"result": FINISH_TASK_SUCCESS_RESULT}
            for result in turn.tool_results
        ):
            raise
        report = WorldModelReport.model_validate(call.args)
        if turn.structured_output != _without_null_fields(report.model_dump()):
            raise ValueError(
                "Native research task output differs from its validated receipt"
            ) from None
        logger.info("world_model.output_restored reason=explicit_null_projection_loss")
        return report
