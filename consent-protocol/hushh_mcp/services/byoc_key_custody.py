"""BYOC key custody: the pod's log key is wrapped by the USER'S OWN KMS key.

WHY THIS EXISTS SEPARATELY FROM ``pod_key_custody``
---------------------------------------------------
The managed tier derives every pod's keys with HKDF from one hushh-held master
(``pod_key_custody``). That is a deliberate, bounded trade: whoever holds the master
can re-derive any managed pod's keys, which is acceptable only because the managed
tier is an internal development and validation environment.

BYOC is the production path and does not get to make that trade. The whole promise is
that the compute and the storage are the user's, so the key that seals their history
must be one hushh cannot reconstruct. Here there is no master and no derivation:

1. A random 32-byte data key (DEK) is generated **once**, at bootstrap.
2. It is encrypted by the user's own KMS key (``one-pod-<slug>-key``, created in the
   user's project by ``render_bootstrap_plan``) and the WRAPPED form is stored in the
   user's own bucket. The plaintext is discarded immediately.
3. At boot the pod unwraps it with the KMS ``decrypt`` permission the bootstrap grants
   its service account -- ``roles/cloudkms.cryptoKeyDecrypter`` on that key, and
   nothing else. See ``UserGcpBackend.render_bootstrap_plan``'s ``iam`` block.

So hushh's consent plane never holds the plaintext DEK, and the pod never holds the
KMS key. Revoking the pod's decrypter binding makes every future boot unable to read
the history, without touching a single stored byte.

WHY NOT PASS THE KEY IN THE POD'S ENVIRONMENT, AS THE MANAGED TIER DOES
-----------------------------------------------------------------------
A Cloud Run environment variable is readable by anyone who can describe the service.
In the managed tier that is hushh, which already holds the master, so it discloses
nothing new. In the user's project it would mean the plaintext key sat in a service
description in *their* cloud, readable by every project viewer -- turning a key that
was supposed to need KMS into one that needs only ``run.services.get``. The wrapped
DEK in a bucket plus a decrypt permission is strictly tighter, and it is the standard
envelope pattern rather than an invention.
"""

from __future__ import annotations

import base64
import logging
import os
import secrets
from typing import Any, Optional

logger = logging.getLogger(__name__)

_KEY_LEN = 32

#: Where the wrapped DEK lives inside the user's own bucket. One object, one pod.
WRAPPED_LOG_KEY_OBJECT = "keys/log-key.wrapped"

#: Env names the pod reads to find its key material. These carry LOCATIONS, never the
#: key: the KMS resource to decrypt with and the object to decrypt.
KMS_KEY_ENV = "HUSSH_POD_KMS_KEY"
WRAPPED_KEY_OBJECT_ENV = "HUSSH_POD_WRAPPED_LOG_KEY_OBJECT"


class ByocKeyCustodyError(RuntimeError):
    """Key material could not be created, wrapped, or opened. Never soft-failed."""


def _kms_endpoint(kms_key: str, verb: str) -> str:
    return f"https://cloudkms.googleapis.com/v1/{kms_key}:{verb}"


def generate_dek() -> bytes:
    """A fresh 32-byte data key. Generated once, at bootstrap, and never regenerated.

    Regenerating it would not rotate anything -- it would orphan every record already
    sealed under the previous one. Rotation of a commit-log key is a re-encryption
    problem, not a key-generation problem, and is deliberately not offered here.
    """
    return secrets.token_bytes(_KEY_LEN)


def wrap_dek(dek: bytes, *, kms_key: str, session: Any, token: str) -> bytes:
    """Encrypt the DEK under the user's KMS key. Returns the ciphertext to store.

    ``session`` and ``token`` are injected rather than resolved here so this module
    stays free of any opinion about whose credential is in play -- at bootstrap it is
    a short-lived impersonated token in the user's project; in a pod it is the pod's
    own identity. Same code, different caller.
    """
    if len(dek) != _KEY_LEN:
        raise ByocKeyCustodyError(f"the log DEK must be exactly {_KEY_LEN} bytes")
    response = session.post(
        _kms_endpoint(kms_key, "encrypt"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"plaintext": base64.b64encode(dek).decode("ascii")},
        timeout=60,
    )
    if response.status_code != 200:
        raise ByocKeyCustodyError(
            f"KMS wrap failed ({response.status_code}); the pod would boot without a "
            f"key it can prove is the user's: {response.text[:200]}"
        )
    return base64.b64decode(response.json()["ciphertext"])


