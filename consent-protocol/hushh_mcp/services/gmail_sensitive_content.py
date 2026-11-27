"""Two-layer OTP and credential shield for turn-local Gmail reads and outbound drafts.

A pure security gene (explicitly permitted under ``backend-semantic-boundary.md``
security and authority guards; never a semantic intent router):

1. Layer 1 (explicit mode): when One passes ``sensitive_masking="otp"`` or
   ``"credentials"``, verification codes or labeled credentials are redacted
   from subject/snippet/body BEFORE the tool output reaches model context or
   durable session projection.
2. Layer 2 (narrow defense-in-depth): even when ``sensitive_masking="none"``,
   high-precision verification codes directly adjacent to explicit OTP/sign-in
   context, or explicitly labeled plaintext passwords/API secrets, are redacted
   before leaving the tool boundary, emitting a count-only metric.
3. Ephemeral single-consume reveal: redacted OTP codes are held ONLY in a
   bounded process-local RAM TTL map (120 seconds, owner + conversation bound,
   never written to Postgres or logs) behind an opaque ``otp1.*`` ref that the
   inline ``SensitiveCodeRevealCard`` fetches once on explicit owner approval.
"""

from __future__ import annotations

import hmac
import logging
import re
import secrets
import threading
import time
from dataclasses import dataclass
from typing import Any, Literal

logger = logging.getLogger(__name__)

SensitiveMaskingMode = Literal["none", "otp", "credentials"]
SENSITIVE_REVEAL_EXPERIENCE_TYPE = "one.sensitive_code_reveal.v1"
EPHEMERAL_REF_PREFIX = "otp1."
EPHEMERAL_REF_PATTERN = r"^otp1\.[A-Za-z0-9_-]{16,128}$"
EPHEMERAL_TTL_SECONDS = 120
AUTO_CLEAR_SECONDS = 60
_MAX_STORE_ENTRIES = 512

OTP_PLACEHOLDER = "\u27e6otp:redacted\u27e7"
CREDENTIAL_PLACEHOLDER = "\u27e6credential:redacted\u27e7"

# High-precision Google SMS/Email OTP format (e.g. G-482913).
_GOOGLE_G_CODE_RE = re.compile(r"\bG-(\d{6})\b")

# Explicit verification/OTP context cues for narrow Layer 2 defense-in-depth.
_OTP_CUE_WORDS = (
    r"(?:"
    r"verification\s+code|"
    r"one[- ]time\s+(?:password|passcode|code|pin)|"
    r"security\s+code|"
    r"sign[- ]?in\s+code|"
    r"log[- ]?in\s+code|"
    r"authentication\s+code|"
    r"auth\s+code|"
    r"confirmation\s+code|"
    r"(?:2fa|mfa|totp)\s+code|"
    r"passcode|"
    r"\botp\b"
    r")"
)

# Code following cue within ~55 chars (e.g., "Your verification code is: 482913" or "482-913").
_OTP_AFTER_CUE_RE = re.compile(
    rf"(?P<prefix>{_OTP_CUE_WORDS}[^\n\r\d]{{0,55}}?)"
    r"(?P<code>(?<!\d)(?:\d{3}[-\s]\d{3}|\d{4,8})(?!\d))",
    re.IGNORECASE,
)

# Code preceding cue within ~45 chars (e.g., "482913 is your Google verification code").
_OTP_BEFORE_CUE_RE = re.compile(
    r"(?P<code>(?<!\d)(?:\d{3}[-\s]\d{3}|\d{4,8})(?!\d))"
    rf"(?P<suffix>[^\n\r\d]{{1,45}}?{_OTP_CUE_WORDS})",
    re.IGNORECASE,
)

# Broader standalone code matcher used ONLY when One explicitly sets sensitive_masking="otp"
# AND the message text has verification/code/sign-in context (avoids eating years/dates).
_EXPLICIT_OTP_STANDALONE_RE = re.compile(
    r"(?<![\d/$€£₹.,-])(?P<code>\d{3}[-\s]\d{3}|\d{6,8})(?![\d.,-])"
)
_YEAR_RE = re.compile(r"^(?:19|20)\d{2}$")

