# consent-protocol/hushh_mcp/services/chat_db_service.py
"""
Chat Database Service.

The old chat_conversations / chat_messages tables have been removed. Until chat
history is moved into PKM or a dedicated store, this service provides a
process-local in-memory fallback so Kai chat flows remain functional in local/UAT
without reviving deprecated tables.
"""

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import Enum
from typing import Optional
from uuid import uuid4

logger = logging.getLogger(__name__)


class MessageRole(str, Enum):
    """Role of message sender."""

    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"
    TOOL = "tool"


class ContentType(str, Enum):
    """Type of message content."""

    TEXT = "text"
    COMPONENT = "component"
    TOOL_USE = "tool_use"


class ComponentType(str, Enum):
    """Types of insertable UI components."""

    ANALYSIS = "analysis"
    PORTFOLIO_IMPORT = "portfolio_import"
    DECISION_CARD = "decision_card"
    HOLDINGS_CHART = "holdings_chart"
    PKM_SUMMARY = "pkm_summary"
    LOSER_REPORT = "loser_report"
    CONSENT_REQUEST = "consent_request"


@dataclass
class Conversation:
    """Chat conversation metadata."""

    id: str
    user_id: str
    title: Optional[str] = None
    agent_context: Optional[dict] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    title_ciphertext: Optional[str] = None
    title_iv: Optional[str] = None
    title_tag: Optional[str] = None
    encryption_status: str = "pending"


@dataclass
class ChatMessage:
    """Chat message with optional component and encryption support."""

    id: str
    conversation_id: str
    role: MessageRole
    content: str
    content_type: ContentType = ContentType.TEXT
    component_type: Optional[ComponentType] = None
    component_data: Optional[dict] = None
    tokens_used: Optional[int] = None
    model_used: Optional[str] = None
    created_at: Optional[datetime] = None
    content_ciphertext: Optional[str] = None
    content_iv: Optional[str] = None
    content_tag: Optional[str] = None
    component_data_ciphertext: Optional[str] = None
    component_data_iv: Optional[str] = None
    component_data_tag: Optional[str] = None
    encryption_status: str = "pending"


class ChatDBService:
    """
    Process-local in-memory chat store.

    This keeps the current Kai chat surfaces operational while the long-term PKM
    chat persistence design is finalized.
    """

    def __init__(self):
        self._conversations: dict[str, Conversation] = {}
        self._messages: dict[str, list[ChatMessage]] = {}

    def _now(self) -> datetime:
        return datetime.now(UTC)

    def _touch_conversation(self, conversation_id: str) -> None:
        conversation = self._conversations.get(conversation_id)
        if conversation is not None:
            conversation.updated_at = self._now()

    async def create_conversation(
        self,
        user_id: str,
        title: Optional[str] = None,
        agent_context: Optional[dict] = None,
        **_: object,
    ) -> Optional[Conversation]:
        conversation_id = str(uuid4())
        now = self._now()
        conversation = Conversation(
            id=conversation_id,
            user_id=user_id,
            title=title,
            agent_context=agent_context or {},
            created_at=now,
            updated_at=now,
        )
        self._conversations[conversation_id] = conversation
        self._messages[conversation_id] = []
        return conversation

    async def get_conversation(self, conversation_id: str) -> Optional[Conversation]:
        return self._conversations.get(conversation_id)

    async def list_conversations(
        self,
        user_id: str,
        limit: int = 20,
        offset: int = 0,
        **_: object,
    ) -> list[Conversation]:
        conversations = [
            conversation
            for conversation in self._conversations.values()
            if conversation.user_id == user_id
        ]
        conversations.sort(
            key=lambda conversation: (
                conversation.updated_at or conversation.created_at or self._now()
            ),
            reverse=True,
        )
        return conversations[offset : offset + limit]

    async def update_conversation(self, conversation_id: str, **kwargs: object) -> bool:
        conversation = self._conversations.get(conversation_id)
        if conversation is None:
            return False
        for key in ("title", "agent_context"):
            if key in kwargs:
                setattr(conversation, key, kwargs[key])
        conversation.updated_at = self._now()
        return True

    async def delete_conversation(self, conversation_id: str) -> bool:
        existed = conversation_id in self._conversations
        self._conversations.pop(conversation_id, None)
        self._messages.pop(conversation_id, None)
        return existed

    async def add_message(
        self,
        conversation_id: str,
        role: MessageRole,
        content: str,
        content_type: ContentType = ContentType.TEXT,
        component_type: Optional[ComponentType] = None,
        component_data: Optional[dict] = None,
        tokens_used: Optional[int] = None,
        model_used: Optional[str] = None,
        **_: object,
    ) -> Optional[ChatMessage]:
        if conversation_id not in self._conversations:
            logger.warning("chat.in_memory_missing_conversation id=%s", conversation_id)
            return None

        message = ChatMessage(
            id=str(uuid4()),
            conversation_id=conversation_id,
            role=role,
            content=content,
            content_type=content_type,
            component_type=component_type,
            component_data=component_data,
            tokens_used=tokens_used,
            model_used=model_used,
            created_at=self._now(),
        )
        self._messages.setdefault(conversation_id, []).append(message)
        self._touch_conversation(conversation_id)
        return message

    async def get_messages(
        self,
        conversation_id: str,
        limit: int = 50,
        offset: int = 0,
        **_: object,
    ) -> list[ChatMessage]:
        messages = list(self._messages.get(conversation_id, []))
        return messages[offset : offset + limit]

    async def get_recent_context(
        self,
        conversation_id: str,
        max_messages: int = 10,
        **_: object,
    ) -> list[dict]:
        messages = self._messages.get(conversation_id, [])
        recent_messages = messages[-max_messages:]
        return [
            {
                "role": message.role.value,
                "content": message.content,
                "content_type": message.content_type.value,
                "component_type": message.component_type.value if message.component_type else None,
                "component_data": message.component_data,
                "created_at": message.created_at.isoformat() if message.created_at else None,
            }
            for message in recent_messages
        ]

    async def add_analysis_component(self, *args, **kwargs) -> Optional[ChatMessage]:
        kwargs.setdefault("content_type", ContentType.COMPONENT)
        kwargs.setdefault("component_type", ComponentType.ANALYSIS)
        return await self.add_message(*args, **kwargs)

    async def add_decision_card(self, *args, **kwargs) -> Optional[ChatMessage]:
        kwargs.setdefault("content_type", ContentType.COMPONENT)
        kwargs.setdefault("component_type", ComponentType.DECISION_CARD)
        return await self.add_message(*args, **kwargs)

    async def add_loser_report(self, *args, **kwargs) -> Optional[ChatMessage]:
        kwargs.setdefault("content_type", ContentType.COMPONENT)
        kwargs.setdefault("component_type", ComponentType.LOSER_REPORT)
        return await self.add_message(*args, **kwargs)


_chat_db_service: Optional[ChatDBService] = None


def get_chat_db_service() -> ChatDBService:
    """Get singleton ChatDBService instance."""
    global _chat_db_service
    if _chat_db_service is None:
        _chat_db_service = ChatDBService()
    return _chat_db_service
