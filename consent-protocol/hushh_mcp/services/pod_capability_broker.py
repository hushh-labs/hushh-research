# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Hub Zero-Role Capability & Custody Broker for multi-cloud private pods.

Allows zero-privilege compute-cell pods (`gcp`, `ace`, `aws`, `azure` — holding zero
per-user Cloud IAM Service Accounts, zero Postgres credentials, and zero KMS IAM roles)
to authenticate strictly via their per-pod `Ed25519` request signature
(`pod_request_signing`) and request:

1. **15-minute prefix-scoped storage capabilities (`pods/{hushh_id}/*`):**
   - `ace_prefix_bearer`: Hub-signed `hpst1` prefix capability token for HTTPS prefix gateways
     (`PrefixTokenObjectStore`);
   - `gcs_cab`: Google STS Downscoped Credential Access Boundary (`resource.name.startsWith`);
   - `aws_sts_s3_prefix`: AWS STS `AssumeRole` inline session policy locked to
     `arn:aws:s3:::{bucket}/pods/{hushh_id}/*`;
   - `azure_blob_delegation_sas`: Azure Blob User Delegation SAS (`sv=2023-11-03`).

2. **AAD-bound regional KMS envelope DEK wrap/unwrap (`custody_mode="hub_broker"`):**
   - Plaintext DEKs never cross the wire in JSON: pod->hub `wrap` seals the DEK to the
     Hub Broker's derived X25519 public key (`ACE-X25519-AES256GCM-V1`), and hub->pod
     responses seal the DEK to the pod's registered `row["pod_pubkey"]`.
   - Every cloud KMS wrap/unwrap binds canonical AAD (`owner_id | hushh_id | custody_mode |
     cloud_provider`), and every broker call verifies serving-owner, `placement_epoch`,
     registry erasure, and `account_deletion_tombstones` fences BOTH before and after
     external cloud I/O.
