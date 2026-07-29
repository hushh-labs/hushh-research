# hushh_mcp/types.py

import logging
from typing import Any, Literal, NewType, Optional

from pydantic import BaseModel, model_validator

from hushh_mcp.constants import ConsentScope

logger = logging.getLogger(__name__)

# ==================== Aliases ====================

UserID = NewType("UserID", str)
AgentID = NewType("AgentID", str)

# ==================== Internal helpers ====================

_STRING_FIELDS_TO_STRIP = frozenset(
    {"token", "user_id", "agent_id", "scope_str", "signature",
     "from_agent", "to_agent", "signed_by_user", "ciphertext", "iv", "tag"}
)


def _strip_string_fields(values: dict[str, Any]) -> dict[str, Any]:
    """Strip leading/trailing whitespace from every string field that warrants it.

    Called by the pre-save @model_validator so callers never have to remember
    to strip — the class boundary always enforces clean state.
    Integrated by Abdul Gaffar — canonical pre-save model hook.
    """
    return {
        k: (v.strip() if isinstance(v, str) and k in _STRING_FIELDS_TO_STRIP else v)
        for k, v in values.items()
    }


def _mask_id(value: str, *, visible_prefix_chars: int = 4) -> str:
    """Return a privacy-safe masked representation of an identifier.

    Keeps the first ``visible_prefix_chars`` characters and replaces the rest
    with ``***`` so log lines are correl-able without leaking full IDs.
    """
    if len(value) <= visible_prefix_chars:
        return "***"
    return value[:visible_prefix_chars] + "***"


def _mask_token(token: str) -> str:
    """Show the token prefix (e.g. ``HCT:``) and mask the rest."""
    colon = token.find(":")
    if colon >= 0:
        return token[: colon + 1] + "***"
    return "***"


# ==================== HushhConsentToken ====================


class HushhConsentToken(BaseModel):
    """Parsed, validated consent token.

    Lifecycle hooks
    ---------------
    Pre-save  (@model_validator mode='before'):
        All string identity fields are stripped of surrounding whitespace.
        Log line: ``Pre-Save Hook Triggered: normalizing HushhConsentToken fields``

    Post-load (public_dict()):
        Returns a privacy-safe view: ``token`` and ``signature`` are masked,
        ``user_id`` / ``agent_id`` show only a short prefix.
        Log line: ``Post-Load Hook Triggered: masking HushhConsentToken for public view``

    Canonical surface: hushh_mcp.types
    Integrated by Abdul Gaffar — canonical pre-save and post-load model hooks.
    """

    token: str
    user_id: UserID
    agent_id: AgentID
    scope: ConsentScope  # Resolved enum (fallback to WORLD_MODEL_READ for dynamic scopes)
    scope_str: str = ""  # Actual scope string from token (e.g., "attr.financial.*")
    issued_at: int  # epoch ms
    expires_at: int  # epoch ms
    signature: str
    commercial: bool = False  # True if token authorizes monetized/commercial agent usage

    @model_validator(mode="before")
    @classmethod
    def _pre_save_normalize(cls, values: Any) -> Any:
        """Pre-Save Hook: strip whitespace from all string identity fields.

        Fires before field validation so every downstream consumer of
        HushhConsentToken is guaranteed to receive clean, trimmed values
        regardless of where the raw data originated.
        """
        if not isinstance(values, dict):
            return values
        logger.info("Pre-Save Hook Triggered: normalizing HushhConsentToken fields")
        return _strip_string_fields(values)

    def public_dict(self) -> dict[str, Any]:
        """Post-Load Hook: return a privacy-safe view of this token.

        Sensitive fields (``token``, ``signature``) are masked; identity
        fields (``user_id``, ``agent_id``) are truncated to a short prefix
        so the output is safe for logs, API responses, and audit trails.
        """
        logger.info(
            "Post-Load Hook Triggered: masking HushhConsentToken for public view "
            "user_id=%s",
            _mask_id(str(self.user_id)),
        )
        return {
            "user_id": _mask_id(str(self.user_id)),
            "agent_id": _mask_id(str(self.agent_id)),
            "scope": self.scope_str or self.scope.value,
            "issued_at": self.issued_at,
            "expires_at": self.expires_at,
            "commercial": self.commercial,
            "token": _mask_token(str(self.token)),
            "signature": "***",
        }


# ==================== TrustLink ====================


class TrustLink(BaseModel):
    """Signed trust delegation between two agents.

    Pre-Save Hook: strips whitespace from ``from_agent``, ``to_agent``,
    ``signed_by_user``, and ``signature``.
    Integrated by Abdul Gaffar — canonical pre-save model hook.
    """

    from_agent: AgentID
    to_agent: AgentID
    scope: ConsentScope
    created_at: int
    expires_at: int
    signed_by_user: UserID
    signature: str

    @model_validator(mode="before")
    @classmethod
    def _pre_save_normalize(cls, values: Any) -> Any:
        """Pre-Save Hook: strip whitespace from TrustLink identity fields."""
        if not isinstance(values, dict):
            return values
        logger.info("Pre-Save Hook Triggered: normalizing TrustLink fields")
        return _strip_string_fields(values)


# ==================== Vault Structures ====================


class VaultKey(BaseModel):
    user_id: UserID
    scope: ConsentScope


class EncryptedPayload(BaseModel):
    """Encrypted data envelope.

    Pre-Save Hook: strips whitespace from ``ciphertext``, ``iv``, and ``tag``
    to guard against encoding artifacts from base64-padded strings with
    accidental surrounding whitespace.
    Integrated by Abdul Gaffar — canonical pre-save model hook.
    """

    ciphertext: str
    iv: str
    tag: str
    encoding: Literal["base64", "hex"]
    algorithm: Literal["aes-256-gcm", "chacha20-poly1305"]

    @model_validator(mode="before")
    @classmethod
    def _pre_save_normalize(cls, values: Any) -> Any:
        """Pre-Save Hook: strip whitespace from EncryptedPayload crypto fields."""
        if not isinstance(values, dict):
            return values
        logger.info("Pre-Save Hook Triggered: normalizing EncryptedPayload fields")
        return _strip_string_fields(values)


class VaultRecord(BaseModel):
    key: VaultKey
    data: EncryptedPayload
    agent_id: AgentID
    created_at: int
    updated_at: Optional[int] = None
    expires_at: Optional[int] = None
    deleted: Optional[bool] = False
    metadata: Optional[dict] = None
