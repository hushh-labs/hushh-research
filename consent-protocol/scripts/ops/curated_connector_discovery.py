"""Reviewed public-client metadata admission, without registration effects."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import urlsplit

from hushh_mcp.services.curated_connector_manifest import (
    CuratedConnectorManifest,
    CuratedConnectorRegistrationSpec,
)
from hushh_mcp.services.mcp_oauth_metadata import authorization_server_metadata_url
from hushh_mcp.services.mcp_public_http import UnsafeMcpEndpoint, validate_mcp_endpoint

RegistrationContract = CuratedConnectorManifest | CuratedConnectorRegistrationSpec
GetJson = Callable[[str], Awaitable[dict[str, Any]]]


class DiscoveryError(ValueError):
    pass


def metadata_tokens(value: Any) -> frozenset[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        return frozenset()
    return frozenset(value)


def _registration_problem(endpoint: str, expected: str | None) -> str | None:
    if not endpoint:
        return "no registration_endpoint (register the app in the provider dashboard)"
    try:
        validate_mcp_endpoint(endpoint)
    except UnsafeMcpEndpoint:
        return "registration_endpoint is not a public HTTPS endpoint"
    if endpoint != expected:
        return "registration_endpoint differs from the manifest"
    return None


async def registration_endpoint(manifest: RegistrationContract, *, get_json: GetJson) -> str:
    parts = urlsplit(manifest.mcp_endpoint)
    origin = f"{parts.scheme}://{parts.netloc}"
    issuer = manifest.oauth_issuer or origin
    if manifest.oauth_issuer is not None:
        protected = await get_json(f"{origin}/.well-known/oauth-protected-resource")
        if protected.get("resource") != manifest.mcp_endpoint or protected.get(
            "authorization_servers"
        ) != [issuer]:
            raise DiscoveryError("Protected resource differs from the reviewed issuer pin.")
    metadata = await get_json(authorization_server_metadata_url(issuer))
    problems: list[str] = []
    for name, expected in (
        ("issuer", issuer),
        ("authorization_endpoint", manifest.authorize_url),
        ("token_endpoint", manifest.token_url),
    ):
        if metadata.get(name) != expected:
            problems.append(f"{name} differs from the manifest")
    if "S256" not in metadata_tokens(metadata.get("code_challenge_methods_supported")):
        problems.append("S256 PKCE is not advertised")
    if manifest.token_endpoint_auth not in metadata_tokens(
        metadata.get("token_endpoint_auth_methods_supported")
    ):
        problems.append(f"token auth method {manifest.token_endpoint_auth!r} is not advertised")
    endpoint = str(metadata.get("registration_endpoint") or "").strip()
    problem = _registration_problem(endpoint, manifest.registration_url)
    if problem:
        problems.append(problem)
    if problems:
        raise DiscoveryError("Metadata check failed: " + "; ".join(problems) + ".")
    return endpoint
