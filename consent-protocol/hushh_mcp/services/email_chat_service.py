"""Owner-scoped Gmail chat ingress and compatibility facade.

UAT typed turns compose upstream Gmail execution, the local semantic
router and LangChain's standard graph. Existing injected ADK/voice adapters
remain compatible. OAuth, reviewed effects and encrypted PKM keep their owners.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Awaitable, Callable

from hushh_mcp.agents.email.agent import build_email_agent
from hushh_mcp.agents.email.tools import EMAIL_TOOLS
from hushh_mcp.services.agent_chat_service import get_agent_chat_service
from hushh_mcp.services.email_chat_legacy import (
    _GAVE_UP_MESSAGE as _GAVE_UP_MESSAGE,
)
from hushh_mcp.services.email_chat_legacy import (
    _HISTORY_CHARS as _HISTORY_CHARS,
)
from hushh_mcp.services.email_chat_legacy import (
    _MAX_HISTORY as _MAX_HISTORY,
)
from hushh_mcp.services.email_chat_legacy import (
    _MAX_TOOL_STEPS as _MAX_TOOL_STEPS,
)
from hushh_mcp.services.email_chat_legacy import (
    _SYSTEM_PROMPT as _SYSTEM_PROMPT,
)
from hushh_mcp.services.email_chat_legacy import (
    LegacyEmailChatOperations,
)
from hushh_mcp.services.email_chat_legacy import (
    _as_response_dict as _as_response_dict,
)
from hushh_mcp.services.email_chat_legacy import (
    _function_declarations as _function_declarations,
)
from hushh_mcp.services.email_chat_legacy import (
    _history_contents as _history_contents,
)
from hushh_mcp.services.email_chat_legacy import (
    _run_inbox_tool as _run_inbox_tool,
)
from hushh_mcp.services.gmail_receipts_service import get_gmail_receipts_service

logger = logging.getLogger(__name__)

_LLM_TIMEOUT_S = 30.0

_UNAVAILABLE_MESSAGE = "The email assistant is temporarily unavailable. Please try again."


# model call seam: (contents, config) -> Gemini response. Injectable for tests.
ModelCall = Callable[[Any, Any], Awaitable[Any]]


def _is_uat_deployment() -> bool:
    environment = os.getenv("HUSHH_DEPLOY_ENV") or os.getenv("ENVIRONMENT") or "local"
    return environment.strip().lower() == "uat"


class EmailChatService(LegacyEmailChatOperations):
    def __init__(
        self,
        *,
        chat_store: Any = None,
        gmail_service: Any = None,
        model_call: ModelCall | None = None,
        model: Any | None = None,
        genai_types: Any = None,
        ready: Callable[[], bool] | None = None,
        reader_factory: Callable[..., Any] | None = None,
        oss_runtime_factory: Callable[..., Any] | None = None,
    ) -> None:
        self._chat_store = chat_store if chat_store is not None else get_agent_chat_service()
        self._gmail = gmail_service if gmail_service is not None else get_gmail_receipts_service()
        # Select ADK when a model adapter is supplied, while retaining the
        # optional model_call callback for pod authority checks.
        self._use_adk = model is not None
        self._adk_model = model
        self._reader_factory = reader_factory
        self._oss_runtime_factory = oss_runtime_factory
        self._legacy_dependencies = (
            model_call is not None
            or model is not None
            or reader_factory is not None
            or (oss_runtime_factory is None and not _is_uat_deployment())
        )

        if model_call is not None:
            self._model_call = model_call
            self._types = genai_types
            self._ready = ready or (lambda: True)
        elif self._legacy_dependencies:
            from hushh_mcp.operons.kai import llm as _llm

            self._types = genai_types or _llm.types
            self._ready = ready or _llm._require_gemini_ready

            async def _default_call(contents: Any, config: Any) -> Any:
                # Shared hedged call: short per-attempt deadline + retry inside
                # the total budget collapses rare stalls (tail-at-scale).
                return await _llm.agent_chat_model_call(
                    contents, config, total_timeout_s=_LLM_TIMEOUT_S
                )

            self._model_call = _default_call
        else:
            # The UAT path constructs only the selected central Azure
            # client. Compatibility adapters remain injectable for old callers.
            self._types = genai_types
            self._ready = ready or (lambda: True)
            self._model_call = None
        if self._use_adk and self._adk_model is None:
            self._adk_model = build_email_agent(tools=EMAIL_TOOLS).model

    async def handle_turn(
        self,
        *,
        user_id: str,
        message: str | None = None,
        consent_token: str = "",
        conversation_id: str | None = None,
        timezone: str = "UTC",
        memory_markdown: str = "",
    ) -> dict[str, Any]:
        if not message:
            return {
                "conversationId": conversation_id or "",
                "response": "Ask me what needs a reply, or to find something in your inbox.",
                "isComplete": True,
                "stateChanged": False,
            }

        turn = await self._chat_store.prepare_turn(
            user_id=user_id, message=message, conversation_id=conversation_id
        )

        if self._oss_runtime_factory is not None or not self._legacy_dependencies:

            async def require_access():
                from hushh_mcp.adk_bridge.delegation import validate_first_party_owner_token

                if await validate_first_party_owner_token(user_id, consent_token) is None:
                    raise PermissionError("Mail owner authority is unavailable")

            result = await self._run_oss_turn(
                user_id=user_id,
                consent_token=consent_token,
                message=message,
                conversation_id=turn.conversation_id,
                require_access=require_access,
                timezone=timezone,
                memory_markdown=memory_markdown,
                history=turn.history,
            )
            finished = await self._finish(
                turn, result["response"], user_id, errored=result.get("status") == "unavailable"
            )
            return {**finished, **result}

        if self._use_adk:
            if not self._ready():
                return await self._finish(turn, _UNAVAILABLE_MESSAGE, user_id, errored=True)
            try:
                reply, errored = await self._run_adk_tool_loop(
                    user_id=user_id,
                    consent_token=consent_token,
                    message=message,
                    history=turn.history,
                )
            except Exception:
                logger.exception("Email ADK turn failed")
                return await self._finish(turn, _UNAVAILABLE_MESSAGE, user_id, errored=True)
            return await self._finish(turn, reply or "Done.", user_id, errored=errored)

        if self._types is None or not self._ready():
            return await self._finish(turn, _UNAVAILABLE_MESSAGE, user_id, errored=True)

        types = self._types
        contents = _history_contents(turn.history, types)
        contents.append(types.Content(role="user", parts=[types.Part(text=message)]))

        try:
            reply, errored = await self._run_tool_loop(user_id=user_id, contents=contents)
        except Exception as exc:
            logger.warning("Email chat turn failed type=%s", type(exc).__name__)
            return await self._finish(turn, _UNAVAILABLE_MESSAGE, user_id, errored=True)

        return await self._finish(turn, reply or "Done.", user_id, errored=errored)

    async def handle_delegated_turn(
        self,
        *,
        user_id: str,
        consent_token: str,
        conversation_id: str,
        message: str,
        require_access: Callable[[], Awaitable[None]],
        timezone: str = "UTC",
        receipt_memory: object | None = None,
        receipt_cursor: str | None = None,
        read_offer: dict[str, Any] | None = None,
        require_explicit_latest: bool = False,
        memory_markdown: str = "",
        history: list[Any] | None = None,
        pending_email_draft: str = "",
        page_context: dict | None = None,
        supports_email_reviews: bool = False,
        selected_messages: dict | None = None,
        on_text: Callable[[str], Awaitable[None]] | None = None,
    ) -> dict[str, Any]:
        """Read Mail for One without creating or writing a second conversation.

        ``receipt_memory`` is the owner's saved receipt index, sent by their device
        for this one turn; ``receipt_cursor`` is where the last receipts list stopped.
        Typed chat is the only caller, so it is the only surface that reads receipts.
        """
        if self._oss_runtime_factory is not None or not self._legacy_dependencies:
            return await self._run_oss_turn(
                user_id=user_id,
                consent_token=consent_token,
                conversation_id=conversation_id,
                message=message,
                require_access=require_access,
                timezone=timezone,
                memory_markdown=memory_markdown,
                history=history or [],
                pending_email_draft=pending_email_draft,
                page_context=page_context,
                supports_email_reviews=supports_email_reviews,
                selected_messages=selected_messages,
                read_offer=read_offer,
                on_text=on_text,
            )

        # Compatibility for injected ADK readers and the separate voice caller.
        # UAT typed chat no longer calls MailReadPlan or the receipt snapshot.
        from hushh_mcp.services.email_delegated_read import run_delegated_mail_read

        dependencies: dict[str, Any] = {}
        if self._adk_model is not None:
            from hushh_mcp.agents.email.runtime import run_email_gene

            async def owner_gene(**kwargs: Any) -> dict[str, Any]:
                await require_access()
                result = await run_email_gene(model=self._adk_model, **kwargs)
                await require_access()
                return result

            dependencies["gene_runner"] = owner_gene
        if self._reader_factory is not None:
            dependencies["reader_factory"] = self._reader_factory

        return await run_delegated_mail_read(
            gmail=self._gmail,
            user_id=user_id,
            consent_token=consent_token,
            conversation_id=conversation_id,
            message=message,
            require_access=require_access,
            timezone=timezone,
            **dependencies,
            receipt_memory=receipt_memory,
            receipt_cursor=receipt_cursor,
            receipt_reads=True,
            read_offer=read_offer,
            require_explicit_latest=require_explicit_latest,
        )

    async def _run_oss_turn(
        self,
        *,
        user_id: str,
        consent_token: str,
        conversation_id: str,
        message: str,
        require_access: Any,
        timezone: str,
        memory_markdown: str,
        history: list[Any],
        pending_email_draft: str = "",
        page_context: dict | None = None,
        supports_email_reviews: bool = False,
        selected_messages: dict | None = None,
        read_offer: dict | None = None,
        on_text: Callable[[str], Awaitable[None]] | None = None,
    ) -> dict:
        from hushh_mcp.services.email_oss_ingress import run_oss_turn

        return await run_oss_turn(
            self,
            user_id=user_id,
            consent_token=consent_token,
            conversation_id=conversation_id,
            message=message,
            require_access=require_access,
            timezone=timezone,
            memory_markdown=memory_markdown,
            history=history,
            pending_email_draft=pending_email_draft,
            page_context=page_context,
            supports_email_reviews=supports_email_reviews,
            selected_messages=selected_messages,
            read_offer=read_offer,
            on_text=on_text,
        )