def unwrap_dek(wrapped: bytes, *, kms_key: str, session: Any, token: str) -> bytes:
    """Open the wrapped DEK. Raises rather than returning anything on failure.

    A pod that cannot unwrap its key must not continue with a fresh one: that would
    silently start a second history beside the first and present it as the same agent.
    """
    response = session.post(
        _kms_endpoint(kms_key, "decrypt"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"ciphertext": base64.b64encode(wrapped).decode("ascii")},
        timeout=60,
    )
    if response.status_code != 200:
        raise ByocKeyCustodyError(
            f"KMS unwrap failed ({response.status_code}); refusing to run with a "
            f"substitute key: {response.text[:200]}"
        )
    dek = base64.b64decode(response.json()["plaintext"])
    if len(dek) != _KEY_LEN:
        raise ByocKeyCustodyError("the unwrapped log DEK is not 32 bytes")
    return dek


def byoc_key_env(*, kms_key: str, bucket_object: str = WRAPPED_LOG_KEY_OBJECT) -> list[dict[str, str]]:
    """The env a BYOC pod gets INSTEAD of a plaintext key: two addresses, no secret.

    Contrast with the managed tier's ``_durable_state_env``, which ships
    ``HUSSH_POD_LOG_KEY`` directly. Here the pod is told where its key is and given
    permission to open it; the key itself never appears in the service description.
    """
    return [
        {"name": KMS_KEY_ENV, "value": kms_key},
        {"name": WRAPPED_KEY_OBJECT_ENV, "value": bucket_object},
    ]


def byoc_custody_configured() -> bool:
    """Is this process a BYOC pod that should unwrap rather than read its key?"""
    return bool((os.getenv(KMS_KEY_ENV) or "").strip())


def resolve_pod_log_key(*, session: Any = None, token: Optional[str] = None) -> bytes:
    """The pod's log key, whichever custody model it was provisioned under.

    Managed pods read ``HUSSH_POD_LOG_KEY``; BYOC pods unwrap from KMS. Resolving both
    behind one call is what lets the rest of the pod -- the commit log, the memory
    service -- stay identical across tiers, which is the parity the managed tier
    exists to rehearse.
    """
    if not byoc_custody_configured():
        from hushh_mcp.services.pod_commit_log import log_key_from_env  # noqa: PLC0415

        return log_key_from_env()

    kms_key = (os.getenv(KMS_KEY_ENV) or "").strip()
    obj = (os.getenv(WRAPPED_KEY_OBJECT_ENV) or WRAPPED_LOG_KEY_OBJECT).strip()
    bucket = (os.getenv("POD_STORAGE_GCS_BUCKET") or "").strip()
    if not bucket:
        raise ByocKeyCustodyError(
            "BYOC custody needs POD_STORAGE_GCS_BUCKET to find the wrapped key"
        )

    if session is None:
        import requests as session  # noqa: PLC0415

    if token is None:
        token = _metadata_token(session)

    import urllib.parse  # noqa: PLC0415

    quoted = urllib.parse.quote(obj, safe="")
    response = session.get(
        f"https://storage.googleapis.com/storage/v1/b/{bucket}/o/{quoted}",
        params={"alt": "media"},
        headers={"Authorization": f"Bearer {token}"},
        timeout=60,
    )
    if getattr(response, "status_code", 0) != 200:
        raise ByocKeyCustodyError(
            f"the wrapped log key is missing from gs://{bucket}/{obj} "
            f"({getattr(response, 'status_code', '?')}) -- bootstrap did not complete"
        )
    return unwrap_dek(response.content, kms_key=kms_key, session=session, token=token)


def _metadata_token(session: Any) -> str:
    """The pod's OWN identity, from the metadata server. An address, not a secret."""
    response = session.get(
        "http://metadata.google.internal/computeMetadata/v1/instance"
        "/service-accounts/default/token",
        headers={"Metadata-Flavor": "Google"},
        timeout=10,
    )
    return str(response.json()["access_token"])


__all__ = [
    "ByocKeyCustodyError",
    "KMS_KEY_ENV",
    "WRAPPED_KEY_OBJECT_ENV",
    "WRAPPED_LOG_KEY_OBJECT",
    "byoc_custody_configured",
    "byoc_key_env",
    "generate_dek",
    "resolve_pod_log_key",
    "unwrap_dek",
    "wrap_dek",
]
