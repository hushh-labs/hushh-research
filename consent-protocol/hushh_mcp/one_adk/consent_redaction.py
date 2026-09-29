"""Forget another person's information once their grant ends (CONTRACT C3).

Measured on UAT 2026-09-28: after the owner revoked, the requester asked the
same chat again and One answered "Nopa" with no tool call. The shared block is
only ever in the answer turn's instruction (``temp:`` state), but One's ANSWER
is an ordinary model event in the sealed session history, and every later turn
replays it to the model.

The fix has three parts, each small:

* **Tag.** Each invocation that ran while shared information was live in the
  conversation (the answer turn, and every later turn until access ends) is
  recorded against the bundle in sealed session state
  (``hussh:consent_invocations:<bundle>``). Anything the model said in those
  turns may carry the information, so all of it is "derived from it".
* **Check.** Once per turn, before the model runs, each tagged bundle's current
  outcome is read through the requester-bound bundle view (an injected lookup,
  so a pod can supply its own). When access has ended the bundle is latched as
  ended in sealed state, and later turns skip the read. A failed read redacts
  for that turn only: the safe direction.
* **Redact.** Before every model call, everything the agent side produced in a
  tagged turn (text, thoughts, tool calls and their responses) is replaced in
  the REQUEST with one neutral note. Turns are found by identity, not by
  content equality: the person's own messages in the request are aligned, in
  order, with the user events of the sealed session, and every non-person
  content between two of them belongs to that turn's invocation. When that
  cannot be verified (a tagged turn whose message is not found), the bundle
  fails closed: every agent-side content from the first tagged turn onward is
  replaced. Content equality, a shared-block fence, and a tool payload naming
  an ended bundle are independent extra nets. Stored sealed events are never
  mutated; ADK hands the callback shallow copies.

Measured on localhost 2026-09-28 (run 598321cd): Agent Chat's encrypted store
sealed the answer turn's ``temp:`` continuation record, so every later turn
re-rendered the fenced shared block into the system instruction and skipped the
revoke check for that bundle. The store no longer seals ``temp:`` state; this
module also refuses a continuation record that outlives its answer turn and
strips a fenced block from any other turn's instruction.

The same state drives the history projection (``redaction_for_history``), so
the client renders those messages as "Access ended" and never receives the
text again.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Awaitable, Callable, Iterable, Mapping
from typing import Any

from hushh_mcp.one_adk.consent_continuation import (
    ACCESS_ENDED_OUTCOMES,
    CONSENT_SHARED_STATE_PREFIX,
    SHARED_OUTCOMES,
    STATE_CONSENT_CONTINUATION,
    consent_shared_state_key,
)

logger = logging.getLogger(__name__)

# Persisted (sealed): invocation ids that ran while the bundle's information was live.
CONSENT_INVOCATIONS_PREFIX = "hussh:consent_invocations:"
# Persisted (sealed): the bundle's access ended ("revoked" or "expired"); terminal.
CONSENT_ACCESS_ENDED_PREFIX = "hussh:consent_access_ended:"
# Per-invocation: {bundle_id: neutral note} for bundles to redact this turn.
STATE_ENDED_CONSENT = "temp:hussh:ended_consent_access"
MAX_TAGGED_INVOCATIONS = 200
# The answer turn's instruction fences the shared text between these markers
# (``consent_continuation_instruction``); no other turn may carry one.
_FENCE_MARKER = "BEGIN SHARED-"
_FENCED_BLOCK = re.compile(r"BEGIN (SHARED-[0-9a-f]{12})\n.*?\nEND \1", re.DOTALL)
_FENCE_REMOVED = "[Shared information removed: it belonged to an earlier turn.]"

BundleLookup = Callable[[str, str], Awaitable[Mapping[str, Any] | None]]


def consent_invocations_state_key(bundle_id: str) -> str:
    return f"{CONSENT_INVOCATIONS_PREFIX}{bundle_id.lower()}"


def consent_access_ended_state_key(bundle_id: str) -> str:
    return f"{CONSENT_ACCESS_ENDED_PREFIX}{bundle_id.lower()}"


def neutral_note(labels: Iterable[str] | None, person_name: str | None) -> str:
    """The text a redacted answer becomes in the model's context."""
    what = ", ".join(str(label) for label in labels or [] if str(label).strip()) or "information"
    who = str(person_name or "").strip() or "the other person"
    return f"Access to {what} from {who} ended; do not use or repeat it."


