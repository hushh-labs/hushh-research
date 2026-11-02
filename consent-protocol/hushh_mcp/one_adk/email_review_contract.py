"""Closed specialist proposals; approval and effects remain with existing owners."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError


class _Closed(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class _Draft(_Closed):
    to: str = Field(min_length=1, max_length=2048)
    cc: str = Field(max_length=2048)
    bcc: str = Field(max_length=2048)
    subject: str = Field(max_length=256)
    body: str = Field(min_length=1, max_length=12_000)
    sourceMailRef: str | None = Field(default=None, pattern=r"^rs1\.[A-Za-z0-9_-]{16,2044}$")


class _DraftReview(_Closed):
    type: Literal["gmail.review_requested"]
    operation: Literal["send_email", "reply_to_thread"]
    draft: _Draft


class _Message(_Closed):
    subject: str | None = Field(max_length=512)
    sender: str | None = Field(max_length=1024)
    receivedAt: str | None = Field(max_length=256)


class _MailboxReview(_Closed):
    type: Literal["gmail.execute_mailbox_proposal"]
    proposalId: str = Field(pattern=r"^gmod_[A-Za-z0-9_-]{8,128}$")
    action: Literal["archive", "add_label", "remove_label", "mark_read", "mark_unread", "trash"]
    label: str | None = Field(max_length=256)
    summary: str = Field(min_length=1, max_length=512)
    confirmLabel: str = Field(min_length=1, max_length=80)
    expiresAt: str = Field(min_length=1, max_length=80)
    truncated: bool
    messages: list[_Message] = Field(min_length=1, max_length=25)


def valid_gmail_review(payload: dict) -> bool:
    try:
        if payload.get("type") == "gmail.review_requested":
            review = _DraftReview.model_validate(payload)
            return (review.operation == "reply_to_thread") == bool(review.draft.sourceMailRef)
        _MailboxReview.model_validate(payload)
        return True
    except ValidationError:
        return False
