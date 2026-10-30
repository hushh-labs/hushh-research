"""Bounded namespace provisioning for fixed PLG targets, without app deployment."""

from __future__ import annotations

import base64
import json
import os
import re
import secrets
import shutil
import subprocess
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from qualification_target import (
    MIGRATOR_ROLE,
    MIGRATOR_SECRETS,
    PREFIX,
    RUNTIME_ROLE,
    RUNTIME_SECRETS,
    Target,
    config_bytes,
    require,
)


class CloudRequestError(RuntimeError):
    """Only nonsecret operation/status fields; never retain an API message."""

    def __init__(self, api: str, method: str, status: int, reasons=(), fields=()):
        super().__init__("qualification_cloud_request_refused")
        self.api, self.method, self.http_status = api, method, status
        self.reasons, self.fields = tuple(reasons), tuple(fields)

    def safe_details(self) -> dict:
        return {
            "api": self.api,
            "method": self.method,
            "httpStatus": self.http_status,
            "reasons": list(self.reasons),
            "fields": list(self.fields),
        }


def _request_failure(error: HTTPError, api: str, method: str) -> CloudRequestError:
    reasons, fields = set(), set()
    try:
        raw = error.read(16_385)
        body = json.loads(raw) if len(raw) <= 16_384 else {}
        detail = body.get("error", {})
        candidates = [detail.get("status")]
        for item in detail.get("details", [])[:10]:
            candidates.append(item.get("reason"))
            for violation in item.get("fieldViolations", [])[:10]:
                field = violation.get("field", "")
                if isinstance(field, str) and re.fullmatch(
                    r"[A-Za-z0-9_.\[\]\"-]{1,128}", field
                ):
                    fields.add(field)
        reasons = {
            value
            for value in candidates
            if isinstance(value, str) and re.fullmatch(r"[A-Z_]{1,64}", value)
        }
    except (AttributeError, TypeError, ValueError):
        pass  # Malformed/oversized diagnostics grant no additional information.
    return CloudRequestError(api, method, error.code, sorted(reasons), sorted(fields))


