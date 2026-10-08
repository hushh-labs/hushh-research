"""Azure custody of the pod's log key: wrapped by the person's own Key Vault key.

The Azure twin of the GCP path in ``byoc_key_custody``, with the same promises:

1. The 32-byte data key (DEK) is minted **once, by the pod, on its first boot**.
2. It is wrapped **locally** with the Key Vault key's RSA public key
   (``RSA-OAEP-256``), then proven: the pod asks Key Vault to unwrap it and
   compares, so a key the pod could never open again is never stored.
3. The wrapped form is written **create-only** to the person's own blob container.
   A lost race adopts the winner's key; a read failure other than absence refuses
   rather than minting, because a second key would start a second history and
   present it as the same agent. So does absence after a crypto-erase
   (``pod_crypto_erase`` leaves a tombstone): an erased agent never boots again.
4. Later boots unwrap through Key Vault (``POST {key}/unwrapkey``, api-version 7.4).

The pod's identity holds ``Key Vault Crypto Service Encryption User`` at key scope
only (measured: public key read and unwrap allowed, sign refused). Hussh holds no
Key Vault role at all, so it can build the vault and provably cannot open the key.
"""

from __future__ import annotations

import base64
import hmac
import json
import logging
import os
import re
import urllib.parse
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from hushh_mcp.services.byoc_key_custody import (
    KEY_VAULT_KEY_ENV,
    WRAPPED_KEY_OBJECT_ENV,
    WRAPPED_LOG_KEY_OBJECT,
    ByocKeyCustodyError,
    generate_dek,
)
from hushh_mcp.services.pod_object_version import ABSENT
from hushh_mcp.services.pod_workload_identity import get_workload_token

logger = logging.getLogger(__name__)

BLOB_URL_ENV = "POD_STORAGE_AZURE_BLOB_URL"
_API_VERSION = "7.4"
_ALG = "RSA-OAEP-256"
_ENVELOPE_VERSION = 1
_DEK_LEN = 32
_MIN_RSA_BITS = 2048
_TIMEOUT_SECONDS = 60
# Vault host suffix -> the token resource for that cloud.
_VAULT_CLOUDS = {
    ".vault.azure.net": "https://vault.azure.net",
    ".vault.usgovcloudapi.net": "https://vault.usgovcloudapi.net",
}
_KEY_PATH = re.compile(r"/keys/([A-Za-z0-9-]{1,127})/([0-9a-f]{32})")
_VAULT_NAME = re.compile(r"[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,23}")


class PodKeyVaultCustodyError(ByocKeyCustodyError):
    """Key Vault custody refused. Never soft-failed, never carries provider bodies."""


@dataclass(frozen=True)
class KeyVaultKey:
    key_id: str  # https://<vault>.vault.azure.net/keys/<name>/<version>
    resource: str  # the token audience for that vault's cloud


def key_vault_custody_configured() -> bool:
    return bool((os.getenv(KEY_VAULT_KEY_ENV) or "").strip())


def parse_key_vault_key(value: str) -> KeyVaultKey:
    """A versioned key id. The version is required: it is what the DEK is wrapped to."""
    parsed = urllib.parse.urlsplit(str(value or "").strip())
    host = (parsed.hostname or "").lower()
    suffix = next((s for s in _VAULT_CLOUDS if host.endswith(s)), "")
    if (
        parsed.scheme != "https"
        or not suffix
        or ":" in parsed.netloc
        or "@" in parsed.netloc
        or parsed.query
        or parsed.fragment
        or not _VAULT_NAME.fullmatch(host[: -len(suffix)])
        or not _KEY_PATH.fullmatch(parsed.path)
    ):
        raise PodKeyVaultCustodyError(f"{KEY_VAULT_KEY_ENV} is not a versioned Key Vault key id")
    return KeyVaultKey(key_id=f"https://{host}{parsed.path}", resource=_VAULT_CLOUDS[suffix])


def _b64url_decode(value: Any) -> bytes:
    if not isinstance(value, str) or not value:
        raise ValueError("missing value")
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


class _Vault:
    """The three Key Vault calls custody needs, as the pod's own identity."""

    def __init__(self, key: KeyVaultKey, session: Any, token_provider: Callable[[str], str]):
        self._key, self._session, self._token_provider = key, session, token_provider

    def _call(self, method: str, url: str, **kwargs: Any) -> dict[str, Any]:
        headers = {"Authorization": f"Bearer {self._token_provider(self._key.resource)}"}
        try:
            response = getattr(self._session, method)(
                url,
                params={"api-version": _API_VERSION},
                headers=headers,
                timeout=_TIMEOUT_SECONDS,
                allow_redirects=False,
                **kwargs,
            )
            status = getattr(response, "status_code", 0)
            body = response.json() if status == 200 else None
        except Exception:  # noqa: BLE001 - transport errors can embed tokens and bodies
            raise PodKeyVaultCustodyError("Key Vault request unavailable") from None
        if status != 200 or not isinstance(body, dict):
            raise PodKeyVaultCustodyError(f"Key Vault refused the request ({status})")
        return body

    def wrap_locally(self, dek: bytes) -> bytes:
        from cryptography.hazmat.primitives import hashes  # noqa: PLC0415
        from cryptography.hazmat.primitives.asymmetric import padding, rsa  # noqa: PLC0415

        jwk = self._call("get", self._key.key_id).get("key")
        try:
            if (
                not isinstance(jwk, dict)
                or jwk.get("kid") != self._key.key_id
                or jwk.get("kty") not in ("RSA", "RSA-HSM")
                or "unwrapKey" not in (jwk.get("key_ops") or ["unwrapKey"])
            ):
                raise ValueError("key shape")
            public = rsa.RSAPublicNumbers(
                int.from_bytes(_b64url_decode(jwk.get("e")), "big"),
                int.from_bytes(_b64url_decode(jwk.get("n")), "big"),
            ).public_key()
            if public.key_size < _MIN_RSA_BITS:
                raise ValueError("key size")
        except Exception:  # noqa: BLE001 - a key we cannot wrap to is a refusal
            raise PodKeyVaultCustodyError("the Key Vault key cannot wrap the log key") from None
        oaep = padding.OAEP(
            mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None
        )
        return public.encrypt(dek, oaep)

    def unwrap(self, wrapped: bytes) -> bytes:
        body = self._call(
            "post", f"{self._key.key_id}/unwrapkey", json={"alg": _ALG, "value": _b64url(wrapped)}
        )
        try:
            if body.get("kid", self._key.key_id) != self._key.key_id:
                raise ValueError("kid")
            dek = _b64url_decode(body.get("value"))
        except Exception:  # noqa: BLE001 - malformed responses never disclose material
            raise PodKeyVaultCustodyError("Key Vault unwrap response invalid") from None
        if len(dek) != _DEK_LEN:
            raise PodKeyVaultCustodyError("the unwrapped log key is not 32 bytes")
        return dek


