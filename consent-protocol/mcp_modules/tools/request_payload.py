"""Backend request serialization for consent tools; public key material only.

Transport-owned key custody is injected. This module creates no consent, quote,
payment or recipient registration and never returns a private key.
"""

from __future__ import annotations

from typing import Any, Callable


def negotiation_offer(args: dict[str, Any]) -> dict[str, Any] | None:
    offer = args.get("offer")
    if not isinstance(offer, dict) and any(
        args.get(key) is not None
        for key in ("offer_amount", "offer_currency", "offer_summary", "settlement_ref")
    ):
        offer = {
            "bid_amount": args.get("offer_amount"),
            "currency": args.get("offer_currency") or "USD",
            "offer_summary": args.get("offer_summary"),
            "settlement_ref": args.get("settlement_ref"),
        }
    return offer if isinstance(offer, dict) else None


def recipient_key_bundle(
    args: dict[str, Any], *, scope: str, local_stdio: bool, keypair_factory: Callable[[], Any]
) -> dict[str, str]:
    connector_public_key = str(args.get("connector_public_key") or "").strip()
    connector_key_id = str(args.get("connector_key_id") or "").strip()
    connector_wrapping_alg = str(args.get("connector_wrapping_alg") or "").strip()
    if (
        scope.startswith("attr.")
        and local_stdio
        and not all((connector_public_key, connector_key_id, connector_wrapping_alg))
    ):
        keypair = keypair_factory()
        connector_public_key = keypair.public_key_b64
        connector_key_id = keypair.key_id
        connector_wrapping_alg = keypair.wrapping_alg
    if scope.startswith("attr.") and all(
        (connector_public_key, connector_key_id, connector_wrapping_alg)
    ):
        return {
            "connector_public_key": connector_public_key,
            "connector_key_id": connector_key_id,
            "connector_wrapping_alg": connector_wrapping_alg,
        }
    return {}


def consent_request_body(
    args: dict[str, Any],
    *,
    identifier: str,
    scope: str,
    local_stdio: bool,
    keypair_factory: Callable[[], Any],
) -> dict[str, Any]:
    body = {
        "user_identifier": identifier,
        "scope": scope,
        "purpose": str(args.get("purpose") or "").strip(),
        "expiry_hours": int(args.get("expiry_hours") or 24),
        "approval_timeout_minutes": int(args.get("approval_timeout_minutes") or 1440),
        "refresh_policy": str(args.get("refresh_policy") or "snapshot"),
        **(
            {"country_iso2": str(args.get("country_iso2")).strip()}
            if args.get("country_iso2")
            else {}
        ),
        **({"country": str(args.get("country")).strip()} if args.get("country") else {}),
    }
    offer = negotiation_offer(args)
    if offer is not None:
        body["offer"] = offer
    body.update(
        recipient_key_bundle(
            args, scope=scope, local_stdio=local_stdio, keypair_factory=keypair_factory
        )
    )
    return body