class Cloud:
    """The caller's normal cloud identity; no identity switch or key-file creation."""

    def __init__(self, target: Target):
        self.target = target
        token = os.environ.get("CLOUDSDK_AUTH_ACCESS_TOKEN", "").strip()
        if not token:
            cli = shutil.which("gcloud")
            require(cli is not None, "qualification_cloud_cli_required")
            result = subprocess.run(  # noqa: S603 -- resolved CLI and fixed credential arguments.
                [cli, "auth", "print-access-token", "--project=" + target.project],
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            require(
                result.returncode == 0 and bool(result.stdout.strip()),
                "qualification_cloud_identity_required",
            )
            token = result.stdout.strip()
        self._token = token
        project = self.request("cloudresourcemanager", "projects/" + target.project)
        require(
            project.get("projectId") == target.project
            and re.fullmatch(r"[0-9]+", str(project.get("projectNumber", ""))),
            "qualification_project_identity_unverified",
        )
        self.project_number = str(project["projectNumber"])

    def request(
        self,
        api: str,
        path: str,
        *,
        method="GET",
        body=None,
        missing=False,
        secret_id=None,
    ):
        require(
            api in {"iam", "secretmanager", "cloudresourcemanager"},
            "qualification_api_invalid",
        )
        parents = {"projects/" + self.target.project}
        if hasattr(self, "project_number"):
            parents.add("projects/" + self.project_number)
        require(
            any(path == parent or path.startswith(parent + "/") for parent in parents)
            and ".." not in path
            and "?" not in path,
            "qualification_cloud_target_invalid",
        )
        if secret_id is not None:
            require(
                api == "secretmanager"
                and method == "POST"
                and path == f"projects/{self.target.project}/secrets"
                and secret_id
                in {PREFIX + name for name in (*RUNTIME_SECRETS, *MIGRATOR_SECRETS)},
                "qualification_secret_creation_invalid",
            )
            path += "?secretId=" + secret_id
        request = Request(  # noqa: S310 -- fixed Google APIs and environment-local path.
            f"https://{api}.googleapis.com/v1/{path}",
            data=None if body is None else json.dumps(body).encode(),
            method=method,
            headers={
                "Authorization": "Bearer " + self._token,
                "Content-Type": "application/json",
                "x-goog-user-project": self.target.project,
            },
        )
        try:
            with urlopen(request, timeout=30) as response:  # noqa: S310 -- fixed Google APIs.
                raw = response.read(1024 * 1024 + 1)
        except HTTPError as error:
            try:
                if missing and error.code == 404 and method == "GET":
                    return None  # Only a missing read, never a failed write, admits creation.
                failure = _request_failure(error, api, method)
            finally:
                error.close()
            raise failure from None
        require(len(raw) <= 1024 * 1024, "qualification_cloud_response_too_large")
        result = json.loads(raw)
        require(isinstance(result, dict), "qualification_cloud_receipt_invalid")
        return result


def ensure_identity(cloud: Cloud, target: Target) -> None:
    name = f"projects/{target.project}/serviceAccounts/{target.runtime_sa}"
    record = cloud.request("iam", name, missing=True)
    display = "PLG isolated qualification runtime"
    if record is None:
        cloud.request(
            "iam",
            f"projects/{target.project}/serviceAccounts",
            method="POST",
            body={
                "accountId": "plg-qualification-runtime",
                "serviceAccount": {"displayName": display},
            },
        )
        record = cloud.request("iam", name)
    require(
        record.get("email") == target.runtime_sa
        and record.get("projectId") == target.project
        and record.get("displayName") == display
        and record.get("disabled", False) is False,
        "qualification_runtime_identity_unowned",
    )


def _secret_path(target: Target, name: str) -> str:
    require(
        name in (*RUNTIME_SECRETS, *MIGRATOR_SECRETS), "qualification_secret_invalid"
    )
    return f"projects/{target.project}/secrets/{PREFIX}{name}"


def _value(target: Target, name: str) -> bytes:
    fixed = {
        "DB_USER": RUNTIME_ROLE.encode(),
        "MIGRATOR_DB_USER": MIGRATOR_ROLE.encode(),
        "BACKEND_RUNTIME_CONFIG_JSON": config_bytes(target),
    }
    if name in fixed:
        return fixed[name]
    if name in {"APP_SIGNING_KEY", "VAULT_DATA_KEY"}:
        return secrets.token_hex(32).encode()
    return secrets.token_urlsafe(32).encode()


def _check_value(target: Target, name: str, value: bytes) -> None:
    if name in {"DB_USER", "MIGRATOR_DB_USER", "BACKEND_RUNTIME_CONFIG_JSON"}:
        require(value == _value(target, name), "qualification_secret_value_mismatch")
    elif name in {"APP_SIGNING_KEY", "VAULT_DATA_KEY"}:
        require(
            re.fullmatch(rb"[0-9a-f]{64}", value) is not None,
            "qualification_key_material_invalid",
        )
    else:
        require(
            re.fullmatch(rb"[A-Za-z0-9_-]{43}", value) is not None,
            "qualification_database_secret_invalid",
        )


def _secret_policy(cloud: Cloud, path: str, target: Target, *, runtime: bool) -> dict:
    policy = cloud.request("secretmanager", path + ":getIamPolicy")
    bindings = policy.get("bindings", [])
    require(
        not any(
            set(row.get("members", [])) & {"allUsers", "allAuthenticatedUsers"}
            for row in bindings
        ),
        "qualification_secret_public",
    )
    member = "serviceAccount:" + target.runtime_sa
    if not runtime:
        require(
            not any(member in row.get("members", []) for row in bindings),
            "qualification_migrator_runtime_access_present",
        )
    return policy


def _runtime_access(cloud: Cloud, path: str, target: Target) -> None:
    policy = _secret_policy(cloud, path, target, runtime=True)
    bindings = policy.get("bindings", [])
    member = "serviceAccount:" + target.runtime_sa
    owned = [
        row
        for row in bindings
        if row.get("role") == "roles/secretmanager.secretAccessor"
        and not row.get("condition")
    ]
    if not any(member in row.get("members", []) for row in owned):
        bindings.append(
            {"role": "roles/secretmanager.secretAccessor", "members": [member]}
        )
        cloud.request(
            "secretmanager",
            path + ":setIamPolicy",
            method="POST",
            body={"policy": policy | {"bindings": bindings}},
        )


def ensure_secret(cloud: Cloud, target: Target, name: str) -> tuple[str, bytes]:
    path = _secret_path(target, name)
    record = cloud.request("secretmanager", path, missing=True)
    if record is None:
        cloud.request(
            "secretmanager",
            f"projects/{target.project}/secrets",
            method="POST",
            secret_id=PREFIX + name,
            body={"replication": {"automatic": {}}, "labels": target.labels},
        )
        record = cloud.request("secretmanager", path)
    aliases = {path, f"projects/{cloud.project_number}/secrets/{PREFIX}{name}"}
    require(
        record.get("name") in aliases and record.get("labels") == target.labels,
        "qualification_existing_secret_unowned",
    )
    path = record["name"]
    # Refuse a public or cross-duty policy before generating/publishing a new
    # version or accessing an existing credential. Grants remain runtime-only.
    _secret_policy(cloud, path, target, runtime=name in RUNTIME_SECRETS)
    version = cloud.request("secretmanager", path + "/versions/latest", missing=True)
    if version is None:
        value = _value(target, name)
        version = cloud.request(
            "secretmanager",
            path + ":addVersion",
            method="POST",
            body={"payload": {"data": base64.b64encode(value).decode()}},
        )
    require(
        version.get("state") == "ENABLED"
        and re.fullmatch(
            re.escape(path) + r"/versions/[1-9][0-9]*", version.get("name", "")
        )
        is not None,
        "qualification_enabled_secret_version_required",
    )
    accessed = cloud.request("secretmanager", version["name"] + ":access")
    require(
        accessed.get("name") == version["name"], "qualification_secret_version_changed"
    )
    value = base64.b64decode(accessed.get("payload", {}).get("data", ""), validate=True)
    _check_value(target, name, value)
    if name in RUNTIME_SECRETS:
        _runtime_access(cloud, path, target)
    return version["name"].rsplit("/", 1)[-1], value


def ensure_resources(cloud: Cloud, target: Target) -> tuple[dict, dict]:
    """Values remain in process memory; only the version map is reportable.

    Existing enabled versions are reused, never rotated. Unknown write outcomes
    must be reconciled by reading the exact fixed resource before retry.
    """
    ensure_identity(cloud, target)
    versions, values = {}, {}
    for name in (*RUNTIME_SECRETS, *MIGRATOR_SECRETS):
        versions[name], values[name] = ensure_secret(cloud, target, name)
    return versions, values