# High-precision labeled password / API secret / private key patterns.
_LABELED_CREDENTIAL_RE = re.compile(
    r"(?P<label>(?:temporary\s+|test\s+|account\s+|app\s+|reviewer\s+|login\s+|admin\s+)?"
    r"(?:password|passwd|pwd|passcode|client[_ ]?secret|api[_ ]?key|secret[_ ]?key|"
    r"access[_ ]?token|auth[_ ]?token|recovery[_ ]?code)"
    r"\s*(?::|=|\bis\b)\s*)"
    r"(?P<secret>[^\s,;\"'<>]{4,128})",
    re.IGNORECASE,
)

_TOKEN_PREFIX_SECRET_RE = re.compile(
    r"\b(?:"
    r"sk_(?:live|test)_[A-Za-z0-9]{16,}|"
    r"rk_(?:live|test)_[A-Za-z0-9]{16,}|"
    r"gh[pousr]_[A-Za-z0-9]{20,}|"
    r"AIza[0-9A-Za-z_-]{20,}|"
    r"AKIA[0-9A-Z]{16}|"
    r"xox[baprs]-[0-9A-Za-z-]{16,}"
    r")\b"
)

_PRIVATE_KEY_BLOCK_RE = re.compile(
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]{1,4096}?-----END [A-Z0-9 ]*PRIVATE KEY-----"
)