def _state_get(state: Any, key: str) -> Any:
    getter = getattr(state, "get", None)
    return getter(key) if callable(getter) else None


def _state_keys(state: Any) -> list[str]:
    if isinstance(state, Mapping):
        return [key for key in state if isinstance(key, str)]
    to_dict = getattr(state, "to_dict", None)
    if callable(to_dict):
        return [key for key in to_dict() if isinstance(key, str)]
    return []


def tagged_bundles(state: Any) -> dict[str, list[str]]:
    """Bundles whose shared information entered this conversation, with their invocations."""
    tagged: dict[str, list[str]] = {}
    for key in _state_keys(state):
        if not key.startswith(CONSENT_INVOCATIONS_PREFIX):
            continue
        value = _state_get(state, key)
        if isinstance(value, list):
            tagged[key[len(CONSENT_INVOCATIONS_PREFIX) :]] = [str(item) for item in value]
    return tagged


def _shared_record(state: Any, bundle_id: str) -> Mapping[str, Any]:
    record = _state_get(state, consent_shared_state_key(bundle_id))
    return record if isinstance(record, Mapping) else {}


def _note_for(state: Any, bundle_id: str) -> str:
    record = _shared_record(state, bundle_id)
    return neutral_note(record.get("labels"), record.get("personName"))


def _append_invocation(state: Any, bundle_id: str, invocation_id: str) -> None:
    key = consent_invocations_state_key(bundle_id)
    current = _state_get(state, key)
    invocations = [str(item) for item in current] if isinstance(current, list) else []
    if invocation_id and invocation_id not in invocations:
        # Assign a new list: ADK records a state delta only on assignment.
        state[key] = [*invocations, invocation_id][-MAX_TAGGED_INVOCATIONS:]


def access_ended_outcome(bundle: Mapping[str, Any] | None) -> str | None:
    """The ended outcome to latch, or None while shared access is still live."""
    if not isinstance(bundle, Mapping):
        return None
    progress = bundle.get("progress")
    if not isinstance(progress, Mapping):
        return None
    outcome = str(progress.get("outcome") or "")
    if outcome in ACCESS_ENDED_OUTCOMES:
        return outcome
    # A partial end (one field revoked while another stays granted) still ends
    # what the earlier answer may contain.
    if progress.get("ended_at"):
        return "revoked" if outcome != "expired" else outcome
    return None


def _answered_in_another_turn(state: Any, bundle_id: str, invocation_id: str) -> bool:
    """The bundle's shared answer already ran, in an invocation other than this one."""
    tagged = _state_get(state, consent_invocations_state_key(bundle_id))
    return isinstance(tagged, list) and bool(tagged) and invocation_id not in tagged


async def track_consent_access(callback_context: Any, *, lookup: BundleLookup) -> None:
    """Before-agent: tag this invocation while shared access is live, latch its end.

    Pure over its inputs apart from the injected ``lookup(owner_id, bundle_id)``,
    which must be requester-bound (a bundle the owner did not send is absent).
    """
    state = getattr(callback_context, "state", None)
    if state is None:
        return
    invocation_id = str(getattr(callback_context, "invocation_id", "") or "")
    owner_id = str(getattr(callback_context, "user_id", "") or "")
    continuation = _state_get(state, STATE_CONSENT_CONTINUATION)
    current_bundle = ""
    if isinstance(continuation, Mapping):
        bundle_id = str(continuation.get("bundleId") or "").lower()
        current_outcome = str(continuation.get("outcome") or "")
        if current_outcome in SHARED_OUTCOMES and _answered_in_another_turn(
            state, bundle_id, invocation_id
        ):
            # A shared answer turn is admitted once per bundle per conversation,
            # so a record that outlived it is stale. Left in place it would
            # re-render the shared block and skip the revoke check below.
            logger.warning("one.consent_continuation_stale bundle=%s", bundle_id)
            state[STATE_CONSENT_CONTINUATION] = None
        elif current_outcome in SHARED_OUTCOMES:
            current_bundle = bundle_id
            _append_invocation(state, current_bundle, invocation_id)
        elif current_outcome in ACCESS_ENDED_OUTCOMES:
            state[consent_access_ended_state_key(bundle_id)] = current_outcome

    ended: dict[str, str] = {}
    for bundle_id in tagged_bundles(state):
        if _state_get(state, consent_access_ended_state_key(bundle_id)):
            ended[bundle_id] = _note_for(state, bundle_id)
            continue
        if bundle_id == current_bundle:
            continue  # the answer turn itself: access was just confirmed live
        try:
            outcome = access_ended_outcome(await lookup(owner_id, bundle_id))
        except Exception as exc:  # noqa: BLE001 - unknown means redact, this turn only
            logger.warning("one.consent_access_check_failed error=%s", type(exc).__name__)
            ended[bundle_id] = _note_for(state, bundle_id)
            continue
        if outcome:
            state[consent_access_ended_state_key(bundle_id)] = outcome
            logger.info("one.consent_access_ended bundle=%s outcome=%s", bundle_id, outcome)
            ended[bundle_id] = _note_for(state, bundle_id)
        else:
            _append_invocation(state, bundle_id, invocation_id)
    if ended:
        state[STATE_ENDED_CONSENT] = ended


