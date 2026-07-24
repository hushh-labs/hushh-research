# hushh_mcp/operons/kai/providers/scopes.py
"""
Provider-specific consent scopes for Kai inference.

These scopes are an *additive* layer on top of the existing operon-level
scopes (`agent.kai.analyze`, `agent.kai.debate`, etc.). They tell the
dispatcher *which* provider Kai is allowed to call for inference.

Scope tree:

    agent.kai.inference.cloud.gemini
    agent.kai.inference.cloud.openai
    agent.kai.inference.cloud.anthropic
    agent.kai.inference.private.self_hosted
    agent.kai.inference.private.local

A token issued with only `agent.kai.inference.private.*` scopes can
NEVER reach a `cloud.*` provider; this is enforced by `dispatch()` in
`registry.py` BEFORE any network call.

Design choice: these are dynamic-style scopes (string-valued), not
additions to the `ConsentScope` enum. Adding to the enum would require
coordinated changes across the consent-protocol token-signing path,
the scope_helpers module, and all language SDKs. By keeping these
strings and leaning on the existing token-string scope check, we ship
the feature without a cross-cutting protocol bump.

If/when the team decides to fold these into `ConsentScope`, only this
file changes -- nothing in the providers themselves.
"""

from __future__ import annotations

from typing import Final

_PREFIX: Final[str] = "agent.kai.inference"

# Cloud providers (call out to third-party APIs)
SCOPE_GEMINI: Final[str] = f"{_PREFIX}.cloud.gemini"
SCOPE_OPENAI: Final[str] = f"{_PREFIX}.cloud.openai"
SCOPE_ANTHROPIC: Final[str] = f"{_PREFIX}.cloud.anthropic"

# Private providers (self-hosted / on-device)
SCOPE_SELF_HOSTED: Final[str] = f"{_PREFIX}.private.self_hosted"
SCOPE_LOCAL: Final[str] = f"{_PREFIX}.private.local"

# Wildcard-style umbrellas. A token may carry these to authorize whole families.
SCOPE_CLOUD_ANY: Final[str] = f"{_PREFIX}.cloud"
SCOPE_PRIVATE_ANY: Final[str] = f"{_PREFIX}.private"
SCOPE_ANY: Final[str] = _PREFIX

#: Mapping from provider name -> required scope string
KAI_INFERENCE_PROVIDER_SCOPES: Final[dict[str, str]] = {
    "gemini": SCOPE_GEMINI,
    "openai": SCOPE_OPENAI,
    "anthropic": SCOPE_ANTHROPIC,
    "vllm": SCOPE_SELF_HOSTED,
    "llamacpp": SCOPE_LOCAL,
}


def scope_for_provider(provider_name: str) -> str:
    """Return the required scope for a provider, raising on unknown names."""
    try:
        return KAI_INFERENCE_PROVIDER_SCOPES[provider_name]
    except KeyError as exc:
        raise ValueError(f"Unknown inference provider: {provider_name!r}") from exc


def is_cloud_scope(scope: str) -> bool:
    """True if scope authorizes a cloud provider."""
    return scope.startswith(f"{_PREFIX}.cloud")


def is_private_scope(scope: str) -> bool:
    """True if scope authorizes a private (self-hosted/local) provider."""
    return scope.startswith(f"{_PREFIX}.private")


def token_authorizes(token_scope_str: str, required_scope: str) -> bool:
    """
    Return True if `token_scope_str` (a single scope on the validated
    token) authorizes `required_scope`.

    Authorization is hierarchical:
      - exact match
      - umbrella `agent.kai.inference.cloud` authorizes any cloud.*
      - umbrella `agent.kai.inference.private` authorizes any private.*
      - umbrella `agent.kai.inference` authorizes everything
      - VAULT_OWNER (`vault.owner`) is treated as full access elsewhere;
        it is NOT recognized here because the inference adapter is
        agent-scoped, not vault-scoped, and silently widening scope at
        this layer would weaken the consent-first invariant.
    """
    if token_scope_str == required_scope:
        return True
    # umbrella checks
    if token_scope_str == SCOPE_ANY:
        return required_scope.startswith(_PREFIX)
    if token_scope_str == SCOPE_CLOUD_ANY:
        return is_cloud_scope(required_scope)
    if token_scope_str == SCOPE_PRIVATE_ANY:
        return is_private_scope(required_scope)
    return False
