# api/models/schemas.py
"""
Pydantic models for FastAPI request/response validation.

All request and response schemas are centralized here for:
- Clean imports across routes
- Single source of truth for API contracts
- Easy documentation generation
"""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel

# ============================================================================
# AGENT CHAT MODELS
# ============================================================================


class ChatRequest(BaseModel):
    """Request model for agent chat endpoints."""

    userId: str
    message: str
    sessionState: Optional[Dict[str, Any]] = None


class ChatResponse(BaseModel):
    """Response model for agent chat endpoints."""

    response: str
    sessionState: Optional[Dict[str, Any]] = None
    needsConsent: bool = False
    isComplete: bool = False
    ui_type: Optional[str] = None
    options: Optional[List[str]] = None
    allow_custom: Optional[bool] = None
    allow_none: Optional[bool] = None
    consent_token: Optional[str] = None
    consent_issued_at: Optional[int] = None
    consent_expires_at: Optional[int] = None


# ============================================================================
# TOKEN VALIDATION MODELS
# ============================================================================


class ValidateTokenRequest(BaseModel):
    """Request to validate a consent token."""

    token: str


# ============================================================================
# DEVELOPER API MODELS
# ============================================================================


class ConsentRequest(BaseModel):
    """Request consent from a user for data access."""

    user_id: str
    developer_token: str  # Developer's API key
    scope: str  # e.g. "attr.food.*", "world_model.read"
    reason: Optional[str] = None
    expiry_hours: int = 24  # How long consent lasts


class ConsentResponse(BaseModel):
    """Response for consent request."""

    status: str
    message: str
    consent_token: Optional[str] = None
    expires_at: Optional[int] = None
    request_id: Optional[str] = None  # When status is 'pending', use this for SSE poll URL


class DataAccessRequest(BaseModel):
    """Request to access user data with consent token."""

    user_id: str
    consent_token: str  # Token from user consent


class DataAccessResponse(BaseModel):
    """Response for data access requests."""

    status_code: int
    data: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


# ============================================================================
# SESSION TOKEN MODELS
# ============================================================================


class SessionTokenRequest(BaseModel):
    """Request to issue a session token."""

    userId: str
    scope: str = "session"


class SessionTokenResponse(BaseModel):
    """Response with issued session token."""

    sessionToken: str
    issuedAt: int
    expiresAt: int
    scope: str


class LogoutRequest(BaseModel):
    """Request to logout and destroy session tokens."""

    userId: str


class HistoryRequest(BaseModel):
    """Request for consent history with pagination."""

    userId: str
    page: int = 1
    limit: int = 20