def _envelope(key: KeyVaultKey, wrapped: bytes) -> bytes:
    body = {"alg": _ALG, "kid": key.key_id, "v": _ENVELOPE_VERSION, "value": _b64url(wrapped)}
    return json.dumps(body, sort_keys=True, separators=(",", ":")).encode()


def _opened(key: KeyVaultKey, stored: bytes, vault: _Vault) -> bytes:
    """Unwrap a stored envelope, refusing one wrapped to any other key version."""
    try:
        envelope = json.loads(stored)
        if (
            not isinstance(envelope, dict)
            or set(envelope) != {"alg", "kid", "v", "value"}
            or envelope["alg"] != _ALG
            or envelope["v"] != _ENVELOPE_VERSION
        ):
            raise ValueError("shape")
        wrapped = _b64url_decode(envelope["value"])
    except Exception:  # noqa: BLE001 - never mint over an unreadable stored key
        raise PodKeyVaultCustodyError("the stored wrapped log key is malformed") from None
    if envelope["kid"] != key.key_id:
        raise PodKeyVaultCustodyError("the stored log key is wrapped to a different key version")
    return vault.unwrap(wrapped)


def _wrap_and_prove(dek: bytes, key: KeyVaultKey, vault: _Vault) -> bytes:
    """Wrap locally, then prove Key Vault opens it, before anything is stored."""
    wrapped = vault.wrap_locally(dek)
    if not hmac.compare_digest(vault.unwrap(wrapped), dek):
        raise PodKeyVaultCustodyError("Key Vault did not return the key it was given")
    return _envelope(key, wrapped)


def _refuse_after_erasure(store: Any) -> None:
    """An erased agent's missing key is not a first boot: never mint a second history."""
    from hushh_mcp.services.pod_crypto_erase import ERASURE_TOMBSTONE_OBJECT  # noqa: PLC0415

    if store.get_with_generation_blocking(ERASURE_TOMBSTONE_OBJECT)[0] is not None:
        raise PodKeyVaultCustodyError("this agent was erased; refusing to mint a replacement key")


def resolve_key_vault_log_key(
    *,
    store: Any = None,
    session: Any = None,
    token_provider: Callable[[str], str] | None = None,
) -> bytes:
    """The pod's log DEK under Key Vault custody: unwrap it, or mint it exactly once."""
    key = parse_key_vault_key(os.getenv(KEY_VAULT_KEY_ENV) or "")
    obj = (os.getenv(WRAPPED_KEY_OBJECT_ENV) or WRAPPED_LOG_KEY_OBJECT).strip()
    if session is None:
        import requests  # type: ignore[import-untyped]  # noqa: PLC0415

        session = requests
    if token_provider is None:  # the pod's own identity, over the same egress session

        def token_provider(resource: str) -> str:
            return get_workload_token(resource, session=session)

    if store is None:
        from hushh_mcp.services.pod_azure_blob_store import AzureBlobObjectStore  # noqa: PLC0415

        blob_url = (os.getenv(BLOB_URL_ENV) or "").strip()
        if not blob_url:
            raise PodKeyVaultCustodyError(f"Key Vault custody needs {BLOB_URL_ENV}")
        store = AzureBlobObjectStore(blob_url, session=session)
    vault = _Vault(key, session, token_provider)
    # Absence is the only answer that may mint. A refused or failed read raises here.
    stored, _ = store.get_with_generation_blocking(obj)
    if stored is not None:
        return _opened(key, stored, vault)
    _refuse_after_erasure(store)
    dek = generate_dek()
    if store.put_if_generation_blocking(obj, _wrap_and_prove(dek, key, vault), ABSENT) is not None:
        logger.info("key_vault_custody.log_key_created")
        return dek
    # Lost the first-boot race: the other boot's key is the agent's key now.
    logger.info("key_vault_custody.log_key_race_lost")
    winner, _ = store.get_with_generation_blocking(obj)
    if winner is None:
        raise PodKeyVaultCustodyError("another boot claimed the log key, then it could not be read")
    return _opened(key, winner, vault)


__all__ = [
    "KEY_VAULT_KEY_ENV",
    "KeyVaultKey",
    "PodKeyVaultCustodyError",
    "key_vault_custody_configured",
    "parse_key_vault_key",
    "resolve_key_vault_log_key",
]
