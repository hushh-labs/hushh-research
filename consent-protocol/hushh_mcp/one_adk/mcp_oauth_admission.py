"""Pure metadata admission for the existing request-only SDK OAuth owner."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

from mcp.shared.auth import OAuthMetadata

from hushh_mcp.services.mcp_public_http import validate_mcp_endpoint


def admitted_authorization_metadata(
    payload: dict[str, Any],
    *,
    advertised_issuer: str | None,
    registered_issuer: str | None,
    source_url: str,
) -> tuple[OAuthMetadata, dict[str, str], bool]:
    if advertised_issuer is None or payload.get("issuer") != advertised_issuer:
        raise ValueError("Authorization issuer changed.")
    if registered_issuer is not None:
        # A resource server cannot impersonate a registered issuer in JSON.
        source, authority = urlsplit(source_url), urlsplit(advertised_issuer)
        if (source.scheme, source.netloc) != (authority.scheme, authority.netloc):
            raise ValueError("Authorization metadata source changed.")
    if "S256" not in (payload.get("code_challenge_methods_supported") or []):
        raise ValueError("PKCE is required.")
    # Complete SDK validation prevents malformed optional fields from causing
    # SDK fallback after a partial raw-JSON whitelist appeared to authorize it.
    metadata = OAuthMetadata.model_validate(payload)
    endpoints: dict[str, str] = {}
    for key in ("authorization_endpoint", "token_endpoint", "registration_endpoint"):
        value = payload.get(key)
        if value is None and key == "registration_endpoint":
            continue
        if not isinstance(value, str):
            raise ValueError("Authorization endpoint missing.")
        validate_mcp_endpoint(value)
        endpoints[key] = value
    requires_issuer = payload.get("authorization_response_iss_parameter_supported", False)
    if not isinstance(requires_issuer, bool):
        raise ValueError("Invalid issuer response contract.")
    return metadata, endpoints, requires_issuer
