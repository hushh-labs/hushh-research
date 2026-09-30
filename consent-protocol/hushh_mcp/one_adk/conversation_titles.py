"""Owner-scoped, tool-free summaries for encrypted chat history labels."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from hushh_mcp.hushh_adk.manifest import ManifestLoader
from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn

logger = logging.getLogger(__name__)
MANUAL_TITLE = "hussh:thread_title"
GENERATED_TITLE = "hussh:thread_summary_title"
# Content-free, bounded process-local backoff; never cache prompts or keys.
_retry_after: OrderedDict[str, float] = OrderedDict()


class ConversationTitle(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    ref: str
    title: str = Field(min_length=1, max_length=32)

    @field_validator("title")
    @classmethod
    def concise_complete_title(cls, value: str) -> str:
        if value != value.strip() or "\n" in value or "..." in value or "…" in value:
            raise ValueError("Title must be a complete, single-line label")
        if len(value.split()) > 6:
            raise ValueError("Title must contain at most six words")
        return value


class ConversationTitles(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    items: list[ConversationTitle] = Field(max_length=20)


def opening_prompt(session: Any) -> str:
    # Only the owner's opening words. Assistant replies may contain subsequently
    # revoked shared information; tool results and thoughts never enter a title.
    for event in session.events:
        if event.author != "user":
            continue
        parts = getattr(getattr(event, "content", None), "parts", None) or []
        text = "\n".join(
            part.text
            for part in parts
            if getattr(part, "text", None) and not getattr(part, "thought", False)
        ).strip()
        if text:
            return text[:1500]
    return ""


async def generate_titles(
    *, openings: list[dict[str, str]], owner: str, token: str
) -> ConversationTitles:
    manifest = ManifestLoader.load(
        str(Path(__file__).resolve().parents[1] / "agents" / "one" / "agent.yaml")
    )
    gene = next(child for child in manifest.subagents if child.id == "one_conversation_title")
    agent = build_single_turn_agent(gene, output_schema=ConversationTitles)
    result = await run_single_turn(
        agent,
        prompt_parts=json.dumps({"conversations": openings}, ensure_ascii=False),
        user_id=owner,
        consent_token=token,
        timeout_seconds=12,
    )

    if not isinstance(result, ConversationTitles):
        raise ValueError("Invalid title response")
    return result


async def ensure_conversation_titles(
    *, sessions: list[Any], service: Any, owner: str, token: str
) -> None:
    """Repair untitled history in one bounded model call under the live chat key."""
    if os.getenv("ONE_CHAT_TITLE_SUMMARIES_ENABLED", "true").lower() == "false":
        logger.info("one.chat_titles outcome=disabled")
        return
    pending: dict[str, Any] = {}
    openings = []
    for session in sessions[:20]:
        if session.user_id != owner:
            continue
        if session.state.get(MANUAL_TITLE) or session.state.get(GENERATED_TITLE):
            continue
        text = opening_prompt(session)
        if text:
            ref = f"c{len(pending)}"
            pending[ref] = session
            openings.append({"ref": ref, "opening": text})
    if not openings or not token:
        return
    retry_key = hashlib.sha256(owner.encode()).hexdigest()
    now = time.monotonic()
    if _retry_after.get(retry_key, 0) > now:
        return
    _retry_after[retry_key] = now + 60
    _retry_after.move_to_end(retry_key)
    while len(_retry_after) > 1024:
        _retry_after.popitem(last=False)
    try:
        result = await generate_titles(openings=openings, owner=owner, token=token)
        if not isinstance(result, ConversationTitles):
            raise ValueError("Invalid title response")
        refs = [item.ref for item in result.items]
        if len(refs) != len(set(refs)) or set(refs) != set(pending):
            raise ValueError("Title response must cover exactly the supplied conversations")
    except Exception as error:
        logger.warning("one.chat_titles outcome=model_failed error_type=%s", type(error).__name__)
        return
    _retry_after.pop(retry_key, None)
    for item in result.items:
        session = pending[item.ref]
        try:
            saved = await service.set_title(
                app_name=session.app_name,
                user_id=owner,
                session_id=session.id,
                title=item.title,
                generated=True,
            )
            if saved is not None:
                for key in (MANUAL_TITLE, GENERATED_TITLE):
                    if saved.state.get(key):
                        session.state[key] = saved.state[key]
        except Exception as error:
            logger.warning(
                "one.chat_titles outcome=save_failed error_type=%s", type(error).__name__
            )
    logger.info("one.chat_titles outcome=completed count=%s", len(result.items))
