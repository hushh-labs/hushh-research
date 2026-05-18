"""Gemini-backed Agent chat service with encrypted durable history."""

from __future__ import annotations

import asyncio
import logging
import os
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, AsyncGenerator, Literal
from uuid import uuid4

from google import genai
from google.genai import types as genai_types

from db.db_client import get_db
from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.types import EncryptedPayload
from hushh_mcp.vault.encrypt import decrypt_data, encrypt_data

logger = logging.getLogger(__name__)

AGENT_CHAT_MODEL_ENV = "AGENT_GEMINI_MODEL"
DEFAULT_AGENT_CHAT_MODEL = "gemini-2.5-pro"
AGENT_SYSTEM_PROMPT = """You are Agent, the Kai-focused financial assistant inside Hussh.

Current capability boundary:
- Focus on markets, portfolio context, stock analysis, Kai workflows, consent/privacy surfaces, and how the Hussh app works.
- Normal finance and app questions should be answered as plain streaming text.
- When the stream includes a planned frontend app action, acknowledge that the app is starting or opening it. Do not claim destructive account changes, trades, approvals, revocations, or data deletion.
- Destructive, account-changing, trading, approval, revocation, and manual-only actions must be blocked and explained safely.
- Keep answers concise, practical, and clear. Financial answers are educational, not personalized investment advice.
"""

MessageRole = Literal["user", "assistant", "system", "tool"]
MessageStatus = Literal["complete", "interrupted", "error"]
AgentActionExecution = Literal["frontend", "blocked"]

_STOCK_ALIAS_TO_TICKER = {
    "alphabet": "GOOGL",
    "amazon": "AMZN",
    "amd": "AMD",
    "apple": "AAPL",
    "berkshire": "BRK.B",
    "berkshire hathaway": "BRK.B",
    "facebook": "META",
    "google": "GOOGL",
    "meta": "META",
    "microsoft": "MSFT",
    "netflix": "NFLX",
    "nvidia": "NVDA",
    "tesla": "TSLA",
    "uber": "UBER",
    "visa": "V",
}

_ANALYSIS_PATTERNS = [
    re.compile(
        r"\b(?:start|run|begin|launch|open|kick\s+off|do)\s+"
        r"(?:a\s+|an\s+|the\s+)?(?:stock\s+)?analysis\s+"
        r"(?:of|for|on|about)?\s*(?P<target>[A-Za-z0-9 .&()/-]{1,90})",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:analyze|analyse|research|evaluate)\s+"
        r"(?P<target>[A-Za-z0-9 .&()/-]{1,90})",
        re.IGNORECASE,
    ),
]

_NAVIGATION_ACTION_PATTERNS: list[tuple[re.Pattern[str], str, str]] = [
    (
        re.compile(
            r"\b(?:open|go to|show|take me to|navigate to)\b.*\b(?:consent|consents|permissions)\b",
            re.IGNORECASE,
        ),
        "route.consents",
        "Open Consent Center",
    ),
    (
        re.compile(
            r"\b(?:open|go to|show|take me to|navigate to)\b.*\b(?:profile|account)\b",
            re.IGNORECASE,
        ),
        "route.profile",
        "Open Profile",
    ),
    (
        re.compile(
            r"\b(?:open|go to|show|take me to|navigate to|upload|import)\b.*\b(?:import|statement|portfolio upload)\b",
            re.IGNORECASE,
        ),
        "route.kai_import",
        "Open Portfolio Import",
    ),
    (
        re.compile(
            r"\b(?:open|go to|show|take me to|navigate to)\b.*\b(?:portfolio|holdings|dashboard)\b",
            re.IGNORECASE,
        ),
        "route.kai_dashboard",
        "Open Portfolio Dashboard",
    ),
    (
        re.compile(
            r"\b(?:open|go to|show|take me to|navigate to)\b.*\b(?:analysis history|past analyses|past analysis|history)\b",
            re.IGNORECASE,
        ),
        "route.analysis_history",
        "Open Analysis History",
    ),
    (
        re.compile(
            r"\b(?:open|go to|show|take me to|navigate to|start|run)\b.*\b(?:optimize|optimise|rebalance)\b",
            re.IGNORECASE,
        ),
        "route.kai_optimize",
        "Open Optimize Surface",
    ),
    (
        re.compile(
            r"\b(?:open|go to|show|take me to|navigate to)\b.*\b(?:market|kai home|home)\b",
            re.IGNORECASE,
        ),
        "route.kai_home",
        "Open Market Home",
    ),
]

