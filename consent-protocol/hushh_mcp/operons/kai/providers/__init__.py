# hushh_mcp/operons/kai/providers/__init__.py
"""
Kai LLM Provider Abstraction
=============================

Provider-agnostic, consent-scoped LLM dispatch for Kai's multi-agent
debate engine. The existing `hushh_mcp/operons/kai/llm.py` Gemini path
is preserved verbatim; this package adds an opt-in adapter that lets
Kai route inference through Gemini, OpenAI, Anthropic, vLLM (any
OpenAI-compatible self-hosted endpoint) or llama.cpp, with the
consent token determining which providers are reachable.

Design invariants (mirrors consent-protocol/SECURITY.md):

1. BYOK preserved          -- audit logs hash prompts and outputs.
                              No plaintext is ever written to
                              consent_audit by this module.
2. Consent-First           -- every dispatch validates the token
                              against the provider-specific scope
                              BEFORE any network call is initiated.
3. Double Validation       -- the existing per-operon scope check
                              (`agent.kai.analyze` etc.) is unchanged.
                              Provider scopes are an *additional*
                              gate, not a replacement.
4. Audit Everything        -- every inference call records
                              (provider, scope_used, token_id,
                              latency_ms, prompt_hash, output_hash,
                              error_class) into consent_audit.metadata.

Public surface:
    - LLMProvider              ABC implemented by every backend
    - CompletionRequest        canonical input shape
    - CompletionResponse       canonical output shape
    - StreamEvent              event yielded by streaming providers
    - ConsentScopeViolation    raised before a network call when the
                                presented token lacks the required scope
    - ProviderUnavailable      raised when the configured provider is
                                missing creds / SDK / config
    - dispatch                 the top-level entry point
    - get_provider             registry lookup
"""

from .base import (
    CompletionRequest,
    CompletionResponse,
    LLMProvider,
    Message,
    Role,
    StreamEvent,
)
from .errors import (
    ConsentScopeViolation,
    ProviderError,
    ProviderTimeout,
    ProviderUnavailable,
)
from .audit import (
    AuditWriter,
    InferenceAuditRecord,
    TimedDispatch,
    get_audit_writer,
    set_audit_writer,
    sha256_hex,
)
from .registry import (
    available_providers,
    dispatch,
    get_provider,
    load_registry,
    register,
)
from .scopes import (
    KAI_INFERENCE_PROVIDER_SCOPES,
    is_cloud_scope,
    is_private_scope,
    scope_for_provider,
)

__all__ = [
    "AuditWriter",
    "CompletionRequest",
    "CompletionResponse",
    "ConsentScopeViolation",
    "InferenceAuditRecord",
    "KAI_INFERENCE_PROVIDER_SCOPES",
    "LLMProvider",
    "Message",
    "ProviderError",
    "ProviderTimeout",
    "ProviderUnavailable",
    "Role",
    "StreamEvent",
    "TimedDispatch",
    "available_providers",
    "dispatch",
    "get_audit_writer",
    "get_provider",
    "is_cloud_scope",
    "is_private_scope",
    "load_registry",
    "register",
    "scope_for_provider",
    "set_audit_writer",
    "sha256_hex",
]
