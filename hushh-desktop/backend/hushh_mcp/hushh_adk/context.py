"""
Hushh ADK Context Management

Provides thread-safe access to authorization context (User ID, Consent Token)
during agent execution. This avoids passing these parameters manually through
every tool function.
"""

from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Dict, Optional

# Thread-local storage for current execution context
# This allows tools to access the active user/token without explicit arguments
_current_context: ContextVar[Optional["HushhContext"]] = ContextVar("hushh_context", default=None)


@dataclass
class HushhContext:
    """
    Secure context for agent execution.

    Attributes:
        user_id: The authenticated user ID
        consent_token: The signed consent token string
        vault_keys: Optional dictionary of domain-specific decryption keys
    """

    user_id: str
    consent_token: str
    vault_keys: Dict[str, str] = field(default_factory=dict)

    @classmethod
    def current(cls) -> Optional["HushhContext"]:
        """Get the current active context."""
        return _current_context.get()

    def __enter__(self):
        """Set this context as active for the current thread/task."""
        self._token = _current_context.set(self)
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Reset context on exit."""
        _current_context.reset(self._token)