def _part_key(part: Any) -> list[Any]:
    function_call = getattr(part, "function_call", None)
    function_response = getattr(part, "function_response", None)
    return [
        getattr(part, "text", None),
        bool(getattr(part, "thought", None)),
        getattr(function_call, "name", None),
        getattr(function_call, "args", None),
        getattr(function_response, "name", None),
        getattr(function_response, "response", None),
    ]


def _content_key(content: Any) -> str | None:
    parts = getattr(content, "parts", None)
    if not parts:
        return None
    keys = [_part_key(part) for part in parts]
    if not any(any(value not in (None, False) for value in key) for key in keys):
        return None
    return json.dumps(keys, default=str, sort_keys=True)


def _person_key(content: Any) -> str | None:
    """The key of a message the person sent: user role, no thought and no tool part."""
    if getattr(content, "role", None) != "user":
        return None
    for part in getattr(content, "parts", None) or []:
        if getattr(part, "thought", None):
            return None
        if getattr(part, "function_call", None) or getattr(part, "function_response", None):
            return None
    return _content_key(content)


def _has_function_parts(content: Any, field: str) -> bool:
    return any(getattr(part, field, None) for part in getattr(content, "parts", None) or [])


def _has_shared_fence(content: Any) -> bool:
    """Text or a tool payload carrying the answer turn's shared-block fence."""
    for part in getattr(content, "parts", None) or []:
        if _FENCE_MARKER in str(getattr(part, "text", None) or ""):
            return True
        if _FENCE_MARKER in _tool_payload(part):
            return True
    return False


def _names_ended_bundle(content: Any, ended_bundles: Iterable[str]) -> bool:
    """A tool call or result about a bundle whose access has ended."""
    bundles = [bundle.lower() for bundle in ended_bundles if bundle]
    return any(
        bundle in _tool_payload(part).lower()
        for part in getattr(content, "parts", None) or []
        for bundle in bundles
    )


def _tool_payload(part: Any) -> str:
    function_call = getattr(part, "function_call", None)
    function_response = getattr(part, "function_response", None)
    if function_call is not None:
        return json.dumps(getattr(function_call, "args", None), default=str)
    if function_response is not None:
        return json.dumps(getattr(function_response, "response", None), default=str)
    return ""


def _strip_fenced_blocks(text: str) -> tuple[str, int]:
    stripped, count = _FENCED_BLOCK.subn(_FENCE_REMOVED, text)
    if _FENCE_MARKER in stripped:
        # An unterminated fence: drop everything from it on (fail closed).
        stripped = stripped[: stripped.index(_FENCE_MARKER)] + _FENCE_REMOVED
        count += 1
    return stripped, count


def _live_answer_bundle(state: Any) -> str:
    """The bundle this invocation is the admitted shared answer turn for, if any."""
    record = _state_get(state, STATE_CONSENT_CONTINUATION)
    if isinstance(record, Mapping) and str(record.get("outcome") or "") in SHARED_OUTCOMES:
        return str(record.get("bundleId") or "").lower()
    return ""


def _strip_stale_shared_block(state: Any, llm_request: Any, ended: Mapping[str, Any]) -> int:
    """Remove a fenced shared block from any instruction but its own live answer turn."""
    config = getattr(llm_request, "config", None)
    instruction = getattr(config, "system_instruction", None)
    live = _live_answer_bundle(state)
    if config is None or (live and live not in ended):
        return 0
    if isinstance(instruction, str) and _FENCE_MARKER in instruction:
        config.system_instruction, count = _strip_fenced_blocks(instruction)
        return count
    count = 0
    for part in getattr(instruction, "parts", None) or []:
        text = getattr(part, "text", None)
        if isinstance(text, str) and _FENCE_MARKER in text:
            part.text, stripped = _strip_fenced_blocks(text)
            count += stripped
    return count


