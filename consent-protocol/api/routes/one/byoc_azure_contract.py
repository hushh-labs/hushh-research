"""Public Azure authorization shapes; metadata only, never provider credentials."""

from typing import Literal, Optional

from pydantic import BaseModel, Field


class AzureAuthorizeBeginRequest(BaseModel):
    subscriptionId: Optional[str] = Field(default=None, max_length=64)
    filesEnabled: bool = Field(default=False, strict=True)


class AzureAuthorizeBeginResponse(BaseModel):
    authorizationUrl: str


class AzureAuthorizeCompleteRequest(BaseModel):
    code: str = Field(min_length=1, max_length=8192)
    state: str = Field(min_length=1, max_length=4096)


class AzureSubscription(BaseModel):
    subscriptionId: str
    displayName: str
    state: str


class AzureAuthorizeCompleteResponse(BaseModel):
    #: ``continue``: the account was identified; sign in again at ``authorizationUrl``
    #: (its own directory) for Azure. Microsoft usually completes that without asking.
    status: Literal[
        "setup_started",
        "needs_subscription",
        "upgrade_started",
        "continue",
        "cleanup_pending",
        "cleanup_review_required",
    ]
    jobId: Optional[str] = None
    operationId: Optional[str] = None
    cleanupPurpose: Literal["remove_cloud"] | None = None
    releaseId: Optional[str] = None
    authorizationUrl: Optional[str] = None
    subscriptions: Optional[list[AzureSubscription]] = None
    #: Only with needs_subscription: choose_subscription | no_enabled_subscription |
    #: personal_account (a personal Microsoft account must name its subscription id).
    reason: Optional[str] = None
    filesEnabled: Optional[bool] = None
