"""Stateless, full-document LTM preparation; the unlocked owner app commits it."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from hushh_mcp.hushh_adk.manifest import ManifestLoader
from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn

MAX_MEMORY_CHARS = 96_000
MAX_SOURCE_CHARS = 192_000


class MemoryMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=256)
    conversationId: str = Field(min_length=1, max_length=256)
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=MAX_SOURCE_CHARS)


class RewriteMemoryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: str = Field(min_length=1, max_length=256)
    current_markdown: str = Field(max_length=MAX_MEMORY_CHARS)
    messages: list[MemoryMessage] = Field(min_length=1, max_length=2048)
    max_tokens: int = Field(default=24_000, ge=256, le=24_000)

    @model_validator(mode="after")
    def bounded_source(self):
        if sum(len(message.content) for message in self.messages) > MAX_SOURCE_CHARS:
            raise ValueError("Incremental memory source exceeds batch budget")
        if len({(m.conversationId, m.id) for m in self.messages}) != len(self.messages):
            raise ValueError("Duplicate source identity")
        return self


class RewriteMemoryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    markdown: str = Field(min_length=1, max_length=MAX_MEMORY_CHARS)


async def rewrite_chat_memory(body: RewriteMemoryRequest, *, model: Any = None):
    manifest = ManifestLoader.load(
        str(Path(__file__).parents[1] / "agents/chat_memory_manager/agent.yaml")
    )
    agent = build_single_turn_agent(manifest, output_schema=RewriteMemoryResponse, model=model)
    result = await run_single_turn(
        agent,
        user_id=body.user_id,
        consent_token="owner-chat-memory-preparation",  # noqa: S106 - not an access credential
        prompt_parts=json.dumps(
            {
                "current_markdown": body.current_markdown,
                "new_messages": [m.model_dump() for m in body.messages],
                "target_tokens": min(body.max_tokens, 16_000),
            },
            ensure_ascii=False,
        ),
        timeout_seconds=90,
    )
    return RewriteMemoryResponse.model_validate(result)
