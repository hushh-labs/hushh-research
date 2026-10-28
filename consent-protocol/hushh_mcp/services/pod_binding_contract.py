"""Signed private-pod binding wire contract, shared by issuer and verifier.

Absent optional fields preserve the canonical bytes of existing BYOC bindings.
Managed hosting is explicit authority; a generic fleet target never implies it.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Optional

from hushh_mcp.services.compute_backend import is_known_pod_target, is_owner_cloud_target

BINDING_KIND = "pod_binding_v1"

ROLE_DEVICE = "device"
ROLE_APP = "app"
ROLE_BY_PLATFORM: dict[str, str] = {
    "macos": ROLE_DEVICE,
    "web": ROLE_APP,
    "ios": ROLE_APP,
    "android": ROLE_APP,
}

SCOPE_PKM_READ = "pkm.read"
SCOPE_POD_CONFIG = "pod.config"
SCOPE_POD_STATUS = "pod.status"
SCOPE_POD_REVOKE = "pod.revoke"
SCOPE_POD_UPGRADE = "pod.upgrade"
SCOPE_PUPPY_INFERENCE = "puppy.inference"
SCOPE_POD_ACT = "pod.act"  # confirm a change the agent prepared (pod_actions.py)
SCOPE_BROWSER_INVOKE = "browser.invoke"
SCOPE_BROWSER_OBSERVE = "browser.observe"
SCOPE_BROWSER_CONTROL = "browser.control"
APP_SCOPES: tuple[str, ...] = (
    "files.read",
    "files.manage",
    SCOPE_POD_ACT,
    SCOPE_PKM_READ,
    SCOPE_POD_CONFIG,
    SCOPE_POD_STATUS,
    SCOPE_POD_REVOKE,
    SCOPE_POD_UPGRADE,
    SCOPE_BROWSER_INVOKE,
    SCOPE_BROWSER_OBSERVE,
    SCOPE_BROWSER_CONTROL,
)
DEVICE_SCOPES: tuple[str, ...] = ()
DEVICE_INFERENCE_SCOPES: tuple[str, ...] = (SCOPE_PUPPY_INFERENCE,)


class PodSessionRefused(Exception):
    """One exact refusal. ``code`` is stable and safe to log; ``status`` maps to HTTP."""

    def __init__(self, code: str, detail: str = "", *, status: int = 403) -> None:
        super().__init__(detail or code)
        self.code = code
        self.detail = detail
        self.status = status


def _clean(value: Any) -> str:
    return str(value or "").strip()


def canonical_json(value: Mapping[str, Any]) -> str:
    """Byte-exact canonical form shared by the hub, the pod and the device."""
    return json.dumps(dict(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def role_for_platform(platform: str) -> Optional[str]:
    return ROLE_BY_PLATFORM.get(_clean(platform).lower())


# -- the binding ----------------------------------------------------------------------


@dataclass(frozen=True)
class PodBindingV1:
    hushh_id: str
    user_id: str
    environment: str
    pod_key_id: str
    pod_public_key: str
    url: str
    subject_id: str
    subject_kind: str
    subject_public_key: str
    platform: str
    role: str
    scopes: tuple[str, ...]
    version: int
    issued_at_ms: int
    expires_at_ms: int
    deployment_target: str | None = None
    kind: str = BINDING_KIND
    hosting_mode: str | None = None

    def to_dict(self) -> dict[str, Any]:
        payload = {
            "kind": self.kind,
            "hushh_id": self.hushh_id,
            "user_id": self.user_id,
            "environment": self.environment,
            "pod_key_id": self.pod_key_id,
            "pod_public_key": self.pod_public_key,
            "url": self.url,
            "subject_id": self.subject_id,
            "subject_kind": self.subject_kind,
            "subject_public_key": self.subject_public_key,
            "platform": self.platform,
            "role": self.role,
            "scopes": list(self.scopes),
            "version": self.version,
            "issued_at_ms": self.issued_at_ms,
            "expires_at_ms": self.expires_at_ms,
        }
        # Older signed v1 records omitted this field. Preserve their canonical
        # bytes while including the verified placement on newly issued bindings.
        if self.deployment_target is not None:
            payload["deployment_target"] = self.deployment_target
        if self.hosting_mode is not None:
            payload["hosting_mode"] = self.hosting_mode
        return payload

    def canonical(self) -> str:
        return canonical_json(self.to_dict())

    @classmethod
    def from_mapping(cls, raw: Any) -> PodBindingV1:
        if not isinstance(raw, Mapping):
            raise PodSessionRefused("malformed", "a binding is an object", status=400)
        if _clean(raw.get("kind")) != BINDING_KIND:
            raise PodSessionRefused("malformed", "unknown binding kind", status=400)
        text_fields = (
            "hushh_id",
            "user_id",
            "environment",
            "pod_key_id",
            "pod_public_key",
            "url",
            "subject_id",
            "subject_kind",
            "subject_public_key",
            "platform",
            "role",
        )
        values: dict[str, Any] = {}
        for name in text_fields:
            value = raw.get(name)
            if not isinstance(value, str) or not value.strip() or len(value) > 4096:
                raise PodSessionRefused(
                    "malformed", f"binding field {name} is required", status=400
                )
            values[name] = value.strip()
        scopes = raw.get("scopes")
        if not isinstance(scopes, list) or any(
            not isinstance(s, str) or not s.strip() or len(s) > 64 for s in scopes
        ):
            raise PodSessionRefused("malformed", "binding scopes are a list of names", status=400)
        for name in ("version", "issued_at_ms", "expires_at_ms"):
            value = raw.get(name)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise PodSessionRefused(
                    "malformed", f"binding field {name} is an integer", status=400
                )
            values[name] = value
        deployment_target = raw.get("deployment_target")
        if deployment_target is not None:
            if not is_known_pod_target(deployment_target):
                raise PodSessionRefused(
                    "malformed", "binding deployment target is unsupported", status=400
                )
            values["deployment_target"] = deployment_target
        if "hosting_mode" in raw:
            if raw["hosting_mode"] != "hussh_hosted":
                raise PodSessionRefused(
                    "malformed", "binding hosting mode is unsupported", status=400
                )
            if deployment_target != "gcp" or values["environment"] != "dev":
                raise PodSessionRefused(
                    "malformed", "managed binding placement is unsupported", status=400
                )
            values["hosting_mode"] = raw["hosting_mode"]
        if values["version"] < 1:
            raise PodSessionRefused("malformed", "a binding version starts at 1", status=400)
        return cls(scopes=tuple(scopes), **values)


def hosting_mode_for_row(row: Mapping[str, Any]) -> str | None:
    """Derive signed hosting authority only from the retained placement contract."""
    from hushh_mcp.services.hosted_gcp_placement import retained_hosted_placement

    return "hussh_hosted" if retained_hosted_placement(dict(row)) is not None else None


def verify_binding_capabilities(binding: PodBindingV1, *, now_ms: float) -> None:
    """Validate private hosting symmetrically before recording any local authority."""
    from hushh_mcp.services.private_gcp_deployment import hosted_runtime_deployment

    deployment = hosted_runtime_deployment()
    if deployment is not None:
        if (
            binding.hosting_mode != "hussh_hosted"
            or binding.deployment_target != "gcp"
            or binding.environment != deployment.environment
            or binding.hushh_id != deployment.owner
        ):
            raise PodSessionRefused(
                "foreign_hosting", "binding does not name this managed placement"
            )
    elif binding.hosting_mode is not None:
        raise PodSessionRefused("foreign_hosting", "managed binding requires a managed runtime")
    if SCOPE_PUPPY_INFERENCE in binding.scopes and not is_owner_cloud_target(
        binding.deployment_target
    ):
        raise PodSessionRefused(
            "non_byoc_puppy", "Puppy inference bindings require the owner's BYOC pod"
        )
    expected_role = role_for_platform(binding.platform)
    if binding.role not in {ROLE_DEVICE, ROLE_APP} or binding.role != expected_role:
        raise PodSessionRefused("forged_role", "the role does not follow from the platform")
    if binding.subject_kind != binding.role:
        raise PodSessionRefused("forged_role", "the subject kind does not match the role")
    if now_ms >= binding.expires_at_ms:
        raise PodSessionRefused("expired", "the binding has expired")


def make_pod_binding(
    *,
    row: Mapping[str, Any],
    user_id: str,
    device_id: str,
    device: Mapping[str, Any],
    role: str,
    scopes: tuple[str, ...],
    version: int,
    environment: str,
    now_ms: int,
    ttl_ms: int,
) -> PodBindingV1:
    """One issuer projection of the verified registry and trusted-device snapshot."""
    metadata = row.get("backend_metadata") or {}
    return PodBindingV1(
        hushh_id=_clean(row.get("hushh_id")),
        user_id=user_id,
        environment=environment,
        pod_key_id=_clean(row.get("pod_key_id")),
        pod_public_key=_clean(row.get("pod_pubkey")),
        url=_clean(metadata.get("url")).rstrip("/"),
        subject_id=device_id,
        subject_kind=role,
        subject_public_key=_clean(device.get("device_public_key")),
        platform=_clean(device.get("platform")).lower(),
        role=role,
        scopes=tuple(scopes),
        version=version,
        issued_at_ms=now_ms,
        expires_at_ms=now_ms + ttl_ms,
        deployment_target=_clean(row.get("deployment_target")) or None,
        hosting_mode=hosting_mode_for_row(row),
    )
