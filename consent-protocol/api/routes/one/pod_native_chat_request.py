"""The native Cloud Chat request carries one new input and no client tool schemas."""

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator

ForwardedKey = Literal[
    "timezone",
    "runtimeCredential",
    "runtimeCredentialTransport",
    "runtimeProvider",
    "puppyDeviceId",
    "vertexProject",
    "vertexLocation",
    "dataDoorGrants",
    "screenContext",
    "specialistFocus",
    "communicationPreferences",
    "turnLocation",
    "mcpConfigurations",
    "mcpApproval",
    "mainChat",
    "locationChatReview",
    "locationChatConversation",
    "locationChatContinuation",
]
RunIdentity = Annotated[str, Field(min_length=1, max_length=128)]


class NativeMcpDecisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    interrupt_id: str = Field(alias="interruptId", min_length=1, max_length=256)
    confirmed: StrictBool


class NativePodChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    transport: Literal["native-adk-v1"]
    visual_mode: Literal["finance-dev"] | None = Field(default=None, alias="visualMode")
    thread_id: RunIdentity = Field(alias="threadId")
    run_id: RunIdentity = Field(alias="runId")
    message: str | None = Field(default=None, min_length=1, max_length=8000)
    decision: NativeMcpDecisionRequest | None = None
    forwarded_props: dict[ForwardedKey, Any] = Field(alias="forwardedProps", default_factory=dict)

    @model_validator(mode="after")
    def require_one_input(self):
        if (self.message is None) == (self.decision is None) or (
            self.message is not None and not self.message.strip()
        ):
            raise ValueError("Provide a message or a connector decision.")
        confirmed = bool(self.decision and self.decision.confirmed)
        if confirmed != ("mcpApproval" in self.forwarded_props):
            raise ValueError("An approval is required only for a confirmed connector decision.")
        return self
