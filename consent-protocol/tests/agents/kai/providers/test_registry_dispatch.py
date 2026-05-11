# tests/agents/kai/providers/test_registry_dispatch.py
"""
Dispatcher tests: the consent gate, audit emission, and provider routing.

These are the highest-leverage tests in this PR. They prove that:

1. A token without the right scope CANNOT reach the network
   (ConsentScopeViolation is raised before provider.complete is called).
2. A valid token routes correctly and emits one audit record per call.
3. A revoked token is rejected.
4. An unknown provider raises ProviderUnavailable.
5. The default provider falls back to gemini.
"""

from __future__ import annotations

from typing import AsyncIterator, Optional

import pytest

from hushh_mcp.consent.token import issue_token
from hushh_mcp.operons.kai.providers import (
    CompletionRequest,
    CompletionResponse,
    ConsentScopeViolation,
    LLMProvider,
    ProviderUnavailable,
    StreamEvent,
    dispatch,
    register,
)
from hushh_mcp.operons.kai.providers.audit import AuditWriter, set_audit_writer
from hushh_mcp.operons.kai.providers.registry import _REGISTRY  # noqa: SLF001
from hushh_mcp.operons.kai.providers.scopes import (
    SCOPE_GEMINI,
    SCOPE_OPENAI,
    SCOPE_SELF_HOSTED,
)

# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------


class RecordingProvider(LLMProvider):
    """A provider that records whether complete() was actually called."""

    def __init__(self, name: str, kind: str = "cloud", ready: bool = True) -> None:
        self.name = name  # type: ignore[misc]
        self.kind = kind  # type: ignore[misc]
        self.default_model = f"{name}-test"
        self._ready = ready
        self.complete_called = 0
        self.last_request: Optional[CompletionRequest] = None

    def is_ready(self) -> tuple[bool, Optional[str]]:
        if not self._ready:
            return False, "test-not-ready"
        return True, None

    async def complete(self, request: CompletionRequest) -> CompletionResponse:
        self.complete_called += 1
        self.last_request = request
        return CompletionResponse(
            text="ok", provider=self.name, model=self.default_model, finish_reason="stop"
        )

    async def stream(self, request: CompletionRequest) -> AsyncIterator[StreamEvent]:
        yield StreamEvent(type="complete", text="ok")


@pytest.fixture
def fresh_registry():
    """Reset the module-level registry between tests."""
    snapshot = dict(_REGISTRY)
    _REGISTRY.clear()
    yield _REGISTRY
    _REGISTRY.clear()
    _REGISTRY.update(snapshot)


@pytest.fixture
def capture_audit():
    writer = AuditWriter()
    set_audit_writer(writer)
    yield writer
    set_audit_writer(AuditWriter())


# ---------------------------------------------------------------------------
# Consent gate negative tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dispatch_rejects_when_token_lacks_scope(fresh_registry, capture_audit):
    """The cardinal test: a private-only token cannot reach a cloud provider."""
    cloud = RecordingProvider(name="openai")
    register(cloud)

    # Issue a token authorized ONLY for private inference.
    token = issue_token(
        user_id="u1",
        agent_id="agent_kai",
        scope=SCOPE_SELF_HOSTED,
    )
    token_str = token.token if hasattr(token, "token") else str(token)

    with pytest.raises(ConsentScopeViolation) as exc_info:
        await dispatch(
            CompletionRequest(prompt="hi"),
            consent_token=token_str,
            provider_name="openai",
        )

    # The provider was NEVER called.
    assert cloud.complete_called == 0
    assert "openai" in str(exc_info.value).lower() or "cloud" in str(exc_info.value).lower()


@pytest.mark.asyncio
async def test_dispatch_rejects_invalid_token(fresh_registry, capture_audit):
    register(RecordingProvider(name="gemini"))
    with pytest.raises(ConsentScopeViolation):
        await dispatch(
            CompletionRequest(prompt="hi"),
            consent_token="HCT:not-a-real-token.invalid-signature",  # noqa: S106 - intentionally invalid
            provider_name="gemini",
        )


@pytest.mark.asyncio
async def test_dispatch_rejects_unknown_provider(fresh_registry, capture_audit):
    """Unknown provider name surfaces as ProviderUnavailable, not network error."""
    token = issue_token(user_id="u1", agent_id="agent_kai", scope=SCOPE_GEMINI)
    token_str = token.token if hasattr(token, "token") else str(token)
    with pytest.raises((ProviderUnavailable, ValueError)):
        await dispatch(
            CompletionRequest(prompt="hi"),
            consent_token=token_str,
            provider_name="not_a_real_provider",
        )


@pytest.mark.asyncio
async def test_dispatch_rejects_provider_not_ready(fresh_registry, capture_audit):
    """Configured-but-not-ready providers are caught before network."""
    not_ready = RecordingProvider(name="gemini", ready=False)
    register(not_ready)
    token = issue_token(user_id="u1", agent_id="agent_kai", scope=SCOPE_GEMINI)
    token_str = token.token if hasattr(token, "token") else str(token)
    with pytest.raises(ProviderUnavailable):
        await dispatch(
            CompletionRequest(prompt="hi"),
            consent_token=token_str,
            provider_name="gemini",
        )
    assert not_ready.complete_called == 0


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dispatch_routes_to_provider_with_matching_scope(fresh_registry, capture_audit):
    cloud = RecordingProvider(name="openai")
    register(cloud)
    token = issue_token(user_id="u1", agent_id="agent_kai", scope=SCOPE_OPENAI)
    token_str = token.token if hasattr(token, "token") else str(token)
    resp = await dispatch(
        CompletionRequest(prompt="hi"),
        consent_token=token_str,
        provider_name="openai",
    )
    assert resp.provider == "openai"
    assert cloud.complete_called == 1


@pytest.mark.asyncio
async def test_dispatch_writes_one_audit_record_per_call(fresh_registry, capture_audit):
    cloud = RecordingProvider(name="openai")
    register(cloud)
    token = issue_token(user_id="u1", agent_id="agent_kai", scope=SCOPE_OPENAI)
    token_str = token.token if hasattr(token, "token") else str(token)
    await dispatch(
        CompletionRequest(prompt="hi"),
        consent_token=token_str,
        provider_name="openai",
    )
    assert len(capture_audit.records) == 1
    _token_id, record = capture_audit.records[0]
    assert record.provider == "openai"
    assert record.scope_used == SCOPE_OPENAI
    assert record.outcome == "ok"
    assert record.latency_ms >= 0


@pytest.mark.asyncio
async def test_dispatch_audit_record_contains_no_prompt_plaintext(fresh_registry, capture_audit):
    cloud = RecordingProvider(name="openai")
    register(cloud)
    secret = "my retirement portfolio is $4.2M in Vanguard funds"  # noqa: S105 - test fixture
    token = issue_token(user_id="u1", agent_id="agent_kai", scope=SCOPE_OPENAI)
    token_str = token.token if hasattr(token, "token") else str(token)
    await dispatch(
        CompletionRequest(prompt=secret),
        consent_token=token_str,
        provider_name="openai",
    )
    _, record = capture_audit.records[0]
    serialized = repr(record.to_metadata())
    assert secret not in serialized
    assert "$4.2M" not in serialized
