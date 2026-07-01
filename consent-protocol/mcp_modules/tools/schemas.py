"""
Pydantic schemas for MCP tool argument validation.

Enforces zero-trust inputs, preventing prompt injections and malformed inputs.
"""

from typing import Any, Optional

from pydantic import BaseModel, Field, field_validator, model_validator


class OfferSchema(BaseModel):
    bid_amount: float = Field(..., gt=0, le=1000000, description="Amount offered to the user for this scoped access")
    currency: Optional[str] = Field("USD", min_length=3, max_length=3, description="ISO-4217 currency code")
    offer_summary: Optional[str] = Field(None, description="Short human-readable description of the offer")
    settlement_ref: Optional[str] = Field(None, description="Optional correlation id linking to AP2 payment mandate")


class RequestConsentSchema(BaseModel):
    user_id: str = Field(..., description="Firebase UID, registered email, or registered E.164 phone number")
    country_iso2: Optional[str] = Field(None, description="Optional ISO country hint")
    country: Optional[str] = Field(None, description="Optional country name or shortform")
    scope: Optional[str] = Field(None, description="Data scope to access")
    reason: Optional[str] = Field(None, description="Reason for request")
    approval_timeout_minutes: Optional[int] = Field(None, ge=5, le=1440)
    expiry_hours: Optional[int] = Field(None, ge=24, le=2160)
    connector_public_key: str = Field(..., description="Base64-encoded X25519 public key")
    connector_key_id: str = Field(..., description="Stable caller-managed identifier")
    connector_wrapping_alg: str = Field(..., description="Connector key-wrapping algorithm")
    scope_bundle: Optional[str] = Field(None, description="Pre-defined scope bundle name")
    offer: Optional[OfferSchema] = Field(None, description="Optional price-consent offer")

    @field_validator("connector_wrapping_alg")
    @classmethod
    def validate_wrapping_alg(cls, v: str) -> str:
        expected = "X25519-AES256-GCM"
        if v != expected:
            raise ValueError(f"Unsupported wrapping algorithm: {v}. Must be {expected}")
        return v


