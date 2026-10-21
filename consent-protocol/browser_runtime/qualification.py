"""Immutable Browser qualification; no activation or cloud credentials.

Stdlib only. The governed release verifies reviewed receipt bytes. This contract
checks their bindings; it does not execute probes or grant owner authority.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

# Static Browser evidence travels with this release, never with owner policy.
MAX_QUALIFICATION_BYTES = 8192
_GATES = frozenset(
    {
        "isolated",
        "direct_egress_denied",
        "broker_bridge_verified",
        "ephemeral_bridge_verified",
        "private_access_denied",
        "model_transport_verified",
    }
)
_HOSTS = {"gcp_cloud_run": "gcp", "azure_vm": "azure", "azure_container_apps": "azure"}
_V2_DEFAULTS = {
    "version": 1,
    "boundary": "isolated_browser",
    "chromium_sandbox": True,
    "browser_start_verified": False,
    "runtime_uid_verified": False,
    "lifecycle_verified": False,
}


def _execution_ready(ready: dict, version: int, host: str) -> bool:
    if version == 1:
        return (
            host != "azure_container_apps"
            and all(ready[key] is True for key in _GATES)
            and all(
                key not in ready or (type(ready[key]) is type(value) and ready[key] == value)
                for key, value in _V2_DEFAULTS.items()
            )
        )
    return (
        host in {"gcp_cloud_run", "azure_container_apps"}
        and ready.get("version") == 2
        and type(ready.get("version")) is int
        and ready.get("boundary") == "shared_owner_container"
        and ready.get("chromium_sandbox") is (host == "gcp_cloud_run")
        and all(
            ready[key] is False
            for key in ("isolated", "direct_egress_denied", "private_access_denied")
        )
        and all(
            ready.get(key) is True
            for key in (
                "browser_start_verified",
                "runtime_uid_verified",
                "lifecycle_verified",
                "broker_bridge_verified",
                "ephemeral_bridge_verified",
                "model_transport_verified",
            )
        )
    )


def validate_qualification(
    value: object, *, image_digest: str, source_revision: str
) -> dict[str, Any]:
    """Check a reviewed statement against the selected image, never a tag."""
    if not isinstance(value, dict) or set(value) - {"public_policy"} != {
        "version",
        "host_kind",
        "source_revision",
        "image_tag",
        "evidence_sha256",
        "public_policy_sha256",
        "readiness",
    }:
        raise ValueError("invalid Browser qualification")
    if type(value["version"]) is not int or value["version"] not in {1, 2}:
        raise ValueError("unsupported Browser qualification")
    host = value["host_kind"]
    if not isinstance(host, str) or host not in _HOSTS:
        raise ValueError("unqualified Browser host")
    source = value["source_revision"]
    if not isinstance(source, str) or not re.fullmatch(r"[a-f0-9]{40}", source):
        raise ValueError("Browser qualification requires source provenance")
    if source != source_revision or not re.fullmatch(r"sha256:[a-f0-9]{64}", image_digest):
        raise ValueError("Browser qualification image provenance changed")
    for key, pattern in (
        ("image_tag", r"[A-Za-z0-9_.+-]{1,128}"),
        ("evidence_sha256", r"[a-f0-9]{64}"),
        ("public_policy_sha256", r"[a-f0-9]{64}"),
    ):
        if not isinstance(value[key], str) or not re.fullmatch(pattern, value[key]):
            raise ValueError("invalid Browser qualification evidence")
    ready = value["readiness"]
    required = _GATES | {
        "cloud",
        "component_digest",
        "model_name",
        "model_transport",
    }
    if (
        not isinstance(ready, dict)
        or not required <= set(ready) <= required | set(_V2_DEFAULTS)
        or (value["version"] == 2 and set(ready) != required | set(_V2_DEFAULTS))
    ):
        raise ValueError("invalid Browser readiness evidence")
    if (
        not _execution_ready(ready, value["version"], host)
        or ready["cloud"] != _HOSTS[host]
        or ready["component_digest"] != image_digest
    ):
        raise ValueError("Browser execution or image is not qualified")
    for key in ("model_name", "model_transport"):
        text = ready[key]
        if (
            not isinstance(text, str)
            or not 1 <= len(text) <= (128 if key == "model_name" else 256)
            or any(ord(char) < 33 for char in text)
        ):
            raise ValueError("Browser model transport is not qualified")
    if len(json.dumps(value).encode()) > MAX_QUALIFICATION_BYTES:
        raise ValueError("Browser qualification exceeds its bound")
    if "public_policy" in value:
        policy = value["public_policy"]
        digest_policy = dict(policy) if isinstance(policy, dict) else {}
        if digest_policy.get("interactive_origins") == []:
            digest_policy.pop("interactive_origins")
        if (
            not isinstance(policy, dict)
            or set(policy) - {"interactive_origins"} != {"page_urls", "static_prefixes"}
            or any(not isinstance(policy[key], list) for key in policy)
            or not 1 <= len(policy["page_urls"]) <= 128
            or len(policy["static_prefixes"]) > 32
            or len(policy.get("interactive_origins", [])) > 20
            or (policy.get("interactive_origins") and value["version"] != 2)
            or any(
                not isinstance(url, str) or not 1 <= len(url) <= 4096
                for entries in policy.values()
                for url in entries
            )
            or hashlib.sha256(
                json.dumps(digest_policy, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest()
            != value["public_policy_sha256"]
        ):
            raise ValueError("Browser public policy offer changed")
    return value


def qualification_from_receipt(
    raw: bytes, *, expected_sha256: str, image_digest: str, source_revision: str
) -> dict[str, Any]:
    """Verify reviewed receipt bytes before projecting their release statement.

    The receipt is a bounded, sanitized probe summary reviewed with the source.
    The caller supplies its reviewed checksum; build output cannot substitute a
    differently measured image or claim qualification from a shaped hash alone.
    """
    if not raw or len(raw) > 65536 or hashlib.sha256(raw).hexdigest() != expected_sha256:
        raise ValueError("Browser qualification receipt changed")
    receipt = json.loads(raw)
    if not isinstance(receipt, dict) or set(receipt) != {"qualification"}:
        raise ValueError("invalid Browser qualification receipt")
    value = receipt["qualification"]
    if not isinstance(value, dict) or "evidence_sha256" in value:
        raise ValueError("invalid Browser qualification receipt statement")
    return validate_qualification(
        {**value, "evidence_sha256": expected_sha256},
        image_digest=image_digest,
        source_revision=source_revision,
    )


def qualification_environment(
    qualification: dict[str, Any] | None, *, image_digest: str, host_kind: str
) -> dict[str, str]:
    """Only image evidence; never an enable flag or destination configuration."""
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", image_digest):
        raise ValueError("Browser qualification requires an immutable image")
    environment = {"HUSSH_POD_INSTALLED_IMAGE_DIGEST": image_digest}
    if qualification is None:
        return environment
    qualified = validate_qualification(
        qualification,
        image_digest=image_digest,
        source_revision=qualification.get("source_revision", ""),
    )
    if qualified["host_kind"] != host_kind:
        raise ValueError("Browser qualification does not match the target host")
    return {
        **environment,
        "HUSSH_BROWSER_QUALIFICATION_JSON": json.dumps(
            qualified, separators=(",", ":"), sort_keys=True
        ),
    }