# Outbound credential detection categories (safe labels only; never echoes values).
_OUTBOUND_PASSWORD_RE = re.compile(
    r"\b(?:password|passwd|pwd|passcode|client[_ ]?secret|api[_ ]?key|secret[_ ]?key)\s*(?::|=)\s*\S{4,}",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class _EphemeralSecret:
    owner_user_id: str
    conversation_id: str
    kind: Literal["otp", "credentials"]
    codes: tuple[str, ...]
    sender: str
    subject: str
    received_at: str | None
    expires_at: float


_STORE_LOCK = threading.Lock()
_EPHEMERAL_STORE: dict[str, _EphemeralSecret] = {}


def clear_ephemeral_store_for_tests() -> None:
    """Reset the RAM-only ephemeral reveal store between unit tests."""
    with _STORE_LOCK:
        _EPHEMERAL_STORE.clear()


def _prune_expired_locked(now: float) -> None:
    expired = [key for key, item in _EPHEMERAL_STORE.items() if item.expires_at <= now]
    for key in expired:
        _EPHEMERAL_STORE.pop(key, None)


def _store_ephemeral(
    *,
    owner_user_id: str,
    conversation_id: str,
    kind: Literal["otp", "credentials"],
    codes: list[str],
    sender: str,
    subject: str,
    received_at: str | None,
    now: float | None = None,
) -> str:
    current = time.monotonic() if now is None else now
    ref = EPHEMERAL_REF_PREFIX + secrets.token_urlsafe(24)
    entry = _EphemeralSecret(
        owner_user_id=owner_user_id,
        conversation_id=conversation_id,
        kind=kind,
        codes=tuple(codes[:6]),
        sender=sender[:120],
        subject=subject[:180],
        received_at=received_at,
        expires_at=current + EPHEMERAL_TTL_SECONDS,
    )
    with _STORE_LOCK:
        _prune_expired_locked(current)
        if len(_EPHEMERAL_STORE) >= _MAX_STORE_ENTRIES:
            oldest_key = min(_EPHEMERAL_STORE, key=lambda k: _EPHEMERAL_STORE[k].expires_at)
            _EPHEMERAL_STORE.pop(oldest_key, None)
        _EPHEMERAL_STORE[ref] = entry
    return ref


def reveal_ephemeral_code(
    *,
    reveal_ref: str,
    owner_user_id: str,
    now: float | None = None,
) -> dict[str, Any] | None:
    """Single-consume RAM-only reveal for the matching vault owner, or None."""
    if (
        not isinstance(reveal_ref, str)
        or not re.fullmatch(EPHEMERAL_REF_PATTERN, reveal_ref)
        or not isinstance(owner_user_id, str)
        or not owner_user_id.strip()
    ):
        return None
    current = time.monotonic() if now is None else now
    with _STORE_LOCK:
        _prune_expired_locked(current)
        entry = _EPHEMERAL_STORE.get(reveal_ref)
        if entry is None:
            return None
        if not hmac.compare_digest(entry.owner_user_id, owner_user_id):
            # Refuse without consuming so another user cannot invalidate the owner's ref.
            return None
        _EPHEMERAL_STORE.pop(reveal_ref, None)
    return {
        "kind": entry.kind,
        "codes": list(entry.codes),
        "sender": entry.sender,
        "subject": entry.subject,
        "received_at": entry.received_at,
        "auto_clear_seconds": AUTO_CLEAR_SECONDS,
    }


def _normalize_otp_value(raw: str) -> str:
    return raw.strip()


def _redact_text(
    text: str,
    *,
    mode: SensitiveMaskingMode,
    allow_standalone_otp: bool,
) -> tuple[str, list[str], int]:
    """Redact OTPs and credentials from one text field.

    Returns ``(redacted_text, extracted_otps, credential_redaction_count)``.
    """
    if not text:
        return text, [], 0
    otps: list[str] = []
    cred_count = 0
    current = text

    def _capture_g_code(match: re.Match[str]) -> str:
        code = f"G-{match.group(1)}"
        if code not in otps:
            otps.append(code)
        return OTP_PLACEHOLDER

    current = _GOOGLE_G_CODE_RE.sub(_capture_g_code, current)

    def _capture_after(match: re.Match[str]) -> str:
        code = _normalize_otp_value(match.group("code"))
        if _YEAR_RE.fullmatch(code):
            return match.group(0)
        if code not in otps:
            otps.append(code)
        return f"{match.group('prefix')}{OTP_PLACEHOLDER}"

    current = _OTP_AFTER_CUE_RE.sub(_capture_after, current)

    def _capture_before(match: re.Match[str]) -> str:
        code = _normalize_otp_value(match.group("code"))
        if _YEAR_RE.fullmatch(code):
            return match.group(0)
        if code not in otps:
            otps.append(code)
        return f"{OTP_PLACEHOLDER}{match.group('suffix')}"

    current = _OTP_BEFORE_CUE_RE.sub(_capture_before, current)

    if mode == "otp" and allow_standalone_otp:

        def _capture_standalone(match: re.Match[str]) -> str:
            code = _normalize_otp_value(match.group("code"))
            if _YEAR_RE.fullmatch(code):
                return match.group(0)
            if code not in otps:
                otps.append(code)
            return OTP_PLACEHOLDER

        current = _EXPLICIT_OTP_STANDALONE_RE.sub(_capture_standalone, current)

    def _mask_private_key(_match: re.Match[str]) -> str:
        nonlocal cred_count
        cred_count += 1
        return CREDENTIAL_PLACEHOLDER

    current = _PRIVATE_KEY_BLOCK_RE.sub(_mask_private_key, current)

    def _mask_token_prefix(_match: re.Match[str]) -> str:
        nonlocal cred_count
        cred_count += 1
        return CREDENTIAL_PLACEHOLDER

    current = _TOKEN_PREFIX_SECRET_RE.sub(_mask_token_prefix, current)

    def _mask_labeled_cred(match: re.Match[str]) -> str:
        nonlocal cred_count
        secret_val = match.group("secret")
        if secret_val in {OTP_PLACEHOLDER, CREDENTIAL_PLACEHOLDER}:
            return match.group(0)
        # Skip plain English filler words after "password is" (e.g. "password is required").
        if secret_val.lower() in {
            "required",
            "expired",
            "reset",
            "changed",
            "updated",
            "invalid",
            "incorrect",
            "missing",
            "protected",
            "optional",
            "needed",
            "none",
            "not",
        }:
            return match.group(0)
        cred_count += 1
        return f"{match.group('label')}{CREDENTIAL_PLACEHOLDER}"

    current = _LABELED_CREDENTIAL_RE.sub(_mask_labeled_cred, current)

    return current, otps, cred_count


def normalize_sensitive_masking(value: Any) -> SensitiveMaskingMode:
    cleaned = str(value or "none").strip().lower()
    if cleaned in {"otp", "credentials"}:
        return cleaned  # type: ignore[return-value]
    return "none"


def redact_sensitive_mail_items(
    items: list[dict[str, Any]],
    *,
    owner_user_id: str,
    conversation_id: str,
    sensitive_masking: SensitiveMaskingMode = "none",
    now: float | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any] | None, dict[str, int]]:
    """Redact OTP codes & plaintext credentials before items enter LLM context.

    Returns ``(sanitized_items, experience_or_none, stats)``.
    Raw codes are stored ONLY in the 120s RAM-only single-consume store and are
    never echoed into model text, tool results, or durable session history.
    """
    mode = normalize_sensitive_masking(sensitive_masking)
    sanitized_items: list[dict[str, Any]] = []
    total_otps = 0
    total_creds = 0
    primary_reveal_codes: list[str] = []
    primary_sender = ""
    primary_subject = ""
    primary_received_at: str | None = None

    for item in items:
        copy = dict(item)
        item_otps: list[str] = []
        item_creds = 0
        for field_name in ("subject", "snippet", "body"):
            raw = copy.get(field_name)
            if not isinstance(raw, str) or not raw:
                continue
            redacted, found_otps, found_creds = _redact_text(
                raw,
                mode=mode,
                allow_standalone_otp=(field_name in {"snippet", "body"}),
            )
            copy[field_name] = redacted
            for code in found_otps:
                if code not in item_otps:
                    item_otps.append(code)
            item_creds += found_creds

        if item_otps:
            total_otps += len(item_otps)
            copy["otp_redacted"] = True
            if not primary_reveal_codes:
                primary_reveal_codes = list(item_otps)
                primary_sender = str(copy.get("sender") or "Email sender")
                primary_subject = str(copy.get("subject") or "Verification code")
                primary_received_at = (
                    str(copy["received_at"]) if isinstance(copy.get("received_at"), str) else None
                )
        if item_creds:
            total_creds += item_creds
            copy["credentials_redacted"] = True
        sanitized_items.append(copy)

    if total_otps > 0 or total_creds > 0:
        # Count-only telemetry; never log code values, senders, or subjects.
        logger.info(
            "gmail.sensitive_content.guard_fired mode=%s otp_count=%d cred_count=%d",
            mode,
            total_otps,
            total_creds,
        )

    experience: dict[str, Any] | None = None
    if primary_reveal_codes and owner_user_id:
        reveal_ref = _store_ephemeral(
            owner_user_id=owner_user_id,
            conversation_id=conversation_id,
            kind="otp",
            codes=primary_reveal_codes,
            sender=primary_sender,
            subject=primary_subject,
            received_at=primary_received_at,
            now=now,
        )
        experience = {
            "type": SENSITIVE_REVEAL_EXPERIENCE_TYPE,
            "kind": "otp",
            "reveal_ref": reveal_ref,
            "sender": primary_sender[:120],
            "subject": primary_subject[:180],
            "received_at": primary_received_at,
            "expires_in_seconds": EPHEMERAL_TTL_SECONDS,
            "auto_clear_seconds": AUTO_CLEAR_SECONDS,
            "code_count": len(primary_reveal_codes),
        }

    return sanitized_items, experience, {"otp_count": total_otps, "credential_count": total_creds}