class PrepareCampaignContextSchema(BaseModel):
    user_id: str = Field(..., description="Firebase UID, registered email, or registered E.164 phone number")
    country_iso2: Optional[str] = Field(None, description="Optional ISO country hint")
    country: Optional[str] = Field(None, description="Optional country name or shortform")
    campaign_goal: Optional[str] = Field(None, description="Plain-English campaign goal")
    surface: Optional[str] = Field(None, description="Campaign surface or experience type")
    preferred_context: Optional[str] = Field(None, description="Preferred context hint")
    approval_timeout_minutes: Optional[int] = Field(None, ge=5, le=1440)
    expiry_hours: Optional[int] = Field(None, ge=24, le=2160)
    poll_seconds: Optional[int] = Field(None, ge=0, le=90)
    connector_public_key: Optional[str] = Field(None, description="Base64-encoded X25519 public key")
    connector_key_id: Optional[str] = Field(None, description="Stable caller-managed identifier")
    connector_wrapping_alg: Optional[str] = Field(None, description="Connector key-wrapping algorithm")
    fetch_export_metadata: Optional[bool] = Field(True, description="Fetch safe metadata")

    @field_validator("connector_wrapping_alg")
    @classmethod
    def validate_wrapping_alg(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        expected = "X25519-AES256-GCM"
        if v != expected:
            raise ValueError(f"Unsupported wrapping algorithm: {v}. Must be {expected}")
        return v


class ValidateTokenSchema(BaseModel):
    token: str = Field(..., description="The consent token string")
    expected_scope: Optional[str] = Field(None, description="Optional expected scope")


class GetEncryptedScopedExportSchema(BaseModel):
    user_id: str = Field(..., description="Firebase UID, registered email, or registered E.164 phone number")
    country_iso2: Optional[str] = Field(None, description="Optional ISO country hint")
    country: Optional[str] = Field(None, description="Optional country name or shortform")
    consent_token: str = Field(..., description="Valid consent token")
    expected_scope: Optional[str] = Field(None, description="Optional safety check scope")


class DelegateToAgentSchema(BaseModel):
    from_agent: str = Field(..., description="Agent ID making the delegation")
    to_agent: str = Field(..., description="Target agent ID")
    scope: str = Field(..., description="Scope being delegated")
    user_id: str = Field(..., description="User authorizing the delegation")
    country_iso2: Optional[str] = Field(None, description="Optional ISO country hint")
    country: Optional[str] = Field(None, description="Optional country name or shortform")

    @field_validator("from_agent", "to_agent")
    @classmethod
    def validate_agent_ids(cls, v: str) -> str:
        allowed = {"agent_food_dining", "agent_professional_profile", "agent_identity"}
        if v not in allowed and not v.startswith("agent_") and v != "orchestrator":
            raise ValueError(f"Invalid agent ID: {v}. Allowed prefixes: agent_ or orchestrator")
        return v


class DiscoverUserDomainsSchema(BaseModel):
    user_id: str = Field(..., description="Firebase UID, registered email, or registered E.164 phone number")
    country_iso2: Optional[str] = Field(None, description="Optional ISO country hint")
    country: Optional[str] = Field(None, description="Optional country name or shortform")


class CheckConsentStatusSchema(BaseModel):
    user_id: str = Field(..., description="Firebase UID, registered email, or registered E.164 phone number")
    country_iso2: Optional[str] = Field(None, description="Optional ISO country hint")
    country: Optional[str] = Field(None, description="Optional country name or shortform")
    scope: Optional[str] = Field(None, description="The scope requested")
    request_id: Optional[str] = Field(None, description="Optional request_id")


class ListRiaProfilesSchema(BaseModel):
    query: Optional[str] = Field(None, description="Search query")
    firm: Optional[str] = Field(None, description="Firm filter")
    verification_status: Optional[str] = Field(None, description="Verification status filter")
    limit: Optional[int] = Field(None, ge=1, le=50)


class GetRiaProfileSchema(BaseModel):
    ria_id: str = Field(..., description="RIA profile ID")


class ListMarketplaceInvestorsSchema(BaseModel):
    query: Optional[str] = Field(None, description="Search query")
    limit: Optional[int] = Field(None, ge=1, le=50)


class GetRiaVerificationStatusSchema(BaseModel):
    user_id: str = Field(..., description="Firebase UID")
    consent_token: str = Field(..., description="Valid consent token")


class GetRiaClientAccessSummarySchema(BaseModel):
    user_id: str = Field(..., description="Firebase UID")
    consent_token: str = Field(..., description="Valid consent token")


class KaiAnalyzeStockSchema(BaseModel):
    symbol: Optional[str] = Field(None, description="Stock symbol or company name")
    ticker: Optional[str] = Field(None, description="Stock ticker alternative")
    target: Optional[str] = Field(None, description="Target stock alternative")
    query: Optional[str] = Field(None, description="Query string alternative")
    analysis_type: Optional[str] = Field("full", description="Type of analysis")
    analysis_mode: Optional[str] = Field(None, description="Mode of analysis alternative")
    country: Optional[str] = Field(None, description="Country context")
    exchange: Optional[str] = Field(None, description="Exchange context")

    @model_validator(mode="before")
    @classmethod
    def check_identifier(cls, data: Any) -> Any:
        if isinstance(data, dict):
            if not any(data.get(k) for k in ("symbol", "ticker", "target", "query")):
                raise ValueError("Must provide at least one of symbol, ticker, target, or query")
        return data


class KaiOpenHistorySchema(BaseModel):
    tab: Optional[str] = Field("history", description="Tab to open")


class EmptyArgsSchema(BaseModel):
    """Fallback schema for tools requiring no arguments"""
    pass
