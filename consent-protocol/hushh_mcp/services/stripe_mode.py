"""One explicit Stripe mode for provider calls and durable financial bindings."""

from __future__ import annotations

import os


def configured_stripe_mode() -> str:
    environments = {
        (os.getenv("ENVIRONMENT") or "").strip().lower(),
        (os.getenv("HUSHH_DEPLOY_ENV") or "").strip().lower(),
        (os.getenv("HUSSH_DEPLOY_ENV") or "").strip().lower(),
    }
    if {"production", "uat"}.issubset(environments):
        raise ValueError("stripe_environment_conflict")
    default = "live" if "production" in environments else "test"
    mode = (os.getenv("STRIPE_MODE") or default).strip().lower()
    if mode not in {"test", "live"}:
        raise ValueError("stripe_mode_invalid")
    if "production" in environments and mode != "live":
        raise ValueError("stripe_production_mode_invalid")
    return mode


def stripe_key_mode(key: str) -> str:
    mode = configured_stripe_mode()
    if not key.startswith(f"sk_{mode}_") or len(key) < 24:
        raise ValueError("stripe_key_mode_mismatch")
    return mode


def stripe_mode_sql() -> str:
    """Closed enum literal for SQL composed by existing projection builders."""
    return "'live'" if configured_stripe_mode() == "live" else "'test'"


def stripe_environment() -> str:
    return (
        (
            os.getenv("HUSHH_DEPLOY_ENV")
            or os.getenv("HUSSH_DEPLOY_ENV")
            or os.getenv("ENVIRONMENT")
            or "local"
        )
        .strip()
        .lower()
    )


def uat_live_document_only() -> bool:
    """Legacy credit/subscription ledgers have no mode or environment binding."""
    return stripe_environment() == "uat" and configured_stripe_mode() == "live"


def configured_connect_mode() -> str:
    """Connect can use sandbox independently of live document Checkout in UAT."""
    payment_mode = configured_stripe_mode()
    mode = (os.getenv("STRIPE_CONNECT_MODE") or payment_mode).strip().lower()
    if mode not in {"test", "live"}:
        raise ValueError("stripe_connect_mode_invalid")
    if stripe_environment() == "production" and mode != "live":
        raise ValueError("stripe_connect_production_mode_invalid")
    return mode


def connect_config() -> tuple[str, str]:
    """Return a validated, request-scoped key and mode; never mutate Stripe globals."""
    mode = configured_connect_mode()
    key = (os.getenv("STRIPE_CONNECT_SECRET_KEY") or "").strip()
    if not key:
        # Existing deployments remain compatible only when both modes agree.
        if mode != configured_stripe_mode():
            raise ValueError("stripe_connect_key_required")
        key = (os.getenv("STRIPE_SECRET_KEY") or "").strip()
    if not key.startswith(f"sk_{mode}_") or len(key) < 24:
        raise ValueError("stripe_connect_key_mode_mismatch")
    return key, mode
