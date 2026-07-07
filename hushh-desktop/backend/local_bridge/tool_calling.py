"""Tool-calling translation for models/runtimes with no native function-calling.

GenieX (Qualcomm's QAIRT inference server) accepts an OpenAI-style `tools`
array in the request but does nothing with it -- the schema gets stuffed
into the prompt with no enforcement, and the model's attempt at a call comes
back as raw, unparsed text in `content` with `tool_calls` left null.

This module renders `tools` into the Nous/Hermes function-calling convention
(a `<tool_call>{"name": ..., "arguments": {...}}</tool_call>` tag) and parses
that convention back out of the model's raw completion into a proper OpenAI
`tool_calls` array. Whether this exact checkpoint reliably honors the tag is
the main open risk of the bridge -- see the beta 1.2 plan.
"""

from __future__ import annotations

import json
import re
import uuid
from typing import Any

_TOOL_CALL_TAG_RE = re.compile(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", re.DOTALL)


def _find_balanced_json_objects(text: str) -> list[tuple[int, int, str]]:
    """Scan for top-level `{...}` substrings with balanced braces.

    Returns (start, end, raw_json) for each candidate found, in order.
    Doesn't validate JSON-ness -- callers attempt to parse and discard
    failures. Used as a fallback for models that produce well-formed
    tool-call JSON without the requested `<tool_call>` wrapper.
    """
    candidates: list[tuple[int, int, str]] = []
    depth = 0
    start = -1
    for i, ch in enumerate(text):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start != -1:
                    candidates.append((start, i + 1, text[start : i + 1]))
                    start = -1
    return candidates

_TOOLS_SYSTEM_BLOCK_TEMPLATE = """You have access to the following functions. To call one, respond with EXACTLY one <tool_call> block containing a single JSON object with "name" and "arguments" keys, and nothing else in that response:

<tool_call>
{{"name": "<function name>", "arguments": {{"<arg>": <value>}}}}
</tool_call>

If no function call is needed, respond normally with plain text.

Available functions:
{tool_schemas}"""


def render_tools_system_block(tools: list[dict[str, Any]]) -> str:
    """Render an OpenAI-style `tools` array into a system-prompt text block."""
    schemas = [t.get("function", t) for t in tools if isinstance(t, dict)]
    return _TOOLS_SYSTEM_BLOCK_TEMPLATE.format(tool_schemas=json.dumps(schemas, indent=2))


def inject_tools_into_messages(
    messages: list[dict[str, Any]], tools: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Append the tool-calling instructions to the first system message.

    Inserts a new system message at the front if none exists, rather than
    mutating the caller's list.
    """
    block = render_tools_system_block(tools)
    result = [dict(m) for m in messages]
    for msg in result:
        if msg.get("role") == "system":
            msg["content"] = f"{msg.get('content', '')}\n\n{block}".strip()
            return result
    result.insert(0, {"role": "system", "content": block})
    return result


def _unwrap_schema_echo(arguments: Any) -> Any:
    """Smaller models (observed with Llama-3.2-1B) sometimes echo the tool's
    own JSON-schema shape instead of real values -- e.g.
    {"properties": {"location": "Paris"}} instead of {"location": "Paris"},
    copying the schema's wrapper key into the actual call. Unwrap that one
    specific pattern rather than passing bogus nested args downstream.
    """
    if (
        isinstance(arguments, dict)
        and set(arguments.keys()) == {"properties"}
        and isinstance(arguments["properties"], dict)
    ):
        return arguments["properties"]
    return arguments


def _tool_call_from_parsed(parsed: Any) -> dict[str, Any] | None:
    if not isinstance(parsed, dict):
        return None
    name = parsed.get("name")
    if not isinstance(name, str) or not name:
        return None
    # Llama-3.2 checkpoints (unlike the earlier Qwen/QAIRT one) reliably use
    # "parameters" instead of the requested "arguments" key -- accept either
    # rather than depend on prompting alone to fix the model's own habit.
    arguments = _unwrap_schema_echo(parsed.get("arguments", parsed.get("parameters", {})))
    return {
        "id": f"call_{uuid.uuid4().hex[:24]}",
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments)},
    }


def extract_tool_calls(text: str) -> tuple[str, list[dict[str, Any]]]:
    """Pull tool-call JSON out of raw model text.

    Tries the requested `<tool_call>{...}</tool_call>` convention first.
    Falls back to scanning for a bare `{"name": ..., "arguments": {...}}`
    object with no wrapper -- observed in practice: the model reliably
    produces the right JSON but doesn't always honor the tag instruction.

    Returns (remaining_text_with_calls_stripped, tool_calls), where
    tool_calls is an OpenAI-shaped list:
    [{"id", "type": "function", "function": {"name", "arguments"}}].
    Malformed/ambiguous JSON is left in place as plain text rather than
    raising -- a model that doesn't follow either convention should degrade
    to a normal text response instead of erroring.
    """
    tool_calls: list[dict[str, Any]] = []

    def _replace_tagged(match: re.Match[str]) -> str:
        try:
            parsed = json.loads(match.group(1))
        except json.JSONDecodeError:
            return match.group(0)
        call = _tool_call_from_parsed(parsed)
        if call is None:
            return match.group(0)
        tool_calls.append(call)
        return ""

    remaining = _TOOL_CALL_TAG_RE.sub(_replace_tagged, text).strip()
    if tool_calls:
        return remaining, tool_calls

    # No tagged call found -- look for a bare JSON object shaped like one.
    for start, end, raw in _find_balanced_json_objects(remaining):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            continue
        call = _tool_call_from_parsed(parsed)
        if call is not None:
            tool_calls.append(call)
            remaining = (remaining[:start] + remaining[end:]).strip()
            break

    return remaining, tool_calls
