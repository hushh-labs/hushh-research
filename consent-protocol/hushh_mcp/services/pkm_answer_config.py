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
    return (os.getenv("PKM_ANSWER_COMPOSER_ENABLED") or "").strip().lower() == "true"


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
    if (
        not key.startswith(f"sk_{mode}_")
        or len(key) < 24
        or not secret.startswith("whsec_")
        or len(secret) < 20
        or parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("answer_payment_unavailable")
    return key, secret, origin
