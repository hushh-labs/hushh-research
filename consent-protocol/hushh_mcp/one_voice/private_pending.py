"""Seal first-party draft fields before storing a voice confirmation.

The pending-action table is a confirmation ledger, not a transcript store.
Only canonical references and an opaque, owner/conversation-bound ciphertext
may be persisted for a mail draft. The envelope is opened only when the exact
confirmed action executes.
"""

from __future__ import annotations

import base64
import json
import os
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from hushh_mcp.runtime_settings import get_core_security_settings

_PREFIX = "v1:"
_PURPOSE = b"one-voice-private-pending-v1"


def _key() -> bytes:
    secret = get_core_security_settings().app_signing_key
    if not secret:
        raise ValueError("voice pending draft key is unavailable")
    return HKDF(algorithm=SHA256(), length=32, salt=None, info=_PURPOSE).derive(
        secret.encode("utf-8")
    )


def _aad(*, owner_id: str, conversation_id: str, tool: str, public_args: dict[str, Any]) -> bytes:
    return json.dumps(
        {
            "owner": owner_id,
            "conversation": conversation_id,
            "tool": tool,
            "args": public_args,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def seal(
    private_args: dict[str, Any],
    *,
    owner_id: str,
    conversation_id: str,
    tool: str,
    public_args: dict[str, Any],
) -> str:
    nonce = os.urandom(12)
    plaintext = json.dumps(private_args, separators=(",", ":")).encode("utf-8")
    ciphertext = AESGCM(_key()).encrypt(
        nonce,
        plaintext,
        _aad(
            owner_id=owner_id,
            conversation_id=conversation_id,
            tool=tool,
            public_args=public_args,
        ),
    )
    return _PREFIX + base64.b64encode(nonce + ciphertext).decode("ascii")


def open_sealed(
    sealed: str,
    *,
    owner_id: str,
    conversation_id: str,
    tool: str,
    public_args: dict[str, Any],
) -> dict[str, Any]:
    if not isinstance(sealed, str) or not sealed.startswith(_PREFIX):
        raise ValueError("voice pending draft is unavailable")
    raw = base64.b64decode(sealed[len(_PREFIX) :], validate=True)
    if len(raw) < 29:
        raise ValueError("voice pending draft is invalid")
    plaintext = AESGCM(_key()).decrypt(
        raw[:12],
        raw[12:],
        _aad(
            owner_id=owner_id,
            conversation_id=conversation_id,
            tool=tool,
            public_args=public_args,
        ),
    )
    value = json.loads(plaintext)
    if not isinstance(value, dict):
        raise ValueError("voice pending draft is invalid")
    return value
