"""Raw-body signature and endpoint-scope admission through an explicit SDK port."""

from __future__ import annotations

from typing import Any, Callable

from .stripe_adapter import CommerceProviderError, provider_dict


def _verified_event(
    construct_event: Callable[..., Any], payload: bytes, signature: str, secret: str
) -> dict[str, Any] | None:
    try:
        return provider_dict(construct_event(payload, signature, secret, tolerance=300))
    except Exception:
        return None


def verify_scoped_signature(
    *,
    payload: bytes,
    signature: str | None,
    platform_secret: str,
    connect_secret: str,
    mode: str,
    construct_event: Callable[..., Any],
    allow_cli: bool,
) -> dict[str, Any]:
    if not isinstance(payload, bytes) or not signature:
        raise CommerceProviderError("provider_invalid_signature")
    if (
        mode not in {"endpoints", "cli"}
        or (mode == "cli" and not allow_cli)
        or (connect_secret and connect_secret == platform_secret)
    ):
        raise CommerceProviderError("provider_configuration_invalid")
    secrets = [(platform_secret, False)]
    if connect_secret:
        secrets.append((connect_secret, True))
    for secret, connected in secrets:
        event = _verified_event(construct_event, payload, signature, secret)
        if event is None:
            continue
        # Scope follows the successfully verified secret, not unverified JSON.
        if mode != "cli" and bool(event.get("account")) != connected:
            raise CommerceProviderError("provider_invalid_event")
        return event
    raise CommerceProviderError("provider_invalid_signature")
