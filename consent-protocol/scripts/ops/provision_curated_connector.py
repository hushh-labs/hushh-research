#!/usr/bin/env python3
"""Provision a curated OAuth MCP connector from its reviewed manifest.

A provider is described once, in `config/curated_connectors/<id>.json`. This
script does the operator steps around it:

    status   <id>                     read-only: manifest, secrets, and the registry row
    register <id> --env uat [...]     register a public OAuth client (dynamic client
                                      registration) for a `tokenEndpointAuth: none`
                                      provider, and store its client id
    apply    <id> --env uat           write the registry row (configure_external_mcp_connector)

Adding a provider then looks like:
    1. write config/curated_connectors/<id>.json and open a PR (review is the gate)
    2. python3 scripts/ops/provision_curated_connector.py register <id> --env uat --store --dry-run
       (inspect the exact request), then again without --dry-run
    3. python3 scripts/ops/provision_curated_connector.py apply <id> --env uat --operator you@hushh.ai
    4. merge; the next deploy mounts the secrets derived from the manifests

For a public provider whose authenticated tool list is not known yet, write a
registration-only spec in config/curated_connector_registrations/<id>.json.
`register` and `status` may use that spec, but it is deliberately excluded from
the runtime catalog, registry apply, and deploy-secret list. Use a separately
authorized MCP client to sign in and capture tools/list, then replace the spec
with the reviewed runtime manifest before applying or deploying the provider.

Confidential providers (`client_secret_post`, for example HubSpot) need their app
created by hand in the provider's dashboard; store the two values with
`gcloud secrets create` using the names in the manifest, then run `apply`.

A registered client id is per environment and is never regenerated silently:
registering again would orphan every existing grant, so `register` refuses when
the secret already exists unless `--force` is passed.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import httpx  # noqa: E402

from hushh_mcp.services.curated_connector_manifest import (  # noqa: E402
    CuratedConnectorManifest,
    CuratedConnectorManifestError,
    CuratedConnectorRegistrationSpec,
    get_manifest,
    get_registration_spec,
    manifest_errors,
    registration_spec_errors,
)
from hushh_mcp.services.mcp_public_http import (  # noqa: E402
    McpResponseLimitError,
    UnsafeMcpEndpoint,
    create_public_mcp_http_client,
    validate_mcp_endpoint,
)

CLIENT_NAME = "Hushh One"
DEFAULT_PROJECT = {"uat": "hushh-pda-uat"}
_RESPONSE_LIMIT = 64 * 1024
_LOCAL_WEB_RETURN_PATH = "/one/profile/connectors/oauth/return"
_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
# A client id travels in authorization URLs and lands in .env and Secret Manager,
# so anything outside this shape is refused rather than written anywhere.
_CLIENT_ID = re.compile(r"^[A-Za-z0-9._~-]{4,256}$")


class ProvisionError(RuntimeError):
    pass


RegistrationContract = CuratedConnectorManifest | CuratedConnectorRegistrationSpec


def _origin(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


def _metadata_tokens(value: Any) -> frozenset[str]:
    """Return exact OAuth metadata tokens, never substring-match a string."""
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        return frozenset()
    return frozenset(value)


def require_manifest(connector_id: str) -> CuratedConnectorManifest:
    manifest = get_manifest(connector_id)
    if manifest is None:
        if get_registration_spec(connector_id) is not None:
            raise ProvisionError(
                f"{connector_id!r} has a registration-only spec and cannot be applied. "
                "Capture authenticated tools/list and add its runtime manifest first."
            )
        detail = manifest_errors()
        raise ProvisionError(
            f"No valid manifest for {connector_id!r} in config/curated_connectors/."
            + (f" Errors: {detail}" if detail else "")
        )
    return manifest


def require_registration_contract(connector_id: str) -> RegistrationContract:
    """Return a runtime manifest or a registration-only public PKCE contract.

    The latter is intentionally valid only for `register` and `status`: it
    cannot be applied to the registry or loaded by the runtime before an
    authenticated tools/list establishes a reviewed tool policy.
    """
    manifest = get_manifest(connector_id)
    if manifest is not None:
        return manifest
    runtime_errors = manifest_errors()
    if f"{connector_id}.json" in runtime_errors:
        raise ProvisionError(
            f"The runtime manifest for {connector_id!r} is invalid: "
            f"{runtime_errors[f'{connector_id}.json']}"
        )
    spec = get_registration_spec(connector_id)
    if spec is not None:
        return spec
    details = registration_spec_errors()
    raise ProvisionError(
        f"No valid runtime manifest or registration-only spec for {connector_id!r}."
        + (f" Registration-spec errors: {details}" if details else "")
    )


async def _get_json(url: str) -> dict[str, Any]:
    try:
        validate_mcp_endpoint(url)
    except UnsafeMcpEndpoint:
        raise ProvisionError(f"{url} is not a public HTTPS endpoint.") from None
    try:
        async with create_public_mcp_http_client(
            timeout=httpx.Timeout(15), max_response_bytes=_RESPONSE_LIMIT
        ) as client:
            response = await client.get(url, headers={"Accept": "application/json"})
    except (httpx.HTTPError, McpResponseLimitError, UnsafeMcpEndpoint) as error:
        raise ProvisionError(f"Could not read {url}: {type(error).__name__}.") from None
    if response.status_code != 200:
        raise ProvisionError(f"{url} answered {response.status_code}.")
    try:
        parsed = response.json()
    except ValueError:
        raise ProvisionError(f"{url} did not return JSON.") from None
    if not isinstance(parsed, dict):
        raise ProvisionError(f"{url} did not return a JSON object.")
    return parsed


async def discover_registration_endpoint(manifest: RegistrationContract) -> str:
    """Read the provider's authorization-server metadata and check it still agrees
    with the reviewed manifest before anything is sent to it."""
    origin = _origin(manifest.mcp_endpoint)
    metadata = await _get_json(f"{origin}/.well-known/oauth-authorization-server")
    problems: list[str] = []
    if metadata.get("issuer") != origin:
        problems.append(f"issuer {metadata.get('issuer')!r} is not {origin!r}")
    if metadata.get("authorization_endpoint") != manifest.authorize_url:
        problems.append("authorization_endpoint differs from the manifest")
    if metadata.get("token_endpoint") != manifest.token_url:
        problems.append("token_endpoint differs from the manifest")
    if "S256" not in _metadata_tokens(metadata.get("code_challenge_methods_supported")):
        problems.append("S256 PKCE is not advertised")
    methods = _metadata_tokens(metadata.get("token_endpoint_auth_methods_supported"))
    if manifest.token_endpoint_auth not in methods:
        problems.append(f"token auth method {manifest.token_endpoint_auth!r} is not advertised")
    endpoint = str(metadata.get("registration_endpoint") or "").strip()
    if not endpoint:
        problems.append("no registration_endpoint (register the app in the provider dashboard)")
    else:
        try:
            validate_mcp_endpoint(endpoint)
        except UnsafeMcpEndpoint:
            problems.append("registration_endpoint is not a public HTTPS endpoint")
        else:
            # Attio's authorization server lives on app.attio.com while its
            # protected MCP resource and metadata live on mcp.attio.com. A
            # same-origin rule would reject that legitimate layout; accepting
            # any cross-origin endpoint would instead turn live metadata into
            # an unreviewed registration target. Exact manifest equality is
            # the reviewed binding for both layouts.
            if endpoint != manifest.registration_url:
                problems.append("registration_endpoint differs from the manifest")
    if problems:
        raise ProvisionError("Metadata check failed: " + "; ".join(problems) + ".")
    return endpoint


def _local_development_redirect(value: Any) -> str:
    """Validate the one unreviewed redirect shape allowed for local testing.

    UAT redirects are checked into the manifest. The only exception is a local
    frontend's canonical callback, which the runtime itself permits in a
    development process. It may never be an arbitrary HTTPS URL, because a
    dynamic public client would otherwise permanently register a callback that
    was not reviewed with the provider contract.
    """
    candidate = value.strip() if isinstance(value, str) else ""
    try:
        parts = urlsplit(candidate)
        port = parts.port
    except ValueError:
        raise ProvisionError(
            "--extra-redirect must be an HTTP loopback OAuth return address."
        ) from None
    if (
        parts.scheme != "http"
        or parts.hostname not in _LOOPBACK_HOSTS
        or parts.username is not None
        or parts.password is not None
        or parts.path != _LOCAL_WEB_RETURN_PATH
        or parts.query
        or parts.fragment
        or (port is not None and not 1 <= port <= 65535)
    ):
        raise ProvisionError("--extra-redirect must be an HTTP loopback OAuth return address.")
    return candidate


def build_registration_request(
    manifest: RegistrationContract, environment: str, extra_redirects: list[str]
) -> dict[str, Any]:
    if not manifest.is_public_client:
        raise ProvisionError(
            f"{manifest.connector_id} is a confidential client; create its app in the provider's "
            "dashboard and store its client id and secret instead."
        )
    reviewed_redirects = manifest.redirect_uris.get(environment)
    if not reviewed_redirects:
        raise ProvisionError(f"No redirect addresses for environment {environment!r}.")
    redirects = [
        *reviewed_redirects,
        *(_local_development_redirect(uri) for uri in extra_redirects),
    ]
    return {
        "client_name": CLIENT_NAME,
        "redirect_uris": redirects,
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        **({"scope": " ".join(manifest.scopes)} if manifest.scopes else {}),
    }


async def register_client(endpoint: str, request: dict[str, Any]) -> dict[str, Any]:
    try:
        validate_mcp_endpoint(endpoint)
    except UnsafeMcpEndpoint:
        raise ProvisionError("The registration endpoint is not a public HTTPS endpoint.") from None
    try:
        async with create_public_mcp_http_client(
            timeout=httpx.Timeout(20), max_response_bytes=_RESPONSE_LIMIT
        ) as client:
            response = await client.post(
                endpoint, json=request, headers={"Accept": "application/json"}
            )
    except (httpx.HTTPError, McpResponseLimitError, UnsafeMcpEndpoint) as error:
        # The request may have reached the provider before this failed, so a
        # client may already exist there. Say so instead of inviting a blind retry.
        raise ProvisionError(
            f"The registration request failed ({type(error).__name__}) and may have reached "
            "the provider, so a client may already exist. Check the provider before retrying."
        ) from None
    try:
        body = response.json()
    except ValueError:
        body = {}
    if response.status_code not in (200, 201) or not isinstance(body, dict):
        code = body.get("error") if isinstance(body, dict) else None
        detail = body.get("error_description") if isinstance(body, dict) else None
        raise ProvisionError(
            f"Registration failed ({response.status_code}): {code} {detail}".strip()
        )
    client_id = body.get("client_id")
    if not isinstance(client_id, str) or not client_id.strip():
        raise ProvisionError("The provider returned no client_id.")
    if not _CLIENT_ID.match(client_id.strip()):
        raise ProvisionError(
            "The provider returned a client_id of an unexpected shape; nothing has been stored."
        )
    if body.get("client_secret"):
        raise ProvisionError(
            "The provider issued a client secret for a public-client request; refusing to "
            "continue. Nothing has been stored."
        )
    return body


def _gcloud(*args: str, stdin: str | None = None) -> subprocess.CompletedProcess[str]:
    binary = shutil.which("gcloud")
    if not binary:
        raise ProvisionError("gcloud is not installed or not on PATH.")
    return subprocess.run(  # noqa: S603 - fixed binary, argument list, no shell
        [binary, *args], input=stdin, capture_output=True, text=True, check=False, timeout=120
    )


def secret_state(name: str, project: str) -> str:
    """'missing', 'empty' (no usable latest version), 'disabled' or 'ready'.

    Only a definite NOT_FOUND reads as missing. An auth, permission or network
    failure raises instead, so it can never be mistaken for "safe to register"."""
    described = _gcloud("secrets", "describe", name, f"--project={project}")
    if described.returncode != 0:
        if "NOT_FOUND" in described.stderr:
            return "missing"
        raise ProvisionError(
            f"Could not check secret {name} in {project}: {described.stderr.strip()[:300]}"
        )
    version = _gcloud(
        "secrets",
        "versions",
        "describe",
        "latest",
        f"--secret={name}",
        f"--project={project}",
        "--format=value(state)",
    )
    if version.returncode != 0:
        if "NOT_FOUND" in version.stderr:
            return "empty"
        raise ProvisionError(
            f"Could not check the latest version of {name}: {version.stderr.strip()[:300]}"
        )
    return "ready" if version.stdout.strip() == "ENABLED" else "disabled"


def secret_exists(name: str, project: str) -> bool:
    """True when the secret holds (or held) a value; registering again would orphan it."""
    return secret_state(name, project) in {"ready", "disabled"}


def store_secret(name: str, value: str, project: str) -> None:
    """Create the secret if needed and add the value as a new version (via stdin,
    so it never appears in a process list). A secret this call created is removed
    again if the value cannot be stored, so no empty shell is left behind."""
    created_here = secret_state(name, project) == "missing"
    if created_here:
        created = _gcloud(
            "secrets", "create", name, f"--project={project}", "--replication-policy=automatic"
        )
        if created.returncode != 0:
            raise ProvisionError(f"Could not create secret {name}: {created.stderr.strip()[:300]}")
    added = _gcloud(
        "secrets", "versions", "add", name, f"--project={project}", "--data-file=-", stdin=value
    )
    if added.returncode != 0:
        if created_here:
            _gcloud("secrets", "delete", name, f"--project={project}", "--quiet")
        raise ProvisionError(f"Could not store {name}: {added.stderr.strip()[:300]}")


def _env_assignment(name: str) -> re.Pattern[str]:
    return re.compile(rf"^\s*(?:export\s+)?{re.escape(name)}\s*=")


def upsert_env_file(path: Path, name: str, value: str) -> None:
    text = path.read_text(encoding="utf-8-sig") if path.exists() else ""
    lines = text.splitlines()
    pattern = _env_assignment(name)
    updated = [f"{name}={value}" if pattern.match(line) else line for line in lines]
    if not any(pattern.match(line) for line in lines):
        updated.append(f"{name}={value}")
    # Replace the file atomically so an interrupted write cannot truncate it.
    handle, temp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as temp:
            temp.write("\n".join(updated) + "\n")
        os.replace(temp_name, path)
    except BaseException:
        Path(temp_name).unlink(missing_ok=True)
        raise


def env_file_has(path: Path, name: str) -> bool:
    if not path.exists():
        return False
    pattern = re.compile(_env_assignment(name).pattern + r"\s*\S")
    return any(pattern.match(line) for line in path.read_text(encoding="utf-8-sig").splitlines())


async def cmd_register(args: argparse.Namespace) -> dict[str, Any]:
    manifest = require_registration_contract(args.connector_id)
    project = args.project or DEFAULT_PROJECT.get(args.env)
    request = build_registration_request(manifest, args.env, args.extra_redirect or [])
    endpoint = await discover_registration_endpoint(manifest)
    summary: dict[str, Any] = {
        "connectorId": manifest.connector_id,
        "registrationEndpoint": endpoint,
        "request": request,
        "clientIdVariable": manifest.client_id_env,
    }
    if args.store and not project:
        # Checked before anything is sent: a client registered and then not storable is lost.
        raise ProvisionError("--project is required with --store for this environment.")
    if not args.force:
        if args.store and secret_exists(manifest.client_id_env, project):
            raise ProvisionError(
                f"{manifest.client_id_env} already exists in {project}. Registering again would "
                "orphan every existing grant; pass --force only if that is intended."
            )
        if args.local_env_file and env_file_has(Path(args.local_env_file), manifest.client_id_env):
            raise ProvisionError(
                f"{manifest.client_id_env} is already set in {args.local_env_file}; pass --force "
                "to replace it."
            )
    if args.dry_run:
        return {**summary, "dryRun": True}
    body = await register_client(endpoint, request)
    client_id = body["client_id"].strip()
    stored: list[str] = []
    try:
        if args.store:
            store_secret(manifest.client_id_env, client_id, project)
            stored.append(f"secret {manifest.client_id_env} in {project}")
        if args.local_env_file:
            upsert_env_file(Path(args.local_env_file), manifest.client_id_env, client_id)
            stored.append(f"{manifest.client_id_env} in {args.local_env_file}")
    except (ProvisionError, OSError) as error:
        # The client now exists at the provider. Its id is public, so print it and
        # how to save it rather than losing it.
        raise ProvisionError(
            f"The provider created client {client_id} but storing it failed: {error}. "
            f"Save it manually as {manifest.client_id_env} (already stored: {stored or 'nothing'})."
        ) from None
    # The client id is a public identifier (it appears in every authorization URL).
    return {**summary, "clientId": client_id, "stored": stored}


def cmd_status(args: argparse.Namespace) -> dict[str, Any]:
    manifest = require_registration_contract(args.connector_id)
    project = args.project or DEFAULT_PROJECT.get(args.env)
    report: dict[str, Any] = {
        "connectorId": manifest.connector_id,
        "runtimeManifest": isinstance(manifest, CuratedConnectorManifest),
        "registrationOnly": isinstance(manifest, CuratedConnectorRegistrationSpec),
        "publicClient": manifest.is_public_client,
        "environments": sorted(manifest.redirect_uris),
    }
    if isinstance(manifest, CuratedConnectorManifest):
        report["tools"] = {
            "allowlist": len(manifest.tool_allowlist),
            "freeRead": len(manifest.free_read_tools),
        }
    else:
        report["toolsPendingDiscovery"] = True
    if project:
        report["project"] = project
        states = {name: secret_state(name, project) for name in manifest.secret_env_names}
        report["secrets"] = states
        registration_ready = all(state == "ready" for state in states.values())
        report["registrationReady"] = registration_ready
        # A stored public client id is sufficient to perform the controlled
        # discovery sign-in, not to mount a runtime credential or serve MCP.
        # Never make bootstrap state look deploy/runtime-ready.
        report["ready"] = registration_ready and isinstance(manifest, CuratedConnectorManifest)
    return report


def cmd_apply(args: argparse.Namespace) -> dict[str, Any]:
    manifest = require_manifest(args.connector_id)
    from scripts.ops import configure_external_mcp_connector as cli

    path = ROOT / "config" / "curated_connectors" / f"{manifest.connector_id}.json"
    descriptor = cli.load_descriptor(str(path), environment=args.env)
    return cli._apply(descriptor, operator=args.operator)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("status", "register", "apply"):
        command = sub.add_parser(name)
        command.add_argument("connector_id")
        command.add_argument("--env", default="uat")
        command.add_argument("--project", default=None)
    register = sub.choices["register"]
    register.add_argument(
        "--dry-run", action="store_true", help="show the exact request; send nothing"
    )
    register.add_argument(
        "--store", action="store_true", help="store the client id in Secret Manager"
    )
    register.add_argument("--local-env-file", help="also write the client id to this .env file")
    register.add_argument(
        "--extra-redirect",
        action="append",
        help="additional redirect address (for example a local one)",
    )
    register.add_argument("--force", action="store_true")
    sub.choices["apply"].add_argument("--operator", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "register":
            result = asyncio.run(cmd_register(args))
        elif args.command == "status":
            result = cmd_status(args)
        else:
            result = cmd_apply(args)
    except (ProvisionError, CuratedConnectorManifestError) as error:
        print(json.dumps({"status": "error", "message": str(error)}), file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    os.environ.setdefault("PYTHONUTF8", "1")
    raise SystemExit(main())
