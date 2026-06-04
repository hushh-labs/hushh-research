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
- Use the provided PKM context when it is relevant, especially when the user asks what Kai knows about them or shares preferences.
- The PKM context may contain decrypted session-only details supplied by the frontend after vault unlock. Treat it as user-authorized memory for this turn, not as exhaustive truth. Do not invent personal facts outside that context and the current conversation.
- If PKM context is present and the user asks to show, summarize, or reason over PKM, answer from that context. Do not claim Agent cannot access PKM.
- When the user explicitly asks to save, remember, or add durable personal context to PKM, use the frontend PKM tool. Do not say Agent cannot save to PKM.
- Normal finance and app questions should be answered as streaming text. Use concise GitHub-flavored Markdown with headings, lists, links, code, or tables when structure makes the answer easier to scan.
- When the stream includes a planned frontend app action, keep the reply to a short receipt. The frontend owns the actual navigation/action state.
- Destructive, account-changing, trading, approval, revocation, and manual-only actions must be blocked and explained safely.
- Keep answers concise, practical, and clear. Financial answers are educational, not personalized investment advice.
"""

AGENT_ACTION_PLANNER_PROMPT = """You are Agent's action router inside Hussh.

Decide whether the latest user message needs a frontend app function.

Call exactly one function only when the user clearly asks Agent to do one of these:
- start stock analysis for a ticker or public company
- open a Hussh/Kai app surface
- save, remember, or add durable personal context to the user's PKM
- perform a destructive, account-changing, consent approval/revocation, trading, or manual-only action that must be blocked

