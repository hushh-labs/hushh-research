"""The three Hushh injection points; no query planning or agent loop lives here."""

from __future__ import annotations

import asyncio
import time
from contextlib import asynccontextmanager
from functools import partial
from typing import Any

import httpx

from .binding_helpers import (
    approved_azure_binding,
    build_email_model,
    connection_status_port,
    restore_email_selection,
)
from .gmail_execution import GmailExecution
from .memory import EmailMemorySession
from .review_ports import ExistingReviewPort as ExistingReviewPort
from .routing import select_email_tools
from .runtime import EmailAgentRuntime
from .transport import (
    GMAIL_HTTP_RESPONSE_LIMIT as GMAIL_HTTP_RESPONSE_LIMIT,
)
from .transport import (
    _BoundedGmailHttp as _BoundedGmailHttp,
)


class OwnerGmailExecution:
    """Inject a fresh, scope-specific vault token into an upstream operation."""

    def __init__(
        self, gmail: Any, user_id: str, require_access: Any, page_context: dict | None = None
    ) -> None:
        self.gmail, self.user_id, self.require_access = gmail, user_id, require_access
        self.grant_binding: tuple[str, ...] | None = None
        self.observed_messages: dict[str, dict] = {}
        self.page_context = page_context
        self.telemetry = {
            "gmail_http_requests": 0,
            "gmail_api_methods": 0,
            "gmail_http_elapsed_ms": 0.0,
        }

    async def require_current_grant(self):
        if self.grant_binding is not None:
            current = await self.gmail.read_execution_grant_binding(user_id=self.user_id)
            if current != self.grant_binding:
                raise PermissionError("The Gmail account or grant changed")

    def __getattr__(self, operation: str):
        if operation not in {
            "search_threads",
            "get_message",
            "get_thread",
            "get_attachment",
            "create_draft",
            "send_email",
            "reply_to_thread",
            "batch_modify_messages",
            "trash_message",
        }:
            raise AttributeError(operation)
        return partial(self._invoke, operation)

    async def _admit_operation(self, operation, arguments):
        await self.require_access()
        # Existing app effect owners retain review, idempotency and uncertainty.
        if operation in {"send_email", "reply_to_thread", "batch_modify_messages", "trash_message"}:
            raise PermissionError(
                "A reviewed action must execute through its existing action owner"
            )
        token, observed = await self.gmail.get_bound_read_access_token(
            user_id=self.user_id, compose=operation == "create_draft"
        )
        if observed is None or (
            self.grant_binding is not None and self.grant_binding[:4] != observed[:4]
        ):
            raise PermissionError("The Gmail account or grant changed")
        # Refresh may repin this token generation, never the connected account.
        self.grant_binding = observed
        if operation == "search_threads" and arguments.get("page_token"):
            previous = self.page_context or {}
            if (
                arguments.get("q") != previous.get("q")
                or arguments["page_token"] != previous.get("page_token")
                or tuple(previous.get("grant_binding") or ())[:4] != observed[:4]
            ):
                raise PermissionError("The Gmail page or account changed; search again")
        return token, observed

    async def _build_service(self, token):
        from google.oauth2.credentials import Credentials
        from google_auth_httplib2 import AuthorizedHttp
        from googleapiclient.discovery import build

        transport = _BoundedGmailHttp(timeout=8)
        request = transport.request

        def observed_request(*args, **kwargs):
            started = time.monotonic()
            self.telemetry["gmail_http_requests"] += 1
            try:
                return request(*args, **kwargs)
            finally:
                self.telemetry["gmail_http_elapsed_ms"] += round(
                    (time.monotonic() - started) * 1000, 2
                )

        transport.request = observed_request
        return await asyncio.to_thread(
            build,
            "gmail",
            "v1",
            http=AuthorizedHttp(Credentials(token=token), http=transport, max_refresh_attempts=0),
            cache_discovery=False,
            static_discovery=True,
        )

    def _observe_result(self, operation, arguments, observed, result):
        if operation == "search_threads":
            self.telemetry["gmail_api_methods"] += (
                1 + result.get("returned_count", 0) + result.get("failed_count", 0)
            )
            self.page_context = (
                {
                    **arguments,
                    "page_token": result["next_page_token"],
                    "grant_binding": list(observed),
                }
                if result.get("next_page_token")
                else None
            )
        else:
            self.telemetry["gmail_api_methods"] += 1
        rows = result.get("messages", []) if isinstance(result, dict) else []
        if operation == "search_threads":
            self.observed_messages.clear()
        if operation == "get_message" and isinstance(result, dict):
            rows = [result]
        for row in rows:
            if isinstance(row, dict) and isinstance(row.get("id"), str):
                if len(self.observed_messages) < 100 or row["id"] in self.observed_messages:
                    self.observed_messages[row["id"]] = {
                        key: row.get(key) for key in ("id", "thread_id", "subject", "from", "date")
                    }

    async def _invoke(self, operation, **arguments):
        token, observed = await self._admit_operation(operation, arguments)
        service = await self._build_service(token)
        try:
            await self.require_access()
            execution = GmailExecution(service, require_access=self.require_access)
            result = await getattr(execution, operation)(**arguments)
            await self.require_access()
            self._observe_result(operation, arguments, observed, result)
            return result
        finally:
            await asyncio.to_thread(service.close)


@asynccontextmanager
async def owner_email_runtime(
    *,
    gmail: Any,
    user_id: str,
    require_access: Any,
    memory_markdown: str = "",
    review_port: Any = None,
    pending_email_draft: str = "",
    page_context: dict | None = None,
    supports_email_reviews: bool = False,
    selected_messages: dict | None = None,
):
    """Central Azure selection, existing owner grant, and device-encrypted memory."""
    await require_access()
    binding, descriptor = approved_azure_binding()
    current = True
    memory = EmailMemorySession(
        owner_id=user_id,
        projection_owner_id=user_id,
        markdown=memory_markdown,
        authorization_current=lambda: current,
    )

    async def admitted():
        await require_access()
        binding.require_current()
        await execution.require_current_grant()

    execution = OwnerGmailExecution(gmail, user_id, admitted, page_context)
    await restore_email_selection(gmail, user_id, execution, selected_messages)
    status = connection_status_port(gmail, admitted, user_id)

    try:
        with httpx.Client(timeout=30) as sync_http:
            async with httpx.AsyncClient(timeout=30) as async_http:
                model = build_email_model(binding, descriptor, sync_http, async_http)
                yield (
                    EmailAgentRuntime(
                        model_factory=lambda _context: model,
                        execution_factory=lambda _context: execution,
                        memory_port=memory,
                        review_port=review_port
                        or ExistingReviewPort(execution, pending_email_draft),
                        connection_status_port=status,
                        router=select_email_tools,
                        supports_email_reviews=supports_email_reviews,
                    ),
                    admitted,
                )
    finally:
        current = False
        memory.clear()
