"""Transport-agnostic A2A delegation contract.

These types are the ONLY thing One and a specialist agree on. For slice 1 the
transport is an in-process function call; a later network A2A swap reuses these
exact shapes over HTTP without touching callers.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Literal


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
) -> A2AAuthorityContext:
    authority = task.authority
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


@dataclass(frozen=True)
class A2ADirective:
    """A specialist's client-side instruction. ``payload`` is the specialist's
    existing coordinate-free descriptor (e.g. Location's clientAction/clientPrompt)."""

    kind: Literal["action", "prompt"]
    payload: dict


@dataclass(frozen=True)
class SpecialistTurnResult:
    """specialist → One. Coordinate-free by construction."""

    conversation_id: str
    text: str
    directive: A2ADirective | None
    is_complete: bool
    state_changed: bool
    model: str