Do not call a function for normal finance questions, explanations, brainstorming, or general chat.
When unsure, do not call a function.
"""

_APP_SURFACE_ACTIONS: dict[str, tuple[str, str]] = {
    "consent_center": ("route.consents", "Open Consent Center"),
    "pkm": ("route.profile_pkm_agent_lab", "Open PKM"),
    "profile": ("route.profile", "Open Profile"),
    "portfolio_import": ("route.kai_import", "Open Portfolio Import"),
    "portfolio_dashboard": ("route.kai_dashboard", "Open Portfolio Dashboard"),
    "analysis_history": ("route.analysis_history", "Open Analysis History"),
    "optimize": ("route.kai_optimize", "Open Optimize Surface"),
    "market_home": ("route.kai_home", "Open Market Home"),
}

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
            r"\b(?:open|go to|show|take me to|navigate to)\b.*\b(?:pkm|personal knowledge|memory lab|saved memory|saved memories)\b",
            re.IGNORECASE,
        ),
        "route.profile_pkm_agent_lab",
        "Open PKM",
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

_PKM_ADD_PATTERNS = [
    re.compile(
        r"\b(?:add|save|store|remember)\b.*\b(?:pkm|personal knowledge|memory|memories)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:add|save|store|remember)\s+(?:this|that)\b",
        re.IGNORECASE,
    ),
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


def _schema_string(description: str, *, enum: list[str] | None = None) -> genai_types.Schema:
    return genai_types.Schema(
        type=genai_types.Type.STRING,
        description=description,
        enum=enum,
    )


def _schema_object(
    properties: dict[str, genai_types.Schema],
    *,
    required: list[str] | None = None,
) -> genai_types.Schema:
    return genai_types.Schema(
        type=genai_types.Type.OBJECT,
        properties=properties,
        required=required or [],
    )


def _agent_action_tool() -> genai_types.Tool:
    return genai_types.Tool(
        function_declarations=[
            genai_types.FunctionDeclaration(
                name="start_stock_analysis",
                description=(
                    "Start Kai's frontend stock analysis workflow for a requested ticker "
                    "or public company."
                ),
                parameters=_schema_object(
                    {
                        "symbol": _schema_string(
                            "Ticker symbol if known, for example NVDA or AAPL."
                        ),
                        "company": _schema_string(
                            "Company or asset name if the user gave a name instead of a ticker."
                        ),
                    }
                ),
            ),
            genai_types.FunctionDeclaration(
                name="open_app_surface",
                description="Open a safe Hussh or Kai frontend surface.",
                parameters=_schema_object(
                    {
                        "surface": _schema_string(
                            "Frontend surface to open.",
                            enum=list(_APP_SURFACE_ACTIONS.keys()),
                        )
                    },
                    required=["surface"],
                ),
            ),
            genai_types.FunctionDeclaration(
                name="block_manual_action",
                description=(
                    "Use when the user asks Agent to perform a destructive, account-changing, "
                    "consent approval/revocation, trading, or manual-only action."
                ),
                parameters=_schema_object(
                    {
                        "reason": _schema_string(
                            "Short safe reason explaining why Agent cannot perform the action."
                        )
                    }
                ),
            ),
            genai_types.FunctionDeclaration(
                name="add_to_pkm",
                description=(
                    "Save or queue durable personal context to the user's encrypted PKM through "
                    "the frontend PKM writer. Use only when the user explicitly asks to save, "
                    "remember, store, or add information to PKM or memory."
                ),
                parameters=_schema_object(
                    {
                        "memory_text": _schema_string(
                            "The exact user-provided information that should be considered for PKM."
                        ),
                        "reason": _schema_string(
                            "Short reason this looks like long-term personal context."
                        ),
                    },
                    required=["memory_text"],
                ),
            ),
        ]
    )


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

    async def rename_conversation(
        self,
        conversation_id: str,
        *,
        user_id: str,
        title: str,
    ) -> AgentChatConversation | None:
        encrypted_title = self._encrypt_text(_trim_title(title))
        result = await self._execute_raw(
            """
            UPDATE agent_chat_conversations
            SET
              title_ciphertext = :title_ciphertext,
              title_iv = :title_iv,
              title_tag = :title_tag,
              title_algorithm = :title_algorithm,
              updated_at = now()
            WHERE id = :conversation_id AND user_id = :user_id
            RETURNING *
            """,
            {
                "conversation_id": conversation_id,
                "user_id": user_id,
                "title_ciphertext": encrypted_title.ciphertext,
                "title_iv": encrypted_title.iv,
                "title_tag": encrypted_title.tag,
                "title_algorithm": encrypted_title.algorithm,
            },
        )
        rows = result.data or []
        if not rows:
            return None
        return self._conversation_from_row(rows[0])

    async def delete_conversation(self, conversation_id: str, *, user_id: str) -> bool:
        result = await self._execute_raw(
            """
            DELETE FROM agent_chat_conversations
            WHERE id = :conversation_id AND user_id = :user_id
            RETURNING id
            """,
            {
                "conversation_id": conversation_id,
                "user_id": user_id,
            },
        )
        return bool(result.data or [])

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
        pkm_context: str | None = None,
    ) -> AsyncGenerator[str, None]:
        contents = self._build_contents(
            user_message=user_message,
            history=history,
            action_plan=action_plan,
            pkm_context=pkm_context,
        )
        config = genai_types.GenerateContentConfig(
            system_instruction=AGENT_SYSTEM_PROMPT,
            temperature=0.7,
            max_output_tokens=4096,
        )
        stream = await self.client.aio.models.generate_content_stream(
            model=self.model,
            contents=contents,
            config=config,
        )
        async for chunk in stream:
            text = self._chunk_text(chunk)
            if text:
                yield text

    async def plan_action_with_gemini(
        self,
        *,
        user_message: str,
        history: list[AgentChatMessage],
        pkm_context: str | None = None,
    ) -> AgentChatActionPlan | None:
        deterministic_block = self._plan_blocked_action(user_message)
        if deterministic_block is not None:
            return deterministic_block

        try:
            response = await self.client.aio.models.generate_content(
                model=self.model,
                contents=self._build_action_planning_contents(
                    user_message=user_message,
                    history=history,
                    pkm_context=pkm_context,
                ),
                config=genai_types.GenerateContentConfig(
                    system_instruction=AGENT_ACTION_PLANNER_PROMPT,
                    temperature=0.0,
                    max_output_tokens=256,
                    tools=[_agent_action_tool()],
                    automatic_function_calling=genai_types.AutomaticFunctionCallingConfig(
                        disable=True
                    ),
                    tool_config=genai_types.ToolConfig(
                        function_calling_config=genai_types.FunctionCallingConfig(mode="AUTO")
                    ),
                ),
            )
            for function_call in self._function_calls_from_response(response):
                action_plan = self._action_plan_from_function_call(function_call)
                if action_plan is not None:
                    return action_plan
        except Exception:
            logger.exception("agent_chat.function_planning_failed")

        return self.plan_action(user_message)

    def plan_action(self, user_message: str) -> AgentChatActionPlan | None:
        message = " ".join(str(user_message or "").split())
        if not message:
            return None

        blocked_action = self._plan_blocked_action(message)
        if blocked_action is not None:
            return blocked_action

        for pattern in _PKM_ADD_PATTERNS:
            if pattern.search(message):
                return AgentChatActionPlan(
                    call_id=_tool_call_id(),
                    action_id="pkm.add",
                    label="Add to PKM",
                    execution="frontend",
                    slots={},
                    message="Checking PKM and saving what fits.",
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

    def _plan_blocked_action(self, user_message: str) -> AgentChatActionPlan | None:
        message = " ".join(str(user_message or "").split())
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
        return None

    def _build_contents(
        self,
        *,
        user_message: str,
        history: list[AgentChatMessage],
        action_plan: AgentChatActionPlan | None = None,
        pkm_context: str | None = None,
    ) -> list[genai_types.Content]:
        contents: list[genai_types.Content] = []
        for message in history[-20:]:
            if message.role not in {"user", "assistant"}:
                continue
            role = "user" if message.role == "user" else "model"
            contents.append(
                genai_types.Content(
                    role=role,
                    parts=[genai_types.Part(text=message.content[:4000])],
                )
            )
        contents.append(
            genai_types.Content(
                role="user",
                parts=[
                    genai_types.Part(
                        text=(
                            f"{self._build_turn_context(action_plan=action_plan, pkm_context=pkm_context)}\n\n"
                            f"Latest user message:\n{user_message}"
                        )
                    )
                ],
            )
        )
        return contents

    def _build_action_planning_contents(
        self,
        *,
        user_message: str,
        history: list[AgentChatMessage],
        pkm_context: str | None = None,
    ) -> list[genai_types.Content]:
        contents: list[genai_types.Content] = []
        for message in history[-8:]:
            if message.role not in {"user", "assistant"}:
                continue
            role = "user" if message.role == "user" else "model"
            contents.append(
                genai_types.Content(
                    role=role,
                    parts=[genai_types.Part(text=message.content[:1500])],
                )
            )
        clean_pkm_context = str(pkm_context or "").strip()
        planning_context = (
            clean_pkm_context[:4000]
            if clean_pkm_context
            else "No PKM context was provided for this turn."
        )
        contents.append(
            genai_types.Content(
                role="user",
                parts=[
                    genai_types.Part(
                        text=(
                            "PKM context for routing only:\n"
                            f"{planning_context}\n\n"
                            f"Latest user message:\n{user_message}"
                        )
                    )
                ],
            )
        )
        return contents

    def _build_turn_context(
        self,
        *,
        action_plan: AgentChatActionPlan | None = None,
        pkm_context: str | None = None,
    ) -> str:
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
        clean_pkm_context = str(pkm_context or "").strip()
        pkm_context_text = (
            clean_pkm_context[:20000]
            if clean_pkm_context
            else "No PKM context was provided for this turn."
        )
        return f"PKM context:\n{pkm_context_text}\n\nAction context:\n{action_context}"

    def _function_calls_from_response(self, response: Any) -> list[Any]:
        response_calls = getattr(response, "function_calls", None)
        if response_calls:
            return list(response_calls)

        calls: list[Any] = []
        candidates = getattr(response, "candidates", None) or []
        for candidate in candidates:
            content = getattr(candidate, "content", None)
            for part in getattr(content, "parts", None) or []:
                function_call = getattr(part, "function_call", None)
                if function_call is not None:
                    calls.append(function_call)
        return calls

    def _action_plan_from_function_call(self, function_call: Any) -> AgentChatActionPlan | None:
        name = str(getattr(function_call, "name", "") or "").strip()
        args = dict(getattr(function_call, "args", None) or {})
        call_id = str(getattr(function_call, "id", "") or "").strip() or _tool_call_id()

        if name == "start_stock_analysis":
            ticker = _resolve_ticker(
                str(args.get("symbol") or args.get("company") or args.get("target") or "")
            )
            if not ticker:
                return None
            return AgentChatActionPlan(
                call_id=call_id,
                action_id="analysis.start",
                label=f"Start analysis for {ticker}",
                execution="frontend",
                slots={"symbol": ticker},
                message=f"Starting Kai analysis for {ticker}.",
            )

        if name == "open_app_surface":
            surface = str(args.get("surface") or "").strip()
            action = _APP_SURFACE_ACTIONS.get(surface)
            if action is None:
                return None
            action_id, label = action
            return AgentChatActionPlan(
                call_id=call_id,
                action_id=action_id,
                label=label,
                execution="frontend",
                slots={},
                message=f"{label} in the app.",
            )

        if name == "block_manual_action":
            reason = str(args.get("reason") or "").strip() or "manual_or_destructive_action"
            return AgentChatActionPlan(
                call_id=call_id,
                action_id=None,
                label="Blocked Manual Action",
                execution="blocked",
                slots={},
                message=(
                    "I can't perform destructive, account-changing, consent approval, "
                    "revocation, or trading actions from Agent. Please do that manually."
                ),
                reason=reason[:160],
            )

        if name == "add_to_pkm":
            memory_text = str(args.get("memory_text") or "").strip()
            if not memory_text:
                return None
            reason = str(args.get("reason") or "").strip()
            return AgentChatActionPlan(
                call_id=call_id,
                action_id="pkm.add",
                label="Add to PKM",
                execution="frontend",
                slots={},
                message="Checking PKM and saving what fits.",
                reason=reason[:160] if reason else None,
            )

        return None

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