def detect_outbound_credentials(text: str) -> list[str]:
    """Return safe category names if outbound draft text appears to contain raw credentials.

    Used as a non-blocking safety warning (US-095); never echoes matched values.
    """
    if not isinstance(text, str) or not text.strip():
        return []
    found: list[str] = []
    if _PRIVATE_KEY_BLOCK_RE.search(text):
        found.append("private_key")
    if _TOKEN_PREFIX_SECRET_RE.search(text):
        found.append("api_key")
    match = _OUTBOUND_PASSWORD_RE.search(text)
    if match:
        tail = match.group(0).split(":", 1)[-1].split("=", 1)[-1].strip()
        if tail not in {OTP_PLACEHOLDER, CREDENTIAL_PLACEHOLDER} and not tail.startswith("["):
            found.append("password")
    return found


__all__ = [
    "AUTO_CLEAR_SECONDS",
    "CREDENTIAL_PLACEHOLDER",
    "EPHEMERAL_REF_PATTERN",
    "EPHEMERAL_REF_PREFIX",
    "EPHEMERAL_TTL_SECONDS",
    "OTP_PLACEHOLDER",
    "SENSITIVE_REVEAL_EXPERIENCE_TYPE",
    "SensitiveMaskingMode",
    "clear_ephemeral_store_for_tests",
    "detect_outbound_credentials",
    "normalize_sensitive_masking",
    "redact_sensitive_mail_items",
    "reveal_ephemeral_code",
]
