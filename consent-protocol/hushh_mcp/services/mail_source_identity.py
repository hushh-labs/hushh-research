"""Stable exact-message references from the Mail Overview contract.

The caller supplies its topology's custody key. Opening an identity never grants
provider access. The reader separately verifies the owner, mailbox and grant.
"""

import base64
import binascii
import hashlib
import hmac
import json
import re
from dataclasses import dataclass

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from hushh_mcp.services.gmail_metadata_reader import _ID

_PURPOSE = b"one-mail-overview-source-v1"
_REF_PREFIX = "ms1."
_REF_VERSION = 1
SOURCE_ID_PATTERN = r"^ms1\.[A-Za-z0-9_-]{16,2044}$"
_SOURCE_ID = re.compile(SOURCE_ID_PATTERN)


@dataclass(frozen=True)
class SourceRef:
    account: str
    message_id: str


def _derive(info: bytes, key: bytes) -> bytes:
    return HKDF(algorithm=SHA256(), length=32, salt=None, info=info).derive(key)


def _aad(owner_user_id: str) -> bytes:
    return _PURPOSE + b":" + owner_user_id.encode("utf-8")


def seal_source_id(*, key: bytes, owner_user_id: str, account: str, message_id: str) -> str:
    """The stable, opaque identity of one message in one owner's one Google account.

    The nonce is a keyed hash of the plaintext (a synthetic IV), so equal inputs
    give equal ids while distinct inputs never share a nonce. Equality is the
    only thing this reveals, and only to a holder of both ids.
    """
    if not _ID.fullmatch(message_id) or not account or not owner_user_id:
        raise ValueError("invalid_mail_source")
    payload = json.dumps(
        {"v": _REF_VERSION, "account": account, "message_id": message_id},
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    aad = _aad(owner_user_id)
    nonce = hmac.new(
        _derive(_PURPOSE + b":iv", key), aad + b"\x00" + payload, hashlib.sha256
    ).digest()[:12]
    sealed = AESGCM(_derive(_PURPOSE, key)).encrypt(nonce, payload, aad)
    return _REF_PREFIX + base64.urlsafe_b64encode(nonce + sealed).decode("ascii").rstrip("=")


def open_source_id(token: str, *, key: bytes, owner_user_id: str) -> SourceRef:
    """Authenticate an id for this owner. Tampered, foreign or malformed ids fail closed."""
    invalid = ValueError("invalid_mail_source")
    if not isinstance(token, str) or not _SOURCE_ID.fullmatch(token):
        raise invalid
    body = token[len(_REF_PREFIX) :]
    try:
        packed = base64.b64decode(body + "=" * (-len(body) % 4), altchars=b"-_", validate=True)
        if len(packed) < 12 + 16:
            raise ValueError("short")
        raw = AESGCM(_derive(_PURPOSE, key)).decrypt(packed[:12], packed[12:], _aad(owner_user_id))
        value = json.loads(raw)
    except (ValueError, TypeError, binascii.Error, InvalidTag):
        raise invalid from None
    if (
        not isinstance(value, dict)
        or value.get("v") != _REF_VERSION
        or not isinstance(value.get("account"), str)
        or not value["account"]
        or not isinstance(value.get("message_id"), str)
        or not _ID.fullmatch(value["message_id"])
    ):
        raise invalid
    return SourceRef(account=value["account"], message_id=value["message_id"])