def _align_turns(contents: list[Any], events: list[Any]) -> tuple[list[str | None], set[int]]:
    """Each request content's invocation, by aligning the person's messages in order.

    Returns ``(turn per content, indexes of the person's own messages)``. A
    content before the first aligned message has no known turn (``None``).
    """
    person_events = [
        (str(getattr(event, "invocation_id", "") or ""), key)
        for event in events
        if getattr(event, "author", "") == "user"
        and (key := _person_key(getattr(event, "content", None)))
    ]
    turns: list[str | None] = []
    person: set[int] = set()
    cursor = 0
    current: str | None = None
    for index, content in enumerate(contents):
        key = _person_key(content)
        if key is not None:
            match = next(
                (at for at in range(cursor, len(person_events)) if person_events[at][1] == key),
                None,
            )
            if match is not None:
                current = person_events[match][0]
                cursor = match + 1
                person.add(index)
        turns.append(current)
    return turns, person


def redact_ended_consent_context(callback_context: Any, llm_request: Any) -> int:
    """Before-model: replace ended bundles' turns in the request. Returns contents replaced."""
    state = getattr(callback_context, "state", None)
    ended_notes = _state_get(state, STATE_ENDED_CONSENT) if state is not None else None
    ended: Mapping[str, Any] = ended_notes if isinstance(ended_notes, Mapping) else {}
    fence = _strip_stale_shared_block(state, llm_request, ended) if state is not None else 0
    if fence:
        logger.warning("one.consent_shared_block_stripped blocks=%s", fence)
    if not ended:
        return 0

    note_by_turn: dict[str, str] = {}
    for bundle_id, invocations in tagged_bundles(state).items():
        if ended.get(bundle_id):
            for invocation_id in invocations:
                note_by_turn[invocation_id] = str(ended[bundle_id])
    notes = list(dict.fromkeys(str(note) for note in ended.values() if note))
    fallback_note = " ".join(notes) or neutral_note(None, None)
    session = getattr(callback_context, "session", None)
    events = list(getattr(session, "events", None) or [])
    # Net 2: exact content of anything the agent side produced in a tagged turn.
    note_by_content: dict[str, str] = {}
    anchored_turns: set[str] = set()
    for event in events:
        turn = str(getattr(event, "invocation_id", "") or "")
        if turn not in note_by_turn:
            continue
        if getattr(event, "author", "") == "user" and _person_key(event.content):
            anchored_turns.add(turn)
        elif stored_key := _content_key(getattr(event, "content", None)):
            note_by_content[stored_key] = note_by_turn[turn]
    tagged_with_events = {
        str(getattr(event, "invocation_id", "") or "")
        for event in events
        if str(getattr(event, "invocation_id", "") or "") in note_by_turn
    }

    contents = list(getattr(llm_request, "contents", None) or [])
    turns, person = _align_turns(contents, events)
    current_turn = str(getattr(callback_context, "invocation_id", "") or "")
    aligned = {turns[index] for index in person}
    unverified = sorted(
        turn for turn in tagged_with_events if turn not in anchored_turns or turn not in aligned
    )

    replace: dict[int, str] = {}
    for index, content in enumerate(contents):
        if index in person:
            continue
        content_turn = turns[index] or ""
        if content_turn in note_by_turn:
            replace[index] = note_by_turn[content_turn]
        elif (request_key := _content_key(content)) and request_key in note_by_content:
            replace[index] = note_by_content[request_key]
        elif _has_shared_fence(content):
            replace[index] = fallback_note
        elif content_turn != current_turn and _names_ended_bundle(content, ended):
            # This turn's own tool loop is left intact; the ledger read it makes
            # after the end returns no shared values.
            replace[index] = fallback_note
    if unverified:
        # Fail closed: every agent-side content from the first tagged turn on,
        # except this invocation's own work in progress.
        starts = [i for i, owner in enumerate(turns) if owner in note_by_turn] + sorted(replace)
        start = min(starts) if starts else 0
        for index in range(start, len(contents)):
            if index not in person and turns[index] != current_turn:
                replace.setdefault(index, fallback_note)
        logger.warning(
            "one.consent_redaction_unverified bundles=%s turns=%s",
            ",".join(sorted(ended)),
            len(unverified),
        )
    _keep_tool_pairs_whole(contents, replace)

    from google.genai import types as genai_types

    rewritten: list[Any] = []
    previous_note: str | None = None
    for index, content in enumerate(contents):
        note = replace.get(index)
        if note is None:
            rewritten.append(content)
            previous_note = None
            continue
        if note != previous_note:
            # ``content`` is ADK's per-request copy; the stored event keeps its parts.
            content.parts = [genai_types.Part(text=note)]
            content.role = "model"
            rewritten.append(content)
        previous_note = note
    if replace:
        llm_request.contents = rewritten
    logger.info(
        "one.consent_redaction bundles=%s tagged_turns=%s replaced=%s mode=%s",
        ",".join(sorted(ended)),
        len(tagged_with_events),
        len(replace),
        "fail_closed" if unverified else "identity",
    )
    return len(replace)


