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


def answer_payment_config() -> tuple[str, str, str]:
    mode = answer_stripe_mode()
    key = (os.getenv("PKM_ANSWER_STRIPE_SECRET_KEY") or "").strip()
    secret = (os.getenv("PKM_ANSWER_STRIPE_WEBHOOK_SECRET") or "").strip()
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


def answer_requests_enabled() -> bool:
    """Request intake and owner review, independent of the payment lane.

    Asking a connected person a question, and that person reviewing it and
    setting a price, move no money and need no written answer. So this gate
    deliberately consults neither Stripe mode, nor the answer credentials,
    nor the composer: coupling them is what left an intake-ready deployment
    showing a dead control.

    Unset falls back to the payment flag, so a deployment already taking paid
    answers keeps accepting questions without a new binding. An explicit
    value wins in both directions and remains the kill switch.
    """
    raw = (os.getenv("PKM_ANSWER_REQUESTS_ENABLED") or "").strip().lower()
    if raw in {"true", "false"}:
        return raw == "true"
    # Imported at call time: the payment service imports this module, so a
    # module-level import here would close the cycle.
    from hushh_mcp.services.pkm_answer_payment_service import answer_payments_enabled

    return answer_payments_enabled()
