"""Alpaca Broker API runtime configuration helpers."""

from __future__ import annotations

import base64
import os
from dataclasses import dataclass
from typing import Any

_ALPACA_BASE_URLS = {
    "sandbox": "https://broker-api.sandbox.alpaca.markets",
    "production": "https://broker-api.alpaca.markets",
}


def _clean_text(value: Any, *, default: str = "") -> str:
    if not isinstance(value, str):
        return default
    text = value.strip()
    return text or default


def _first_non_empty(*values: Any) -> str:
    for value in values:
        text = _clean_text(value)
        if text:
            return text
    return ""


def _normalize_auth_header(
    auth_token: str | None,
    key_id: str | None,
    secret: str | None,
) -> str:
    token = _clean_text(auth_token)
    if token:
        lowered = token.lower()
        if lowered.startswith("basic ") or lowered.startswith("bearer "):
            return token
        return f"Basic {token}"

    key = _clean_text(key_id)
    secret_value = _clean_text(secret)
    if not key or not secret_value:
        return ""
    encoded = base64.b64encode(f"{key}:{secret_value}".encode("utf-8")).decode("utf-8")
    return f"Basic {encoded}"


@dataclass(frozen=True)
class AlpacaBrokerRuntimeConfig:
    environment: str
    base_url: str
    auth_header: str
    default_account_id: str | None

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.auth_header)

    @classmethod
    def from_env(cls) -> "AlpacaBrokerRuntimeConfig":
        environment = _clean_text(
            os.getenv("ALPACA_ENV") or os.getenv("ALPACA_BROKER_ENV"),
            default="sandbox",
        ).lower()

        explicit_base_url = _clean_text(
            os.getenv("ALPACA_BROKER_BASE_URL") or os.getenv("BROKER_API_BASE")
        )
        mapped_base_url = _ALPACA_BASE_URLS.get(environment, _ALPACA_BASE_URLS["sandbox"])
        base_url = (explicit_base_url or mapped_base_url).rstrip("/")

        auth_header = _normalize_auth_header(
            auth_token=_first_non_empty(
                os.getenv("ALPACA_BROKER_AUTH_TOKEN"),
                os.getenv("BROKER_TOKEN"),
                os.getenv("ALPACA_AUTH_TOKEN"),
            )
            or None,
            key_id=_first_non_empty(
                os.getenv("ALPACA_BROKER_KEY_ID"),
                os.getenv("APCA_API_KEY_ID"),
                os.getenv("ALPACA_API_KEY"),
                os.getenv("ALPACA_KEY_ID"),
            )
            or None,
            secret=_first_non_empty(
                os.getenv("ALPACA_BROKER_SECRET"),
                os.getenv("APCA_API_SECRET_KEY"),
                os.getenv("ALPACA_API_SECRET"),
                os.getenv("ALPACA_SECRET_KEY"),
                os.getenv("ALPACA_API_SECRET_KEY"),
            )
            or None,
        )

        default_account_id = _clean_text(os.getenv("ALPACA_DEFAULT_ACCOUNT_ID")) or None
        return cls(
            environment=environment,
            base_url=base_url,
            auth_header=auth_header,
            default_account_id=default_account_id,
        )

    def to_status(self) -> dict[str, Any]:
        return {
            "alpaca_configured": self.configured,
            "alpaca_environment": self.environment,
            "alpaca_base_url": self.base_url,
            "alpaca_default_account_id": self.default_account_id,
        }