"""

from __future__ import annotations

import asyncio
import base64
import datetime as dt
import hashlib
import hmac
import json
import logging
import os
import time
import urllib.parse
from dataclasses import dataclass
from typing import Any, Literal, Optional

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import x25519
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from hushh_mcp.services.pod_access_audit import (
    PodAccessUnavailable,
    resolve_serving_owner_hushh_id,
)
from hushh_mcp.services.pod_commit_log import object_key_is_within
from hushh_mcp.services.pod_custody_port import open_ace_dek, seal_ace_dek
from hushh_mcp.services.pod_session_authority import canonical_json

logger = logging.getLogger(__name__)

StorageProviderKind = Literal[
    "ace_prefix_bearer",
    "gcs_cab",
    "aws_sts_s3_prefix",
    "azure_blob_delegation_sas",
]
HubKmsBackendKind = Literal["hub_aead", "gcp_kms", "aws_kms"]

MIN_STORAGE_TTL_SECONDS = 60
MAX_STORAGE_TTL_SECONDS = 900
AWS_STS_MIN_DURATION_SECONDS = 900

BROKER_SEAL_SECRET_ENV = "HUSSH_CUSTODY_BROKER_SEAL_KEY"  # noqa: S105
HUB_REGIONAL_KEK_ENV = "HUSSH_HUB_REGIONAL_KEK"
HUB_KMS_BACKEND_ENV = "HUSSH_HUB_CUSTODY_KMS_BACKEND"
HUB_GCP_KMS_KEY_ENV = "HUSSH_HUB_GCP_KMS_KEY"
HUB_AWS_KMS_KEY_ENV = "HUSSH_HUB_AWS_KMS_KEY_ARN"
HUB_PREFIX_GATEWAY_URL_ENV = "HUSSH_HUB_STORAGE_PREFIX_BASE_URL"
HUB_STORAGE_PROVIDER_ENV = "HUSSH_HUB_STORAGE_TOKEN_PROVIDER"
HUB_GCS_BUCKET_ENV = "HUSSH_HUB_POD_GCS_BUCKET"
HUB_S3_BUCKET_ENV = "HUSSH_HUB_POD_S3_BUCKET"
HUB_AWS_ROLE_ARN_ENV = "HUSSH_HUB_POD_AWS_STS_ROLE_ARN"
HUB_AZURE_ACCOUNT_ENV = "HUSSH_HUB_POD_AZURE_ACCOUNT"
HUB_AZURE_CONTAINER_ENV = "HUSSH_HUB_POD_AZURE_CONTAINER"

_BROKER_X25519_INFO = b"hussh.hub.custody-broker.x25519.v1"
_GATEWAY_SIGNING_INFO = b"hussh.hub.prefix-gateway.hmac-sha256.v1"
_REGIONAL_KEK_INFO = b"hussh.hub.regional-kek.aes256gcm.v1"
_TOKEN_PREFIX = "hpst1."  # noqa: S105
_GATEWAY_AUDIENCE = "hussh-pod-prefix-gateway"
_HUB_KMS_ALG = "hussh.pod.hub-kms.v1"
_SNAPSHOT_FIELDS = (
    "user_id",
    "status",
    "deployment_target",
    "pod_key_id",
    "pod_signing_key_id",
    "placement_epoch",
)


class PodCapabilityBrokerError(RuntimeError):
    """Base error for Hub capability/custody broker failures."""


class PodCapabilityBrokerUnauthorized(PodCapabilityBrokerError):
    """Caller failed Ed25519 pod authentication (`401`)."""


class PodCapabilityBrokerForbidden(PodCapabilityBrokerError):
    """Pod failed placement, epoch, serving-owner, or erasure/tombstone fencing (`403`)."""


class PodCapabilityBrokerUnavailable(PodCapabilityBrokerError):
    """Control-plane authority or upstream KMS/STS is unavailable (`503`)."""


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64url_decode(value: str) -> bytes:
    cleaned = (value or "").strip()
    if not cleaned:
        raise ValueError("empty base64url field")
    return base64.urlsafe_b64decode(cleaned + "=" * (-len(cleaned) % 4))


def _root_broker_secret() -> bytes:
    raw = (os.getenv(BROKER_SEAL_SECRET_ENV) or os.getenv("APP_SIGNING_KEY") or "").strip()
    if len(raw) < 16:
        raise PodCapabilityBrokerUnavailable("hub custody broker signing material is unconfigured")
    return raw.encode("utf-8")


def derive_hub_broker_keypair(*, secret: Optional[bytes] = None) -> tuple[bytes, bytes, str]:
    """Deterministically derive the Hub Custody Broker X25519 `(priv, pub, kid)` triad."""
    ikm = secret if secret is not None else _root_broker_secret()
    priv_bytes = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=None,
        info=_BROKER_X25519_INFO,
    ).derive(ikm)
    priv = x25519.X25519PrivateKey.from_private_bytes(priv_bytes)
    pub_bytes = priv.public_key().public_bytes(
        serialization.Encoding.Raw,
        serialization.PublicFormat.Raw,
    )
    pub_b64 = base64.b64encode(pub_bytes).decode("ascii")
    kid = f"hubk_{hashlib.sha256(pub_b64.encode('utf-8')).hexdigest()[:24]}"
    return priv_bytes, pub_bytes, kid


def _derive_gateway_hmac_key(*, secret: Optional[bytes] = None) -> bytes:
    ikm = secret if secret is not None else _root_broker_secret()
    return HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=None,
        info=_GATEWAY_SIGNING_INFO,
    ).derive(ikm)


def _derive_local_regional_kek(*, secret: Optional[bytes] = None) -> bytes:
    explicit = (os.getenv(HUB_REGIONAL_KEK_ENV) or "").strip()
    if explicit:
        try:
            decoded = _b64url_decode(explicit)
        except Exception as exc:  # noqa: BLE001
            raise PodCapabilityBrokerUnavailable("HUSSH_HUB_REGIONAL_KEK is malformed") from exc
        if len(decoded) != 32:
            raise PodCapabilityBrokerUnavailable("HUSSH_HUB_REGIONAL_KEK must decode to 32 bytes")
        return decoded
    ikm = secret if secret is not None else _root_broker_secret()
    return HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=None,
        info=_REGIONAL_KEK_INFO,
    ).derive(ikm)


def validated_pod_prefix(hushh_id: str) -> str:
    """Return `pods/<hushh_id>` after proving `<hushh_id>` is a single safe path segment."""
    cleaned = (hushh_id or "").strip()
    if (
        not cleaned
        or "/" in cleaned
        or "\\" in cleaned
        or cleaned in {".", ".."}
        or any(ch.isspace() for ch in cleaned)
    ):
        raise PodCapabilityBrokerForbidden("invalid pod storage prefix identity")
    prefix = f"pods/{cleaned}"
    if not object_key_is_within("pods", f"{prefix}/_probe") or not object_key_is_within(
        prefix, f"{prefix}/_probe"
    ):
        raise PodCapabilityBrokerForbidden("pod storage prefix failed segment confinement")
    return prefix


def mint_prefix_gateway_token(
    *,
    hushh_id: str,
    owner_id: str,
    placement_epoch: int,
    ttl_seconds: int,
    now_epoch: Optional[int] = None,
    secret: Optional[bytes] = None,
) -> tuple[str, dict[str, Any]]:
    """Issue an HMAC-SHA256-authenticated `hpst1` bearer token confined to `pods/{hushh_id}`."""
    prefix = validated_pod_prefix(hushh_id)
    clamped_ttl = max(MIN_STORAGE_TTL_SECONDS, min(MAX_STORAGE_TTL_SECONDS, int(ttl_seconds)))
    now = int(time.time()) if now_epoch is None else int(now_epoch)
    claims: dict[str, Any] = {
        "aud": _GATEWAY_AUDIENCE,
        "epoch": int(placement_epoch),
        "exp": now + clamped_ttl,
        "hushh_id": hushh_id,
        "iat": now,
        "owner_id": owner_id,
        "prefix": prefix,
    }
    payload_bytes = canonical_json(claims).encode("utf-8")
    mac = hmac.new(_derive_gateway_hmac_key(secret=secret), payload_bytes, hashlib.sha256).digest()
    token = f"{_TOKEN_PREFIX}{_b64url_encode(payload_bytes)}.{_b64url_encode(mac)}"
    return token, claims


def verify_prefix_gateway_token(
    token: str,
    *,
    object_path: str,
    now_epoch: Optional[int] = None,
    secret: Optional[bytes] = None,
) -> dict[str, Any]:
    """Verify an `hpst1` prefix bearer token and enforce segment-strict `pods/{hushh_id}` confinement."""
    raw = (token or "").strip()
    if not raw.startswith(_TOKEN_PREFIX):
        raise PodCapabilityBrokerForbidden("unsupported prefix capability token")
    encoded_claims, dot, encoded_mac = raw[len(_TOKEN_PREFIX) :].partition(".")
    if not dot or not encoded_claims or not encoded_mac:
        raise PodCapabilityBrokerForbidden("malformed prefix capability token")
    try:
        payload_bytes = _b64url_decode(encoded_claims)
        provided_mac = _b64url_decode(encoded_mac)
        claims = json.loads(payload_bytes.decode("utf-8"))
    except Exception:  # noqa: BLE001
        raise PodCapabilityBrokerForbidden("malformed prefix capability token") from None

    expected_mac = hmac.new(
        _derive_gateway_hmac_key(secret=secret), payload_bytes, hashlib.sha256
    ).digest()
    if not hmac.compare_digest(provided_mac, expected_mac):
        raise PodCapabilityBrokerForbidden("invalid prefix capability token signature")

    if not isinstance(claims, dict) or claims.get("aud") != _GATEWAY_AUDIENCE:
        raise PodCapabilityBrokerForbidden("invalid prefix capability token audience")

    now = int(time.time()) if now_epoch is None else int(now_epoch)
    exp = claims.get("exp")
    if not isinstance(exp, int) or now >= exp:
        raise PodCapabilityBrokerUnauthorized("prefix capability token expired")

    prefix = str(claims.get("prefix") or "").strip("/")
    normalized_object = (object_path or "").strip("/")
    if not prefix or not object_key_is_within(prefix, normalized_object):
        raise PodCapabilityBrokerForbidden("object path escapes authorized pod prefix")
    return claims


def build_gcs_cab_options(*, bucket: str, pod_prefix: str) -> dict[str, Any]:
    """Construct the exact Google STS Credential Access Boundary rule for `pods/{hushh_id}/`."""
    clean_bucket = (bucket or "").strip()
    clean_prefix = (pod_prefix or "").strip("/")
    if not clean_bucket or not clean_prefix:
        raise ValueError("bucket and pod_prefix are required for GCS CAB")
    return {
        "accessBoundary": {
            "accessBoundaryRules": [
                {
                    "availableResource": f"//storage.googleapis.com/projects/_/buckets/{clean_bucket}",
                    "availablePermissions": ["inRole:roles/storage.objectUser"],
                    "availabilityCondition": {
                        "title": "HusshPodPrefixConfinement",
                        "expression": (
                            "resource.name.startsWith("
                            f"'projects/_/buckets/{clean_bucket}/objects/{clean_prefix}/')"
                        ),
                    },
                }
            ]
        }
    }


def build_aws_s3_prefix_session_policy(*, bucket: str, pod_prefix: str) -> dict[str, Any]:
    """Construct the exact AWS STS inline session policy confining S3 access to `pods/{hushh_id}/*`."""
    clean_bucket = (bucket or "").strip()
    clean_prefix = (pod_prefix or "").strip("/")
    if not clean_bucket or not clean_prefix:
        raise ValueError("bucket and pod_prefix are required for AWS S3 prefix policy")
    return {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Sid": "PodPrefixObjectRW",
                "Effect": "Allow",
                "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
                "Resource": f"arn:aws:s3:::{clean_bucket}/{clean_prefix}/*",
            },
            {
                "Sid": "PodPrefixListOnly",
                "Effect": "Allow",
                "Action": ["s3:ListBucket"],
                "Resource": f"arn:aws:s3:::{clean_bucket}",
                "Condition": {"StringLike": {"s3:prefix": [f"{clean_prefix}/*"]}},
            },
        ],
    }


@dataclass(frozen=True)
class AzureUserDelegationKey:
    signed_oid: str
    signed_tid: str
    signed_start: str
    signed_expiry: str
    signed_service: str
    signed_version: str
    value_b64: str


def mint_azure_user_delegation_sas(
    *,
    account: str,
    container: str,
    pod_prefix: str,
    delegation_key: AzureUserDelegationKey,
    ttl_seconds: int,
    now_utc: Optional[dt.datetime] = None,
) -> dict[str, Any]:
    """Sign an Azure Blob `sv=2023-11-03` User Delegation SAS scoped to `pods/{hushh_id}`."""
    clean_account = (account or "").strip()
    clean_container = (container or "").strip()
    clean_prefix = (pod_prefix or "").strip("/")
    if not clean_account or not clean_container or not clean_prefix:
        raise ValueError("account, container, and pod_prefix are required")

    clamped_ttl = max(MIN_STORAGE_TTL_SECONDS, min(MAX_STORAGE_TTL_SECONDS, int(ttl_seconds)))
    now = now_utc or dt.datetime.now(dt.timezone.utc)
    start_str = (now - dt.timedelta(seconds=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
    expiry_str = (now + dt.timedelta(seconds=clamped_ttl)).strftime("%Y-%m-%dT%H:%M:%SZ")
    signed_version = "2023-11-03"
    signed_permissions = "rcwdl"
    signed_resource = "d"
    signed_depth = str(len(clean_prefix.split("/")))
    canonicalized_resource = f"/blob/{clean_account}/{clean_container}/{clean_prefix}"

    string_to_sign = "\n".join(
        [
            signed_permissions,
            start_str,
            expiry_str,
            canonicalized_resource,
            delegation_key.signed_oid,
            delegation_key.signed_tid,
            delegation_key.signed_start,
            delegation_key.signed_expiry,
            delegation_key.signed_service,
            delegation_key.signed_version,
            "",  # signedAuthorizedObjectId
            "",  # signedUnauthorizedObjectId
            "",  # signedCorrelationId
            "",  # signedIP
            "https",
            signed_version,
            signed_resource,
            "",  # signedSnapshotTime
            "",  # signedEncryptionScope
            "",  # rscc
            "",  # rscd
            "",  # rsce
            "",  # rscl
            "",  # rsct
        ]
    )
    key_bytes = base64.b64decode(delegation_key.value_b64)
    signature = base64.b64encode(
        hmac.new(key_bytes, string_to_sign.encode("utf-8"), hashlib.sha256).digest()
    ).decode("ascii")

    query = urllib.parse.urlencode(
        {
            "sv": signed_version,
            "sr": signed_resource,
            "sdd": signed_depth,
            "sp": signed_permissions,
            "st": start_str,
            "se": expiry_str,
            "spr": "https",
            "skoid": delegation_key.signed_oid,
            "sktid": delegation_key.signed_tid,
            "skt": delegation_key.signed_start,
            "ske": delegation_key.signed_expiry,
            "sks": delegation_key.signed_service,
            "skv": delegation_key.signed_version,
            "sig": signature,
        }
    )
    prefix_url = f"https://{clean_account}.blob.core.windows.net/{clean_container}/{clean_prefix}"
    return {
        "prefixUrl": prefix_url,
        "sasQuery": query,
        "sasUrl": f"{prefix_url}?{query}",
        "expiresInSeconds": clamped_ttl,
    }


def _hub_kms_aad(*, owner_id: str, hushh_id: str, cloud_provider: str) -> bytes:
    return str(
        canonical_json(
            {
                "alg": _HUB_KMS_ALG,
                "cloud_provider": cloud_provider,
                "custody_mode": "hub_broker",
                "hushh_id": hushh_id,
                "owner_id": owner_id,
            }
        )
    ).encode("utf-8")


async def _default_is_owner_tombstoned(owner_id: str) -> bool:
    from hushh_mcp.services.account_deletion_lifecycle_service import (  # noqa: PLC0415
        AccountDeletionInProgressError,
        AccountDeletionLifecycleService,
    )

    try:
        return bool(
            await asyncio.to_thread(AccountDeletionLifecycleService.is_tombstoned, owner_id)
        )
    except AccountDeletionInProgressError:
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("pod_capability_broker.tombstone_check_unavailable %s", type(exc).__name__)
        raise PodCapabilityBrokerUnavailable("account deletion authority unavailable") from None


async def _verify_active_primary_pod_fence(
    *,
    verified: Any,
    registry: Any,
    owner_tombstoned_fn: Any,
    expected_snapshot: Optional[tuple[Any, ...]] = None,
) -> tuple[dict[str, Any], str, tuple[Any, ...]]:
    """Enforce signed primary pod identity + active registry + non-erased + non-tombstoned owner."""
    if verified is None or not getattr(verified, "signed", False):
        raise PodCapabilityBrokerUnauthorized("signed Ed25519 pod identity required")
    if getattr(verified, "standby", False):
        raise PodCapabilityBrokerForbidden("standby placements may not mint primary capabilities")

    hushh_id = str(getattr(verified, "hushh_id", "") or "").strip()
    key_id = str(getattr(verified, "key_id", "") or "").strip()
    if not hushh_id or not key_id:
        raise PodCapabilityBrokerUnauthorized("signed Ed25519 pod identity required")

    try:
        row = await registry.get_by_hushh_id(hushh_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("pod_capability_broker.registry_unavailable %s", type(exc).__name__)
        raise PodCapabilityBrokerUnavailable("pod registry authority unavailable") from None

    if not isinstance(row, dict):
        raise PodCapabilityBrokerForbidden("pod is not active in registry")

    metadata = row.get("backend_metadata")
    if (
        row.get("status") != "provisioned"
        or (isinstance(metadata, dict) and "erasure" in metadata)
        or str(row.get("pod_signing_key_id") or "").strip() != key_id
    ):
        raise PodCapabilityBrokerForbidden("pod is not authorized for capability brokering")

    tombstone_check = getattr(registry, "tombstone_exists", None)
    if callable(tombstone_check):
        try:
            pod_tombstoned = bool(await tombstone_check(hushh_id))
        except Exception as exc:  # noqa: BLE001
            logger.warning("pod_capability_broker.pod_tombstone_unavailable %s", type(exc).__name__)
            raise PodCapabilityBrokerUnavailable("pod tombstone authority unavailable") from None
        if pod_tombstoned:
            raise PodCapabilityBrokerForbidden("erased pod may not mint capabilities")

    owner_id = str(row.get("user_id") or "").strip()
    if not owner_id:
        raise PodCapabilityBrokerForbidden("pod has no bound owner")

    try:
        serving_hushh = await resolve_serving_owner_hushh_id(owner_id, registry=registry)
    except PodAccessUnavailable:
        raise PodCapabilityBrokerUnavailable("serving-owner authority unavailable") from None
    if serving_hushh != hushh_id:
        raise PodCapabilityBrokerForbidden("pod is not the owner's active serving agent")

    if await owner_tombstoned_fn(owner_id):
        raise PodCapabilityBrokerForbidden("account deletion fence active")

    snapshot = tuple(row.get(field) for field in _SNAPSHOT_FIELDS)
    if expected_snapshot is not None and snapshot != expected_snapshot:
        raise PodCapabilityBrokerForbidden("pod placement mutated during broker operation")

    return row, owner_id, snapshot


def _decode_pod_x25519_pubkey(row: dict[str, Any]) -> tuple[bytes, str]:
    raw_pub = str(row.get("pod_pubkey") or "").strip()
    pod_key_id = str(row.get("pod_key_id") or "").strip()
    if not raw_pub or not pod_key_id:
        raise PodCapabilityBrokerForbidden("pod X25519 public key is not registered")
    try:
        pub_bytes = base64.b64decode(raw_pub, validate=True)
        if len(pub_bytes) != 32:
            raise ValueError("length")
        x25519.X25519PublicKey.from_public_bytes(pub_bytes)
    except Exception:  # noqa: BLE001
        raise PodCapabilityBrokerForbidden("registered pod X25519 public key is invalid") from None
    return pub_bytes, pod_key_id


def _wrap_with_hub_kek(
    dek: bytes,
    *,
    owner_id: str,
    hushh_id: str,
    cloud_provider: str,
    kms_backend: HubKmsBackendKind,
    http_session: Any = None,
    gcp_token: Optional[str] = None,
    aws_kms_client: Any = None,
    secret: Optional[bytes] = None,
) -> bytes:
    aad = _hub_kms_aad(owner_id=owner_id, hushh_id=hushh_id, cloud_provider=cloud_provider)
    if kms_backend == "gcp_kms":
        from hushh_mcp.services.byoc_key_custody import (  # noqa: PLC0415
            ByocKeyCustodyError,
            unwrap_dek,
            wrap_dek,
        )

        kms_key = (os.getenv(HUB_GCP_KMS_KEY_ENV) or "").strip()
        if not kms_key:
            raise PodCapabilityBrokerUnavailable(f"{HUB_GCP_KMS_KEY_ENV} is unconfigured")
        session = http_session
        if session is None:
            import requests  # type: ignore[import-untyped]  # noqa: PLC0415

            session = requests
        token = gcp_token or "floci-gcp-emulator-token"
        try:
            ct = wrap_dek(dek, kms_key=kms_key, session=session, token=token, aad=aad)
            proved = unwrap_dek(ct, kms_key=kms_key, session=session, token=token, aad=aad)
        except ByocKeyCustodyError as exc:
            raise PodCapabilityBrokerUnavailable("GCP KMS custody unavailable") from exc
        if not hmac.compare_digest(proved, dek):
            raise PodCapabilityBrokerUnavailable("GCP KMS failed round-trip verification")
        envelope = {
            "alg": _HUB_KMS_ALG,
            "backend": "gcp_kms",
            "cloud_provider": cloud_provider,
            "ct": _b64url_encode(ct),
            "hushh_id": hushh_id,
            "v": 1,
        }
        return str(canonical_json(envelope)).encode("utf-8")

    if kms_backend == "aws_kms":
        from hushh_mcp.services.pod_s3_object_store import (  # noqa: PLC0415
            resolve_aws_boto3_client_kwargs,
        )

        key_arn = (os.getenv(HUB_AWS_KMS_KEY_ENV) or "").strip()
        if not key_arn:
            raise PodCapabilityBrokerUnavailable(f"{HUB_AWS_KMS_KEY_ENV} is unconfigured")
        client = aws_kms_client
        if client is None:
            import boto3  # type: ignore[import-not-found]  # noqa: PLC0415

            client = boto3.client("kms", **resolve_aws_boto3_client_kwargs("kms"))
        context = {
            "alg": _HUB_KMS_ALG,
            "cloud_provider": cloud_provider,
            "custody_mode": "hub_broker",
            "hushh_id": hushh_id,
            "owner_id": owner_id,
        }
        try:
            enc = client.encrypt(KeyId=key_arn, Plaintext=dek, EncryptionContext=context)
            ct = bytes(enc["CiphertextBlob"])
            dec = client.decrypt(KeyId=key_arn, CiphertextBlob=ct, EncryptionContext=context)
            proved = bytes(dec["Plaintext"])
        except Exception as exc:  # noqa: BLE001
            raise PodCapabilityBrokerUnavailable("AWS KMS custody unavailable") from exc
        if not hmac.compare_digest(proved, dek):
            raise PodCapabilityBrokerUnavailable("AWS KMS failed round-trip verification")
        envelope = {
            "alg": _HUB_KMS_ALG,
            "backend": "aws_kms",
            "cloud_provider": cloud_provider,
            "ct": _b64url_encode(ct),
            "hushh_id": hushh_id,
            "v": 1,
        }
        return str(canonical_json(envelope)).encode("utf-8")

    kek = _derive_local_regional_kek(secret=secret)
    nonce = os.urandom(12)
    ct = AESGCM(kek).encrypt(nonce, dek, aad)
    envelope = {
        "alg": _HUB_KMS_ALG,
        "backend": "hub_aead",
        "cloud_provider": cloud_provider,
        "ct": _b64url_encode(ct),
        "hushh_id": hushh_id,
        "nonce": _b64url_encode(nonce),
        "v": 1,
    }
    return str(canonical_json(envelope)).encode("utf-8")


def _unwrap_with_hub_kek(
    wrapped: bytes,
    *,
    owner_id: str,
    hushh_id: str,
    http_session: Any = None,
    gcp_token: Optional[str] = None,
    aws_kms_client: Any = None,
    secret: Optional[bytes] = None,
) -> bytes:
    try:
        envelope = json.loads(wrapped.decode("utf-8"))
        if (
            not isinstance(envelope, dict)
            or envelope.get("alg") != _HUB_KMS_ALG
            or envelope.get("v") != 1
        ):
            raise ValueError("shape")
        backend = str(envelope.get("backend") or "")
        cloud_provider = str(envelope.get("cloud_provider") or "")
        recorded_pod = str(envelope.get("hushh_id") or "")
        ct = _b64url_decode(str(envelope.get("ct") or ""))
    except Exception:  # noqa: BLE001
        raise PodCapabilityBrokerForbidden(
            "stored hub-brokered DEK envelope is malformed"
        ) from None

    if recorded_pod != hushh_id:
        raise PodCapabilityBrokerForbidden("stored DEK envelope belongs to a different pod")

    aad = _hub_kms_aad(owner_id=owner_id, hushh_id=hushh_id, cloud_provider=cloud_provider)
    if backend == "gcp_kms":
        from hushh_mcp.services.byoc_key_custody import (  # noqa: PLC0415
            ByocKeyCustodyError,
            unwrap_dek,
        )

        kms_key = (os.getenv(HUB_GCP_KMS_KEY_ENV) or "").strip()
        if not kms_key:
            raise PodCapabilityBrokerUnavailable(f"{HUB_GCP_KMS_KEY_ENV} is unconfigured")
        session = http_session
        if session is None:
            import requests  # type: ignore[import-untyped]  # noqa: PLC0415

            session = requests
        token = gcp_token or "floci-gcp-emulator-token"
        try:
            return bytes(unwrap_dek(ct, kms_key=kms_key, session=session, token=token, aad=aad))
        except ByocKeyCustodyError:
            raise PodCapabilityBrokerForbidden("GCP KMS refused DEK unwrap") from None

    if backend == "aws_kms":
        from hushh_mcp.services.pod_s3_object_store import (  # noqa: PLC0415
            resolve_aws_boto3_client_kwargs,
        )

        key_arn = (os.getenv(HUB_AWS_KMS_KEY_ENV) or "").strip()
        if not key_arn:
            raise PodCapabilityBrokerUnavailable(f"{HUB_AWS_KMS_KEY_ENV} is unconfigured")
        client = aws_kms_client
        if client is None:
            import boto3  # type: ignore[import-not-found]  # noqa: PLC0415

            client = boto3.client("kms", **resolve_aws_boto3_client_kwargs("kms"))
        context = {
            "alg": _HUB_KMS_ALG,
            "cloud_provider": cloud_provider,
            "custody_mode": "hub_broker",
            "hushh_id": hushh_id,
            "owner_id": owner_id,
        }
        try:
            dec = client.decrypt(KeyId=key_arn, CiphertextBlob=ct, EncryptionContext=context)
            dek = bytes(dec["Plaintext"])
        except Exception:  # noqa: BLE001
            raise PodCapabilityBrokerForbidden("AWS KMS refused DEK unwrap") from None
        if len(dek) != 32:
            raise PodCapabilityBrokerForbidden("unwrapped DEK length invalid")
        return dek

    if backend == "hub_aead":
        try:
            nonce = _b64url_decode(str(envelope.get("nonce") or ""))
            kek = _derive_local_regional_kek(secret=secret)
            dek = AESGCM(kek).decrypt(nonce, ct, aad)
        except Exception:  # noqa: BLE001
            raise PodCapabilityBrokerForbidden("Hub regional KEK refused DEK unwrap") from None
        if len(dek) != 32:
            raise PodCapabilityBrokerForbidden("unwrapped DEK length invalid")
        return dek

    raise PodCapabilityBrokerForbidden("unsupported hub custody backend")


async def describe_hub_custody_broker_key(
    *,
    verified: Any,
    registry: Any = None,
    owner_tombstoned_fn: Any = None,
    secret: Optional[bytes] = None,
) -> dict[str, str]:
    """Return the Hub Custody Broker X25519 public key to an authenticated active primary pod."""
    if registry is None:
        from hushh_mcp.services.personal_agent_registry_repo import (  # noqa: PLC0415
            PersonalAgentRegistryRepo,
        )

        registry = PersonalAgentRegistryRepo()
    tombstone_fn = owner_tombstoned_fn or _default_is_owner_tombstoned
    await _verify_active_primary_pod_fence(
        verified=verified,
        registry=registry,
        owner_tombstoned_fn=tombstone_fn,
    )
    _, pub_bytes, kid = derive_hub_broker_keypair(secret=secret)
    return {
        "brokerPublicKey": base64.b64encode(pub_bytes).decode("ascii"),
        "brokerKeyId": kid,
        "wrappingAlg": "ACE-X25519-AES256GCM-V1",
    }


async def broker_pod_storage_token(
    *,
    verified: Any,
    ttl_seconds: int = MAX_STORAGE_TTL_SECONDS,
    provider: Optional[StorageProviderKind] = None,
    registry: Any = None,
    owner_tombstoned_fn: Any = None,
    http_session: Any = None,
    gcp_source_token: Optional[str] = None,
    aws_sts_client: Any = None,
    azure_delegation_key: Optional[AzureUserDelegationKey] = None,
    secret: Optional[bytes] = None,
) -> dict[str, Any]:
    """Mint a 15-minute prefix-scoped storage capability (`pods/{hushh_id}/*`) for an active pod."""
    if registry is None:
        from hushh_mcp.services.personal_agent_registry_repo import (  # noqa: PLC0415
            PersonalAgentRegistryRepo,
        )

        registry = PersonalAgentRegistryRepo()
    tombstone_fn = owner_tombstoned_fn or _default_is_owner_tombstoned
    row, owner_id, pre_snapshot = await _verify_active_primary_pod_fence(
        verified=verified,
        registry=registry,
        owner_tombstoned_fn=tombstone_fn,
    )
    hushh_id = str(row["hushh_id"])
    pod_prefix = validated_pod_prefix(hushh_id)
    epoch = int(row.get("placement_epoch") or 0)
    clamped_ttl = max(MIN_STORAGE_TTL_SECONDS, min(MAX_STORAGE_TTL_SECONDS, int(ttl_seconds)))

    selected_provider: str = (
        provider or (os.getenv(HUB_STORAGE_PROVIDER_ENV) or "ace_prefix_bearer").strip()
    )

    if selected_provider == "ace_prefix_bearer":
        base_url = (
            (os.getenv(HUB_PREFIX_GATEWAY_URL_ENV) or "https://storage-gateway.hussh.ai")
            .strip()
            .rstrip("/")
        )
        token, _ = mint_prefix_gateway_token(
            hushh_id=hushh_id,
            owner_id=owner_id,
            placement_epoch=epoch,
            ttl_seconds=clamped_ttl,
            secret=secret,
        )
        result: dict[str, Any] = {
            "hushhId": hushh_id,
            "provider": "ace_prefix_bearer",
            "prefix": pod_prefix,
            "prefixUrl": f"{base_url}/{pod_prefix}",
            "bearerToken": token,
            "expiresInSeconds": clamped_ttl,
        }
    elif selected_provider == "gcs_cab":
        bucket = (os.getenv(HUB_GCS_BUCKET_ENV) or "").strip()
        if not bucket:
            raise PodCapabilityBrokerUnavailable(f"{HUB_GCS_BUCKET_ENV} is unconfigured")
        cab = build_gcs_cab_options(bucket=bucket, pod_prefix=pod_prefix)
        session = http_session
        if session is None:
            import requests  # type: ignore[import-untyped]  # noqa: PLC0415

            session = requests
        src_tok = (
            gcp_source_token or (os.getenv("HUSSH_HUB_GCP_STORAGE_SOURCE_TOKEN") or "").strip()
        )
        if not src_tok:
            raise PodCapabilityBrokerUnavailable("GCP CAB source token is unconfigured")

        def _exchange_cab() -> tuple[str, int]:
            resp = session.post(
                "https://sts.googleapis.com/v1/token",
                data={
                    "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
                    "subject_token_type": "urn:ietf:params:oauth:token-type:access_token",
                    "requested_token_type": "urn:ietf:params:oauth:token-type:access_token",
                    "subject_token": src_tok,
                    "options": urllib.parse.quote(canonical_json(cab)),
                },
                timeout=15,
            )
            if getattr(resp, "status_code", 0) != 200:
                raise PodCapabilityBrokerUnavailable("Google STS CAB exchange failed")
            body = resp.json()
            tok = str(body.get("access_token") or "").strip()
            exp_in = int(body.get("expires_in") or clamped_ttl)
            if not tok:
                raise PodCapabilityBrokerUnavailable("Google STS CAB returned empty token")
            return tok, min(clamped_ttl, max(MIN_STORAGE_TTL_SECONDS, exp_in))

        cab_token, cab_ttl = await asyncio.to_thread(_exchange_cab)
        result = {
            "hushhId": hushh_id,
            "provider": "gcs_cab",
            "bucket": bucket,
            "prefix": pod_prefix,
            "prefixUrl": f"https://storage.googleapis.com/{bucket}/{pod_prefix}",
            "bearerToken": cab_token,
            "expiresInSeconds": cab_ttl,
        }
    elif selected_provider == "aws_sts_s3_prefix":
        bucket = (os.getenv(HUB_S3_BUCKET_ENV) or "").strip()
        role_arn = (os.getenv(HUB_AWS_ROLE_ARN_ENV) or "").strip()
        if not bucket or not role_arn:
            raise PodCapabilityBrokerUnavailable(
                f"{HUB_S3_BUCKET_ENV} and {HUB_AWS_ROLE_ARN_ENV} are required"
            )
        policy = build_aws_s3_prefix_session_policy(bucket=bucket, pod_prefix=pod_prefix)
        client = aws_sts_client
        if client is None:
            import boto3  # type: ignore[import-not-found]  # noqa: PLC0415

            from hushh_mcp.services.pod_s3_object_store import (  # noqa: PLC0415
                resolve_aws_boto3_client_kwargs,
            )

            client = boto3.client("sts", **resolve_aws_boto3_client_kwargs("sts"))

        def _assume_prefix_role() -> dict[str, Any]:
            try:
                assumed = client.assume_role(
                    RoleArn=role_arn,
                    RoleSessionName=f"pod-{hushh_id[:40]}",
                    Policy=canonical_json(policy),
                    DurationSeconds=AWS_STS_MIN_DURATION_SECONDS,
                )
            except Exception as exc:  # noqa: BLE001
                raise PodCapabilityBrokerUnavailable("AWS STS AssumeRole failed") from exc
            creds = assumed.get("Credentials") or {}
            return {
                "accessKeyId": str(creds["AccessKeyId"]),
                "secretAccessKey": str(creds["SecretAccessKey"]),
                "sessionToken": str(creds["SessionToken"]),
            }

        aws_creds = await asyncio.to_thread(_assume_prefix_role)
        result = {
            "hushhId": hushh_id,
            "provider": "aws_sts_s3_prefix",
            "s3Uri": f"s3://{bucket}/{pod_prefix}",
            "prefix": pod_prefix,
            "credentials": aws_creds,
            "expiresInSeconds": AWS_STS_MIN_DURATION_SECONDS,
        }
    elif selected_provider == "azure_blob_delegation_sas":
        account = (os.getenv(HUB_AZURE_ACCOUNT_ENV) or "").strip()
        container = (os.getenv(HUB_AZURE_CONTAINER_ENV) or "").strip()
        if not account or not container or azure_delegation_key is None:
            raise PodCapabilityBrokerUnavailable("Azure User Delegation SAS is unconfigured")
        sas = mint_azure_user_delegation_sas(
            account=account,
            container=container,
            pod_prefix=pod_prefix,
            delegation_key=azure_delegation_key,
            ttl_seconds=clamped_ttl,
        )
        result = {
            "hushhId": hushh_id,
            "provider": "azure_blob_delegation_sas",
            "prefix": pod_prefix,
            "prefixUrl": sas["prefixUrl"],
            "bearerToken": sas["sasQuery"],
            "sasUrl": sas["sasUrl"],
            "expiresInSeconds": sas["expiresInSeconds"],
        }
    else:
        raise PodCapabilityBrokerForbidden("unsupported storage capability provider")

    await _verify_active_primary_pod_fence(
        verified=verified,
        registry=registry,
        owner_tombstoned_fn=tombstone_fn,
        expected_snapshot=pre_snapshot,
    )
    return result


async def broker_pod_dek_envelope(
    *,
    verified: Any,
    operation: Literal["wrap", "unwrap"],
    sealed_dek_b64: Optional[str] = None,
    broker_key_id: Optional[str] = None,
    wrapped_dek_b64: Optional[str] = None,
    registry: Any = None,
    owner_tombstoned_fn: Any = None,
    kms_backend: Optional[HubKmsBackendKind] = None,
    http_session: Any = None,
    gcp_token: Optional[str] = None,
    aws_kms_client: Any = None,
    secret: Optional[bytes] = None,
) -> dict[str, str]:
    """Wrap or unwrap a pod's 32-byte DEK via regional KMS, keeping DEK sealed end-to-end."""
    if registry is None:
        from hushh_mcp.services.personal_agent_registry_repo import (  # noqa: PLC0415
            PersonalAgentRegistryRepo,
        )

        registry = PersonalAgentRegistryRepo()
    tombstone_fn = owner_tombstoned_fn or _default_is_owner_tombstoned
    row, owner_id, pre_snapshot = await _verify_active_primary_pod_fence(
        verified=verified,
        registry=registry,
        owner_tombstoned_fn=tombstone_fn,
    )
    hushh_id = str(row["hushh_id"])
    pod_pub_bytes, pod_key_id = _decode_pod_x25519_pubkey(row)
    cloud_provider = str(row.get("deployment_target") or "gcp").strip()
    active_kms_backend: HubKmsBackendKind = kms_backend or (  # type: ignore[assignment]
        (os.getenv(HUB_KMS_BACKEND_ENV) or "hub_aead").strip()
    )
    if active_kms_backend not in {"hub_aead", "gcp_kms", "aws_kms"}:
        raise PodCapabilityBrokerUnavailable(f"unsupported {HUB_KMS_BACKEND_ENV}")

    if operation == "wrap":
        if not sealed_dek_b64 or not broker_key_id:
            raise PodCapabilityBrokerForbidden("wrap requires sealedDek and brokerKeyId")
        broker_priv, _, expected_broker_kid = derive_hub_broker_keypair(secret=secret)
        if broker_key_id.strip() != expected_broker_kid:
            raise PodCapabilityBrokerForbidden("brokerKeyId mismatch")
        try:
            sealed_bytes = _b64url_decode(sealed_dek_b64)
            dek = open_ace_dek(
                sealed_bytes,
                custodian_private_bytes=broker_priv,
                expected_hushh_id=hushh_id,
                expected_key_id=expected_broker_kid,
            )
        except Exception:  # noqa: BLE001
            raise PodCapabilityBrokerForbidden(
                "sealedDek could not be opened for this pod"
            ) from None

        wrapped_bytes = await asyncio.to_thread(
            _wrap_with_hub_kek,
            dek,
            owner_id=owner_id,
            hushh_id=hushh_id,
            cloud_provider=cloud_provider,
            kms_backend=active_kms_backend,
            http_session=http_session,
            gcp_token=gcp_token,
            aws_kms_client=aws_kms_client,
            secret=secret,
        )
        pod_sealed = seal_ace_dek(
            dek,
            custodian_public_bytes=pod_pub_bytes,
            hushh_id=hushh_id,
            key_id=pod_key_id,
        )
        await _verify_active_primary_pod_fence(
            verified=verified,
            registry=registry,
            owner_tombstoned_fn=tombstone_fn,
            expected_snapshot=pre_snapshot,
        )
        return {
            "hushhId": hushh_id,
            "podKeyId": pod_key_id,
            "wrappedDek": _b64url_encode(wrapped_bytes),
            "sealedDek": _b64url_encode(pod_sealed),
        }

    if operation == "unwrap":
        if not wrapped_dek_b64:
            raise PodCapabilityBrokerForbidden("unwrap requires wrappedDek")
        try:
            wrapped_bytes = _b64url_decode(wrapped_dek_b64)
        except Exception:  # noqa: BLE001
            raise PodCapabilityBrokerForbidden("wrappedDek encoding invalid") from None

        dek = await asyncio.to_thread(
            _unwrap_with_hub_kek,
            wrapped_bytes,
            owner_id=owner_id,
            hushh_id=hushh_id,
            http_session=http_session,
            gcp_token=gcp_token,
            aws_kms_client=aws_kms_client,
            secret=secret,
        )
        pod_sealed = seal_ace_dek(
            dek,
            custodian_public_bytes=pod_pub_bytes,
            hushh_id=hushh_id,
            key_id=pod_key_id,
        )
        await _verify_active_primary_pod_fence(
            verified=verified,
            registry=registry,
            owner_tombstoned_fn=tombstone_fn,
            expected_snapshot=pre_snapshot,
        )
        return {
            "hushhId": hushh_id,
            "podKeyId": pod_key_id,
            "sealedDek": _b64url_encode(pod_sealed),
        }

    raise PodCapabilityBrokerForbidden("unsupported DEK broker operation")
