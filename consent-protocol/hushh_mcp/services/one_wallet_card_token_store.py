"""Owner-only recovery of Wallet Profile links; public lookup stays hash-based.

Uses the deployed credential encryption primitive with a wallet-specific AAD
bound to the owner and current token digest. Ciphertext is never projected to
either owner/public responses. Legacy hash-only rows remain valid.
"""

from __future__ import annotations

import json
import os
from typing import Any

from hushh_mcp.services.external_connector_credentials_service import (
    ExternalConnectorCredentialsService,
)


def _aad(user_id: str, token_hash: str) -> str:
    return json.dumps(["one-wallet-card-v1", user_id, token_hash], separators=(",", ":"))


def seal_share_token(
    *, db: Any, user_id: str, token_hash: str, token: str
) -> dict[str, str] | None:
    # Existing installs without the key retain the legacy hash-only behavior.
    # UAT/prod already bind this key for connected services.
    if not str(os.getenv("EXTERNAL_CONNECTOR_CREDENTIAL_KEY") or "").strip():
        return None
    return ExternalConnectorCredentialsService(db=db).encrypt_secret(
        token, aad=_aad(user_id, token_hash)
    )


def open_share_token(*, db: Any, user_id: str, token_hash: str, envelope: Any) -> str | None:
    if not isinstance(envelope, dict):
        return None
    try:
        return ExternalConnectorCredentialsService(db=db).decrypt_secret(
            ciphertext=str(envelope["ciphertext"]),
            iv=str(envelope["iv"]),
            aad=_aad(user_id, token_hash),
        )
    except Exception:
        # Legacy/missing-key/corrupt ciphertext must never rotate a live link.
        return None
