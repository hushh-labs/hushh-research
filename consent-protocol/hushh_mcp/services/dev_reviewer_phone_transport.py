"""Temporary owner-bound recorded phone transport for the shared Dev rehearsal."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import time
from dataclasses import dataclass

from hushh_mcp.services.scope_commerce.provider_sandbox import SandboxPolicy
from hushh_mcp.services.scope_commerce.stripe_adapter import CommerceProviderError

CONFIG_ENV = "HUSHH_DEV_REVIEWER_PHONE_TEST_CONFIG_JSON"
_SANDBOX_ACCOUNT = "acct_1UNyyyLsJU9ZDBZX"
_PREFIX = "uat-test-phone:dev:"


@dataclass(frozen=True, repr=False)
class DevReviewerPhoneTransport:
    owner: str
    phone: str
    deadline: int
    code: str
    secret: str
    revision: str

    def admits(self, owner: str, phone: str) -> bool:
        return owner == self.owner and phone == self.phone

    def _digest(self, expiry: int, nonce: str) -> str:
        payload = json.dumps(
            ["dev-reviewer-phone-v1", self.owner, self.phone, expiry, nonce, self.revision],
            separators=(",", ":"),
        )
        return hmac.new(self.secret.encode(), payload.encode(), hashlib.sha256).hexdigest()

    def issue(self) -> str:
        expiry = min(int(time.time()) + 600, self.deadline)
        nonce = secrets.token_hex(16)
        return f"{_PREFIX}{expiry}:{nonce}:{self._digest(expiry, nonce)}"

    def verifies(self, verification_id: str, code: str) -> bool:
        if not verification_id.startswith(_PREFIX):
            return False
        parts = verification_id.removeprefix(_PREFIX).split(":")
        if len(parts) != 3 or not parts[0].isdigit():
            return False
        expiry = int(parts[0])
        nonce, digest = parts[1:]
        now = int(time.time())
        return (
            now < expiry <= min(now + 600, self.deadline)
            and re.fullmatch(r"[a-f0-9]{32}", nonce) is not None
            and secrets.compare_digest(digest, self._digest(expiry, nonce))
            and secrets.compare_digest(code.strip(), self.code)
        )


def configured_dev_reviewer_phone_transport() -> DevReviewerPhoneTransport | None:
    """Fail closed; never borrow a UAT code, global reviewer or application key."""
    required = {
        "ENVIRONMENT": "dev",
        "HUSHH_DEPLOY_ENV": "dev",
        "HUSHH_DEPLOY_SOURCE": "deploy-dev",
        "APP_REVIEW_MODE": "true",
        "APP_FRONTEND_ORIGIN": "https://dev.one.hushh.ai",
        "SCOPE_COMMERCE_STRIPE_LIVEMODE": "false",
        "SCOPE_COMMERCE_SANDBOX_POLICY_REQUIRED": "true",
    }
    if os.getenv("APP_RUNTIME_PROFILE", "").strip().lower() in {"prod", "production"}:
        return None
    if any(os.getenv(name, "").strip() != value for name, value in required.items()):
        return None
    raw = os.getenv(CONFIG_ENV, "")
    if not raw or len(raw) > 4096:
        return None
    try:
        config = json.loads(raw)
        sandbox = SandboxPolicy.parse(
            json.loads(os.getenv("SCOPE_COMMERCE_SANDBOX_POLICY_JSON", ""))
        )
    except (ValueError, TypeError, CommerceProviderError):
        return None
    fields = {
        "enabled",
        "primary_user_id",
        "phone_number",
        "expires_at",
        "verification_code",
        "challenge_secret",
        "platform_account_id",
    }
    if not isinstance(config, dict) or set(config) != fields:
        return None
    if config["enabled"] is not True or type(config["expires_at"]) is not int:
        return None
    strings = fields - {"enabled", "expires_at"}
    if any(not isinstance(config[key], str) or not config[key].strip() for key in strings):
        return None
    reviewers = sandbox.reviewer_user_ids
    account = config["platform_account_id"]
    if (
        account != _SANDBOX_ACCOUNT
        or account != os.getenv("SCOPE_COMMERCE_STRIPE_ACCOUNT_ID", "")
        or sandbox.platform_account_id != account
        or re.fullmatch(r"acct_[A-Za-z0-9]+", account) is None
        or config["primary_user_id"] != reviewers[0]
        or re.fullmatch(r"\+1[2-9]\d{9}", config["phone_number"]) is None
        or re.fullmatch(r"\d{6}", config["verification_code"]) is None
        or len(config["challenge_secret"]) < 32
        or not int(time.time()) < config["expires_at"] <= int(time.time()) + 86400
    ):
        return None
    revision = hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()
    return DevReviewerPhoneTransport(
        owner=config["primary_user_id"],
        phone=config["phone_number"],
        deadline=config["expires_at"],
        code=config["verification_code"],
        secret=config["challenge_secret"],
        revision=revision,
    )
