"""Request-scoped Email facade over the standard LangChain agent graph."""

from collections.abc import AsyncIterator, Sequence
from contextlib import aclosing
from datetime import datetime
from datetime import timezone as utc_timezone
from typing import Any
from uuid import uuid4
from zoneinfo import ZoneInfo

from .protocol import EmailRuntimeContext as EmailRuntimeContext
from .protocol import review_arguments_digest as review_arguments_digest
from .tool_state import ToolState
from .tools import TOOL_NAMES, build_tools
from .turn import run_turn


class EmailAgentRuntime:
    """One finite graph per request; dependencies retain credential/effect authority.

    Factories receive EmailRuntimeContext. Memory is a request-bound port with
    read_memory_md/save_to_memory_md. Review returns a pending directive or an
    exact existing-ledger receipt; model arguments can never approve a write.
    """

    def __init__(
        self,
        *,
        model_factory,
        execution_factory,
        memory_port=None,
        review_port=None,
        router=None,
        attachment_parser=None,
        attachment_scanner=None,
        connection_status_port=None,
        supports_email_reviews: bool = True,
        max_model_calls: int = 8,
        max_tool_calls: int = 24,
        recursion_limit: int = 32,
        deadline_seconds: float = 90,
    ):
        if (
            not 1 <= max_model_calls <= 16
            or not 1 <= max_tool_calls <= 64
            or (not 4 <= recursion_limit <= 64)
            or (not 0 < deadline_seconds <= 180)
        ):
            raise ValueError("Invalid Email graph budget")
        self.model_factory, self.execution_factory = (model_factory, execution_factory)
        self.memory_port, self.review_port, self.router = (memory_port, review_port, router)
        self.attachment_parser, self.attachment_scanner = (attachment_parser, attachment_scanner)
        self.connection_status_port = connection_status_port
        self.supports_email_reviews = supports_email_reviews
        self.max_model_calls, self.max_tool_calls = (max_model_calls, max_tool_calls)
        self.recursion_limit, self.deadline_seconds = (recursion_limit, deadline_seconds)

    async def handle_turn(self, **kwargs) -> dict[str, Any]:
        result = None
        async for event in self.stream_turn(**kwargs):
            if event["type"] == "result":
                result = event["result"]
        if result is None:
            raise RuntimeError("Email graph returned no terminal result")
        return result

    async def stream_turn(
        self,
        *,
        user_id: str,
        message: str,
        timezone: str = "UTC",
        conversation_id: str | None = None,
        history: Sequence[Any] = (),
        current_memory_md: str = "",
        now_utc: datetime | None = None,
        consent_token: str = "",
        require_access=None,
        pending_email_draft: str = "",
        page_context: dict | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        if not user_id.strip() or not message.strip() or len(message) > 16000:
            raise ValueError("Email owner and bounded request required")
        if require_access is None:
            raise PermissionError("Email owner access callback required")
        ZoneInfo(timezone)
        now = now_utc or datetime.now(utc_timezone.utc)
        if now.tzinfo is None:
            raise ValueError("Email clock must include its timezone")
        now = now.astimezone(utc_timezone.utc)
        context = EmailRuntimeContext(
            user_id, conversation_id or str(uuid4()), timezone, now, require_access, consent_token
        )
        async with aclosing(
            run_turn(
                self,
                context,
                message,
                history,
                current_memory_md,
                pending_email_draft,
                page_context,
            )
        ) as events:
            async for event in events:
                yield event

    def stream(self, **kwargs):
        return self.stream_turn(**kwargs)

    @staticmethod
    def _tool_names():
        return TOOL_NAMES

    def _tools(
        self, context, execution, counts, directives, effects, uncertain_effects, read_receipt
    ):
        return build_tools(
            ToolState(
                self, context, execution, directives, effects, uncertain_effects, read_receipt
            )
        )
