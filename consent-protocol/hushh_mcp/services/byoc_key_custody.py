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

1. A random 32-byte data key (DEK) is generated **once, by the pod itself, on its first
   boot** -- not by hushh's bootstrap. See the note below; this was corrected after a
   live run proved the earlier design could not work.
2. It is encrypted by the user's own KMS key (``one-pod-<slug>-key``, created in the
   user's project by ``render_bootstrap_plan``) and the WRAPPED form is stored in the
   user's own bucket. The plaintext never leaves the pod.
3. At every later boot the pod unwraps it with the KMS permissions the bootstrap grants
   its service account -- ``cryptoKeyEncrypter`` and ``cryptoKeyDecrypter`` on that one
   key, and nothing else. See ``UserGcpBackend.render_bootstrap_plan``'s ``iam`` block.

So hushh's consent plane never holds the plaintext DEK, and the pod never holds the
KMS key. Revoking the pod's decrypter binding makes every future boot unable to read
the history, without touching a single stored byte.

WHY THE POD WRAPS ITS OWN KEY, AND HOW THAT WAS FOUND
-----------------------------------------------------
This module used to say the DEK was generated and wrapped "at bootstrap", by hushh's
short-lived impersonated token. Running it against a real project (``hushh-byoc-test``,
2026-08-08) returned::

    403 Permission 'cloudkms.cryptoKeyVersions.useToEncrypt' denied

The bootstrap account holds ``roles/cloudkms.admin`` -- it may *create and administer*
the key -- and deliberately holds neither encrypter nor decrypter on it, so it cannot
*use* it. The documented flow was therefore impossible, and the fix was not to widen
the bootstrap's permission: doing so would have put the plaintext DEK in hushh's hands
at wrap time, which is the exact thing this file exists to prevent.

Moving generation into the pod makes the Zero-Knowledge claim enforced by IAM rather
than asserted by convention. Hushh's applier can build the key and provably cannot
open it, and that is now a property of the policy the bootstrap writes.

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
#: Azure: the versioned Key Vault key the DEK is wrapped to (``pod_key_vault_custody``).
KEY_VAULT_KEY_ENV = "HUSSH_POD_KEY_VAULT_KEY"


class ByocKeyCustodyError(RuntimeError):
    """Key material could not be created, wrapped, or opened. Never soft-failed."""


def _kms_endpoint(kms_key: str, verb: str) -> str:
    from hushh_mcp.services.pod_emulator_endpoints import (  # noqa: PLC0415
        PodEmulatorEndpointError,
        resolve_gcp_kms_origin,
    )

    try:
        origin, _ = resolve_gcp_kms_origin()
    except PodEmulatorEndpointError as exc:
        raise ByocKeyCustodyError(str(exc)) from None
    return f"{origin}/v1/{kms_key}:{verb}"


def _gcs_origin() -> tuple[str, bool]:
    from hushh_mcp.services.pod_emulator_endpoints import (  # noqa: PLC0415
        PodEmulatorEndpointError,
        resolve_gcp_storage_origin,
    )

    try:
        return resolve_gcp_storage_origin()
    except PodEmulatorEndpointError as exc:
        raise ByocKeyCustodyError(str(exc)) from None


def _custody_request(session: Any, method: str, url: str, **kwargs: Any) -> Any:
    try:
        return getattr(session, method)(url, allow_redirects=False, **kwargs)
    except Exception:  # noqa: BLE001 - transport errors can embed credentials and request bodies
        raise ByocKeyCustodyError("key custody request unavailable") from None


def _decode_key_response(response: Any, field: str) -> bytes:
    try:
        encoded = response.json()[field]
        if not isinstance(encoded, str) or not encoded:
            raise ValueError("missing key material")
        return base64.b64decode(encoded, validate=True)
    except Exception:  # noqa: BLE001 - malformed responses must not disclose key material
        raise ByocKeyCustodyError("key custody response invalid") from None


def generate_dek() -> bytes:
    """A fresh 32-byte data key. Generated once, by the pod, and never regenerated.

    Regenerating it would not rotate anything -- it would orphan every record already
    sealed under the previous one. Rotation of a commit-log key is a re-encryption
    problem, not a key-generation problem, and is deliberately not offered here.
    """
    return secrets.token_bytes(_KEY_LEN)


