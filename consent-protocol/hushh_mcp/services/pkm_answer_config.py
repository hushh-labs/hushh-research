"""Answer-only Stripe credentials and rollout; never changes Drive mode."""

from __future__ import annotations

import os
from urllib.parse import urlsplit

from hushh_mcp.runtime_settings import get_app_runtime_settings
from hushh_mcp.services.stripe_mode import configured_stripe_mode, stripe_environment


def answer_stripe_mode() -> str:
    mode = (os.getenv("PKM_ANSWER_STRIPE_MODE") or configured_stripe_mode()).strip().lower()
    if mode not in {"test", "live"} or (stripe_environment() == "production" and mode != "live"):
        raise ValueError("answer_stripe_mode_invalid")
    return mode


def answer_composer_enabled() -> bool:
    enabled = (os.getenv("PKM_ANSWER_COMPOSER_ENABLED") or "").strip().lower() == "true"
    if not enabled:
        return False
    if answer_stripe_mode() == "live":
        return (os.getenv("PKM_ANSWER_LIVE_PROVIDER_REVIEWED") or "").strip().lower() == "true"
    return True


def answer_payment_config(mode: str | None = None) -> tuple[str, str, str]:
    selected = answer_stripe_mode()
    mode = selected if mode is None else mode
    if mode not in {"test", "live"}:
        raise ValueError("answer_payment_unavailable")
    key = (os.getenv(f"PKM_ANSWER_STRIPE_{mode.upper()}_SECRET_KEY") or "").strip()
    secret = (os.getenv(f"PKM_ANSWER_STRIPE_{mode.upper()}_WEBHOOK_SECRET") or "").strip()
    if mode == selected:
        key = key or (os.getenv("PKM_ANSWER_STRIPE_SECRET_KEY") or "").strip()
        secret = secret or (os.getenv("PKM_ANSWER_STRIPE_WEBHOOK_SECRET") or "").strip()
    # Compatibility for existing sandbox deployments only. Live requires its
    # own bindings; changing this lane cannot change Drive's mode or key.
    if mode == "test" and configured_stripe_mode() == "test" and not key and not secret:
        key = (os.getenv("STRIPE_SECRET_KEY") or "").strip()
        secret = (os.getenv("STRIPE_WEBHOOK_SECRET") or "").strip()
    origin = get_app_runtime_settings().app_frontend_origin.rstrip("/")
    parsed = urlsplit(origin)
    local_test = (
        mode == "test"
        and (os.getenv("ENVIRONMENT") or "").lower() in {"development", "local"}
        and parsed.scheme == "http"
        and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    )
    if (
        not key.startswith(f"sk_{mode}_")
        or len(key) < 24
        or not secret.startswith("whsec_")
        or len(secret) < 20
        or (parsed.scheme != "https" and not local_test)
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("answer_payment_unavailable")
    return key, secret, origin


def available_answer_payment_modes() -> tuple[str, ...]:
    """Only claim financial work whose stored mode has usable credentials."""
    modes = []
    for mode in ("test", "live"):
        try:
            answer_payment_config(mode)
        except ValueError:
            continue
        modes.append(mode)
    return tuple(modes)


def answer_requests_enabled() -> bool:
    """Request intake and owner review, independent of the payment lane.

    Asking a connected person a question, and that person reviewing it and
    setting a price, move no money and need no written answer. So this gate
    deliberately consults neither Stripe mode, nor the answer credentials,
    nor the composer: coupling them is what left an intake-ready deployment
    showing a dead control.

    Open unless explicitly switched off. This one does NOT default closed
    like the paid lane, and the distinction is the whole point: an active
    connection is already the authorization gate for asking, so a second
    default-closed rollout flag in front of it only produces a control that
    explains it cannot be used. An earlier revision defaulted to inheriting
    `PKM_ANSWER_PAYMENTS_ENABLED`, which quietly rebuilt the payment coupling
    this function exists to remove and shipped a deployment still showing
    that dead control.

    `PKM_ANSWER_REQUESTS_ENABLED=false` is the kill switch and is the only
    value that closes intake. Anything else, including unset, is open.
    Nothing here can move money: checkout, the composer and the owner work
    queue keep their own default-closed gate.
    """
    return (os.getenv("PKM_ANSWER_REQUESTS_ENABLED") or "").strip().lower() != "false"
