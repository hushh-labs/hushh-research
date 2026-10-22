"""Current owner configuration contract; no connector execution authority."""

from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from hushh_mcp.one_adk.mcp_turn_scope import validate_mcp_turn_configurations
from hushh_mcp.services.external_mcp_client import ExternalMcpError


class McpConfigurationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    connectorConfiguration: dict[str, Any] | None = Field(default=None, repr=False, exclude=True)

    @field_validator("connectorConfiguration")
    @classmethod
    def validate_configuration(cls, value):
        if value is None:
            return None
        try:
            return next(iter(validate_mcp_turn_configurations([value]).values()))
        except ExternalMcpError:
            raise ValueError("Invalid connector configuration.") from None


class McpRegisteredClient(BaseModel):
    model_config = ConfigDict(extra="forbid")
    issuer: str = Field(min_length=1, max_length=2048, repr=False)
    clientId: str = Field(min_length=1, max_length=8192, repr=False)
    clientSecret: str | None = Field(default=None, min_length=1, max_length=8192, repr=False)
    tokenEndpointAuthMethod: Literal["none", "client_secret_basic", "client_secret_post"]


class McpOAuthBeginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: UUID
    endpoint: str = Field(min_length=1, max_length=4096, repr=False)
    registeredClient: McpRegisteredClient | None = Field(default=None, repr=False)


class McpOAuthAttemptRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: UUID
    attemptId: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$", repr=False)


class McpOAuthCompleteRequest(McpOAuthAttemptRequest):
    code: str = Field(min_length=1, max_length=8192, repr=False)
    state: str = Field(min_length=1, max_length=512, repr=False)
    issuer: str | None = Field(default=None, max_length=4096, repr=False)