def _keep_tool_pairs_whole(contents: list[Any], replace: dict[int, str]) -> None:
    """A replaced tool call takes its response with it, and the reverse.

    A call without its response (or a response without its call) is a request
    the provider rejects.
    """
    for index in sorted(replace):
        if _has_function_parts(contents[index], "function_call"):
            following = index + 1
            if following < len(contents) and _has_function_parts(
                contents[following], "function_response"
            ):
                replace.setdefault(following, replace[index])
        if _has_function_parts(contents[index], "function_response") and index > 0:
            if _has_function_parts(contents[index - 1], "function_call"):
                replace.setdefault(index - 1, replace[index])


def consent_answer_fast_path(callback_context: Any, llm_request: Any, *, model: str | None) -> bool:
    """Before-model: the answer turn runs at the lowest thinking level and calls no tools.

    Assigns fresh config objects: ADK's request config is a shallow copy, so
    mutating the agent's own ``thinking_config`` would leak into later turns.
    """
    state = getattr(callback_context, "state", None)
    if not isinstance(_state_get(state, STATE_CONSENT_CONTINUATION), Mapping):
        return False
    config = getattr(llm_request, "config", None)
    if config is None:
        return False
    from google.genai import types as genai_types

    from hushh_mcp.runtime_providers.gemini_config import thinking_config_for

    resolved = thinking_config_for(model, "minimal", genai_types)
    config.thinking_config = genai_types.ThinkingConfig(
        include_thoughts=False,
        thinking_level=getattr(resolved, "thinking_level", None),
    )
    config.tool_config = genai_types.ToolConfig(
        function_calling_config=genai_types.FunctionCallingConfig(
            mode=genai_types.FunctionCallingConfigMode.NONE
        )
    )
    return True


def redaction_for_history(state: Any) -> tuple[dict[str, str], dict[str, str]]:
    """For the history projection: ``(invocation_id -> bundle_id, bundle_id -> ended outcome)``."""
    bundle_by_invocation: dict[str, str] = {}
    for bundle_id, invocations in tagged_bundles(state).items():
        for invocation_id in invocations:
            bundle_by_invocation.setdefault(invocation_id, bundle_id)
    ended = {
        bundle_id: str(_state_get(state, consent_access_ended_state_key(bundle_id)))
        for bundle_id in tagged_bundles(state)
        if _state_get(state, consent_access_ended_state_key(bundle_id))
    }
    return bundle_by_invocation, ended


def shared_record_for_history(state: Any, bundle_id: str) -> dict[str, Any]:
    """Labels and name for the "Access ended" card; no values."""
    record = _shared_record(state, bundle_id)
    labels = record.get("labels")
    return {
        "personName": str(record.get("personName") or "") or None,
        "labels": [str(label) for label in labels] if isinstance(labels, list) else [],
    }


__all__ = [
    "CONSENT_ACCESS_ENDED_PREFIX",
    "CONSENT_INVOCATIONS_PREFIX",
    "CONSENT_SHARED_STATE_PREFIX",
    "STATE_ENDED_CONSENT",
    "consent_access_ended_state_key",
    "consent_answer_fast_path",
    "consent_invocations_state_key",
    "neutral_note",
    "redact_ended_consent_context",
    "redaction_for_history",
    "shared_record_for_history",
    "tagged_bundles",
    "track_consent_access",
]
