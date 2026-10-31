"""A Puppy turn carries a tool result that contains dates.

The Azure OpenAI path failed live on 2026-10-05 when a memory recall result held a
datetime; the Puppy payload had the same shape: the raw result went into the frame
and the sealed envelope serialized it with plain json.dumps. The payload is now
JSON-safe at the source, for the hub relay and the in-agent broker alike.
"""

from __future__ import annotations

import datetime
import json

from hushh_mcp.runtime_providers.puppy_transport import _messages
from hushh_mcp.runtime_providers.translate import NeutralMessage, NeutralRequest

RECALLED_AT = datetime.datetime(2026, 10, 5, 21, 6, 3, tzinfo=datetime.timezone.utc)


def _request() -> NeutralRequest:
    return NeutralRequest(
        messages=(
            NeutralMessage(role="user", text="What do you remember about me?"),
            NeutralMessage(role="assistant", tool_name="recall", tool_call_id="c1"),
            NeutralMessage(
                role="tool",
                tool_name="recall",
                tool_call_id="c1",
                tool_result={"hits": [{"text": "likes tea", "at": RECALLED_AT, "raw": b"\x01"}]},
            ),
        )
    )


def test_the_tool_result_is_json_safe_in_the_payload():
    [tool] = [m for m in _messages(_request()) if "toolResult" in m]
    assert tool["toolResult"] == {
        "hits": [{"text": "likes tea", "at": RECALLED_AT.isoformat(), "raw": "AQ=="}]
    }
    json.dumps(tool, separators=(",", ":"))  # what the envelope does; must not raise


def test_plain_results_keep_their_shape():
    request = NeutralRequest(
        messages=(
            NeutralMessage(role="assistant", tool_name="t", tool_call_id="c"),
            NeutralMessage(
                role="tool", tool_name="t", tool_call_id="c", tool_result={"n": 1, "ok": True}
            ),
        )
    )
    [tool] = [m for m in _messages(request) if "toolResult" in m]
    assert tool["toolResult"] == {"n": 1, "ok": True}
