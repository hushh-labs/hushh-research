"""Owner connector request/response shapes; routes retain all execution authority."""

from __future__ import annotations

from typing import Any, Literal, Optional
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SerializerFunctionWrapHandler,
    StrictBool,
    field_validator,
    model_serializer,
)

from api.routes.connector_mcp_contracts import McpConfigurationRequest
from hushh_mcp.one_adk.governed_mcp_toolset import validated_mcp_arguments
from hushh_mcp.services.external_mcp_client import ExternalMcpError
from hushh_mcp.services.pod_mcp_approval import PodMcpTerms
from hushh_mcp.services.stripe_mcp_policy import StripeMcpReadiness


class ConnectorSummary(BaseModel):
    connectorId: str
    displayName: str
    description: str
    authStyle: str
    status: str
    accountLabel: Optional[str] = None
    connectedAt: Optional[str] = None
    validationState: str = "unverified"
    profile: Literal["selected", "live"] | None = None
    revocationOutcome: str = "not_attempted"
    lastErrorCode: Optional[str] = None
    available: bool = True
    registrationKind: Literal["curated", "private"] = "curated"
    # Server-derived, presentation only: true for an operator-registered OAuth
    # provider that has a reviewed manifest. Start and complete re-validate the
    # manifest pins themselves; nothing here is trusted from the client.
    curatedOAuth: bool = False
    # A reviewed configuration-derived card. This is presentation-only: OAuth
    # start and completion still obtain and validate the live registry row.
    catalogCard: bool = False
    # `setup_pending` has no exact active runtime row, `discovery_pending` is
    # registration-only, and `unavailable` passed neither the feature nor
    # runtime availability check. A null value is ready for Connect.
    catalogState: Literal["setup_pending", "discovery_pending", "unavailable"] | None = None
    stripeReadiness: StripeMcpReadiness | None = None

    @model_serializer(mode="wrap")
    def serialize_summary(self, handler: SerializerFunctionWrapHandler) -> dict[str, Any]:
        result: dict[str, Any] = handler(self)
        if self.stripeReadiness is None:
            result.pop("stripeReadiness", None)
        return result


class ConnectorsResponse(BaseModel):
    connectors: list[ConnectorSummary]
    features: dict[str, bool] = Field(default_factory=dict)
    driveAgentPackagesEnabled: bool = False


class RegisterConnectorRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    registrationId: UUID
    displayName: str = Field(min_length=1, max_length=100)
    endpoint: str = Field(min_length=1, max_length=4096)
    authStyle: Literal["api_key", "oauth"]


class McpReviewRequest(McpConfigurationRequest):
    conversationId: str = Field(min_length=1, max_length=256)
    toolName: str = Field(pattern=r"^mcp_[0-9a-f]{40}$")
    arguments: dict[str, Any]
    pendingHandle: str | None = Field(default=None, pattern=r"^one_secret_ref:[A-Za-z0-9_-]{32}$")
    directiveId: str | None = Field(default=None, pattern=r"^dir_[a-f0-9]{32}$")

    @field_validator("arguments")
    @classmethod
    def bound_arguments(cls, value):
        try:
            return validated_mcp_arguments({"type": "object"}, value)
        except ExternalMcpError:
            raise ValueError("Invalid or oversized MCP arguments.") from None


class McpConfirmRequest(McpReviewRequest):
    directiveId: str = Field(pattern=r"^dir_[0-9a-f]{32}$")
    confirmed: StrictBool


class PodMcpConfirmRequest(BaseModel):
    """Browser-only confirmation of the preview fetched directly from its pod."""

    model_config = ConfigDict(extra="forbid", strict=True)
    podReview: PodMcpTerms
    directiveId: str = Field(pattern=r"^dir_[0-9a-f]{32}$")
    confirmed: StrictBool


class ConnectApiKeyRequest(BaseModel):
    apiKey: str = Field(min_length=1, max_length=4096)
    accountLabel: Optional[str] = Field(default=None, max_length=200)


class ConnectResultResponse(BaseModel):
    status: str
    connectorId: str
    revocationOutcome: Optional[str] = None


class StartOAuthRequest(BaseModel):
    redirectUri: str = Field(min_length=1, max_length=2048)
    flow: Literal["web", "native"] = "web"
    profile: Literal["selected", "live"] = "selected"


class StartOAuthResponse(BaseModel):
    authorizeUrl: str
    expiresAt: str
    attemptId: Optional[str] = None
    connectorId: Optional[str] = None


class CompleteOAuthRequest(BaseModel):
    state: str = Field(min_length=1, max_length=4096)
    code: str = Field(min_length=1, max_length=4096)


class CompleteWebOAuthRequest(CompleteOAuthRequest):
    attemptId: str = Field(min_length=16, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")


class FinalizeNativeRequest(BaseModel):
    attemptId: str = Field(min_length=16, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")


class PendingNativeAttempt(BaseModel):
    attemptId: str
    expiresAt: str


class PendingNativeResponse(BaseModel):
    pending: PendingNativeAttempt | None


class PickerSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    origin: str = Field(min_length=1, max_length=2048)


class NativePickerStartRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    redirectUri: str = Field(min_length=1, max_length=2048)


class NativePickerStartResponse(BaseModel):
    authorizeUrl: str
    attemptId: str
    expiresAt: str


class NativePickerAttemptFile(BaseModel):
    documentId: str
    name: str
    mimeType: str


class PendingNativePickerAttempt(BaseModel):
    attemptId: str
    expiresAt: str
    files: list[NativePickerAttemptFile]


class PendingNativePickerResponse(BaseModel):
    pending: PendingNativePickerAttempt | None


class NativePickerConfirmRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    attemptId: UUID
    processingConsent: Literal["selected-files-background-v1"] | None = None


class NativePickerCancelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    attemptId: UUID


class SelectDriveDocumentsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sessionId: UUID
    fileIds: list[str] = Field(min_length=1, max_length=25)
    confirmed: Literal[True]
    processingConsent: Literal["selected-files-background-v1"] | None = None


class DriveProcessingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool
    disclosure: Literal["selected-files-background-v1"] | None = None
    confirmed: Literal[True]


class LiveBackgroundRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool
    confirmed: Literal[True]


class DriveCollectionProcessingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: StrictBool
    disclosure: Literal["live-drive-collection-v1"] | None = None
    confirmed: StrictBool

    @field_validator("confirmed")
    @classmethod
    def explicit_processing_confirmation(cls, value):
        if value is not True:
            raise ValueError("Explicit processing permission is required.")
        return value


class RemoveDriveDocumentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirmed: Literal[True]
