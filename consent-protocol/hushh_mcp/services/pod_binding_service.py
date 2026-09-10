"""The hub's part in owner-direct admission: issue bindings, publish the endpoint.

The hub stays the enrolment and discovery authority and leaves the conversation.
Three things it signs or serves, all of them verifiable at the pod with public
material the pod already holds:

* **A pod binding** (``pod_binding_v1``) per enrolled subject: the owner, the
  environment, THIS deployment (``pod_key_id`` and ``pod_pubkey`` from the registry
  row, the recorded url), the subject's P-256 key and platform, the role the
  platform implies, the scopes, a version that only moves forward, an expiry.
  Signed Ed25519 with the consent-token key (``require_asymmetric=True``), so a
  hub without an asymmetric key cannot issue one at all rather than issuing
  something the pod would refuse.
* **The endpoint record** (``pod_endpoint_v1``): url, pod key id, environment and
  a monotonic ``endpointVersion`` that bumps whenever the url or the pod key
  changes, so the app can refuse a downgrade or a silent re-pointing.
* **Nothing else.** The hub never mints a pod session and never sees one. Puppy
  inference is not part of enrolment: the owner enables it from the device page,
  which re-issues the device binding at a higher version carrying the scope.

Everything the owner does here is audited through the same
``PodAccessAuditService.authorize_owner_read`` gate the relay uses, so a binding
for someone else's pod is refused for the same reason and with the same receipt.
"""

from __future__ import annotations

import logging
import os
import secrets
import time
from typing import Any, Optional

from hushh_mcp.consent.token_signing import sign_payload
from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.personal_agent_grant_service import PersonalAgentDisabledError
from hushh_mcp.services.pod_access_audit import (
    PERSONAL_AGENT_ID,
    PodAccessAuditService,
    PodAccessDenied,
)
from hushh_mcp.services.pod_session_authority import (
    APP_SCOPES,
    DEVICE_INFERENCE_SCOPES,
    DEVICE_SCOPES,
    ROLE_DEVICE,
    PodBindingV1,
    canonical_json,
    role_for_platform,
    verify_subject_proof,
)

logger = logging.getLogger(__name__)

ENDPOINT_KIND = "pod_endpoint_v1"
TOMBSTONE_INTENT_KIND = "pod_tombstone_intent_v1"
BINDING_TTL_MS = 30 * 24 * 60 * 60 * 1000
MAX_PENDING_TOMBSTONES = 32


