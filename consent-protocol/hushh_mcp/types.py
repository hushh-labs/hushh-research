# hushh_mcp/types.py

from typing import Literal, NewType, Optional

from pydantic import BaseModel

from hushh_mcp.constants import ConsentScope

# ==================== Aliases ====================

UserID = NewType("UserID", str)
AgentID = NewType("AgentID", str)

# ==================== HushhConsentToken ====================


class HushhConsentToken(BaseModel):
    token: str
    user_id: UserID
    agent_id: AgentID
    scope: ConsentScope  # Resolved enum (fallback to WORLD_MODEL_READ for dynamic scopes)
    scope_str: str = ""  # Actual scope string from token (e.g., "attr.financial.*")
    issued_at: int  # epoch ms
    expires_at: int  # epoch ms
    signature: str


# ==================== TrustLink ====================


class TrustLink(BaseModel):
    from_agent: AgentID
    to_agent: AgentID
    scope: ConsentScope
    created_at: int
    expires_at: int
    signed_by_user: UserID
    signature: str


# ==================== Vault Structures ====================


class VaultKey(BaseModel):
    user_id: UserID
    scope: ConsentScope


class EncryptedPayload(BaseModel):
    ciphertext: str
    iv: str
    tag: str
    encoding: Literal["base64", "hex"]
    algorithm: Literal["aes-256-gcm", "chacha20-poly1305"]


class VaultRecord(BaseModel):
    key: VaultKey
    data: EncryptedPayload
    agent_id: AgentID
    created_at: int
    updated_at: Optional[int] = None
    expires_at: Optional[int] = None
    deleted: Optional[bool] = False
    metadata: Optional[dict] = None
