# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Fail-closed loopback wire-conformance endpoint resolvers for GCP, Azure, AWS, and ACE.

Supports Tier-1.5 ephemeral wire conformance (`floci`, `floci-gcp`, `floci-az`, and the
built-in loopback HTTP wire servers in `tests/floci_wire_harness.py`) while guaranteeing:

1. **Zero live-environment blast radius:** Any custom endpoint or loopback HTTP override
   is unconditionally refused in `uat`, `staging`, `prod`, and `production`.
2. **Loopback confinement:** Plaintext `http://` overrides are permitted only for strict
   loopback addresses (`localhost`, `127.0.0.0/8`, `::1`) without credentials, queries,
   or fragments.
"""

from __future__ import annotations

import ipaddress
import os
import urllib.parse
from typing import Optional

FLOCI_GCP_ENDPOINT_URL_ENV = "FLOCI_GCP_ENDPOINT_URL"
FLOCI_GCP_KMS_ENDPOINT_URL_ENV = "FLOCI_GCP_KMS_ENDPOINT_URL"
STORAGE_EMULATOR_HOST_ENV = "STORAGE_EMULATOR_HOST"
FLOCI_AZ_ENDPOINT_URL_ENV = "FLOCI_AZ_ENDPOINT_URL"
AZURITE_BLOB_ENDPOINT_URL_ENV = "AZURITE_BLOB_ENDPOINT_URL"
FLOCI_PREFIX_ALLOW_LOOPBACK_HTTP_ENV = "FLOCI_PREFIX_ALLOW_LOOPBACK_HTTP"

_FORBIDDEN_EMULATOR_ENVS = frozenset({"production", "prod", "uat", "staging"})
_TRUTHY = frozenset({"1", "true", "yes", "on"})


class PodEmulatorEndpointError(RuntimeError):
    """Custom wire-emulator endpoint is forbidden in this environment or malformed."""


def _deploy_environment() -> str:
    for env_name in ("HUSHH_DEPLOY_ENV", "DEPLOY_ENV", "ENVIRONMENT", "APP_ENV"):
        value = (os.getenv(env_name) or "").strip().lower()
        if value:
            return value
    return ""


def _refuse_in_protected_deploy_env(label: str) -> None:
    if _deploy_environment() in _FORBIDDEN_EMULATOR_ENVS:
        raise PodEmulatorEndpointError(
            f"custom {label} endpoint overrides are refused in UAT and production"
        )


def is_loopback_host(host: str) -> bool:
    normalized = (host or "").strip().lower()
    if not normalized:
        return False
    if normalized == "localhost":
        return True
    try:
        return ipaddress.ip_address(normalized).is_loopback
    except ValueError:
        return False


def validate_emulator_origin(raw: str, *, label: str) -> str:
    """Validate and normalize a custom emulator origin (`scheme://netloc`)."""
    candidate = (raw or "").strip().rstrip("/")
    if "://" not in candidate:
        candidate = f"http://{candidate}"
    _refuse_in_protected_deploy_env(label)
    parsed = urllib.parse.urlsplit(candidate)
    host = (parsed.hostname or "").strip().lower()
    if (
        parsed.scheme not in {"http", "https"}
        or not host
        or parsed.username
        or parsed.password
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise PodEmulatorEndpointError(f"custom {label} endpoint must be a clean origin URL")
    if parsed.scheme == "http" and not is_loopback_host(host):
        raise PodEmulatorEndpointError(
            f"unencrypted HTTP {label} endpoints must bind strictly to loopback"
        )
    return f"{parsed.scheme}://{parsed.netloc}"


def resolve_gcp_storage_origin() -> tuple[str, bool]:
    """Return `(origin, is_emulator)` for GCS JSON/upload REST calls."""
    raw = (
        os.getenv(FLOCI_GCP_ENDPOINT_URL_ENV) or os.getenv(STORAGE_EMULATOR_HOST_ENV) or ""
    ).strip()
    if not raw:
        return "https://storage.googleapis.com", False
    return validate_emulator_origin(raw, label="GCP/Floci storage"), True


def resolve_gcp_kms_origin() -> tuple[str, bool]:
    """Return `(origin, is_emulator)` for Cloud KMS v1 REST calls."""
    raw = (
        os.getenv(FLOCI_GCP_KMS_ENDPOINT_URL_ENV) or os.getenv(FLOCI_GCP_ENDPOINT_URL_ENV) or ""
    ).strip()
    if not raw:
        return "https://cloudkms.googleapis.com", False
    return validate_emulator_origin(raw, label="GCP/Floci KMS"), True


def resolve_azure_emulator_origin() -> Optional[str]:
    """Return validated loopback origin when `FLOCI_AZ_ENDPOINT_URL` is configured."""
    raw = (
        os.getenv(FLOCI_AZ_ENDPOINT_URL_ENV) or os.getenv(AZURITE_BLOB_ENDPOINT_URL_ENV) or ""
    ).strip()
    if not raw:
        return None
    return validate_emulator_origin(raw, label="Azure/Floci")


def allow_loopback_prefix_http() -> bool:
    """True only when loopback HTTP prefix-store testing is explicitly enabled outside UAT/prod."""
    raw = (os.getenv(FLOCI_PREFIX_ALLOW_LOOPBACK_HTTP_ENV) or "").strip().lower()
    if raw not in _TRUTHY:
        return False
    _refuse_in_protected_deploy_env("prefix-store loopback HTTP")
    return True
