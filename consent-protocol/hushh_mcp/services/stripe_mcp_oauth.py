"""Official Stripe OAuth pins, shared by browser connection and pod custody.

The reviewed registration contract owns endpoints. These checks admit no
account tools and never turn a successful OAuth exchange into account proof.
"""

from __future__ import annotations

from typing import Any

from hushh_mcp.services.mcp_oauth_metadata import authorization_server_metadata_url
from hushh_mcp.services.stripe_mcp_policy import (
    STRIPE_MCP_ENDPOINT,
    STRIPE_OAUTH_ISSUER,
    official_stripe_endpoint,
)


def require_stripe_registered_client(
    endpoint: str, *, issuer: str, auth_method: str, client_secret: str | None
) -> None:
    if official_stripe_endpoint(endpoint) and (
        issuer != STRIPE_OAUTH_ISSUER or auth_method != "none" or client_secret is not None
    ):
        raise ValueError("Stripe requires its reviewed public OAuth registration.")


def _advertises(payload: dict[str, Any], field: str, expected: str) -> bool:
    values = payload.get(field)
    return (
        isinstance(values, list)
        and all(isinstance(value, str) for value in values)
        and expected in values
    )


def require_stripe_metadata(endpoint: str, source_url: str, payload: dict[str, Any]) -> None:
    if not official_stripe_endpoint(endpoint):
        return
    if "authorization_servers" in payload:
        if (
            source_url != f"{STRIPE_MCP_ENDPOINT}/.well-known/oauth-protected-resource"
            or payload.get("resource") != STRIPE_MCP_ENDPOINT
            or payload.get("authorization_servers") != [STRIPE_OAUTH_ISSUER]
        ):
            raise ValueError("Stripe protected resource changed.")
        return
    from hushh_mcp.services.curated_connector_manifest import (
        get_manifest,
        get_registration_spec,
        manifest_errors,
        registration_spec_errors,
    )

    contract = get_manifest("stripe") or get_registration_spec("stripe")
    if (
        "stripe.json" in manifest_errors()
        or "stripe.json" in registration_spec_errors()
        or contract is None
        or contract.oauth_issuer != STRIPE_OAUTH_ISSUER
        or contract.mcp_endpoint != STRIPE_MCP_ENDPOINT
        or source_url != authorization_server_metadata_url(STRIPE_OAUTH_ISSUER)
    ):
        raise ValueError("Stripe authorization metadata source changed.")
    pins = {
        "issuer": contract.oauth_issuer,
        "authorization_endpoint": contract.authorize_url,
        "token_endpoint": contract.token_url,
        "registration_endpoint": contract.registration_url,
    }
    if (
        any(payload.get(key) != value for key, value in pins.items())
        or not _advertises(payload, "code_challenge_methods_supported", "S256")
        or not _advertises(payload, "token_endpoint_auth_methods_supported", "none")
    ):
        raise ValueError("Stripe authorization metadata changed.")
