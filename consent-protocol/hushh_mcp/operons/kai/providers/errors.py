# hushh_mcp/operons/kai/providers/errors.py
"""
Error hierarchy for Kai's LLM provider adapter.

Design notes
------------
* `ConsentScopeViolation` MUST be raised before any network I/O when a
  presented token lacks the provider-specific scope. Tests assert that
  no HTTP request is initiated when this exception is raised.

* `ProviderUnavailable` indicates a configuration problem (missing creds,
  uninstalled SDK, bad endpoint). The dispatcher converts it into a
  graceful operon-level failure that does not crash Kai's debate.

* `ProviderTimeout` wraps asyncio/HTTP timeouts so callers can apply
  retry policy uniformly across providers.

* `ProviderError` is the catch-all parent and the only error that
  callers MUST handle.
"""

from __future__ import annotations


class ProviderError(Exception):
    """Parent class for all provider-related failures."""

    def __init__(self, message: str, *, provider: str = "", scope: str = "") -> None:
        super().__init__(message)
        self.provider = provider
        self.scope = scope


class ConsentScopeViolation(ProviderError):
    """
    Token does not authorize the requested provider.

    This is raised BEFORE any network call. The dispatcher and every
    provider rely on this guarantee for the consent-first invariant.
    """


class ProviderUnavailable(ProviderError):
    """The provider cannot service requests right now (config/creds/SDK)."""


class ProviderTimeout(ProviderError):
    """Provider did not respond within the configured deadline."""


class ProviderResponseInvalid(ProviderError):
    """Provider returned a malformed response (e.g. empty body, bad JSON)."""
