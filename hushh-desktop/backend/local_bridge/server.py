"""Local bridge: makes GenieX a spec-compliant, tool-calling-capable
OpenAI backend.

Sits between GenieX (localhost:18181, Qualcomm's QAIRT inference server)
and any OpenAI-compatible client -- our own desktop backend, or an external
Hermes Agent instance. Fixes two gaps found in GenieX directly:

1. Streaming responses don't reliably carry a `finish_reason` / `[DONE]`
   terminator, which strict clients (the `openai` Python SDK, used by
   Hermes) surface as a hard error.
2. GenieX has no native tool-calling -- an OpenAI `tools` array gets
   stuffed into the prompt with no enforcement, and `tool_calls` never
   comes back structured.

Runs on a fixed port (18182) rather than a dynamically-allocated one,
because external tools like Hermes need one address to configure once, the
same way they'd point at any local LM Studio/vLLM instance.

Run with: uvicorn local_bridge.server:app --port 18182
(or directly: python -m local_bridge.server -- see __main__ below, which is
what the PyInstaller-compiled packaged build actually launches; Electron's
ModelRegistry spawns the dev-mode venv python with the uvicorn invocation
above instead, see registry.js's _getLocalBridgeCommand).
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any, AsyncGenerator

import aiohttp
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

from local_bridge.tool_calling import extract_tool_calls, inject_tools_into_messages

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("local_bridge")

GENIEX_BASE_URL = "http://localhost:18181/v1"
BRIDGE_PORT = 18182

app = FastAPI(title="Hushh Local Model Bridge")


def _new_completion_id() -> str:
    return f"chatcmpl-{uuid.uuid4().hex[:24]}"


def _sse_chunk(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload)}\n\n"


def _delta_chunk(completion_id: str, model: str, content: str = "", finish_reason: str | None = None, tool_calls: list | None = None) -> dict[str, Any]:
    delta: dict[str, Any] = {}
    if content:
        delta["content"] = content
    if tool_calls:
        delta["tool_calls"] = tool_calls
    return {
        "id": completion_id,
        "object": "chat.completion.chunk",
        "created": 0,
        "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }


async def _call_geniex_non_streaming(
    payload: dict[str, Any], *, timeout_seconds: int = 90
) -> dict[str, Any]:
    """Call GenieX with stream:false and return the parsed JSON body.

    Bounded rather than unbounded: an ambiguous tool-calling prompt can send
    GenieX into a long/runaway completion (observed live, twice -- a stuck
    request here queued a second one behind it, since GenieX serializes
    requests behind a single internal lock, and both eventually timed out
    around a GenieX crash). A bounded timeout means this one request fails
    cleanly instead of the bridge holding the connection open indefinitely
    and blocking everything queued behind it.

    `timeout_seconds` defaults to a generous 90s for the general-purpose
    no-tools path (a real full chat completion from an external client like
    Hermes should be allowed to run long under legitimate load). The
    tool-calling branch below passes a much shorter budget instead -- see
    that call site for why.
    """
    body = {**payload, "stream": False}
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout_seconds)) as session:
        async with session.post(f"{GENIEX_BASE_URL}/chat/completions", json=body) as resp:
            if resp.status >= 400:
                error_text = await resp.text()
                logger.error(
                    "GenieX rejected request (status=%s, payload_chars=%s): %s",
                    resp.status,
                    len(json.dumps(body)),
                    error_text[:2000],
                )
            resp.raise_for_status()
            return await resp.json()


async def _stream_geniex_passthrough(payload: dict[str, Any]) -> AsyncGenerator[str, None]:
    """Forward a no-tools streaming request to GenieX, guaranteeing a
    spec-correct finish_reason and [DONE] terminator on the way out --
    GenieX's own stream doesn't reliably provide either.
    """
    completion_id = _new_completion_id()
    model = payload.get("model", "")
    saw_finish = False

    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None)) as session:
        async with session.post(f"{GENIEX_BASE_URL}/chat/completions", json=payload) as resp:
            resp.raise_for_status()
            async for line in resp.content:
                line = line.decode("utf-8", errors="replace").strip()
                if not line.startswith("data:"):
                    continue
                # GenieX emits "data:{...}" with no space after the colon,
                # unlike the space-delimited "data: {...}" SSE convention.
                payload_str = line[len("data:"):].strip()
                if payload_str == "[DONE]":
                    continue
                try:
                    data = json.loads(payload_str)
                except json.JSONDecodeError:
                    logger.warning("Failed to parse GenieX SSE line: %r", payload_str[:200])
                    continue
                choice = (data.get("choices") or [{}])[0]
                delta = choice.get("delta", {}) or {}
                content = delta.get("content", "") or choice.get("message", {}).get("content", "")
                finish_reason = choice.get("finish_reason") or None
                if finish_reason:
                    saw_finish = True
                if content or finish_reason:
                    yield _sse_chunk(_delta_chunk(completion_id, model, content=content, finish_reason=finish_reason))

    if not saw_finish:
        yield _sse_chunk(_delta_chunk(completion_id, model, finish_reason="stop"))
    yield "data: [DONE]\n\n"


@app.get("/v1/models")
async def list_models() -> JSONResponse:
    async with aiohttp.ClientSession() as session:
        async with session.get(f"{GENIEX_BASE_URL}/models") as resp:
            data = await resp.json()
            return JSONResponse(content=data, status_code=resp.status)


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    payload = await request.json()
    tools = payload.get("tools")
    client_wants_stream = bool(payload.get("stream"))
    model = payload.get("model", "")

    if not tools:
        # No tool-calling translation needed -- just fix up streaming
        # compliance (or ensure finish_reason on non-streaming) and forward.
        if client_wants_stream:
            return StreamingResponse(
                _stream_geniex_passthrough(payload), media_type="text/event-stream"
            )
        data = await _call_geniex_non_streaming(payload)
        choice = (data.get("choices") or [{}])[0]
        if not choice.get("finish_reason"):
            choice["finish_reason"] = "stop"
        return JSONResponse(content=data)

    # Tools present: translate via the Nous/Hermes tag convention. Always
    # calls GenieX non-streaming internally (simpler correctness first --
    # true incremental streaming for tool calls is a later phase), then
    # shapes the result to match whatever the client actually asked for.
    #
    # 40s, not 15s: the 15s figure was sized for the old QAIRT/Qwen3-4B
    # model, where a slow call meant a genuine multi-minute hang past a
    # crash -- failing fast made sense there. The llama.cpp/Llama-3.2-1B
    # runtime doesn't have that failure mode: live testing shows this same
    # call normally resolving in 5-25s. (Briefly bumped to 60s during a
    # same-session Qwen3.5-2B attempt -- reverted along with that model
    # swap after live testing found its always-on reasoning trace broke
    # this classifier call outright; see agent_chat_service.py's
    # _plan_action_via_bridge and registry.js's GENIEX_MODEL_ID.)
    augmented_messages = inject_tools_into_messages(payload.get("messages", []), tools)
    geniex_payload = {k: v for k, v in payload.items() if k not in {"tools", "tool_choice"}}
    geniex_payload["messages"] = augmented_messages

    data = await _call_geniex_non_streaming(geniex_payload, timeout_seconds=40)
    choice = (data.get("choices") or [{}])[0]
    raw_content = choice.get("message", {}).get("content", "")
    remaining_text, tool_calls = extract_tool_calls(raw_content)

    if tool_calls:
        choice["message"]["content"] = remaining_text or None
        choice["message"]["tool_calls"] = tool_calls
        choice["finish_reason"] = "tool_calls"
    else:
        choice["message"]["content"] = remaining_text
        choice["finish_reason"] = choice.get("finish_reason") or "stop"

    if not client_wants_stream:
        return JSONResponse(content=data)

    completion_id = data.get("id") or _new_completion_id()

    async def _single_chunk_stream() -> AsyncGenerator[str, None]:
        message = choice["message"]
        yield _sse_chunk(
            _delta_chunk(
                completion_id,
                model,
                content=message.get("content") or "",
                tool_calls=message.get("tool_calls"),
                finish_reason=choice["finish_reason"],
            )
        )
        yield "data: [DONE]\n\n"

    return StreamingResponse(_single_chunk_stream(), media_type="text/event-stream")


if __name__ == "__main__":
    # Entrypoint for the PyInstaller-compiled packaged build (see
    # build-local-bridge.py) -- a packaged install has no Python venv to run
    # `uvicorn local_bridge.server:app` against, so the compiled exe needs to
    # be able to start itself directly. Dev mode doesn't use this path (see
    # module docstring); this is deliberately the ONLY entrypoint difference
    # between dev and packaged, everything else in this file is identical.
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=BRIDGE_PORT)
