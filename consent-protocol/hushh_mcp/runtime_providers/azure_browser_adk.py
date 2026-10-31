"""Azure native computer calls inside ADK's existing task protocol.

This transport does not execute actions or acknowledge safety checks. The
Browser tool supplies the exact authorized screenshot result. Ordinary One
chat continues to use the text-only Azure adapter.
"""

from __future__ import annotations

import asyncio
import base64
import json
from collections.abc import AsyncGenerator
from typing import Literal

from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from pydantic import Field

from hushh_mcp.services.pod_browser.contracts import StrictContract

from .azure_adk import (
    AzureOpenAIAdkModel,
    _identifier,
    _json,
    _request,
    _response,
    _value,
)

NATIVE_TOOL = "browser_native_call"
MAX_HISTORY_BYTES = 64 * 1024 * 1024


class SafetyCheck(StrictContract):
    id: str = Field(min_length=1, max_length=256)
    code: str | None = Field(default=None, max_length=128)
    message: str | None = Field(default=None, max_length=4096, repr=False)


class ComputerCall(StrictContract):
    id: str = Field(min_length=1, max_length=256)
    call_id: str = Field(min_length=1, max_length=256)
    type: Literal["computer_call"] = "computer_call"
    status: Literal["completed"]
    actions: list[dict] = Field(min_length=1, max_length=16, repr=False)
    pending_safety_checks: list[SafetyCheck] = Field(default_factory=list, max_length=8)

    def wire(self) -> dict:
        # GA computer calls reject even an empty legacy safety field. Never
        # discard a nonempty provider check or manufacture its acknowledgement.
        excluded = {"pending_safety_checks"} if not self.pending_safety_checks else set()
        result: dict = self.model_dump(exclude_none=True, exclude=excluded)
        return result

    @classmethod
    def from_provider(cls, value: object) -> ComputerCall:
        if hasattr(value, "model_dump"):
            value = value.model_dump(mode="json", exclude_none=True)
        if not isinstance(value, dict):
            raise ValueError("Invalid Azure computer call")
        value = dict(value)
        # Current Responses includes a nullable legacy action alongside actions.
        if value.get("action") is None:
            value.pop("action", None)
        if value.get("pending_safety_checks") is None:
            value["pending_safety_checks"] = []
        call: ComputerCall = cls.model_validate(value)
        _identifier(call.id)
        _identifier(call.call_id)
        if len(_json(value).encode()) > 65536 or len(
            {check.id for check in call.pending_safety_checks}
        ) != len(call.pending_safety_checks):
            raise ValueError("Azure computer call exceeds bounds")
        return call


class ComputerResult(StrictContract):
    call_id: str = Field(min_length=1, max_length=256)
    png_base64: str = Field(min_length=12, max_length=5592408, repr=False)
    acknowledged_safety_checks: list[SafetyCheck] = Field(default_factory=list, max_length=8)

    def wire(self, call: ComputerCall) -> dict:
        if (
            self.call_id != call.call_id
            or self.acknowledged_safety_checks != call.pending_safety_checks
        ):
            raise ValueError("Azure computer result changed")
        try:
            png = base64.b64decode(self.png_base64, validate=True)
        except ValueError:
            raise ValueError("Invalid Azure computer screenshot") from None
        if not 8 <= len(png) <= 4 * 1024 * 1024 or not png.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError("Invalid Azure computer screenshot")
        result = {
            "type": "computer_call_output",
            "call_id": call.call_id,
            "output": {
                "type": "computer_screenshot",
                "image_url": "data:image/png;base64," + self.png_base64,
                "detail": "original",
            },
        }
        if self.acknowledged_safety_checks:
            result["acknowledged_safety_checks"] = [
                check.model_dump(exclude_none=True) for check in self.acknowledged_safety_checks
            ]
        return result


