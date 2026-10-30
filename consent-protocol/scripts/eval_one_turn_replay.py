"""Replay earlier One chat turns exactly as a follow-up request is built.

The history passes through the production storage boundary (the encrypted
session codec, with a key that exists only in this process), ADK's own contents
builder and One's before-model history hygiene. The result is the model input a
follow-up turn would send, built offline with no owner data, tools or credentials.
Only the graded turn is new; scripted earlier turns are test input, never grades.
"""

from __future__ import annotations

import json
import secrets
from pathlib import Path
from typing import Any

from google.adk.events import Event
from google.adk.flows.llm_flows.contents import _get_contents
from google.adk.models import LlmRequest
from google.adk.sessions import Session
from google.genai import types

SCHEMA_VERSION = "one.first_tool_evals.v2"
CASES_PATH = Path(__file__).with_name("eval_cases") / "one_first_tool_turns.v2.json"
CASE_KEYS = {"id", "family", "prompt", "expected", "runtime_context", "history", "args", "note"}
APP, USER, SESSION, AGENT = "one_turn_replay", "synthetic-turn-replay", "turn-replay", "one"


class _ProcessKey:
    """A fresh chat key for this process only; nothing is persisted or shared."""

    def __init__(self) -> None:
        self._key = secrets.token_bytes(32)

    def current_key(self, owner_id: str) -> bytes:
        return self._key


def load_turn_cases(path: Path = CASES_PATH) -> list[dict[str, Any]]:
    """Multi-turn cases; v1 loaders reject this schema instead of grading turn one."""
    document = json.loads(path.read_text(encoding="utf-8"))
    if document.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(f"{path} must declare {SCHEMA_VERSION}")
    cases = document.get("cases")
    if not isinstance(cases, list) or not cases:
        raise ValueError("multi-turn cases must be a non-empty list")
    for case in cases:
        if not isinstance(case, dict) or set(case) - CASE_KEYS or not case.get("history"):
            raise ValueError(
                f"invalid multi-turn case {case.get('id') if isinstance(case, dict) else case}"
            )
        if not all(isinstance(turn.get("user"), str) for turn in case["history"]):
            raise ValueError(f"{case['id']}: every earlier turn needs the owner's words")
    if len({case["id"] for case in cases}) != len(cases):
        raise ValueError("multi-turn case ids must be unique")
    return cases


def _events(history: list[dict]) -> list[Event]:
    """One invocation per earlier turn, as the chat bridge records it."""
    events = []
    for number, turn in enumerate(history):
        invocation = f"replay-{number}"
        user = types.Content(role="user", parts=[types.Part(text=turn["user"])])
        events.append(Event(invocation_id=invocation, author="user", content=user))
        for index, step in enumerate(turn.get("steps", [])):
            if "text" in step:
                answer = types.Content(role="model", parts=[types.Part(text=step["text"])])
                events.append(Event(invocation_id=invocation, author=AGENT, content=answer))
                continue
            name, call_id = step["call"]["name"], f"call-{number}-{index}"
            call = types.Part(
                function_call=types.FunctionCall(
                    id=call_id, name=name, args=step["call"].get("args") or {}
                )
            )
            events.append(
                Event(
                    invocation_id=invocation,
                    author=AGENT,
                    content=types.Content(role="model", parts=[call]),
                )
            )
            if "result" in step:
                result = types.Part(
                    function_response=types.FunctionResponse(
                        id=call_id, name=name, response=step["result"]
                    )
                )
                reply = types.Content(role="user", parts=[result])
                events.append(Event(invocation_id=invocation, author=AGENT, content=reply))
    return events


def stored_session(history: list[dict]) -> Session:
    """The session as a later turn reads it back from the encrypted store."""
    from hushh_mcp.one_adk.encrypted_session_service import EncryptedAdkSessionService
    from hushh_mcp.services.chat_key import ChatCipher

    codec = EncryptedAdkSessionService(ChatCipher(_ProcessKey()))
    session = Session(id=SESSION, app_name=APP, user_id=USER, events=_events(history))
    # The store writes the sealed fields as payload_* columns; read them back the same way.
    row = {f"payload_{key}": value for key, value in codec._encode(session).items()}
    return codec._decode(row, app_name=APP, user_id=USER, session_id=SESSION)


def replayed_contents(
    history: list[dict], prompt: str, *, hygiene: bool = True
) -> list[types.Content]:
    """The graded turn's model contents after storage and One's history hygiene."""
    from hushh_mcp.one_adk.output_privacy import (
        drop_empty_history_parts,
        drop_replayed_tool_placeholders,
    )

    graded = types.Content(role="user", parts=[types.Part(text=prompt)])
    events = [
        *stored_session(history).events,
        Event(invocation_id="graded", author="user", content=graded),
    ]
    # The managed Azure root pairs calls with results by id, so ADK keeps them.
    request = LlmRequest(
        contents=_get_contents(None, events, AGENT, preserve_function_call_ids=True)
    )
    if hygiene:
        drop_empty_history_parts(request)
        drop_replayed_tool_placeholders(request)
    return request.contents