_BLOCKED_ACTION_PATTERNS = [
    re.compile(r"\b(?:delete|erase|wipe)\b.*\b(?:account|vault|profile|data)\b", re.IGNORECASE),
    re.compile(
        r"\b(?:revoke|approve|deny|grant)\b.*\b(?:consent|permission|request)\b", re.IGNORECASE
    ),
    re.compile(
        r"\b(?:disconnect|unlink)\b.*\b(?:account|bank|brokerage|gmail|google)\b", re.IGNORECASE
    ),
    re.compile(r"\b(?:sign out|log out|logout)\b", re.IGNORECASE),
    re.compile(r"\b(?:cancel|stop)\b.*\b(?:active\s+)?analysis\b", re.IGNORECASE),
    re.compile(
        r"\b(?:buy|sell|trade)\b.*\b(?:now|for me|on my behalf|in my account)\b", re.IGNORECASE
    ),
    re.compile(r"\b(?:place|execute)\b.*\b(?:order|trade)\b", re.IGNORECASE),
]


@dataclass
class AgentChatConversation:
    id: str
    user_id: str
    title: str
    status: str
    model: str | None
    message_count: int
    created_at: str | None
    updated_at: str | None
    last_message_at: str | None


@dataclass
class AgentChatMessage:
    id: str
    conversation_id: str
    user_id: str
    role: str
    status: str
    content: str
    model: str | None
    created_at: str | None
    completed_at: str | None


@dataclass
class PreparedAgentChatTurn:
    conversation_id: str
    user_message_id: str
    history: list[AgentChatMessage]
    model: str


@dataclass(frozen=True)
class AgentChatActionPlan:
    call_id: str
    action_id: str | None
    label: str
    execution: AgentActionExecution
    slots: dict[str, Any]
    message: str
    reason: str | None = None

    def to_event_payload(self) -> dict[str, Any]:
        return {
            "call_id": self.call_id,
            "action_id": self.action_id,
            "label": self.label,
            "execution": self.execution,
            "slots": self.slots,
            "message": self.message,
            "reason": self.reason,
        }


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _trim_title(text: str) -> str:
    normalized = " ".join(str(text or "").split())
    if not normalized:
        return "New Agent chat"
    return normalized[:80]


def _tool_call_id() -> str:
    return f"tool_{uuid4().hex[:12]}"


def _sanitize_analysis_target(raw: str) -> str:
    target = re.sub(r"[^A-Za-z0-9 .&()/-]", " ", str(raw or ""))
    target = re.split(
        r"\b(?:and|then|with|using|please|for me|right now|now|today)\b",
        target,
        maxsplit=1,
        flags=re.IGNORECASE,
    )[0]
    target = re.sub(r"\(([^)]+)\)", r" \1 ", target)
    target = re.sub(
        r"\b(?:stock|stocks|share|shares|company|ticker|symbol|analysis|report|deep dive)\b",
        " ",
        target,
        flags=re.IGNORECASE,
    )
    return " ".join(target.split()).strip(" .,-/")


def _resolve_ticker(raw: str) -> str | None:
    target = _sanitize_analysis_target(raw)
    if not target:
        return None
    upper_symbol_match = re.search(r"\b[A-Z]{1,5}(?:\.[A-Z])?\b", target)
    if upper_symbol_match:
        return upper_symbol_match.group(0).upper()
    normalized = target.lower().strip()
    if normalized in _STOCK_ALIAS_TO_TICKER:
        return _STOCK_ALIAS_TO_TICKER[normalized]
    normalized = re.sub(
        r"\b(?:inc|corp|corporation|company|plc|ltd|limited|class\s+[ab])\b", " ", normalized
    )
    normalized = " ".join(normalized.split())
    if normalized in _STOCK_ALIAS_TO_TICKER:
        return _STOCK_ALIAS_TO_TICKER[normalized]
    if re.fullmatch(r"[A-Za-z]{1,5}(?:\.[A-Za-z])?", target):
        return target.upper()
    return None


