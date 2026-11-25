"""Closed owner-device account read. No credentials, mutations or invented grants."""

import re
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

ACCOUNT_CONTEXT_TOOL = "read_account_context"
STATE_ACCOUNT_CONTEXT_ENABLED = "temp:one_account_context_enabled"
STATE_ACCOUNT_CONTEXT_PRIVATE = "hussh:account_context_private_invocations"
PRIVATE_ACCOUNT_ANSWER = (
    "A private account answer was shown for that turn. Ask again to read your account."
)
ACCOUNT_CONTEXT_DESCRIPTION = (
    "Read the signed-in owner's committed account identity for this answer only: display name, "
    "masked email/phone, verification and photo presence. Read before answering personal account "
    "identity or verification questions. This does not read Calendar, mail, billing, signup date, "
    "linked sign-in methods, notification choices or saved timezone and cannot change anything."
)
ACCOUNT_CONTEXT_PARAMETERS = {
    "type": "object",
    "properties": {"section": {"type": "string", "enum": ["identity"]}},
    "required": ["section"],
    "additionalProperties": False,
}


class _Closed(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class _Request(_Closed):
    section: Literal["identity"]


class _Facts(_Closed):
    display_name: str | None = Field(max_length=60)
    masked_email: str | None = Field(max_length=254)
    masked_phone: str | None = Field(max_length=30)
    email_verified: bool | None
    phone_verified: bool | None
    has_photo: bool | None
    last_synced_at: str | None = Field(max_length=40)


class _Available(_Closed):
    status: Literal["ok"]
    source: Literal["committed_account_identity"]
    identity: _Facts


class _Unavailable(_Closed):
    status: Literal["unavailable"]
    reason: Literal["identity_unavailable"]


def validate_account_context_request(value: object) -> dict:
    return _Request.model_validate(value).model_dump()


def validate_account_context_result(request: dict, value: object) -> dict:
    validate_account_context_request(request)
    if isinstance(value, dict) and value.get("status") == "unavailable":
        return _Unavailable.model_validate(value).model_dump()
    parsed = _Available.model_validate(value)
    facts = parsed.identity
    if facts.display_name and re.search(r"[\x00-\x1f\x7f]|@|://|www\.", facts.display_name, re.I):
        raise ValueError("Invalid account name projection.")
    # The app masks contacts before the wire; refuse raw contacts even from an
    # authenticated device. Unknown verification remains null, never false.
    if facts.masked_email is not None and not re.fullmatch(
        r"\*{3}@[^@\s/\x00-\x1f]{1,250}", facts.masked_email
    ):
        raise ValueError("Unmasked account email.")
    if facts.masked_phone is not None and not re.fullmatch(r"••••|••• \d{4}", facts.masked_phone):
        raise ValueError("Unmasked account phone.")
    if facts.last_synced_at is not None:
        stamp = datetime.fromisoformat(facts.last_synced_at.replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            raise ValueError("Account observation needs timezone.")
    return parsed.model_dump()


ACCOUNT_INSTRUCTION = (
    " For your own Profile / Your Account identity and verification questions, call "
    "read_account_context before answering; finish the first pass at that device call. "
    "Use only returned facts, with masked contacts. Unavailable is not missing or unverified. "
    "The committed shadow observation is not a fresh provider check; last_synced_at and "
    "created_at are not signup dates. A profile email never proves Gmail or Calendar access. "
    "For changes use the existing app actions and their review screens. The typed display-name "
    "action prepares a proposed name in the existing editor; ask the person to review and Save, "
    "never report it as changed when merely opened. Distinguish account "
    "display name from the encrypted preferred name (what One calls you). Language style uses "
    "existing style Settings review; turn timezone is not a saved account timezone. "
    "Do not invent plan, billing, storage usage, linked identity inventory or notification "
    "settings, signup date or 2FA status. Sign-in provider rows are not a complete linked-session "
    "inventory; trusted devices are not every active provider session. Current-session sign out "
    "does not sign out all devices. A Vault password is not a Google/Apple sign-in password. "
    "Open the owning Profile, Connections, Calendar or Settings surface when needed. "
    "Email aliases do not replace the primary sign-in email; phone changes need the existing "
    "verification flow and avatar changes need a supplied image. Export uses Download Memory, "
    "not a made-up download link. Reset, sign out, delete account and remove one field are "
    "different actions; clarify ambiguous 'account band karo'. Ask for missing new values "
    "or connector names. Marketing consent stays a manual choice. Never claim a change, "
    "disconnection, export or deletion completed until its settled result proves it; pending "
    "cleanup or uncertain writes stay pending/uncertain. The private read continuation is answer-only: explain which requested changes still need their review, without claiming "
    "those later steps ran. Answer in the person's language without needless clarification."
)


def account_private_invocations(state: Any, events: list[Any]) -> set[str]:
    """Exclude private account answers from existing derived-memory writers."""
    return set((state or {}).get(STATE_ACCOUNT_CONTEXT_PRIVATE) or []) | {
        invocation
        for event in events
        for invocation in getattr(getattr(event, "actions", None), "state_delta", {}).get(
            STATE_ACCOUNT_CONTEXT_PRIVATE, []
        )
    }
