"""Reviewer session helper: mint a VAULT_OWNER bearer for a localhost driver.

Lifted from ``scripts/uat_kai_regression_smoke.py`` (``UatKaiSmoke.__init__``
config loading and ``UatKaiSmoke.authenticate``). That helper is a bound method
on a class whose module imports ``mcp``, ``sqlalchemy`` and the HCT export
modules at load time, so it cannot be imported by a lightweight driver without
paying for the whole smoke. The three steps are reproduced here verbatim in
intent, as small side-effect-free functions:

1. sign a Firebase custom token with the admin service account,
2. exchange it at identitytoolkit for a Firebase ID token,
3. POST ``/api/consent/vault-owner-token`` to issue the VAULT_OWNER token.

Secrets (the service-account key, the API key, the reviewer uid, the passphrase
and every token) are read from dotenv files and the process environment only.
Nothing in this module prints or logs them, and error messages carry HTTP
status codes rather than response bodies so a failure cannot echo a credential.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import jwt
import requests
from dotenv import dotenv_values

PROJECT_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PROJECT_ROOT.parent
DEFAULT_PROTOCOL_ENV = str(PROJECT_ROOT / ".env")
DEFAULT_WEB_ENV = str(REPO_ROOT / "hushh-webapp" / ".env.local")
DEFAULT_TIMEOUT = 45

REVIEWER_UID_KEY = "REVIEWER_UID"
REVIEWER_VAULT_PASSPHRASE_KEY = "REVIEWER_VAULT_PASSPHRASE"  # noqa: S105
FIREBASE_ADMIN_CREDENTIALS_KEY = "FIREBASE_ADMIN_CREDENTIALS_JSON"
FIREBASE_API_KEY_KEY = "NEXT_PUBLIC_FIREBASE_API_KEY"
IDENTITY_TOOLKIT_AUDIENCE = (
    "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit"
)
IDENTITY_TOOLKIT_SIGN_IN_URL = (
    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken"
)
VAULT_OWNER_TOKEN_PATH = "/api/consent/vault-owner-token"  # noqa: S105

# Every key the helper reads. Callers use this list to scrub printed output.
SECRET_ENV_KEYS: tuple[str, ...] = (
    REVIEWER_UID_KEY,
    REVIEWER_VAULT_PASSPHRASE_KEY,
    FIREBASE_ADMIN_CREDENTIALS_KEY,
    FIREBASE_API_KEY_KEY,
)


@dataclass(frozen=True)
class ReviewerConfig:
    """Inputs the reviewer login needs. Never printed, never logged."""

    user_id: str
    passphrase: str
    firebase_service_account: dict[str, Any]
    firebase_api_key: str


@dataclass(frozen=True)
class ReviewerSession:
    """The authenticated reviewer. Holds bearer material; treat as a secret."""

    user_id: str
    firebase_id_token: str
    vault_owner_token: str
    passphrase: str

    def vault_headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.vault_owner_token}"}


def _clean(value: Any) -> str:
    return str(value or "").strip()


def _non_empty_env_overlay(*keys: str) -> dict[str, str]:
    overlay: dict[str, str] = {}
    for key in keys:
        value = _clean(os.getenv(key))
        if value:
            overlay[key] = value
    return overlay


def _require(config: dict[str, Any], key: str) -> str:
    value = _clean(config.get(key))
    if not value:
        raise RuntimeError(f"Missing required config value: {key}")
    return value


def load_reviewer_config(
    *, protocol_env: str = DEFAULT_PROTOCOL_ENV, web_env: str = DEFAULT_WEB_ENV
) -> ReviewerConfig:
    """Merge the two dotenv files with a process-environment overlay.

    Precedence matches the smoke script: process environment wins over the
    webapp env file, which wins over the protocol env file. Missing files are
    tolerated so an operator can supply everything through the environment.
    """

    protocol_cfg = dotenv_values(protocol_env) if Path(protocol_env).is_file() else {}
    web_cfg = dotenv_values(web_env) if Path(web_env).is_file() else {}
    overlay_cfg = _non_empty_env_overlay(*SECRET_ENV_KEYS)
    config: dict[str, Any] = {**protocol_cfg, **web_cfg, **overlay_cfg}
    return ReviewerConfig(
        user_id=_require(config, REVIEWER_UID_KEY),
        # The chat transport only needs the VAULT_OWNER bearer. The passphrase
        # is carried for callers that later derive the vault key; it is optional.
        passphrase=_clean(config.get(REVIEWER_VAULT_PASSPHRASE_KEY)),
        firebase_service_account=json.loads(_require(config, FIREBASE_ADMIN_CREDENTIALS_KEY)),
        firebase_api_key=_require(config, FIREBASE_API_KEY_KEY),
    )


def mint_firebase_custom_token(
    service_account: dict[str, Any], user_id: str, *, now: int | None = None
) -> str:
    issued_at = int(now if now is not None else time.time())
    return jwt.encode(
        {
            "iss": service_account["client_email"],
            "sub": service_account["client_email"],
            "aud": IDENTITY_TOOLKIT_AUDIENCE,
            "uid": user_id,
            "iat": issued_at,
            "exp": issued_at + 3600,
        },
        service_account["private_key"],
        algorithm="RS256",
    )


def exchange_custom_token(
    custom_token: str,
    api_key: str,
    *,
    timeout: int = DEFAULT_TIMEOUT,
    session: requests.Session | None = None,
) -> str:
    http = session or requests
    response = http.post(
        IDENTITY_TOOLKIT_SIGN_IN_URL,
        params={"key": api_key},
        json={"token": custom_token, "returnSecureToken": True},
        timeout=timeout,
    )
    if response.status_code != 200:
        raise RuntimeError(f"Firebase custom-token exchange failed: HTTP {response.status_code}")
    id_token = _clean(response.json().get("idToken"))
    if not id_token:
        raise RuntimeError("Firebase custom-token exchange returned no idToken")
    return id_token


def issue_vault_owner_token(
    backend_url: str,
    firebase_id_token: str,
    user_id: str,
    *,
    timeout: int = DEFAULT_TIMEOUT,
    session: requests.Session | None = None,
) -> str:
    http = session or requests
    response = http.post(
        f"{backend_url.rstrip('/')}{VAULT_OWNER_TOKEN_PATH}",
        headers={
            "Authorization": f"Bearer {firebase_id_token}",
            "Content-Type": "application/json",
        },
        json={"userId": user_id},
        timeout=timeout,
    )
    if response.status_code != 200:
        raise RuntimeError(f"VAULT_OWNER token issuance failed: HTTP {response.status_code}")
    token = _clean(response.json().get("token"))
    if not token:
        raise RuntimeError("VAULT_OWNER token issuance returned no token")
    return token


def authenticate_reviewer(
    backend_url: str,
    *,
    config: ReviewerConfig | None = None,
    timeout: int = DEFAULT_TIMEOUT,
    session: requests.Session | None = None,
) -> ReviewerSession:
    """Run the three-step reviewer login and return the bearer material."""

    resolved = config or load_reviewer_config()
    custom_token = mint_firebase_custom_token(resolved.firebase_service_account, resolved.user_id)
    firebase_id_token = exchange_custom_token(
        custom_token, resolved.firebase_api_key, timeout=timeout, session=session
    )
    vault_owner_token = issue_vault_owner_token(
        backend_url, firebase_id_token, resolved.user_id, timeout=timeout, session=session
    )
    return ReviewerSession(
        user_id=resolved.user_id,
        firebase_id_token=firebase_id_token,
        vault_owner_token=vault_owner_token,
        passphrase=resolved.passphrase,
    )


def derive_reviewer_chat_key(
    backend_url: str, reviewer: ReviewerSession, *, http: requests.Session
) -> str:
    """Unlock the existing vault and derive its chat header in process memory."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

    if not reviewer.passphrase:
        raise RuntimeError("Reviewer vault passphrase is required for chat")
    response = http.post(
        backend_url.rstrip("/") + "/db/vault/get",
        headers={"Authorization": "Bearer " + reviewer.firebase_id_token},
        json={"userId": reviewer.user_id},
        timeout=DEFAULT_TIMEOUT,
    )
    if response.status_code != 200:
        response.close()
        raise RuntimeError(f"Reviewer vault read failed: HTTP {response.status_code}")
    try:
        payload = response.json()
        wrapper = next(
            (w for w in payload.get("wrappers", []) if w.get("method") == "passphrase"),
            None,
        )
        if wrapper is None:
            raise RuntimeError("Reviewer vault has no passphrase wrapper")

        def decode(value: str) -> bytes:
            return base64.b64decode(value, validate=True)

        key = PBKDF2HMAC(
            algorithm=hashes.SHA256(), length=32, salt=decode(wrapper["salt"]), iterations=100000
        ).derive(reviewer.passphrase.encode("utf-8"))
        vault_key = AESGCM(key).decrypt(
            decode(wrapper["iv"]), decode(wrapper["encryptedVaultKey"]), None
        )
        if len(vault_key) != 32:
            raise RuntimeError("Reviewer vault key has invalid bounds")
        expected_hash = payload.get("vaultKeyHash")
        if expected_hash and not any(
            hmac.compare_digest(expected_hash, digest)
            for digest in (
                hashlib.sha256(vault_key).hexdigest(),
                hashlib.sha256(vault_key.hex().encode("utf-8")).hexdigest(),
            )
        ):
            raise RuntimeError("Reviewer vault key integrity verification failed")
        chat_key = HKDF(
            algorithm=hashes.SHA256(), length=32, salt=b"", info=b"hussh-one-chat-v1"
        ).derive(vault_key)
        return "hck1." + chat_key.hex()
    except (KeyError, ValueError, TypeError):
        raise RuntimeError("Reviewer vault wrapper is invalid") from None
    finally:
        response.close()


REDACTED = "[redacted]"


class Printer:
    """Prints lines after replacing every known secret value.

    Belt and braces: the driver already prints only ids and milliseconds, but
    a scrubbed writer means a future format string cannot leak a bearer.
    """

    def __init__(self, secret_values: Iterable[str]) -> None:
        self._secrets = sorted(
            {s for s in secret_values if s and len(s) >= 4}, key=len, reverse=True
        )

    def add(self, *values: str) -> None:
        self._secrets = sorted(
            {*self._secrets, *(v for v in values if v and len(v) >= 4)}, key=len, reverse=True
        )

    def scrub(self, text: str) -> str:
        for secret in self._secrets:
            text = text.replace(secret, REDACTED)
        return text

    def __call__(self, text: str) -> None:
        print(self.scrub(text))


def secret_values_of(config: ReviewerConfig) -> list[str]:
    values = [config.user_id, config.passphrase, config.firebase_api_key]
    for key in ("private_key", "client_email", "private_key_id", "client_id"):
        value = config.firebase_service_account.get(key)
        if isinstance(value, str):
            values.append(value)
    return [v for v in values if v]