def computer_request(request: LlmRequest, deployment: str) -> dict:
    # Reuse text/ADK task/reasoning translation and its complete-call checks.
    # Only this specialist's internal native tool becomes the provider tool.
    result = _request(request, deployment, preserve_message_phase=True)
    declarations = result.get("tools", [])
    native = [tool for tool in declarations if tool.get("name") == NATIVE_TOOL]
    if len(native) != 1 or result.get("tool_choice") == "none":
        raise ValueError("Azure Browser requires its authorized dispatch tool")
    result["tools"] = [
        {"type": "computer"} if tool.get("name") == NATIVE_TOOL else tool for tool in declarations
    ]
    result["parallel_tool_calls"] = False
    calls: dict[str, ComputerCall] = {}
    history = []
    for item in result["input"]:
        if item.get("type") == "function_call" and item.get("name") == NATIVE_TOOL:
            args = json.loads(item["arguments"])
            if set(args) != {"call"}:
                raise ValueError("Invalid Azure computer arguments")
            call = ComputerCall.from_provider(args["call"])
            if call.call_id != item["call_id"]:
                raise ValueError("Azure computer identity changed")
            calls[call.call_id] = call
            history.append(call.wire())
        elif item.get("type") == "function_call_output" and item.get("call_id") in calls:
            call = calls.pop(item["call_id"])
            output = ComputerResult.model_validate(json.loads(item["output"]))
            history.append(output.wire(call))
        else:
            history.append(item)
    if calls or len(_json(history).encode()) > MAX_HISTORY_BYTES:
        raise ValueError("Azure computer history is incomplete or exceeds bounds")
    result["input"] = history
    # Explicit history stays in this ephemeral ADK task. No server conversation
    # or previous_response_id, and no hidden automatic provider retries.
    return result


def computer_response(response: object, *, allowed_names: set[str]) -> LlmResponse:
    output, native_count, executable_count = [], 0, 0
    for item in _value(response, "output", []) or []:
        kind = _value(item, "type")
        if kind == "computer_call":
            call = ComputerCall.from_provider(item)
            native_count += 1
            executable_count += 1
            output.append(
                {
                    "type": "function_call",
                    "name": NATIVE_TOOL,
                    "call_id": call.call_id,
                    "arguments": _json({"call": call.model_dump(exclude_none=True)}),
                }
            )
        else:
            if kind == "function_call" and _value(item, "name") == NATIVE_TOOL:
                raise ValueError("Native computer actions require a computer call")
            executable_count += int(kind == "function_call")
            output.append(item)
    if native_count > 1 or native_count and executable_count > 1:
        raise ValueError("Azure Browser requires one ordered action batch")
    return _response(
        {
            "status": _value(response, "status"),
            "incomplete_details": _value(response, "incomplete_details"),
            "output": output,
            "usage": _value(response, "usage"),
            "model": _value(response, "model"),
        },
        allowed_names=allowed_names | {NATIVE_TOOL},
        preserve_message_phase=True,
    )


class AzureBrowserAdkModel(AzureOpenAIAdkModel):
    """Browser-only native transport; readiness/owner authority stay external."""

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        kwargs = computer_request(llm_request, self.model)
        if self.require_current is not None:
            await self.require_current()
        token = await asyncio.to_thread(self.token_supplier)
        if not isinstance(token, str) or not token:
            raise RuntimeError("Azure managed model token is unavailable")
        from openai import AsyncOpenAI

        from hushh_mcp.services.mcp_public_http import create_public_mcp_http_client

        factory = self.client_factory or AsyncOpenAI
        # Owner credentials never follow a redirect or environment proxy. The
        # existing public transport pins validated DNS at socket creation.
        options = {}
        if self.client_factory is None:
            options["http_client"] = create_public_mcp_http_client(
                max_response_bytes=8 * 1024 * 1024
            )
        async with factory(
            api_key=token,
            base_url=self.endpoint,
            timeout=self.timeout_seconds,
            max_retries=0,
            **options,
        ) as client:
            if self.require_current is not None:
                await self.require_current()
            response = await client.responses.create(**kwargs)
            if self.require_current is not None:
                await self.require_current()
            yield computer_response(
                response,
                allowed_names={
                    tool["name"] for tool in kwargs["tools"] if tool["type"] == "function"
                },
            )
