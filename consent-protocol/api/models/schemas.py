# api/models/schemas.py
"""
Pydantic models for FastAPI request/response validation.

All request and response schemas are centralized here for:
- Clean imports across routes
- Single source of truth for API contracts
- Easy documentation generation
"""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

# ============================================================================
# AGENT CHAT MODELS
# ============================================================================


class ChatRequest(BaseModel):
    """Request model for agent chat endpoints."""

    userId: str = Field(..., min_length=1, max_length=128)
    message: str = Field(..., min_length=1, max_length=8192)
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

    token: str = Field(..., min_length=1, max_length=2048)


# ============================================================================
# DEVELOPER API MODELS
# ============================================================================


class ConsentRequest(BaseModel):
    """Request consent from a user for data access."""

    user_id: str = Field(..., min_length=1, max_length=128)
    developer_token: str = Field(..., min_length=1, max_length=512)
    scope: str = Field(..., min_length=1, max_length=256)
    reason: Optional[str] = Field(default=None, max_length=1024)
    expiry_hours: int = Field(default=24, ge=1, le=720)  # 1 hour to 30 days


class ConsentResponse(BaseModel):
    """Response for consent request."""

    status: str
    message: str
    consent_token: Optional[str] = None
    expires_at: Optional[int] = None
    request_id: Optional[str] = None  # When status is 'pending', use this for SSE poll URL


class DataAccessRequest(BaseModel):
    """Request to access user data with consent token."""

    user_id: str = Field(..., min_length=1, max_length=128)
    consent_token: str = Field(..., min_length=1, max_length=2048)


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

    userId: str = Field(..., min_length=1, max_length=128)
    scope: str = Field(
        default="session",
        min_length=1,
        max_length=64,
    )


class SessionTokenResponse(BaseModel):
    """Response with issued session token."""

    sessionToken: str
    issuedAt: int
    expiresAt: int
    scope: str


class LogoutRequest(BaseModel):
    """Request to logout and destroy session tokens."""

    userId: str = Field(..., min_length=1, max_length=128)


class HistoryRequest(BaseModel):
    """Request for consent history with pagination."""

    userId: str = Field(..., min_length=1, max_length=128)
    page: int = Field(default=1, ge=1, le=10_000)
    limit: int = Field(default=20, ge=1, le=200)
