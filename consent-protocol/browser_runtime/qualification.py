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
_HOSTS = {"gcp_cloud_run": "gcp", "azure_vm": "azure"}


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
    if type(value["version"]) is not int or value["version"] != 1:
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
    if not isinstance(ready, dict) or set(ready) != _GATES | {
        "cloud",
        "component_digest",
        "model_name",
        "model_transport",
    }:
        raise ValueError("invalid Browser readiness evidence")
    if (
        any(ready[key] is not True for key in _GATES)
        or ready["cloud"] != _HOSTS[host]
        or ready["component_digest"] != image_digest
    ):
        raise ValueError("Browser isolation or image is not qualified")
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
        if (
            not isinstance(policy, dict)
            or set(policy) != {"page_urls", "static_prefixes"}
            or any(not isinstance(policy[key], list) for key in policy)
            or not 1 <= len(policy["page_urls"]) <= 128
            or len(policy["static_prefixes"]) > 32
            or any(
                not isinstance(url, str) or not 1 <= len(url) <= 4096
                for entries in policy.values()
                for url in entries
            )
            or hashlib.sha256(
                json.dumps(policy, sort_keys=True, separators=(",", ":")).encode()
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
