# tests/agents/kai/providers/test_scopes.py
"""Tests for the Kai inference scope hierarchy.

These tests document and enforce the consent-first invariant:

* private-only tokens cannot reach cloud providers.
* cloud-only tokens cannot reach private providers.
* exact match wins.
* umbrella scopes work hierarchically.
* unknown providers raise loudly.
"""

from __future__ import annotations

import pytest

from hushh_mcp.operons.kai.providers.scopes import (
    KAI_INFERENCE_PROVIDER_SCOPES,
    SCOPE_ANTHROPIC,
    SCOPE_ANY,
    SCOPE_CLOUD_ANY,
    SCOPE_GEMINI,
    SCOPE_LOCAL,
    SCOPE_OPENAI,
    SCOPE_PRIVATE_ANY,
    SCOPE_SELF_HOSTED,
    is_cloud_scope,
    is_private_scope,
    scope_for_provider,
    token_authorizes,
)


def test_provider_to_scope_mapping_complete():
    """Every concrete provider has a scope mapping."""
    expected = {"gemini", "openai", "anthropic", "vllm", "llamacpp"}
    assert set(KAI_INFERENCE_PROVIDER_SCOPES) == expected


def test_scope_for_provider_known():
    assert scope_for_provider("gemini") == SCOPE_GEMINI
    assert scope_for_provider("openai") == SCOPE_OPENAI
    assert scope_for_provider("anthropic") == SCOPE_ANTHROPIC
    assert scope_for_provider("vllm") == SCOPE_SELF_HOSTED
    assert scope_for_provider("llamacpp") == SCOPE_LOCAL


def test_scope_for_provider_unknown_raises():
    with pytest.raises(ValueError, match="Unknown inference provider"):
        scope_for_provider("openrouter")


def test_is_cloud_scope_classification():
    assert is_cloud_scope(SCOPE_GEMINI) is True
    assert is_cloud_scope(SCOPE_OPENAI) is True
    assert is_cloud_scope(SCOPE_ANTHROPIC) is True
    assert is_cloud_scope(SCOPE_SELF_HOSTED) is False
    assert is_cloud_scope(SCOPE_LOCAL) is False


def test_is_private_scope_classification():
    assert is_private_scope(SCOPE_SELF_HOSTED) is True
    assert is_private_scope(SCOPE_LOCAL) is True
    assert is_private_scope(SCOPE_GEMINI) is False
    assert is_private_scope(SCOPE_OPENAI) is False


def test_token_authorizes_exact_match():
    assert token_authorizes(SCOPE_GEMINI, SCOPE_GEMINI) is True
    assert token_authorizes(SCOPE_OPENAI, SCOPE_OPENAI) is True


def test_token_authorizes_cloud_umbrella_authorizes_any_cloud():
    assert token_authorizes(SCOPE_CLOUD_ANY, SCOPE_GEMINI) is True
    assert token_authorizes(SCOPE_CLOUD_ANY, SCOPE_OPENAI) is True
    assert token_authorizes(SCOPE_CLOUD_ANY, SCOPE_ANTHROPIC) is True


def test_token_authorizes_private_umbrella_authorizes_any_private():
    assert token_authorizes(SCOPE_PRIVATE_ANY, SCOPE_SELF_HOSTED) is True
    assert token_authorizes(SCOPE_PRIVATE_ANY, SCOPE_LOCAL) is True


def test_token_authorizes_root_umbrella_authorizes_everything_under_inference():
    for scope in KAI_INFERENCE_PROVIDER_SCOPES.values():
        assert token_authorizes(SCOPE_ANY, scope) is True


def test_private_token_REJECTS_cloud_request():
    """The core consent-first invariant for the inference adapter."""
    assert token_authorizes(SCOPE_PRIVATE_ANY, SCOPE_GEMINI) is False
    assert token_authorizes(SCOPE_PRIVATE_ANY, SCOPE_OPENAI) is False
    assert token_authorizes(SCOPE_PRIVATE_ANY, SCOPE_ANTHROPIC) is False
    assert token_authorizes(SCOPE_LOCAL, SCOPE_GEMINI) is False
    assert token_authorizes(SCOPE_SELF_HOSTED, SCOPE_OPENAI) is False


def test_cloud_token_REJECTS_private_request():
    """Mirror invariant: cloud-only tokens cannot reach private providers."""
    assert token_authorizes(SCOPE_CLOUD_ANY, SCOPE_SELF_HOSTED) is False
    assert token_authorizes(SCOPE_CLOUD_ANY, SCOPE_LOCAL) is False
    assert token_authorizes(SCOPE_GEMINI, SCOPE_LOCAL) is False


def test_token_authorizes_unrelated_scope_rejected():
    """Scopes outside the kai.inference tree never authorize inference."""
    assert token_authorizes("vault.owner", SCOPE_GEMINI) is False
    assert token_authorizes("agent.kai.analyze", SCOPE_GEMINI) is False
    assert token_authorizes("portfolio.read", SCOPE_OPENAI) is False
