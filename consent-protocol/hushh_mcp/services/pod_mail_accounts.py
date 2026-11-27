"""Account identity and selection inside the owner's existing connector log.

The legacy Gmail slot remains the default. Additional mailboxes have separate
slots; public account IDs never contain email addresses or provider subjects.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any, Mapping

ACCOUNT_ID = re.compile(r"^[a-f0-9]{32}$")
MAX_ACCOUNTS = 20


def credential_key(connector_id: str, account_id: str = "") -> str:
    if account_id and (connector_id != "gmail" or not ACCOUNT_ID.fullmatch(account_id)):
        raise ValueError("invalid mailbox slot")
    return f"{connector_id}:{account_id}" if account_id else connector_id


def public_account_id(credential: Any) -> str:
    return (
        credential.account_id
        or hashlib.sha256(f"google:gmail:{credential.account_subject}".encode()).hexdigest()[:32]
    )


def find_account(current: Mapping[str, Any], account_id: str) -> Any:
    return next(
        (
            item
            for item in current.values()
            if item.connector_id == "gmail" and public_account_id(item) == account_id
        ),
        None,
    )


def _unique_credential(mailboxes: list, opened: Any, previous: Any) -> None:
    if any(
        item is not previous and item.credential_id == opened.credential_id for item in mailboxes
    ):
        raise ValueError("MAIL_ACCOUNT_CHANGED")


def connection_slot(current: Mapping[str, Any], opened: Any, subject: str) -> tuple[str, Any]:
    """Resolve only from verified identity, inside the log's compare-and-set."""
    mailboxes = [item for item in current.values() if item.connector_id == "gmail"]
    if opened.mail_account is None:
        previous = current.get(opened.connector_id)
        if opened.connector_id == "gmail" and any(
            item.account_subject == subject and item is not previous for item in mailboxes
        ):
            raise ValueError("MAIL_ACCOUNT_ALREADY_CONNECTED")
        if opened.connector_id == "gmail":
            _unique_credential(mailboxes, opened, previous)
        return "", previous
    intent = opened.mail_account
    if intent["mode"] == "reconnect":
        previous = find_account(current, intent["accountId"])
        if previous is None or previous.credential_id != intent["credentialId"]:
            raise ValueError("MAIL_ACCOUNT_CHANGED")
        if previous.account_subject != subject:
            raise ValueError("MAIL_ACCOUNT_MISMATCH")
        _unique_credential(mailboxes, opened, previous)
        return previous.account_id, previous
    if any(item.account_subject == subject for item in mailboxes):
        raise ValueError("MAIL_ACCOUNT_ALREADY_CONNECTED")
    _unique_credential(mailboxes, opened, None)
    if len(mailboxes) >= MAX_ACCOUNTS:
        raise ValueError("MAIL_ACCOUNT_LIMIT")
    # Preserve the old default service for existing tools; never select a new
    # account globally when another mailbox is already held.
    account_id = hashlib.sha256(f"google:gmail:{subject}".encode()).hexdigest()[:32]
    return (account_id if current.get("gmail") is not None else ""), None
