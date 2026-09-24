"""Transport-agnostic A2A delegation contract.

These types are the ONLY thing One and a specialist agree on. For slice 1 the
transport is an in-process function call; a later network A2A swap reuses these
exact shapes over HTTP without touching callers.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class A2AAuthorityRequired(PermissionError):
    """Stable fail-closed signal for a missing attenuated authority object."""

    error_code = "EXACT_AUTHORITY_REQUIRED"


@dataclass(frozen=True)
class A2AAuthorityContext:
    """Non-model, ingress-validated authority forwarded to one specialist hop.

    Values are opaque references, never raw developer/consent credentials or
    decrypted user information. A specialist receives only the grants, export
    references, actions, and confirmation that its one hop needs.
    """

    subject_user_id: str
    tenant_id: str
    task_id: str
    caller_kind: Literal["first_party", "developer", "a2a"]
    developer_app_id: str | None = None
    invocation_capabilities: tuple[str, ...] = ()
    information_grant_refs: tuple[str, ...] = ()
    encrypted_export_refs: tuple[str, ...] = ()
    action_capabilities: tuple[str, ...] = ()
    confirmation_receipt: str | None = None
    expires_at_ms: int | None = None

    def is_active_for(self, user_id: str) -> bool:
        if self.subject_user_id != user_id or not self.tenant_id or not self.task_id:
            return False
        return self.expires_at_ms is None or int(time.time() * 1000) < self.expires_at_ms


def require_attenuated_authority(
    task: "A2ATask",
    *,
    information: bool = False,
    action: bool = False,
    required_invocation: str | None = None,
    expected_tenant_id: str | None = None,
    expected_task_id: str | None = None,
    expected_caller_kind: Literal["first_party", "developer", "a2a"] = "first_party",
) -> A2AAuthorityContext:
    """Validate a hop; migrated invocation gates require independent ingress bindings.

    Expected tenant, task and caller values must come from trusted runtime
    context, never be copied from the authority being checked. This contract
    check does not replace token signature/scope/DB revocation checks or consume
    an action confirmation receipt. Unmigrated callers retain the legacy gate.
    """
    authority = task.authority
    if required_invocation is not None:
        # Validate before is_active_for: untyped callers must fail closed for
        # malformed expiry rather than raising a comparison TypeError.
        if (
            not isinstance(authority, A2AAuthorityContext)
            or not isinstance(task.user_id, str)
            or not task.user_id.strip()
            or not isinstance(required_invocation, str)
            or not required_invocation.strip()
            or not isinstance(expected_tenant_id, str)
            or not expected_tenant_id.strip()
            or not isinstance(expected_task_id, str)
            or not expected_task_id.strip()
            or not isinstance(expected_caller_kind, str)
            or expected_caller_kind not in {"first_party", "developer", "a2a"}
            or authority.subject_user_id != task.user_id
            or authority.tenant_id != expected_tenant_id
            or authority.task_id != expected_task_id
            or authority.caller_kind != expected_caller_kind
            or (expected_caller_kind == "first_party" and authority.developer_app_id is not None)
            or not isinstance(authority.invocation_capabilities, tuple)
            or not all(isinstance(value, str) for value in authority.invocation_capabilities)
            or required_invocation not in authority.invocation_capabilities
            or type(authority.expires_at_ms) is not int
            or int(time.time() * 1000) >= authority.expires_at_ms
        ):
            raise A2AAuthorityRequired("EXACT_AUTHORITY_REQUIRED")
    if authority is None or not authority.is_active_for(task.user_id):
        raise A2AAuthorityRequired("EXACT_AUTHORITY_REQUIRED")
    if information and not (authority.information_grant_refs and authority.encrypted_export_refs):
        raise A2AAuthorityRequired("EXACT_AUTHORITY_REQUIRED")
    if action and not (authority.action_capabilities and authority.confirmation_receipt):
        raise A2AAuthorityRequired("ACTION_AUTHORITY_REQUIRED")
    return authority


@dataclass(frozen=True)
class A2ATask:
    """One → specialist. Coordinate-free by construction."""

    user_id: str
    consent_token: str
    conversation_id: str | None
    message: str | None = None
    delegate_result: dict | None = None
    timezone: str | None = None
    planned_action: dict | None = None
    authority: A2AAuthorityContext | None = None
    # Trusted ingress bindings, never inferred from the authority being checked
    # or deserialized from model/client-supplied delegation arguments.
    expected_tenant_id: str | None = None
    expected_task_id: str | None = None
    specialist_target: Literal["consent", "connections"] | None = None
    execution_surface: Literal["typed_chat"] | None = None
    previous_answer: str | None = None


@dataclass(frozen=True)
class A2ADirective:
    """A specialist's client-side instruction. ``payload`` is the specialist's
    existing coordinate-free descriptor (e.g. Location's clientAction/clientPrompt)."""

    kind: Literal["action", "prompt"]
    payload: dict


class SpecialistReadSource(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    source_ref: str = Field(pattern=r"^(mail|document):[A-Za-z0-9_-]{1,80}$")
    label: str = Field(max_length=80)
    kind: Literal["metadata", "document"]
    page: int | None = Field(default=None, ge=1, le=100)


class SpecialistReadResult(BaseModel):
    """Additive, bounded provenance/status; never credentials or raw content."""

    model_config = ConfigDict(extra="forbid", strict=True)
    schema_version: Literal["specialist_read.v1"] = "specialist_read.v1"
    connector: Literal["mail", "drive"]
    status: Literal[
        "ok",
        "input_required",
        "connect_required",
        "reconnect_required",
        "connection_changed",
        "permission_denied",
        "source_changed",
        "response_too_large",
        "invalid_argument",
        "unavailable",
    ]
    sources: list[SpecialistReadSource] = Field(default_factory=list, max_length=25)
    truncated: bool = False
    metadata_only: bool = False


@dataclass(frozen=True)
class SpecialistTurnResult:
    """specialist → One. Coordinate-free by construction."""

    conversation_id: str
    text: str
    directive: A2ADirective | None
    is_complete: bool
    state_changed: bool
    model: str
    structured: SpecialistReadResult | None = None
