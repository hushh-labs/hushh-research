"""Turn-local presentation tool for typed chat; no storage or action authority."""

from collections.abc import Callable
from typing import Any

from google.adk.tools.tool_context import ToolContext

from hushh_mcp.one_adk.external_read_boundary import STATE_EXECUTION_SURFACE
from hushh_mcp.services.agent_chat_reaction import (
    REACTION_EMOJIS,
    normalize_reaction,
)

REACTION_TOOL_NAME = "react_to_message"
_REACTION_SHOWN = "temp:message_reaction_shown"

REACTION_INSTRUCTION = """

MESSAGE REACTIONS (typed chat only): you may tap exactly one emoji reaction
onto the person's latest message, like a person in a chat thread. To do it,
call react_to_message with a single emoji as part of your turn; the app
attaches it to their message bubble. The reaction is separate from your text
reply and is never mentioned in it.

When to react (apply these priorities in order):
- Difficult or vulnerable news: react with a heart (💛) only, never a
  thumbs-up or anything celebratory or playful. Skip endorsement of harmful
  requests, even when phrased as a capability question.
- When the person asks you to do work or help with any task, call
  react_to_message with 👍. Also use 👍 for capability or feasibility
  questions such as "Can you explain this?", "Could you help me plan?", or
  "Can I export this?". Include requests phrased without a question, such as
  "Summarize this" or "Please make a plan". No emotional wording is needed.
  This request acknowledgement takes priority over a topic-specific emoji.
  It acknowledges receipt, not task completion, permission, or a promise
  that the requested action is possible; explain any limits in your answer.
- Their message names something with an obvious emoji counterpart (a place,
  food, plan, hobby, thing they mentioned): react with that specific emoji.
  Specific beats generic.
- Humor, warmth, a small win, shared excitement, a meaningful personal
  update: a warm or playful emoji that fits the moment.

When to skip (call nothing):
- Neutral statements or other ordinary questions that do not meet any of
  the reaction criteria above. Do not skip work requests or capability
  questions merely because they have no emotional charge.
- Only the person's latest message is eligible: never your own messages,
  never older ones, never more than one emoji per turn.

The call is sidecar metadata. It never ends your turn — you still write your
full answer as usual, before or after calling it.
Consider negation, quotation, sarcasm and the conversation's meaning.
If no allowed emoji fits, skip the reaction.
"""


def reaction_instruction(state_getter: Callable[..., Any] | None) -> str:
    if not callable(state_getter) or state_getter(STATE_EXECUTION_SURFACE) != "typed_chat":
        return ""
    return REACTION_INSTRUCTION + "\nAllowed emoji: " + " ".join(sorted(REACTION_EMOJIS))


def react_to_message(emoji: str, tool_context: ToolContext) -> dict[str, str]:
    """Optionally react to the latest user message with one allowed emoji; continue answering."""
    state = tool_context.state
    if state.get(STATE_EXECUTION_SURFACE) != "typed_chat" or state.get(_REACTION_SHOWN):
        return {"status": "ignored"}
    reaction = normalize_reaction({"emoji": emoji, "actor": "agent"})
    if reaction is None:
        return {"status": "ignored"}
    state[_REACTION_SHOWN] = True
    result = {"status": "shown", "emoji": reaction["emoji"]}
    # Joined input carries a server-owned client reference. The model never
    # supplies a message ID and cannot redirect a reaction to another bubble.
    for event in reversed(getattr(getattr(tool_context, "session", None), "events", []) or []):
        if event.author != "user":
            continue
        client_id = (event.custom_metadata or {}).get("clientMessageId")
        if isinstance(client_id, str) and client_id:
            result["clientMessageId"] = client_id
        break
    return result


def without_message_reactions(session: Any) -> Any:
    """Exclude reaction call/results from sealed history, preserving live ADK events."""
    events = []
    for event in session.events:
        updates = {}
        if event.content and event.content.parts:
            parts = [
                part
                for part in event.content.parts
                if not any(
                    getattr(getattr(part, kind, None), "name", None) == REACTION_TOOL_NAME
                    for kind in ("function_call", "function_response")
                )
            ]
            if len(parts) != len(event.content.parts):
                updates["content"] = (
                    event.content.model_copy(update={"parts": parts}) if parts else None
                )
        if _REACTION_SHOWN in event.actions.state_delta:
            updates["actions"] = event.actions.model_copy(
                update={
                    "state_delta": {
                        key: value
                        for key, value in event.actions.state_delta.items()
                        if key != _REACTION_SHOWN
                    }
                }
            )
        events.append(event.model_copy(update=updates) if updates else event)
    return session.model_copy(update={"events": events})