class AgentChatService:
    """Owns Agent chat LLM streaming and backend-decryptable encrypted history."""

    def __init__(
        self,
        *,
        db: Any | None = None,
        model: str | None = None,
        vault_key_hex: str | None = None,
    ):
        self._db = db
        self._client = None
        self._settings = None
        self.model = (model or os.getenv(AGENT_CHAT_MODEL_ENV) or DEFAULT_AGENT_CHAT_MODEL).strip()
        self._vault_key_hex = vault_key_hex

    @property
    def settings(self):
        if self._settings is None:
            self._settings = get_core_security_settings()
        return self._settings

    @property
    def vault_key_hex(self) -> str:
        return self._vault_key_hex or self.settings.vault_data_key

    @property
    def db(self):
        if self._db is None:
            self._db = get_db()
        return self._db

    @property
    def client(self):
        if self._client is None:
            api_key = self.settings.google_api_key or os.getenv("GOOGLE_API_KEY", "").strip()
            if not api_key:
                raise RuntimeError("Gemini API key is not configured")
            self._client = genai.Client(api_key=api_key)
        return self._client

    async def _execute_raw(self, sql: str, params: dict[str, Any] | None = None):
        return await asyncio.to_thread(self.db.execute_raw, sql, params or {})

    def _encrypt_text(self, text: str) -> EncryptedPayload:
        return encrypt_data(str(text or ""), self.vault_key_hex)

    def _decrypt_text(self, row: dict[str, Any], prefix: str) -> str:
        ciphertext = str(row.get(f"{prefix}_ciphertext") or "")
        iv = str(row.get(f"{prefix}_iv") or "")
        tag = str(row.get(f"{prefix}_tag") or "")
        if not ciphertext or not iv or not tag:
            return ""
        payload = EncryptedPayload(
            ciphertext=ciphertext,
            iv=iv,
            tag=tag,
            encoding="base64",
            algorithm="aes-256-gcm",
        )
        return decrypt_data(payload, self.vault_key_hex)

    async def get_conversation(
        self,
        conversation_id: str,
        *,
        user_id: str | None = None,
    ) -> AgentChatConversation | None:
        params: dict[str, Any] = {"conversation_id": conversation_id}
        if user_id is not None:
            params["user_id"] = user_id
            sql = """
            SELECT *
            FROM agent_chat_conversations
            WHERE id = :conversation_id AND user_id = :user_id
            LIMIT 1
            """
        else:
            sql = """
            SELECT *
            FROM agent_chat_conversations
            WHERE id = :conversation_id
            LIMIT 1
            """
        result = await self._execute_raw(
            sql,
            params,
        )
        rows = result.data or []
        if not rows:
            return None
        return self._conversation_from_row(rows[0])

    async def create_conversation(self, user_id: str, first_message: str) -> AgentChatConversation:
        conversation_id = str(uuid4())
        encrypted_title = self._encrypt_text(_trim_title(first_message))
        result = await self._execute_raw(
            """
            INSERT INTO agent_chat_conversations (
              id,
              user_id,
              title_ciphertext,
              title_iv,
              title_tag,
              title_algorithm,
              model
            )
            VALUES (
              :id,
              :user_id,
              :title_ciphertext,
              :title_iv,
              :title_tag,
              :title_algorithm,
              :model
            )
            RETURNING *
            """,
            {
                "id": conversation_id,
                "user_id": user_id,
                "title_ciphertext": encrypted_title.ciphertext,
                "title_iv": encrypted_title.iv,
                "title_tag": encrypted_title.tag,
                "title_algorithm": encrypted_title.algorithm,
                "model": self.model,
            },
        )
        return self._conversation_from_row((result.data or [])[0])

    async def get_or_create_conversation(
        self,
        *,
        user_id: str,
        conversation_id: str | None,
        first_message: str,
    ) -> AgentChatConversation:
        if conversation_id:
            conversation = await self.get_conversation(conversation_id, user_id=user_id)
            if conversation is not None:
                return conversation
        return await self.create_conversation(user_id, first_message)

    async def prepare_turn(
        self,
        *,
        user_id: str,
        message: str,
        conversation_id: str | None = None,
    ) -> PreparedAgentChatTurn:
        conversation = await self.get_or_create_conversation(
            user_id=user_id,
            conversation_id=conversation_id,
            first_message=message,
        )
        history = await self.get_recent_messages(conversation.id, user_id=user_id, limit=20)
        user_message = await self.add_message(
            conversation_id=conversation.id,
            user_id=user_id,
            role="user",
            content=message,
            status="complete",
            model=None,
        )
        return PreparedAgentChatTurn(
            conversation_id=conversation.id,
            user_message_id=user_message.id,
            history=history,
            model=self.model,
        )

    async def add_message(
        self,
        *,
        conversation_id: str,
        user_id: str,
        role: MessageRole,
        content: str,
        status: MessageStatus,
        model: str | None = None,
        error_code: str | None = None,
    ) -> AgentChatMessage:
        message_id = str(uuid4())
        encrypted = self._encrypt_text(content)
        result = await self._execute_raw(
            """
            INSERT INTO agent_chat_messages (
              id,
              conversation_id,
              user_id,
              role,
              status,
              content_ciphertext,
              content_iv,
              content_tag,
              content_algorithm,
              model,
              error_code,
              completed_at
            )
            VALUES (
              :id,
              :conversation_id,
              :user_id,
              :role,
              :status,
              :content_ciphertext,
              :content_iv,
              :content_tag,
              :content_algorithm,
              :model,
              :error_code,
              now()
            )
            RETURNING *
            """,
            {
                "id": message_id,
                "conversation_id": conversation_id,
                "user_id": user_id,
                "role": role,
                "status": status,
                "content_ciphertext": encrypted.ciphertext,
                "content_iv": encrypted.iv,
                "content_tag": encrypted.tag,
                "content_algorithm": encrypted.algorithm,
                "model": model,
                "error_code": error_code,
            },
        )
        await self._execute_raw(
            """
            UPDATE agent_chat_conversations
            SET
              updated_at = now(),
              last_message_at = now(),
              message_count = message_count + 1,
              model = COALESCE(:model, model)
            WHERE id = :conversation_id AND user_id = :user_id
            """,
            {
                "conversation_id": conversation_id,
                "user_id": user_id,
                "model": model,
            },
        )
        return self._message_from_row((result.data or [])[0])

    async def get_recent_messages(
        self,
        conversation_id: str,
        *,
        user_id: str,
        limit: int = 20,
    ) -> list[AgentChatMessage]:
        safe_limit = max(1, min(int(limit), 100))
        result = await self._execute_raw(
            """
            SELECT *
            FROM (
              SELECT *
              FROM agent_chat_messages
              WHERE conversation_id = :conversation_id AND user_id = :user_id
              ORDER BY created_at DESC
              LIMIT :limit
            ) recent
            ORDER BY created_at ASC
            """,
            {
                "conversation_id": conversation_id,
                "user_id": user_id,
                "limit": safe_limit,
            },
        )
        return [self._message_from_row(row) for row in result.data or []]

    async def list_conversations(
        self,
        user_id: str,
        *,
        limit: int = 5,
    ) -> list[AgentChatConversation]:
        safe_limit = max(1, min(int(limit), 20))
        result = await self._execute_raw(
            """
            SELECT *
            FROM agent_chat_conversations
            WHERE user_id = :user_id
            ORDER BY updated_at DESC
            LIMIT :limit
            """,
            {
                "user_id": user_id,
                "limit": safe_limit,
            },
        )
        return [self._conversation_from_row(row) for row in result.data or []]

    async def stream_response(
        self,
        *,
        user_message: str,
        history: list[AgentChatMessage],
        action_plan: AgentChatActionPlan | None = None,
    ) -> AsyncGenerator[str, None]:
        prompt = self._build_prompt(
            user_message=user_message,
            history=history,
            action_plan=action_plan,
        )
        config = genai_types.GenerateContentConfig(
            temperature=0.7,
            max_output_tokens=4096,
        )
        stream = await self.client.aio.models.generate_content_stream(
            model=self.model,
            contents=prompt,
            config=config,
        )
        async for chunk in stream:
            text = self._chunk_text(chunk)
            if text:
                yield text

    def plan_action(self, user_message: str) -> AgentChatActionPlan | None:
        message = " ".join(str(user_message or "").split())
        if not message:
            return None

        for pattern in _BLOCKED_ACTION_PATTERNS:
            if pattern.search(message):
                return AgentChatActionPlan(
                    call_id=_tool_call_id(),
                    action_id=None,
                    label="Blocked Manual Action",
                    execution="blocked",
                    slots={},
                    message=(
                        "I can't perform destructive, account-changing, consent approval, "
                        "revocation, or trading actions from Agent. Please do that manually."
                    ),
                    reason="manual_or_destructive_action",
                )

        for pattern in _ANALYSIS_PATTERNS:
            match = pattern.search(message)
            if not match:
                continue
            ticker = _resolve_ticker(match.group("target"))
            if not ticker:
                continue
            return AgentChatActionPlan(
                call_id=_tool_call_id(),
                action_id="analysis.start",
                label=f"Start analysis for {ticker}",
                execution="frontend",
                slots={"symbol": ticker},
                message=f"Starting Kai analysis for {ticker}.",
            )

        for pattern, action_id, label in _NAVIGATION_ACTION_PATTERNS:
            if pattern.search(message):
                return AgentChatActionPlan(
                    call_id=_tool_call_id(),
                    action_id=action_id,
                    label=label,
                    execution="frontend",
                    slots={},
                    message=f"{label} in the app.",
                )
        return None

    def _build_prompt(
        self,
        *,
        user_message: str,
        history: list[AgentChatMessage],
        action_plan: AgentChatActionPlan | None = None,
    ) -> str:
        history_lines = []
        for message in history[-20:]:
            if message.role not in {"user", "assistant"}:
                continue
            role = "User" if message.role == "user" else "Agent"
            history_lines.append(f"{role}: {message.content[:4000]}")
        history_text = "\n".join(history_lines) if history_lines else "No prior messages."
        action_context = "No frontend app action is planned for this turn."
        if action_plan and action_plan.execution == "frontend":
            action_context = (
                "Frontend app action planned for this turn:\n"
                f"- action_id: {action_plan.action_id}\n"
                f"- label: {action_plan.label}\n"
                f"- slots: {action_plan.slots}\n"
                "Instruction: briefly acknowledge that this action is being started or opened in Kai. "
                "Do not ask for confirmation."
            )
        elif action_plan and action_plan.execution == "blocked":
            action_context = (
                "A requested action was blocked before execution:\n"
                f"- reason: {action_plan.reason}\n"
                f"- message: {action_plan.message}\n"
                "Instruction: explain the block clearly and suggest the safe manual path."
            )
        return (
            f"{AGENT_SYSTEM_PROMPT}\n\n"
            f"Conversation history:\n{history_text}\n\n"
            f"Action context:\n{action_context}\n\n"
            f"User: {user_message}\n\n"
            "Agent:"
        )

    def _chunk_text(self, chunk: Any) -> str:
        text_value = getattr(chunk, "text", None)
        if isinstance(text_value, str) and text_value:
            return text_value
        parts: list[str] = []
        candidates = getattr(chunk, "candidates", None) or []
        for candidate in candidates:
            content = getattr(candidate, "content", None)
            for part in getattr(content, "parts", None) or []:
                part_text = getattr(part, "text", None)
                if isinstance(part_text, str) and part_text:
                    parts.append(part_text)
        return "".join(parts)

    def _conversation_from_row(self, row: dict[str, Any]) -> AgentChatConversation:
        try:
            title = self._decrypt_text(row, "title")
        except Exception:
            logger.warning("agent_chat.title_decrypt_failed conversation_id=%s", row.get("id"))
            title = "Agent conversation"
        return AgentChatConversation(
            id=str(row.get("id") or ""),
            user_id=str(row.get("user_id") or ""),
            title=title or "Agent conversation",
            status=str(row.get("status") or "active"),
            model=str(row.get("model")) if row.get("model") else None,
            message_count=int(row.get("message_count") or 0),
            created_at=_iso(row.get("created_at")),
            updated_at=_iso(row.get("updated_at")),
            last_message_at=_iso(row.get("last_message_at")),
        )

    def _message_from_row(self, row: dict[str, Any]) -> AgentChatMessage:
        try:
            content = self._decrypt_text(row, "content")
        except Exception:
            logger.warning("agent_chat.message_decrypt_failed message_id=%s", row.get("id"))
            content = ""
        return AgentChatMessage(
            id=str(row.get("id") or ""),
            conversation_id=str(row.get("conversation_id") or ""),
            user_id=str(row.get("user_id") or ""),
            role=str(row.get("role") or ""),
            status=str(row.get("status") or "complete"),
            content=content,
            model=str(row.get("model")) if row.get("model") else None,
            created_at=_iso(row.get("created_at")),
            completed_at=_iso(row.get("completed_at")),
        )


_agent_chat_service: AgentChatService | None = None


def get_agent_chat_service() -> AgentChatService:
    global _agent_chat_service
    if _agent_chat_service is None:
        _agent_chat_service = AgentChatService()
    return _agent_chat_service
