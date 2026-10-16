"""Small typed email-auth contracts and cryptographic value operations."""

from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import re
import secrets
from dataclasses import dataclass

import idna
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

POLICY_VERSION = "email-domain-v1"
CODE_LIFETIME = 300
MAX_ATTEMPTS = 5
_LOCAL = re.compile(r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$")
_BINDING = re.compile(r"^[A-Za-z0-9_-]{43,128}$")


class EmailAuthError(ValueError):
    def __init__(self, code: str, message: str, status: int = 400):
        self.code = code
        self.message = message
        self.status = status
        super().__init__(message)


def normalize_domain(value: str) -> str:
    if not value or any(ord(c) <= 32 or ord(c) == 127 for c in value):
        raise EmailAuthError("invalid_email", "Enter a valid email address.")
    try:
        domain = idna.encode(value, uts46=True, std3_rules=True).decode("ascii").lower()
    except (idna.IDNAError, UnicodeError):
        raise EmailAuthError("invalid_email", "Enter a valid email address.") from None
    if len(domain) > 253 or "." not in domain or domain.endswith("."):
        raise EmailAuthError("invalid_email", "Enter a valid email address.")
    try:
        ipaddress.ip_address(domain)
    except ValueError:
        pass
    else:
        raise EmailAuthError("invalid_email", "Enter an email domain, not an IP address.")
    if domain.endswith((".localhost", ".local", ".internal", ".test", ".invalid")):
        raise EmailAuthError("invalid_email", "Enter a public email domain.")
    return domain


def normalize_email(value: str) -> tuple[str, str]:
    value = value.strip()
    if len(value) > 254 or value.count("@") != 1:
        raise EmailAuthError("invalid_email", "Enter a valid email address.")
    local, raw_domain = value.rsplit("@", 1)
    if not _LOCAL.fullmatch(local) or local.startswith(".") or local.endswith(".") or ".." in local:
        raise EmailAuthError("invalid_email", "Enter a valid email address.")
    domain = normalize_domain(raw_domain)
    # Firebase and the existing account identity contract compare emails case-insensitively.
    return f"{local.lower()}@{domain}", domain


def validate_binding(value: str) -> None:
    if not _BINDING.fullmatch(value):
        raise EmailAuthError("invalid_binding", "Restart email sign-in.")


def keyed_digest(key: bytes, *values: str) -> str:
    encoded = json.dumps(values, separators=(",", ":"), ensure_ascii=True).encode()
    return hmac.new(key, encoded, hashlib.sha256).hexdigest()


def generate_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


@dataclass(frozen=True)
class PayloadCipher:
    key: bytes

    def __post_init__(self) -> None:
        if len(self.key) != 32:
            raise ValueError("Email payload key must contain 32 bytes.")

    def seal(self, plaintext: str, associated: str) -> str:
        nonce = secrets.token_bytes(12)
        payload = nonce + AESGCM(self.key).encrypt(nonce, plaintext.encode(), associated.encode())
        return base64.urlsafe_b64encode(payload).decode()

    def open(self, ciphertext: str, associated: str) -> str:
        raw = base64.urlsafe_b64decode(ciphertext)
        return AESGCM(self.key).decrypt(raw[:12], raw[12:], associated.encode()).decode()


@dataclass(frozen=True)
class DomainDecision:
    domain: str
    status: str
    reason: str
    expires_at: float
    risk_version: str
    policy_version: str = POLICY_VERSION
    certificate_status: str = "not_checked"