class PodBindingError(Exception):
    """A stable, non-secret refusal safe for an API response."""

    def __init__(self, code: str, message: str, *, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def _clean(value: Any) -> str:
    return str(value or "").strip()


def hub_environment() -> str:
    return _clean(os.getenv("HUSHH_DEPLOY_ENV") or os.getenv("ENVIRONMENT")).lower()


def _signing_hmac_key() -> str:
    """The HMAC key the signature helper's contract names, read through the config.

    A binding is never HMAC-signed: `_sign` passes `require_asymmetric=True`, so the
    helper refuses unless an Ed25519 key is configured. The value is still read the
    way every other canonical secret is read, through `hushh_mcp.config`, because a
    direct environment read bypasses the KMS envelope resolution that config owns
    and the runtime-config contract refuses it for exactly that reason.
    """
    from hushh_mcp.config import APP_SIGNING_KEY  # noqa: PLC0415 - avoids import cycle

    return _clean(APP_SIGNING_KEY)


def _sign(payload: str) -> str:
    try:
        return sign_payload(payload, hmac_key=_signing_hmac_key(), require_asymmetric=True)
    except RuntimeError as exc:
        raise PodBindingError(
            "BINDING_SIGNING_UNAVAILABLE",
            "This deployment cannot issue owner-pod bindings yet.",
            status=503,
        ) from exc


def _pod_url(row: dict) -> str:
    metadata = row.get("backend_metadata")
    if not isinstance(metadata, dict):
        return ""
    url = _clean(metadata.get("url")).rstrip("/")
    return url if url.startswith("https://") else ""


class PodBindingService:
    def __init__(
        self,
        *,
        registry: Any = None,
        devices: Any = None,
        audit: Any = None,
        clock: Any = time.time,
    ) -> None:
        if registry is None:
            from hushh_mcp.services.personal_agent_registry_repo import (  # noqa: PLC0415
                PersonalAgentRegistryRepo,
            )

            registry = PersonalAgentRegistryRepo()
        if devices is None:
            from hushh_mcp.services.trusted_device_service import (  # noqa: PLC0415
                TrustedDeviceService,
            )

            devices = TrustedDeviceService()
        self._registry = registry
        self._devices = devices
        self._audit = audit or PodAccessAuditService(registry=registry)
        self._clock = clock

    # -- the owner gate -------------------------------------------------------------

    async def _owner_row(self, user_id: str, *, request_id: str) -> dict:
        try:
            await self._audit.authorize_owner_read(
                user_id=user_id,
                agent_id=PERSONAL_AGENT_ID,
                scope=ConsentScope.PKM_READ.value,
                request_id=request_id,
            )
        except PodAccessDenied as exc:
            raise PodBindingError(
                "POD_NOT_AUTHORIZED", "Not authorized for this pod.", status=403
            ) from exc
        except PersonalAgentDisabledError as exc:
            raise PodBindingError(
                "PERSONAL_AGENT_DISABLED", "The personal agent is not available.", status=404
            ) from exc
        row = await self._registry.get(user_id)
        if not isinstance(row, dict):
            raise PodBindingError("POD_NOT_AUTHORIZED", "Not authorized for this pod.", status=403)
        return row

    @staticmethod
    def _deployment(row: dict) -> tuple[str, str, str]:
        pod_key_id = _clean(row.get("pod_key_id"))
        pod_public_key = _clean(row.get("pod_pubkey"))
        if not pod_key_id or not pod_public_key:
            raise PodBindingError(
                "POD_IDENTITY_NOT_DURABLE",
                "This pod has not published a durable identity key yet.",
                status=409,
            )
        url = _pod_url(row)
        if not url:
            raise PodBindingError(
                "POD_ENDPOINT_UNAVAILABLE", "This pod has no recorded address yet.", status=409
            )
        return pod_key_id, pod_public_key, url

    # -- bindings -------------------------------------------------------------------

    async def issue(
        self, *, user_id: str, device_id: str, puppy_inference: bool = False
    ) -> dict[str, Any]:
        """Issue the next binding version for one subject. Signed, recorded, audited."""
        row = await self._owner_row(user_id, request_id=f"pod-binding:{device_id}")
        pod_key_id, pod_public_key, url = self._deployment(row)
        device = self._devices.active_device(user_id=user_id, device_id=device_id)
        if not device:
            raise PodBindingError(
                "TRUSTED_DEVICE_NOT_ACTIVE", "The trusted device is not active.", status=403
            )
        platform = _clean(device.get("platform")).lower()
        role = role_for_platform(platform)
        if role is None:
            raise PodBindingError(
                "TRUSTED_DEVICE_UNSUPPORTED_PLATFORM",
                "This platform cannot hold a pod binding.",
            )
        if role == ROLE_DEVICE:
            scopes = DEVICE_INFERENCE_SCOPES if puppy_inference else DEVICE_SCOPES
        else:
            if puppy_inference:
                raise PodBindingError(
                    "PUPPY_INFERENCE_IS_A_DEVICE_SCOPE",
                    "Only a device binding may carry Puppy inference.",
                )
            scopes = APP_SCOPES
        bindings = self._binding_records(row)
        previous = bindings.get(device_id) or {}
        version = int(previous.get("version") or 0) + 1
        now_ms = int(self._clock() * 1000)
        binding = PodBindingV1(
            hushh_id=_clean(row.get("hushh_id")),
            user_id=user_id,
            environment=hub_environment(),
            pod_key_id=pod_key_id,
            pod_public_key=pod_public_key,
            url=url,
            subject_id=device_id,
            subject_kind=role,
            subject_public_key=_clean(device.get("device_public_key")),
            platform=platform,
            role=role,
            scopes=tuple(scopes),
            version=version,
            issued_at_ms=now_ms,
            expires_at_ms=now_ms + BINDING_TTL_MS,
        )
        envelope = {"binding": binding.to_dict(), "signature": _sign(binding.canonical())}
        await self._registry.record_binding(
            user_id=user_id,
            device_id=device_id,
            record={
                "version": version,
                "role": role,
                "scopes": list(scopes),
                "issuedAt": now_ms,
                "envelope": envelope,
            },
        )
        try:
            self._devices.audit_event(
                user_id=user_id,
                device_id=device_id,
                event_type="pod_binding_issued",
                metadata={"version": version, "role": role, "scopes": list(scopes)},
            )
        except Exception:  # noqa: BLE001 - the binding stands; the audit row is best effort
            logger.warning("pod_binding.audit_failed")
        logger.info("pod_binding.issued role=%s version=%s", role, version)
        return {**envelope, "version": version, "role": role, "scopes": list(scopes)}

    async def latest(self, *, user_id: str, device_id: str) -> Optional[dict[str, Any]]:
        row = await self._owner_row(user_id, request_id=f"pod-binding-read:{device_id}")
        record = self._binding_records(row).get(device_id)
        if not isinstance(record, dict) or not isinstance(record.get("envelope"), dict):
            return None
        return {
            **record["envelope"],
            "version": int(record.get("version") or 0),
            "role": _clean(record.get("role")),
            "scopes": list(record.get("scopes") or []),
        }

    @staticmethod
    def _binding_records(row: dict) -> dict[str, Any]:
        metadata = row.get("backend_metadata")
        bindings = metadata.get("bindings") if isinstance(metadata, dict) else None
        return dict(bindings) if isinstance(bindings, dict) else {}

    # -- endpoint discovery -----------------------------------------------------------

    async def endpoint(self, *, user_id: str) -> dict[str, Any]:
        """Where the owner's pod is, signed, with a version that only moves forward.

        The version is bumped lazily, on the read that observes a change, and
        persisted so every later read agrees. A url or key change without a bump
        is therefore impossible to serve; an unchanged endpoint keeps its number.
        """
        row = await self._owner_row(user_id, request_id="pod-endpoint")
        pod_key_id, _public, url = self._deployment(row)
        metadata = (
            row.get("backend_metadata") if isinstance(row.get("backend_metadata"), dict) else {}
        )
        recorded = metadata.get("endpoint") if isinstance(metadata.get("endpoint"), dict) else {}
        version = int(recorded.get("version") or 0)
        if version < 1 or recorded.get("url") != url or recorded.get("podKeyId") != pod_key_id:
            version += 1
            await self._registry.record_endpoint(
                user_id=user_id,
                endpoint={"version": version, "url": url, "podKeyId": pod_key_id},
            )
        body = {
            "kind": ENDPOINT_KIND,
            "hushhId": _clean(row.get("hushh_id")),
            "url": url,
            "podKeyId": pod_key_id,
            "environment": hub_environment(),
            "endpointVersion": version,
        }
        return {**body, "signature": _sign(canonical_json(body))}

    # -- the tombstone courier ---------------------------------------------------------

    async def courier_tombstone(
        self, *, user_id: str, device_id: str, intent: Any, signature: Any
    ) -> dict[str, Any]:
        """Hold an owner-signed revocation until the pod's next heartbeat collects it.

        The hub verifies the app's signature so it does not carry garbage, and the
        pod verifies it AGAIN against its own trust record before applying it. The
        hub never signs the intent and cannot originate one.
        """
        row = await self._owner_row(user_id, request_id=f"pod-tombstone:{device_id}")
        if not isinstance(intent, dict):
            raise PodBindingError("TOMBSTONE_INTENT_INVALID", "The intent is not an object.")
        expected_keys = {
            "kind",
            "intentId",
            "hushhId",
            "subjectId",
            "atVersion",
            "issuedAtMs",
            "signerSubjectId",
        }
        if set(intent) != expected_keys or intent.get("kind") != TOMBSTONE_INTENT_KIND:
            raise PodBindingError("TOMBSTONE_INTENT_INVALID", "The intent has the wrong shape.")
        if _clean(intent.get("hushhId")) != _clean(row.get("hushh_id")):
            raise PodBindingError("TOMBSTONE_INTENT_INVALID", "The intent names another pod.")
        if _clean(intent.get("subjectId")) != device_id:
            raise PodBindingError("TOMBSTONE_INTENT_INVALID", "The intent names another subject.")
        at_version = intent.get("atVersion")
        if isinstance(at_version, bool) or not isinstance(at_version, int) or at_version < 1:
            raise PodBindingError("TOMBSTONE_INTENT_INVALID", "atVersion is a positive integer.")
        signer_id = _clean(intent.get("signerSubjectId"))
        signer = self._devices.active_device(user_id=user_id, device_id=signer_id)
        if not signer or role_for_platform(_clean(signer.get("platform"))) != "app":
            raise PodBindingError(
                "TOMBSTONE_SIGNER_NOT_TRUSTED",
                "The signer is not an active app installation.",
                status=403,
            )
        if not verify_subject_proof(
            _clean(signer.get("device_public_key")), canonical_json(intent), signature
        ):
            raise PodBindingError(
                "TOMBSTONE_SIGNATURE_INVALID", "The intent signature did not verify.", status=401
            )
        metadata = (
            row.get("backend_metadata") if isinstance(row.get("backend_metadata"), dict) else {}
        )
        pending = metadata.get("pendingTombstones")
        pending = list(pending) if isinstance(pending, list) else []
        if any(
            _clean(p.get("intent", {}).get("intentId")) == _clean(intent["intentId"])
            for p in pending
            if isinstance(p, dict)
        ):
            return {"queued": True, "intentId": intent["intentId"], "pending": len(pending)}
        if len(pending) >= MAX_PENDING_TOMBSTONES:
            raise PodBindingError(
                "TOMBSTONE_QUEUE_FULL", "Too many revocations are waiting for this pod.", status=429
            )
        await self._registry.append_pending_tombstone(
            user_id=user_id, entry={"intent": dict(intent), "signature": _clean(signature)}
        )
        return {"queued": True, "intentId": intent["intentId"], "pending": len(pending) + 1}


def new_intent_id() -> str:
    return f"pti_{secrets.token_urlsafe(18)}"


__all__ = [
    "BINDING_TTL_MS",
    "ENDPOINT_KIND",
    "MAX_PENDING_TOMBSTONES",
    "TOMBSTONE_INTENT_KIND",
    "PodBindingError",
    "PodBindingService",
    "hub_environment",
    "new_intent_id",
]
