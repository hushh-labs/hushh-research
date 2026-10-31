"""Explicit, default-off runtime configuration; no fallback signing keys."""

from __future__ import annotations

import base64
import os
from dataclasses import dataclass

from hushh_mcp.runtime_settings import hydrate_runtime_environment
from hushh_mcp.services.email_auth.contracts import EmailAuthError


@dataclass(frozen=True)
class EmailAuthConfig:
    enabled: bool
    verifier_key: bytes
    payload_key: bytes
    lookup_key: bytes
    risk_manifest: str
    mail_api_endpoint: str
    mail_api_key: str
    mail_from: str

    @classmethod
    def from_env(cls) -> EmailAuthConfig:
        hydrate_runtime_environment()
        enabled = os.getenv("EMAIL_AUTH_ENABLED", "").lower() == "true"

        def key(name: str) -> bytes:
            raw = os.getenv(name, "")
            try:
                decoded = base64.b64decode(raw, validate=True) if raw else b""
            except ValueError:
                decoded = b""
            return decoded

        return cls(
            enabled=enabled,
            verifier_key=key("EMAIL_AUTH_VERIFIER_KEY"),
            payload_key=key("EMAIL_AUTH_PAYLOAD_KEY"),
            lookup_key=key("EMAIL_AUTH_LOOKUP_KEY"),
            risk_manifest=os.getenv("EMAIL_AUTH_RISK_MANIFEST", ""),
            mail_api_endpoint=os.getenv("EMAIL_AUTH_MAIL_API_ENDPOINT", ""),
            mail_api_key=os.getenv("EMAIL_AUTH_MAIL_API_KEY", ""),
            mail_from=os.getenv("EMAIL_AUTH_MAIL_FROM", ""),
        )

    def readiness(self) -> list[str]:
        missing = []
        if any(len(key) != 32 for key in (self.verifier_key, self.payload_key, self.lookup_key)):
            missing.append("managed_keys")
        elif len({self.verifier_key, self.payload_key, self.lookup_key}) != 3:
            missing.append("separate_keys")
        if not self.risk_manifest:
            missing.append("risk_policy")
        if not self.mail_api_key or self.mail_api_endpoint != (
            "https://hushh-mail-api-646258530541.us-central1.run.app"
        ):
            missing.append("mail_api")
        if self.mail_from != "one@hushh.ai":
            missing.append("mail_sender")
        return missing

    def require_ready(self) -> None:
        if not self.enabled:
            raise EmailAuthError("email_auth_disabled", "Email sign-in is not available yet.", 503)
        if self.readiness():
            raise EmailAuthError(
                "email_auth_unavailable", "Email sign-in is temporarily unavailable.", 503
            )
