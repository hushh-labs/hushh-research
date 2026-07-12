"""Official ADK A2A transport for Kai, kept opt-in during compatibility migration.

The existing ``python-a2a`` Flask server remains the default transport while
callers migrate.  This module uses the ADK-supported A2A SDK line and its new
executor implementation, but deliberately does not claim A2A SDK v1 support.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from hushh_mcp.adk_bridge.delegation import validate_a2a_consent_token_with_db
from hushh_mcp.hushh_adk.context import HushhContext

ADK_A2A_EXTENSION_URI = "https://google.github.io/adk-docs/a2a/a2a-extension/"
_AUTH_STATE_KEY = "hushh_a2a_authority"


class _ConsentHeaderMiddleware(BaseHTTPMiddleware):
    """Reject unauthenticated A2A writes before ADK's request handler."""

    async def dispatch(self, request: Any, call_next: Callable[..., Any]) -> Any:
        if (
            request.method == "POST"
            and not str(request.headers.get("x-consent-token") or "").strip()
        ):
            return JSONResponse(
                status_code=401,
                content={
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {
                        "code": -32001,
                        "message": "CONSENT_REQUIRED: X-Consent-Token is required.",
                    },
                },
            )
        return await call_next(request)


def _require_official_a2a() -> tuple[Any, ...]:
    """Load the ADK-supported A2A SDK lazily so legacy startup stays stable."""
    try:
        from a2a.types import (
            AgentCapabilities,
            AgentCard,
            AgentExtension,
            AgentProvider,
            AgentSkill,
        )
        from google.adk.a2a.converters.request_converter import (
            AgentRunRequest,
            convert_a2a_request_to_agent_run_request,
        )
        from google.adk.a2a.executor.a2a_agent_executor import A2aAgentExecutor
        from google.adk.a2a.executor.config import A2aAgentExecutorConfig
        from google.adk.a2a.utils.agent_to_a2a import to_a2a
    except ImportError as exc:  # pragma: no cover - dependency contract guard
        raise RuntimeError(
            "Official ADK A2A requires the google-adk[a2a] dependency extra."
        ) from exc
    return (
        AgentCapabilities,
        AgentCard,
        AgentExtension,
        AgentProvider,
        AgentSkill,
        AgentRunRequest,
        convert_a2a_request_to_agent_run_request,
        A2aAgentExecutor,
        A2aAgentExecutorConfig,
        to_a2a,
    )


async def _authorize_request(context: Any) -> tuple[str, str]:
    """Validate the transient consent header before ADK sees an A2A task."""
    call_context = getattr(context, "call_context", None)
    state = getattr(call_context, "state", {}) if call_context is not None else {}
    headers = dict(state.get("headers") or {})
    consent_token = str(
        headers.get("x-consent-token") or headers.get("X-Consent-Token") or ""
    ).strip()
    if not consent_token:
        raise PermissionError("A2A consent token is required in X-Consent-Token.")

    validation = await validate_a2a_consent_token_with_db("agent_kai", consent_token)
    if not validation.ok or not validation.user_id:
        raise PermissionError("A2A consent token is invalid, expired, or revoked.")

    if call_context is not None:
        # The SDK's default call-context builder retains every HTTP header.
        # Remove the raw consent credential immediately after validation; the
        # extension and protocol headers are represented separately by the SDK.
        sanitized_headers = dict(state.get("headers") or {})
        sanitized_headers.pop("x-consent-token", None)
        sanitized_headers.pop("X-Consent-Token", None)
        call_context.state["headers"] = sanitized_headers
        # Never place raw credentials in A2A task/session metadata. The token
        # remains only in this coroutine's local scope and ContextVar.
        call_context.state[_AUTH_STATE_KEY] = {"user_id": validation.user_id}
    return validation.user_id, consent_token


def create_kai_official_a2a_app(*, host: str = "localhost", port: int = 8001) -> Any:
    """Build the ADK-native A2A ASGI app with the new executor enabled.

    This is intentionally an opt-in transport. It preserves the exact Kai
    consent scope and per-request ContextVar contract before entering ADK.
    """
    (
        AgentCapabilities,
        AgentCard,
        AgentExtension,
        AgentProvider,
        AgentSkill,
        AgentRunRequest,
        default_request_converter,
        A2aAgentExecutor,
        A2aAgentExecutorConfig,
        to_a2a,
    ) = _require_official_a2a()
    from google.adk.runners import Runner
    from google.adk.sessions.in_memory_session_service import InMemorySessionService

    from hushh_mcp.agents.kai.agent import get_kai_agent

    def request_converter(context: Any, part_converter: Callable[..., Any]) -> Any:
        authority = dict(
            getattr(getattr(context, "call_context", None), "state", {}).get(_AUTH_STATE_KEY) or {}
        )
        user_id = str(authority.get("user_id") or "").strip()
        if not user_id:
            raise PermissionError("A2A request was not authorized.")
        request = default_request_converter(context, part_converter)
        return AgentRunRequest(
            user_id=user_id,
            session_id=request.session_id,
            invocation_id=request.invocation_id,
            new_message=request.new_message,
            state_delta=request.state_delta,
            run_config=request.run_config,
        )

    class HushhA2aAgentExecutor(A2aAgentExecutor):
        async def execute(self, context: Any, event_queue: Any) -> None:
            user_id, consent_token = await _authorize_request(context)
            with HushhContext(user_id=user_id, consent_token=consent_token):
                await super().execute(context, event_queue)

    public_url = str(os.getenv("HUSHH_KAI_A2A_PUBLIC_URL") or f"http://{host}:{port}").rstrip("/")
    agent_card = AgentCard(
        name="Kai Financial Agent",
        version="2.0.0",
        description="Consent-gated financial analysis through Hussh Kai.",
        url=public_url,
        provider=AgentProvider(organization="Hussh", url="https://hushh.ai"),
        capabilities=AgentCapabilities(
            streaming=True,
            extensions=[
                AgentExtension(
                    uri=ADK_A2A_EXTENSION_URI,
                    description="Uses ADK's improved A2A executor implementation.",
                    required=False,
                )
            ],
        ),
        skills=[
            AgentSkill(
                id="financial_analysis",
                name="Consent-gated financial analysis",
                description="Analyzes a ticker after validating agent.kai.analyze consent.",
                tags=["finance", "consent", "analysis"],
                input_modes=["text/plain"],
                output_modes=["text/plain"],
            )
        ],
        default_input_modes=["text/plain"],
        default_output_modes=["text/plain"],
        supports_authenticated_extended_card=False,
    )
    agent = get_kai_agent()
    # ``kai`` is the ADK app identity inferred from the checked-in agent
    # directory. Supplying it explicitly avoids a mismatched inferred runner
    # identity and makes local transport behavior deterministic.
    runner = Runner(
        app_name="kai",
        agent=agent,
        session_service=InMemorySessionService(),
        auto_create_session=True,
    )
    executor_config = A2aAgentExecutorConfig(request_converter=request_converter)
    app = to_a2a(
        agent,
        host=host,
        port=port,
        agent_card=agent_card,
        runner=runner,
        agent_executor_factory=lambda runner: HushhA2aAgentExecutor(
            runner=runner,
            config=executor_config,
            force_new_version=True,
        ),
    )

    # Executor-level validation remains in place for malformed, expired, or
    # revoked credentials after this missing-header ingress check.
    app.add_middleware(_ConsentHeaderMiddleware)
    return app
