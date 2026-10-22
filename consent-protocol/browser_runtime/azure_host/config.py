"""Root-host installation contract. Standard library only; no cloud SDK or agent keys."""

from __future__ import annotations

import json
import os
import re
import stat
from pathlib import Path
from uuid import UUID

ROOT = Path("/opt/hussh-host")
RUNTIME = Path("/run/hussh-host")
SECRETS = Path("/run/hussh-secrets")
TLS = Path("/run/hussh-tls")
PROFILE = "hussh-owner-pod"
DOCKER_VERSION = "29.1.3-0ubuntu3~24.04.2"
APPARMOR_SHA256 = "300299ca607fd9e624c764963a784fcca530698337cbcf2045454c181ce39bae"
SECCOMP_SHA256 = "fc543d68d4b46b8a42e23b62ce8aaddd9e3e313f96a4f29fbe6fb9d23233e5e2"


class HostRefused(RuntimeError):
    """Sanitized error. Never include configuration, HTTP bodies or subprocess output."""


def protected_read(path: Path, *, limit: int, private: bool = False) -> bytes:
    """No symlinks or writable ancestors. Host files are always root-owned."""
    for item in (*reversed(path.parents), path):
        info = item.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
            raise HostRefused("HOST_FILE_UNPROTECTED")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if (
            info.st_uid != 0
            or info.st_mode & 0o022
            or not stat.S_ISREG(info.st_mode)
            or (private and info.st_mode & 0o077)
        ):
            raise HostRefused("HOST_FILE_UNPROTECTED")
        value = handle.read(limit + 1)
    if len(value) > limit:
        raise HostRefused("HOST_FILE_TOO_LARGE")
    return value


def validate(value: dict) -> dict:
    expected = {
        "version",
        "installation",
        "tenant_id",
        "image",
        "hostname",
        "signing_secret",
        "environment",
    }
    if set(value) != expected or type(value["version"]) is not int or value["version"] != 1:
        raise HostRefused("HOST_INSTALLATION_INVALID")
    install = value["installation"]
    if not isinstance(install, dict) or set(install) != {
        "version",
        "resource_id",
        "vm_id",
        "client_id",
        "hushh_id",
        "image_digest",
        "generation",
    }:
        raise HostRefused("HOST_INSTALLATION_INVALID")
    _identity(install, value["tenant_id"])
    _connection(value)
    _environment(value["environment"], install)
    return value


def _identity(install: dict, tenant_id: str) -> None:
    try:
        for key in ("vm_id", "client_id"):
            if str(UUID(install[key])) != install[key]:
                raise ValueError()
        if str(UUID(tenant_id)) != tenant_id:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise HostRefused("HOST_IDENTITY_INVALID") from None
    resource = install["resource_id"]
    if (
        type(install["version"]) is not int
        or install["version"] != 1
        or not isinstance(resource, str)
        or not re.fullmatch(
            r"/subscriptions/[a-f0-9-]{36}/resourceGroups/[A-Za-z0-9_.()-]{1,90}/providers/Microsoft.Compute/virtualMachines/[A-Za-z0-9_-]{1,64}",
            resource,
        )
        or not re.fullmatch(r"vm_[a-f0-9]{32}", str(install["generation"]))
        or not re.fullmatch(r"sha256:[a-f0-9]{64}", str(install["image_digest"]))
        or not isinstance(install["hushh_id"], str)
        or not 1 <= len(install["hushh_id"]) <= 256
    ):
        raise HostRefused("HOST_IDENTITY_INVALID")


def _connection(value: dict) -> None:
    image = value["image"]
    if (
        not isinstance(image, str)
        or not re.fullmatch(r"[a-z0-9]{5,50}\.azurecr\.io/pod@sha256:[a-f0-9]{64}", image)
        or image.split("@", 1)[1] != value["installation"]["image_digest"]
    ):
        raise HostRefused("HOST_IMAGE_INVALID")
    hostname = value["hostname"]
    if (
        not isinstance(hostname, str)
        or len(hostname) > 253
        or not re.fullmatch(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}", hostname)
    ):
        raise HostRefused("HOST_ENDPOINT_INVALID")
    secret = value["signing_secret"]
    if not isinstance(secret, str) or not re.fullmatch(
        r"https://[a-z0-9-]{3,24}\.vault\.azure\.net/secrets/[A-Za-z0-9-]{1,127}/[a-f0-9]{32}",
        secret,
    ):
        raise HostRefused("HOST_SECRET_REFERENCE_INVALID")


def _environment(env: dict, install: dict) -> None:
    if (
        not isinstance(env, dict)
        or len(env) > 150
        or any(
            not isinstance(k, str)
            or not re.fullmatch(r"[A-Z][A-Z0-9_]{0,127}", k)
            or re.search(
                r"(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|PASSWORD|PRIVATE_KEY)$", k
            )
            or not isinstance(v, str)
            or len(v) > 16384
            or "\x00" in v
            for k, v in env.items()
        )
    ):
        raise HostRefused("HOST_ENVIRONMENT_INVALID")
    if any(
        k in env
        for k in (
            "APP_SIGNING_KEY",
            "HUSSH_POD_LOG_KEY",
            "HUSSH_POD_MEMORY_KEY",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "AZURE_FEDERATED_TOKEN_FILE",
            "PYTHONPATH",
            "LD_PRELOAD",
            "HUSSH_BROWSER_LAUNCH_FD",
            "IDENTITY_ENDPOINT",
            "IDENTITY_HEADER",
            "MSI_ENDPOINT",
            "MSI_SECRET",
            "K_SERVICE",
            "K_REVISION",
            "CONTAINER_APP_NAME",
            "CONTAINER_APP_REVISION",
        )
    ):
        raise HostRefused("HOST_ENVIRONMENT_INVALID")
    bound = {
        "HUSSH_ID": install["hushh_id"],
        "AZURE_CLIENT_ID": install["client_id"],
        "HUSSH_POD_INCARNATION": install["generation"],
        "PORT": "8080",
    }
    if any(env.get(k) != v for k, v in bound.items()):
        raise HostRefused("HOST_ENVIRONMENT_BINDING_CHANGED")


def load() -> dict:
    try:
        return validate(
            json.loads(protected_read(ROOT / "installation.json", limit=262144, private=True))
        )
    except HostRefused:
        raise
    except Exception:
        raise HostRefused("HOST_INSTALLATION_INVALID") from None