def wrap_dek(
    dek: bytes,
    *,
    kms_key: str,
    session: Any,
    token: str,
    aad: Optional[bytes] = None,
) -> bytes:
    """Encrypt the DEK under the user's KMS key. Returns the ciphertext to store.

    ``session`` and ``token`` are injected rather than resolved here so this module
    stays free of any opinion about whose credential is in play. In production the
    caller is always the pod, using its own identity from the metadata server -- the
    only principal in the whole system that holds encrypt on this key.
    """
    if len(dek) != _KEY_LEN:
        raise ByocKeyCustodyError(f"the log DEK must be exactly {_KEY_LEN} bytes")
    body: dict[str, str] = {"plaintext": base64.b64encode(dek).decode("ascii")}
    if aad is not None:
        body["additionalAuthenticatedData"] = base64.b64encode(aad).decode("ascii")
    response = _custody_request(
        session,
        "post",
        _kms_endpoint(kms_key, "encrypt"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json=body,
        timeout=60,
    )
    if response.status_code != 200:
        raise ByocKeyCustodyError(
            f"KMS wrap failed ({response.status_code}); the pod would boot without a "
            "key it can prove is the user's"
        )
    return _decode_key_response(response, "ciphertext")


def unwrap_dek(
    wrapped: bytes,
    *,
    kms_key: str,
    session: Any,
    token: str,
    aad: Optional[bytes] = None,
) -> bytes:
    """Open the wrapped DEK. Raises rather than returning anything on failure.

    A pod that cannot unwrap its key must not continue with a fresh one: that would
    silently start a second history beside the first and present it as the same agent.
    """
    body: dict[str, str] = {"ciphertext": base64.b64encode(wrapped).decode("ascii")}
    if aad is not None:
        body["additionalAuthenticatedData"] = base64.b64encode(aad).decode("ascii")
    response = _custody_request(
        session,
        "post",
        _kms_endpoint(kms_key, "decrypt"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json=body,
        timeout=60,
    )
    if response.status_code != 200:
        raise ByocKeyCustodyError(
            f"KMS unwrap failed ({response.status_code}); refusing to run with a substitute key"
        )
    dek = _decode_key_response(response, "plaintext")
    if len(dek) != _KEY_LEN:
        raise ByocKeyCustodyError("the unwrapped log DEK is not 32 bytes")
    return dek


def byoc_key_env(
    *, kms_key: str, bucket_object: str = WRAPPED_LOG_KEY_OBJECT
) -> list[dict[str, str]]:
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
    """Is this process a BYOC, ACE envelope, or Hub-brokered pod that unwraps rather than reading env?"""
    from hushh_mcp.services.compute_backend import (  # noqa: PLC0415
        CUSTODY_ACE_ENVELOPE,
        CUSTODY_HUB_BROKER,
        CUSTODY_OWNER_KMS,
        CUSTODY_OWNER_VAULT,
    )
    from hushh_mcp.services.pod_custody_port import (  # noqa: PLC0415
        CUSTODY_MODE_ENV,
        ace_custody_configured,
    )

    explicit = (os.getenv(CUSTODY_MODE_ENV) or "").strip()
    if explicit in {
        CUSTODY_OWNER_KMS,
        CUSTODY_OWNER_VAULT,
        CUSTODY_ACE_ENVELOPE,
        CUSTODY_HUB_BROKER,
    }:
        return True
    return bool(
        (os.getenv(KMS_KEY_ENV) or os.getenv(KEY_VAULT_KEY_ENV) or "").strip()
        or ace_custody_configured()
    )


def _refuse_gcs_after_erasure(*, bucket: str, session: Any, token: str, gcs_origin: str) -> None:
    """Refuse to mint a replacement DEK in GCS after pod crypto-erasure."""
    import urllib.parse  # noqa: PLC0415

    from hushh_mcp.services.pod_crypto_erase import ERASURE_TOMBSTONE_OBJECT  # noqa: PLC0415

    quoted_tombstone = urllib.parse.quote(ERASURE_TOMBSTONE_OBJECT, safe="")
    probe = _custody_request(
        session,
        "get",
        f"{gcs_origin}/storage/v1/b/{bucket}/o/{quoted_tombstone}",
        params={"alt": "media"},
        headers={"Authorization": f"Bearer {token}"},
        timeout=60,
    )
    probe_status = getattr(probe, "status_code", 0)
    if probe_status == 200:
        raise ByocKeyCustodyError("this agent was erased; refusing to mint a replacement key")
    if probe_status != 404:
        raise ByocKeyCustodyError(
            f"the erasure tombstone could not be checked ({probe_status}); refusing to mint"
        )


def _resolve_gcp_kms_log_key(
    *, session: Any = None, token: Optional[str] = None, store: Any = None
) -> bytes:
    kms_key = (os.getenv(KMS_KEY_ENV) or "").strip()
    obj = (os.getenv(WRAPPED_KEY_OBJECT_ENV) or WRAPPED_LOG_KEY_OBJECT).strip()
    bucket = (os.getenv("POD_STORAGE_GCS_BUCKET") or "").strip()
    if not bucket:
        raise ByocKeyCustodyError(
            "BYOC custody needs POD_STORAGE_GCS_BUCKET to find the wrapped key"
        )

    from hushh_mcp.services.pod_emulator_endpoints import (  # noqa: PLC0415
        PodEmulatorEndpointError,
        resolve_gcp_kms_origin,
    )

    gcs_origin, is_gcs_emulator = _gcs_origin()
    try:
        _, is_kms_emulator = resolve_gcp_kms_origin()
    except PodEmulatorEndpointError as exc:
        raise ByocKeyCustodyError(str(exc)) from None
    check_gcs_tombstone = session is None or is_gcs_emulator
    if session is None:
        import requests  # type: ignore[import-untyped]  # noqa: PLC0415

        session = requests

    if token is None:
        if (is_gcs_emulator or is_kms_emulator) and not (
            os.getenv("GCE_METADATA_HOST") or ""
        ).strip():
            token = "floci-gcp-emulator-token"  # noqa: S105
        else:
            token = _metadata_token(session)

    import urllib.parse  # noqa: PLC0415

    quoted = urllib.parse.quote(obj, safe="")
    response = _custody_request(
        session,
        "get",
        f"{gcs_origin}/storage/v1/b/{bucket}/o/{quoted}",
        params={"alt": "media"},
        headers={"Authorization": f"Bearer {token}"},
        timeout=60,
    )
    status = getattr(response, "status_code", 0)
    if status == 404:
        if store is not None:
            from hushh_mcp.services.pod_custody_port import (  # noqa: PLC0415
                refuse_store_after_erasure,
            )

            refuse_store_after_erasure(store)
        elif check_gcs_tombstone:
            _refuse_gcs_after_erasure(
                bucket=bucket, session=session, token=token, gcs_origin=gcs_origin
            )
        # First boot. The pod mints its own key here rather than finding one hushh left
        # for it -- hushh's bootstrap account provably cannot encrypt with this key.
        return _create_wrapped_dek(
            bucket=bucket,
            obj=obj,
            quoted=quoted,
            kms_key=kms_key,
            session=session,
            token=token,
            gcs_origin=gcs_origin,
        )
    if status != 200:
        raise ByocKeyCustodyError(
            f"the wrapped log key could not be read ({status}). "
            "Refusing to mint a replacement: a second key would start a second history "
            "and present it as the same agent."
        )
    return unwrap_dek(response.content, kms_key=kms_key, session=session, token=token)


def resolve_pod_log_key(
    *, session: Any = None, token: Optional[str] = None, store: Any = None
) -> bytes:
    """The pod's log key, whichever custody model it was provisioned under.

    Dispatches through ``resolve_key_custody_port`` so env/HKDF, Cloud KMS, Key Vault,
    and cloud-agnostic ACE envelope custody share one fail-closed interface.
    """
    from hushh_mcp.services.pod_custody_port import resolve_key_custody_port  # noqa: PLC0415

    return resolve_key_custody_port(session=session, token=token, store=store).resolve_log_key()


def _create_wrapped_dek(
    *,
    bucket: str,
    obj: str,
    quoted: str,
    kms_key: str,
    session: Any,
    token: str,
    gcs_origin: str = "https://storage.googleapis.com",
) -> bytes:
    """Mint, wrap and store this pod's log key -- exactly once, ever.

    ``ifGenerationMatch=0`` means "create only if absent" and is the whole safety of
    this function. Two cold starts of the same pod can race (min-instances 0 makes
    concurrent wakes ordinary), and without the precondition both would write a
    different DEK: the second would overwrite the first, and every record sealed in
    between would become unreadable. With it, exactly one writer wins and the loser is
    told so by a 412 -- at which point it reads the winner's key and agrees with it.
    """
    dek = generate_dek()
    wrapped = wrap_dek(dek, kms_key=kms_key, session=session, token=token)
    created = _custody_request(
        session,
        "post",
        f"{gcs_origin}/upload/storage/v1/b/{bucket}/o",
        params={"uploadType": "media", "name": obj, "ifGenerationMatch": 0},
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/octet-stream",
        },
        data=wrapped,
        timeout=60,
    )
    status = getattr(created, "status_code", 0)
    if status in (200, 201):
        logger.info("byoc_custody.log_key_created")
        return dek
    if status == 412:
        # Lost the race. The other boot's key is the real one; ours is discarded unused.
        logger.info("byoc_custody.log_key_race_lost")
        winner = _custody_request(
            session,
            "get",
            f"{gcs_origin}/storage/v1/b/{bucket}/o/{quoted}",
            params={"alt": "media"},
            headers={"Authorization": f"Bearer {token}"},
            timeout=60,
        )
        if getattr(winner, "status_code", 0) != 200:
            raise ByocKeyCustodyError(
                "another boot claimed the log key first, but it could not be read back "
                f"({getattr(winner, 'status_code', '?')})"
            )
        return unwrap_dek(winner.content, kms_key=kms_key, session=session, token=token)
    raise ByocKeyCustodyError(
        f"could not store the wrapped log key ({status}). "
        "The pod stops here rather than running on a key nothing persisted -- that "
        "would seal records no later boot could open"
    )


#: Label separating the memory key from the log key. Same shape as the managed tier's
#: labelled derivation (``pod_key_custody``), so the two tiers seal memory the same way
#: and only the ROOT differs: hushh's master there, the pod's own DEK here.
_MEMORY_KEY_INFO = b"hussh.pod.memory.v1"


def derive_memory_key(dek: bytes) -> bytes:
    """The memory-sealing key, derived inside the pod from its own log DEK.

    BYOC pods must not be handed ``HUSSH_POD_MEMORY_KEY``: it is a plaintext key, and
    the managed tier's copy is derived from hushh's master, so shipping it into the
    user's project would put a hushh-derived secret in a service description in *their*
    cloud -- the precise thing this module's header rules out for the log key.

    Deriving it instead means one wrapped secret covers both purposes and hushh holds
    neither. Labelled, so a memory key is never usable as a log key.
    """
    from cryptography.hazmat.primitives import hashes  # noqa: PLC0415
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF  # noqa: PLC0415

    if len(dek) != _KEY_LEN:
        raise ByocKeyCustodyError(f"the log DEK must be exactly {_KEY_LEN} bytes")
    return HKDF(
        algorithm=hashes.SHA256(), length=_KEY_LEN, salt=None, info=_MEMORY_KEY_INFO
    ).derive(dek)


def resolve_pod_memory_key(
    *, session: Any = None, token: Optional[str] = None, store: Any = None
) -> bytes:
    """The pod's memory key, whichever custody model it was provisioned under."""
    from hushh_mcp.services.pod_custody_port import resolve_key_custody_port  # noqa: PLC0415

    return resolve_key_custody_port(session=session, token=token, store=store).resolve_memory_key()


def _metadata_token(session: Any) -> str:
    """The pod's OWN identity, from the metadata server. An address, not a secret."""
    from hushh_mcp.services.pod_workload_identity import (  # noqa: PLC0415
        PodWorkloadIdentityUnavailable,
        google_metadata_access_endpoint,
    )

    try:
        endpoint = google_metadata_access_endpoint()  # refuses on Azure, before any request
    except PodWorkloadIdentityUnavailable:
        raise ByocKeyCustodyError("pod custody credential unavailable") from None
    response = _custody_request(
        session, "get", endpoint, headers={"Metadata-Flavor": "Google"}, timeout=10
    )
    try:
        if response.status_code != 200:
            raise ValueError("metadata unavailable")
        token = response.json()["access_token"]
        if not isinstance(token, str) or not token.strip():
            raise ValueError("metadata invalid")
        return token
    except Exception:  # noqa: BLE001 - never retain metadata body or credential diagnostics
        raise ByocKeyCustodyError("pod custody credential unavailable") from None


__all__ = [
    "ByocKeyCustodyError",
    "KEY_VAULT_KEY_ENV",
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
