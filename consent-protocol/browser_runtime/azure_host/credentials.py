"""Explicit UAMI only. Provider credentials and image-auth files stay in RAM."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from .config import SECRETS, HostRefused


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def _json(url: str, *, fields: dict | None = None, headers: dict | None = None) -> dict:
    parsed = urlsplit(url)
    if (
        parsed.username
        or parsed.password
        or parsed.fragment
        or parsed.port
        or not (
            (
                parsed.scheme == "http"
                and parsed.hostname == "169.254.169.254"
                and parsed.path in {"/metadata/identity/oauth2/token", "/metadata/instance/compute"}
            )
            or (
                parsed.scheme == "https"
                and re.fullmatch(r"[a-z0-9]{5,50}\.azurecr\.io", parsed.hostname or "")
                and parsed.path == "/oauth2/exchange"
            )
            or (
                parsed.scheme == "https"
                and re.fullmatch(r"[a-z0-9-]{3,24}\.vault\.azure\.net", parsed.hostname or "")
                and re.fullmatch(r"/secrets/[A-Za-z0-9-]{1,127}/[a-f0-9]{32}", parsed.path)
            )
        )
    ):
        raise HostRefused("HOST_PROVIDER_ENDPOINT_REFUSED")
    opener = build_opener(ProxyHandler({}), _NoRedirect())
    request = Request(  # noqa: S310 - fixed provider endpoints above; redirects/proxies disabled
        url, data=None if fields is None else urlencode(fields).encode(), headers=headers or {}
    )
    try:
        with opener.open(request, timeout=15) as response:  # noqa: S310 - fixed provider endpoints above; redirects/proxies disabled
            raw = response.read(65537)
        if len(raw) > 65536:
            raise ValueError()
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise ValueError()
        return result
    except HTTPError as exc:
        raise HostRefused("HOST_PROVIDER_HTTP_" + str(exc.code)) from None
    except Exception:
        raise HostRefused("HOST_PROVIDER_CREDENTIAL_REFUSED") from None


def _token(config: dict, resource: str) -> str:
    params = {
        "api-version": "2018-02-01",
        "client_id": config["installation"]["client_id"],
        "resource": resource,
    }
    result = _json(
        "http://169.254.169.254/metadata/identity/oauth2/token?" + urlencode(params),
        headers={"Metadata": "true"},
    )
    token = result.get("access_token")
    if not isinstance(token, str) or not token or len(token) > 32768:
        raise HostRefused("HOST_PROVIDER_CREDENTIAL_REFUSED")
    return token


def require_vm(config: dict) -> None:
    observed = _json(
        "http://169.254.169.254/metadata/instance/compute?api-version=2025-04-07",
        headers={"Metadata": "true"},
    )
    expected = config["installation"]
    if (
        observed.get("resourceId", "").casefold() != expected["resource_id"].casefold()
        or observed.get("vmId", "").casefold() != expected["vm_id"]
        or observed.get("osType") != "Linux"
        or str(observed.get("azEnvironment", "")).casefold() != "azurepubliccloud"
    ):
        raise HostRefused("HOST_VM_IDENTITY_CHANGED")


def prepare_signing_secret(config: dict) -> None:
    token = _token(config, "https://vault.azure.net")
    result = _json(
        config["signing_secret"] + "?api-version=7.4", headers={"Authorization": "Bearer " + token}
    )
    secret = result.get("value")
    if (
        result.get("id") != config["signing_secret"]
        or not isinstance(secret, str)
        or not 32 <= len(secret) <= 16384
        or "\x00" in secret
    ):
        raise HostRefused("HOST_SIGNING_SECRET_REFUSED")
    SECRETS.mkdir(mode=0o700, exist_ok=True)
    # /run is tmpfs on the qualified OS. Boot installer verifies the mount.
    fd = os.open(
        SECRETS / "app-signing-key", os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o400
    )
    with os.fdopen(fd, "w") as target:
        target.write(secret)
    os.chmod(SECRETS / "app-signing-key", 0o400)


def pull(config: dict) -> None:
    image = config["image"]
    login = image.split("/", 1)[0]
    identity = _token(config, "https://containerregistry.azure.net")
    exchanged = _json(
        "https://" + login + "/oauth2/exchange",
        fields={
            "grant_type": "access_token",
            "service": login,
            "tenant": config["tenant_id"],
            "access_token": identity,
        },
    )
    token = exchanged.get("refresh_token")
    if not isinstance(token, str) or not token:
        raise HostRefused("HOST_IMAGE_CREDENTIAL_REFUSED")
    directory = Path(tempfile.mkdtemp(prefix="hussh-image-", dir="/dev/shm"))
    try:
        env = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "DOCKER_CONFIG": str(directory)}
        subprocess.run(  # noqa: S603 - fixed executable and validated installation values
            [
                "docker",
                "login",
                login,
                "--username",
                "00000000-0000-0000-0000-000000000000",
                "--password-stdin",
            ],
            input=token,
            text=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
            timeout=30,
            env=env,
        )
        subprocess.run(  # noqa: S603 - fixed executable and validated installation values
            ["docker", "pull", image],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
            timeout=480,
            env=env,
        )
    except Exception:
        raise HostRefused("HOST_IMAGE_PULL_REFUSED") from None
    finally:
        shutil.rmtree(directory)
