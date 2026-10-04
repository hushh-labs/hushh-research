"""Stdlib-only bootstrap for the in-Azure model eval jobs (Azure Container Apps Jobs).

It runs as ``python -c <this source> <command>``, so nothing has to be baked into an
image for it. Every credential is the job's own user-assigned managed identity, minted
from the platform's local ``IDENTITY_ENDPOINT`` for ``AZURE_CLIENT_ID``: no keys, no
operator token, and nothing here ever prints a token.

commands
  fetch-context  init container of the build job: download and verify the build context
                 from blob, unpack it, and write the registry login kaniko pushes with
                 (an ACR refresh token exchanged from the identity's own Entra token)
  upload-log     sidecar of the build job: mirror a log file to blob until it carries
                 the exit marker (the environment keeps no logs)
  run-lane       entrypoint of the eval job: download and verify the eval drivers, then
                 exec ``lane.py`` from them

Why this exists: ACR Tasks (``az acr build``) are refused on the spike's free-trial
subscription (``TasksOperationsNotAllowed``, measured 2026-10-03), so the pod image is
built inside the person's own Container Apps environment instead.
"""

import base64
import hashlib
import io
import json
import os
import sys
import tarfile
import time
import urllib.parse
import urllib.request

_TOKENS = {}


def _open(request, timeout):
    """The one network door: https anywhere, plain http only to the local identity endpoint."""
    parts = urllib.parse.urlsplit(request.full_url)
    local = parts.hostname in {"localhost", "127.0.0.1"}
    if parts.scheme != "https" and not (parts.scheme == "http" and local):
        raise SystemExit("refusing to open %s://%s" % (parts.scheme, parts.hostname))
    return urllib.request.urlopen(request, timeout=timeout)  # noqa: S310 - scheme checked above


def _token(resource):
    cached = _TOKENS.get(resource)
    if cached and time.time() < cached[1]:
        return cached[0]
    query = urllib.parse.urlencode(
        {
            "api-version": "2019-08-01",
            "resource": resource,
            "client_id": os.environ["AZURE_CLIENT_ID"],
        }
    )
    request = urllib.request.Request(  # noqa: S310 - opened only via _open
        os.environ["IDENTITY_ENDPOINT"] + "?" + query,
        headers={"X-IDENTITY-HEADER": os.environ["IDENTITY_HEADER"]},
    )
    with _open(request, 30) as response:
        body = json.load(response)
    expires = float(body.get("expires_on") or (time.time() + 600))
    _TOKENS[resource] = (body["access_token"], expires - 300)
    return body["access_token"]


def _blob_url(name):
    return "https://%s.blob.core.windows.net/%s/%s" % (
        os.environ["EVAL_RESULTS_ACCOUNT"],
        os.environ["EVAL_RESULTS_CONTAINER"],
        urllib.parse.quote(name),
    )


def get_blob(name):
    request = urllib.request.Request(  # noqa: S310 - opened only via _open
        _blob_url(name),
        headers={
            "Authorization": "Bearer " + _token("https://storage.azure.com/"),
            "x-ms-version": "2021-08-06",
        },
    )
    with _open(request, 300) as response:
        return response.read()


def put_blob(name, data, content_type="text/plain"):
    for attempt in range(4):
        try:
            request = urllib.request.Request(  # noqa: S310 - opened only via _open
                _blob_url(name),
                data=data,
                method="PUT",
                headers={
                    "Authorization": "Bearer " + _token("https://storage.azure.com/"),
                    "x-ms-version": "2021-08-06",
                    "x-ms-blob-type": "BlockBlob",
                    "Content-Type": content_type,
                },
            )
            with _open(request, 120) as response:
                response.read()
            return
        except Exception:  # noqa: BLE001 - retried, then raised
            if attempt == 3:
                raise
            time.sleep(2**attempt)


def _verified(data, expected, what):
    digest = hashlib.sha256(data).hexdigest()
    if expected and digest != expected:
        raise SystemExit("%s sha256 mismatch: got %s" % (what, digest))
    return digest


def fetch_context():
    data = get_blob(os.environ["BUILD_CONTEXT_BLOB"])
    digest = _verified(data, os.environ.get("BUILD_CONTEXT_SHA256", ""), "context")
    os.makedirs("/workspace/ctx", exist_ok=True)
    os.makedirs("/workspace/out", exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        archive.extractall("/workspace/ctx", filter="data")
    registry = os.environ["REGISTRY"]
    form = urllib.parse.urlencode(
        {
            "grant_type": "access_token",
            "service": registry,
            "tenant": os.environ["AZURE_TENANT_ID"],
            "access_token": _token("https://management.azure.com/"),
        }
    ).encode()
    request = urllib.request.Request(  # noqa: S310 - opened only via _open
        "https://%s/oauth2/exchange" % registry,
        data=form,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with _open(request, 60) as response:
        refresh = json.load(response)["refresh_token"]
    login = base64.b64encode(("00000000-0000-0000-0000-000000000000:" + refresh).encode()).decode()
    os.makedirs("/kaniko/.docker", exist_ok=True)
    with open("/kaniko/.docker/config.json", "w") as handle:
        json.dump({"auths": {registry: {"auth": login}}}, handle)
    put_blob(
        os.environ["BUILD_LOG_PREFIX"] + "/fetch.json",
        json.dumps(
            {"context_sha256": digest, "bytes": len(data), "registry_login": "written"}
        ).encode(),
        "application/json",
    )


def upload_log():
    path = os.environ["LOG_PATH"]
    blob = os.environ["LOG_BLOB"]
    marker = os.environ.get("LOG_EXIT_MARKER", "KANIKO_EXIT=").encode()
    deadline = time.time() + float(os.environ.get("LOG_MAX_SECONDS", "10800"))
    last = None
    while time.time() < deadline:
        try:
            with open(path, "rb") as handle:
                data = handle.read()
        except FileNotFoundError:
            data = None
        if data is not None and data != last:
            put_blob(blob, data[-4_000_000:])
            last = data
        if data and marker in data:
            return
        time.sleep(20)


def run_lane():
    data = get_blob(os.environ["EVAL_DRIVERS_BLOB"])
    expected = os.environ["EVAL_DRIVERS_SHA256"]
    digest = _verified(data, expected, "drivers")
    root = "/tmp/eval-drivers"
    os.makedirs(root, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        archive.extractall(root, filter="data")
    os.environ["EVAL_DRIVERS_SHA256_VERIFIED"] = digest
    lane = os.path.join(root, "azure_model_eval", "lane.py")
    os.execv(sys.executable, [sys.executable, lane])  # noqa: S606 - verified driver, this interpreter


if __name__ == "__main__":
    {"fetch-context": fetch_context, "upload-log": upload_log, "run-lane": run_lane}[sys.argv[1]]()
