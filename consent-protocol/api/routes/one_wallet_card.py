"""Wallet Profile routes — owner-authenticated management plus two genuinely
unauthenticated public surfaces (card resolve + `.pkpass` download).

Shape mirrors ``api/routes/one/location.py``: a single router that mixes
``require_vault_owner_token`` routes with public token-addressed routes, path
parameters bounded against CWE-400, and service errors funnelled through one
translator.

Security posture
----------------
- Every owner route is gated by ``Depends(require_vault_owner_token)`` **and** an
  explicit ``token_data["user_id"] == user_id`` equality check, matching
  ``api/routes/pkm_routes_shared.py`` (publish/list/unpublish projection).
- The two public routes take no auth at all. Because ``SlowAPIMiddleware`` is
  never added to the app and ``RateLimits.GLOBAL_PER_IP`` is never applied, an
  undecorated public route would carry *zero* limit — so both public routes
  carry an explicit ``@limiter.limit`` with a forwarded-IP key function (see
  ``_forwarded_client_ip``).
- The plaintext share token is returned to the owner **only** in the create and
  rotate responses. It is never logged, never echoed on read, and never appears
  in an error body.
- ``card_payload`` values, the share token and pass signing material are never
  logged. Failure logs carry an exception class name only.
"""

from __future__ import annotations

import logging
import os
import re
from datetime import datetime
from typing import Annotated, Any, Literal
from urllib.parse import urlparse

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    HTTPException,
    Path,
    Query,
    Request,
    Response,
    status,
)
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from slowapi.util import get_remote_address

from api.middleware import require_vault_owner_token
from api.middlewares.rate_limit import limiter
from hushh_mcp.services.apple_wallet_pass_service import (
    WALLET_PASS_CONTENT_TYPE,
    WALLET_PASS_FILENAME,
    WALLET_PASS_UNAVAILABLE_CODE,
    WALLET_PASS_UNAVAILABLE_MESSAGE,
    WalletPassContent,
    WalletPassError,
    build_pkpass,
    wallet_pass_signing_available,
)
from hushh_mcp.services.one_wallet_card_service import (
    OneWalletCardError,
    OneWalletCardService,
    wallet_card_error_detail,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/wallet-card", tags=["One Wallet Card"])


# ---------------------------------------------------------------------------
# Bounded path / query parameters (CWE-400)
# ---------------------------------------------------------------------------

# ``secrets.token_urlsafe(32)`` yields 43 base64url characters. The bounds and
# the alphabet keep junk out of the DB lookup and out of the logs; a wrong-shape
# token is rejected before any query runs and reveals nothing about existence.
_ShareToken = Annotated[
    str,
    Path(min_length=16, max_length=128, pattern=r"^[A-Za-z0-9_-]+$"),
]
_OwnerUserId = Annotated[str, Query(min_length=1, max_length=160)]


# ---------------------------------------------------------------------------
# Explicit rate limits for the unauthenticated surfaces
# ---------------------------------------------------------------------------

# Per client IP, per endpoint. slowapi's default key_style is "url", so the
# storage key is (key_func, request path) and a {share_token} path parameter
# would give every distinct token its own fresh bucket — an attacker enumerating
# tokens is exactly the traffic these limits exist to bound, and it would never
# hit one. Binding an explicit scope (shared_limit) drops the path out of the
# key; distinct scope strings keep the two routes independently bucketed.
# Resolve is the scanned-page read and must stay comfortably interactive; pass
# generation signs and zips a bundle, so it is bound harder.
PUBLIC_CARD_RESOLVE_RATE_LIMIT = "30/minute"
PUBLIC_CARD_PASS_RATE_LIMIT = "10/minute"  # noqa: S105 - rate limit, not a credential
PUBLIC_CARD_RESOLVE_RATE_LIMIT_SCOPE = "one_wallet_card_public_resolve"
PUBLIC_CARD_PASS_RATE_LIMIT_SCOPE = "one_wallet_card_public_pass"  # noqa: S105 - bucket name

# Static client-facing text for storage failures. The underlying driver message
# is never forwarded (see _handle_error).
_DB_UNAVAILABLE_MESSAGE = "Wallet Profile storage is temporarily unavailable. Try again shortly."
_DB_FAILED_MESSAGE = "Wallet Profile request failed."

# Number of trailing X-Forwarded-For entries that belong to our own edge rather
# than the visitor. Cloud Run (direct) *appends* the real client IP to whatever
# the caller sent, so the last entry is the visitor and the default of 0 is
# correct. Behind an additional Google load balancer hop, set this to 1 so the
# LB address is skipped instead of becoming everyone's shared bucket.
TRUSTED_PROXY_HOPS_ENV = "ONE_WALLET_CARD_TRUSTED_PROXY_HOPS"


def _trusted_proxy_hops() -> int:
    raw = str(os.getenv(TRUSTED_PROXY_HOPS_ENV) or "").strip()
    try:
        hops = int(raw)
    except ValueError:
        return 0
    return hops if hops >= 0 else 0


def _forwarded_client_ip(request: Request) -> str:
    """Best available visitor IP for an unauthenticated request.

    ``slowapi``'s default key function falls back to ``get_remote_address``,
    which behind Cloud Run is the ingress address — every visitor would then
    share one bucket and the limit would be meaningless. Read the forwarded
    chain instead, counting from the right (the hop our edge appended) and
    skipping ``TRUSTED_PROXY_HOPS_ENV`` entries. Falls back to the socket peer
    when no forwarded header is present (local/dev).
    """

    forwarded = str(request.headers.get("x-forwarded-for") or "")
    chain = [part.strip() for part in forwarded.split(",") if part.strip()]
    if not chain:
        return get_remote_address(request) or "unknown"
    index = max(len(chain) - 1 - _trusted_proxy_hops(), 0)
    return chain[index][:64]


def public_rate_limit_key(request: Request) -> str:
    """Rate-limit bucket for the public Wallet Profile surfaces."""

    return f"one_wallet_card_public:{_forwarded_client_ip(request)}"


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

_MAX_SKILLS = 12
_MAX_SKILL_LENGTH = 40
_EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$")
_PHONE_PATTERN = re.compile(r"^\+?[0-9][0-9\s().-]{5,31}$")
_URL_FIELDS = ("website", "linkedin", "github", "portfolio")


class _StrictModel(BaseModel):
    """Reject unknown keys so an off-allowlist field is refused, not dropped."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class _ResponseModel(BaseModel):
    """Tolerant inbound validation, camelCase on the wire."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")


def _clean_optional(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _validate_https_url(value: str | None) -> str | None:
    """Accept only a plain ``https://host/...`` URL.

    Rejects every other scheme (notably ``javascript:`` and ``data:``) and any
    userinfo form, which is the classic ``https://trusted.example@evil`` display
    spoof. Values are stored as plain text and escaped at render time.
    """

    if value is None:
        return None
    parsed = urlparse(value)
    if parsed.scheme != "https":
        raise ValueError("Links must start with https://")
    if not parsed.hostname:
        raise ValueError("Links must include a host")
    if "@" in parsed.netloc:
        raise ValueError("Links must not contain user information")
    return value


class WalletCardPayload(_StrictModel):
    """Closed, server-validated allowlist for the shared card (contract §3)."""

    full_name: str | None = Field(default=None, alias="fullName", max_length=80)
    headline: str | None = Field(default=None, max_length=120)
    organisation: str | None = Field(default=None, max_length=80)
    location_label: str | None = Field(default=None, alias="locationLabel", max_length=80)
    summary: str | None = Field(default=None, max_length=400)
    skills: list[str] | None = Field(default=None, max_length=_MAX_SKILLS)
    email: str | None = Field(default=None, max_length=254)
    phone: str | None = Field(default=None, max_length=32)
    website: str | None = Field(default=None, max_length=300)
    linkedin: str | None = Field(default=None, max_length=300)
    github: str | None = Field(default=None, max_length=300)
    portfolio: str | None = Field(default=None, max_length=300)
    preferred_contact: Literal["email", "phone", "linkedin", "website"] | None = Field(
        default=None, alias="preferredContact"
    )

    @field_validator(
        "full_name",
        "headline",
        "organisation",
        "location_label",
        "summary",
        "email",
        "phone",
        "website",
        "linkedin",
        "github",
        "portfolio",
        mode="before",
    )
    @classmethod
    def _trim(cls, value: Any) -> str | None:
        return _clean_optional(value)

    @field_validator("skills", mode="before")
    @classmethod
    def _trim_skills(cls, value: Any) -> list[str] | None:
        if value is None:
            return None
        if not isinstance(value, list):
            raise ValueError("Skills must be a list of short text values")
        cleaned = [text for text in (_clean_optional(item) for item in value) if text]
        for item in cleaned:
            if len(item) > _MAX_SKILL_LENGTH:
                raise ValueError(f"Each skill must be {_MAX_SKILL_LENGTH} characters or fewer")
        return cleaned or None

    @field_validator("email")
    @classmethod
    def _check_email(cls, value: str | None) -> str | None:
        if value is not None and not _EMAIL_PATTERN.match(value):
            raise ValueError("Enter a valid email address")
        return value

    @field_validator("phone")
    @classmethod
    def _check_phone(cls, value: str | None) -> str | None:
        if value is not None and not _PHONE_PATTERN.match(value):
            raise ValueError("Enter a valid phone number")
        return value

    @field_validator(*_URL_FIELDS)
    @classmethod
    def _check_url(cls, value: str | None) -> str | None:
        return _validate_https_url(value)


class UpsertWalletCardRequest(_StrictModel):
    user_id: str = Field(alias="userId", min_length=1, max_length=160)
    card_payload: WalletCardPayload = Field(alias="cardPayload")
    # NULL means "no expiry". Present so the §6 expired state is reachable.
    expires_at: str | None = Field(default=None, alias="expiresAt", max_length=64)


class WalletCardOwnerActionRequest(_StrictModel):
    user_id: str = Field(alias="userId", min_length=1, max_length=160)


class WalletCardView(_ResponseModel):
    pass_serial: str | None = Field(default=None, alias="passSerial")
    status: str = "active"
    share_token_version: int = Field(default=1, alias="shareTokenVersion")
    card_payload: dict[str, Any] = Field(default_factory=dict, alias="cardPayload")
    display_name: str | None = Field(default=None, alias="displayName")
    headline: str | None = None
    avatar_url: str | None = Field(default=None, alias="avatarUrl")
    expires_at: str | None = Field(default=None, alias="expiresAt")
    created_at: str | None = Field(default=None, alias="createdAt")
    updated_at: str | None = Field(default=None, alias="updatedAt")
    revoked_at: str | None = Field(default=None, alias="revokedAt")
    last_scanned_at: str | None = Field(default=None, alias="lastScannedAt")
    scan_count: int = Field(default=0, alias="scanCount")


class WalletCardResponse(_ResponseModel):
    """Owner view. ``share_token``/``share_url`` are populated on create and
    rotate only — every other route leaves them null and the client reuses the
    URL it stored locally."""

    card: WalletCardView | None = None
    share_token: str | None = Field(default=None, alias="shareToken")
    share_url: str | None = Field(default=None, alias="shareUrl")


class PublicWalletCardResponse(_ResponseModel):
    """Visitor projection. Identical model on the public route and on the owner
    preview so the preview is byte-identical to what a stranger receives."""

    status: str
    card: dict[str, Any] | None = None


# ---------------------------------------------------------------------------
# Services, flags and error translation
# ---------------------------------------------------------------------------

_ACTIVE = "active"
_NOT_FOUND = "not_found"
_GONE_STATES = frozenset({"revoked", "expired"})

# Friendly, non-technical 503 body. The copy is the contract's verbatim signing
# failure line; the cryptographic detail stays in the server log.
_SIGNING_UNAVAILABLE_BODY: dict[str, str] = {
    "status": "unavailable",
    "code": WALLET_PASS_UNAVAILABLE_CODE,
    "message": WALLET_PASS_UNAVAILABLE_MESSAGE,
}

_FEATURE_FLAG_ENV = "ONE_WALLET_CARD_ENABLED"


def _card_service() -> OneWalletCardService:
    return OneWalletCardService()


def _feature_enabled() -> bool:
    """``ONE_WALLET_CARD_ENABLED``, read from backend runtime settings.

    Prefers the typed accessor. The import is function-local and the env var is
    the fallback for the same reason ``WalletPassSigningMaterial`` does it: a
    deployment whose runtime-settings block predates this feature must degrade
    to "off" for this router only, never fail the whole backend at import time.
    ``hydrate_runtime_environment()`` projects the runtime-settings key onto the
    env var, so the fallback reads the same configured value.
    """

    try:
        from hushh_mcp.runtime_settings import one_wallet_card_enabled
    except ImportError:
        raw = str(os.getenv(_FEATURE_FLAG_ENV) or "").strip().lower()
        return raw in {"1", "true", "yes", "on", "enabled"}
    return bool(one_wallet_card_enabled())


def _require_owner_feature_enabled() -> None:
    """Owner routes disappear entirely when the flag is off."""

    if _feature_enabled():
        return
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={
            "code": "ONE_WALLET_CARD_DISABLED",
            "message": "Wallet Profile is not available in this environment.",
        },
    )


def _owner_user_id(token_data: dict[str, Any], user_id: str) -> str:
    """Explicit owner match on top of the VAULT_OWNER token gate."""

    token_user_id = str(token_data.get("user_id") or "").strip()
    requested = str(user_id or "").strip()
    if not token_user_id or token_user_id != requested:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "WALLET_CARD_FORBIDDEN",
                "message": "Token user_id does not match request user_id",
            },
        )
    return token_user_id


def _handle_error(exc: Exception) -> HTTPException:
    if isinstance(exc, OneWalletCardError):
        return HTTPException(status_code=exc.status_code, detail=wallet_card_error_detail(exc))
    # Matched by name, not by import: routes may not import `db.*` (enforced by
    # tests/quality/test_architecture_compliance.py). Same duck-type the
    # Location routes use for this exact exception.
    if exc.__class__.__name__ == "DatabaseExecutionError":
        # exc.details is str(<the DBAPI error>), and SQLAlchemy appends the
        # statement plus every bound value to that (no engine here sets
        # hide_parameters). On these routes the bound values include
        # card_payload, so the detail stays server-side: the caller gets the
        # stable code and the static hint, which is all it can act on anyway.
        # Deliberately NOT `database_error_detail()`, which forwards
        # `exc.details` verbatim.
        code = getattr(exc, "code", "DATABASE_EXECUTION_ERROR")
        status_code = getattr(exc, "status_code", status.HTTP_500_INTERNAL_SERVER_ERROR)
        logger.error("wallet_card.database_error code=%s", code)
        return HTTPException(
            status_code=status_code,
            detail={
                "code": code,
                "message": (
                    _DB_UNAVAILABLE_MESSAGE
                    if status_code == status.HTTP_503_SERVICE_UNAVAILABLE
                    else _DB_FAILED_MESSAGE
                ),
                "hint": getattr(exc, "hint", "") or "",
            },
        )
    logger.error("wallet_card.owner_request_failed error=%s", exc.__class__.__name__)
    return HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail={
            "code": "ONE_WALLET_CARD_API_FAILED",
            "message": "Wallet Profile request failed.",
        },
    )


def _card_response(result: dict[str, Any]) -> WalletCardResponse:
    return WalletCardResponse.model_validate(result)


def _public_projection(result: dict[str, Any]) -> PublicWalletCardResponse:
    resolved = _normalise_public_status(result.get("status"))
    if resolved != _ACTIVE:
        return PublicWalletCardResponse(status=resolved, card=None)
    card = result.get("card")
    return PublicWalletCardResponse(
        status=_ACTIVE,
        card=dict(card) if isinstance(card, dict) else {},
    )


def _normalise_public_status(raw: Any) -> str:
    """Collapse everything a visitor must not distinguish into ``not_found``.

    ``paused`` is deliberately indistinguishable from an unknown token: the
    service already reports it as ``not_found``, and this second pass keeps that
    true even if the service is later changed to report the real state.
    """

    state = str(raw or "").strip().lower()
    if state == _ACTIVE:
        return _ACTIVE
    if state in _GONE_STATES:
        return state
    return _NOT_FOUND


# ---------------------------------------------------------------------------
# Public response helpers
# ---------------------------------------------------------------------------


def _apply_public_headers(response: Response) -> None:
    """Contract §6 headers: never cached by a shared cache, never indexed."""

    response.headers["Cache-Control"] = "private, max-age=0, must-revalidate"
    response.headers["X-Robots-Tag"] = "noindex, nofollow, noarchive"


def _public_json(payload: dict[str, Any], status_code: int) -> JSONResponse:
    response = JSONResponse(status_code=status_code, content=payload)
    _apply_public_headers(response)
    return response


def _public_status_response(state: str) -> JSONResponse:
    """404 for unknown/paused, 410 for revoked/expired."""

    status_code = status.HTTP_410_GONE if state in _GONE_STATES else status.HTTP_404_NOT_FOUND
    return _public_json({"status": state}, status_code)


def _public_unavailable_response() -> JSONResponse:
    return _public_json({"status": "unavailable"}, status.HTTP_503_SERVICE_UNAVAILABLE)


def _as_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    text = _clean_optional(value)
    if text is None:
        return None
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def _pass_content(material: dict[str, Any]) -> WalletPassContent:
    """Project the card row the service resolved onto the pass face.

    The pass factory is deliberately pure — it does no database access and makes
    no network calls — so the route is where the resolved row becomes pass
    content. Only allowlisted keys are read; nothing here is logged.
    """

    return WalletPassContent.from_card_payload(
        pass_serial=str(material.get("passSerial") or material.get("pass_serial") or ""),
        public_card_url=str(material.get("publicCardUrl") or material.get("public_card_url") or ""),
        card_payload=material.get("cardPayload") or material.get("card_payload") or {},
        display_name=_clean_optional(material.get("displayName") or material.get("display_name")),
        headline=_clean_optional(material.get("headline")),
        expires_at=_as_datetime(material.get("expiresAt") or material.get("expires_at")),
    )


def _avatar_image(material: dict[str, Any]) -> bytes | None:
    """Raw headshot bytes, when the service already had them.

    Never fetched here: the route must not make an outbound request derived from
    a user-supplied URL (SSRF). Absent bytes are fine — the pass factory falls
    back to a generated monogram thumbnail.
    """

    image = material.get("avatarImage") or material.get("avatar_image")
    if isinstance(image, (bytes, bytearray)) and image:
        return bytes(image)
    return None


def _record_scan_best_effort(share_token: str) -> None:
    """Bump the coarse counters. A counter failure must never fail the read."""

    try:
        _card_service().record_scan(share_token=share_token)
    except Exception as exc:  # counters are advisory only
        logger.warning("wallet_card.scan_counter_failed error=%s", exc.__class__.__name__)


# ---------------------------------------------------------------------------
# Owner routes — VAULT_OWNER token + explicit user_id match
# ---------------------------------------------------------------------------


@router.get("", response_model=WalletCardResponse)
def get_wallet_card(
    user_id: _OwnerUserId,
    token_data: dict = Depends(require_vault_owner_token),
) -> WalletCardResponse:
    """Current card and status. Never returns the plaintext share token."""

    _require_owner_feature_enabled()
    owner_id = _owner_user_id(token_data, user_id)
    try:
        card = _card_service().get_card(user_id=owner_id)
    except Exception as exc:
        raise _handle_error(exc) from exc
    if card is None:
        return WalletCardResponse(card=None)
    return _card_response({"card": card})


@router.post("", response_model=WalletCardResponse)
def upsert_wallet_card(
    payload: UpsertWalletCardRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> WalletCardResponse:
    """Idempotent upsert of the shared fields.

    The share token is minted on first creation and returned here exactly once;
    a later update leaves the token untouched so an already-printed QR keeps
    working.
    """

    _require_owner_feature_enabled()
    owner_id = _owner_user_id(token_data, payload.user_id)
    try:
        result = _card_service().upsert_card(
            user_id=owner_id,
            card_payload=payload.card_payload.model_dump(exclude_none=True),
            expires_at=payload.expires_at,
        )
    except Exception as exc:
        raise _handle_error(exc) from exc
    return _card_response(result)


@router.post("/rotate", response_model=WalletCardResponse)
def rotate_wallet_card_token(
    payload: WalletCardOwnerActionRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> WalletCardResponse:
    """Mint a new share token, invalidating the old one immediately."""

    _require_owner_feature_enabled()
    owner_id = _owner_user_id(token_data, payload.user_id)
    try:
        result = _card_service().rotate_share_token(user_id=owner_id)
    except Exception as exc:
        raise _handle_error(exc) from exc
    return _card_response(result)


@router.post("/pause", response_model=WalletCardResponse)
def pause_wallet_card(
    payload: WalletCardOwnerActionRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> WalletCardResponse:
    """Status → paused. A paused card reads as non-existent to a visitor."""

    _require_owner_feature_enabled()
    owner_id = _owner_user_id(token_data, payload.user_id)
    try:
        result = _card_service().pause_card(user_id=owner_id)
    except Exception as exc:
        raise _handle_error(exc) from exc
    return _card_response(result)


@router.post("/resume", response_model=WalletCardResponse)
def resume_wallet_card(
    payload: WalletCardOwnerActionRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> WalletCardResponse:
    """Status → active. The existing token and QR keep working."""

    _require_owner_feature_enabled()
    owner_id = _owner_user_id(token_data, payload.user_id)
    try:
        result = _card_service().resume_card(user_id=owner_id)
    except Exception as exc:
        raise _handle_error(exc) from exc
    return _card_response(result)


@router.delete("", response_model=WalletCardResponse)
def revoke_wallet_card(
    user_id: _OwnerUserId,
    token_data: dict = Depends(require_vault_owner_token),
) -> WalletCardResponse:
    """Status → revoked. The public page then shows an honest 410 state."""

    _require_owner_feature_enabled()
    owner_id = _owner_user_id(token_data, user_id)
    try:
        result = _card_service().revoke_card(user_id=owner_id)
    except Exception as exc:
        raise _handle_error(exc) from exc
    return _card_response(result)


@router.get("/preview", response_model=PublicWalletCardResponse)
def preview_wallet_card(
    user_id: _OwnerUserId,
    token_data: dict = Depends(require_vault_owner_token),
) -> PublicWalletCardResponse:
    """Preview-as-visitor.

    Calls the same projection builder the public route uses, so the ``card``
    object here is byte-identical to what a stranger receives. Unlike the public
    route this always answers 200 and reports the state in the body, so the
    owner can be told *why* a visitor would see nothing.
    """

    _require_owner_feature_enabled()
    owner_id = _owner_user_id(token_data, user_id)
    try:
        result = _card_service().preview_public_card(user_id=owner_id)
    except Exception as exc:
        raise _handle_error(exc) from exc
    return _public_projection(result)


# ---------------------------------------------------------------------------
# Public routes — no authentication, explicit per-IP rate limit
# ---------------------------------------------------------------------------


@router.get("/public/{share_token}", response_model=None)
@limiter.shared_limit(
    PUBLIC_CARD_RESOLVE_RATE_LIMIT,
    PUBLIC_CARD_RESOLVE_RATE_LIMIT_SCOPE,
    key_func=public_rate_limit_key,
)
def resolve_public_wallet_card(
    request: Request,
    share_token: _ShareToken,
    background_tasks: BackgroundTasks,
) -> Response:
    """Resolve a scanned share token into the visitor projection.

    Unauthenticated by design — the token *is* the credential. Unknown and
    paused tokens return the identical generic 404; revoked and expired cards
    return 410 with an honest status so the page can explain itself.
    """

    if not _feature_enabled():
        return _public_status_response(_NOT_FOUND)
    try:
        result = _card_service().resolve_public_card(share_token=share_token)
    except OneWalletCardError as exc:
        logger.warning("wallet_card.public_resolve_rejected code=%s", exc.code)
        return _public_status_response(_NOT_FOUND)
    except Exception as exc:  # never leak internals to a visitor
        logger.error("wallet_card.public_resolve_failed error=%s", exc.__class__.__name__)
        return _public_unavailable_response()

    projection = _public_projection(result)
    if projection.status != _ACTIVE:
        return _public_status_response(projection.status)

    background_tasks.add_task(_record_scan_best_effort, share_token)
    return _public_json(
        projection.model_dump(by_alias=True),
        status.HTTP_200_OK,
    )


@router.get("/pass/{share_token}.pkpass", response_model=None)
@limiter.shared_limit(
    PUBLIC_CARD_PASS_RATE_LIMIT,
    PUBLIC_CARD_PASS_RATE_LIMIT_SCOPE,
    key_func=public_rate_limit_key,
)
def download_wallet_pass(
    request: Request,
    share_token: _ShareToken,
) -> Response:
    """Return the signed `.pkpass` bundle for an active card.

    Unauthenticated for the same reason as the resolve route: iOS follows this
    URL out of the app into Safari, which imports the pass natively. Same status
    rules as resolve; 503 with a friendly code when signing material is absent.
    """

    if not _feature_enabled():
        return _public_status_response(_NOT_FOUND)
    try:
        result = _card_service().resolve_pass_material(share_token=share_token)
    except OneWalletCardError as exc:
        logger.warning("wallet_card.pass_resolve_rejected code=%s", exc.code)
        return _public_status_response(_NOT_FOUND)
    except Exception as exc:  # never leak internals to a visitor
        logger.error("wallet_card.pass_resolve_failed error=%s", exc.__class__.__name__)
        return _public_unavailable_response()

    state = _normalise_public_status(result.get("status"))
    if state != _ACTIVE:
        return _public_status_response(state)

    material = result.get("material")
    if not isinstance(material, dict) or not material:
        logger.error("wallet_card.pass_material_missing")
        return _public_json(_SIGNING_UNAVAILABLE_BODY, status.HTTP_503_SERVICE_UNAVAILABLE)

    # Cheap readiness probe first: a deployment without signing material should
    # answer the friendly 503 without paying for image rendering.
    if not wallet_pass_signing_available():
        return _public_json(_SIGNING_UNAVAILABLE_BODY, status.HTTP_503_SERVICE_UNAVAILABLE)

    try:
        content = _pass_content(material)
        bundle = build_pkpass(content, avatar_image=_avatar_image(material))
    except WalletPassError as exc:
        # The message can carry cryptographic detail, so log the class only.
        logger.error("wallet_card.pass_build_failed error=%s", exc.__class__.__name__)
        return _public_json(_SIGNING_UNAVAILABLE_BODY, status.HTTP_503_SERVICE_UNAVAILABLE)
    except Exception as exc:  # signing detail is server-side only
        logger.error("wallet_card.pass_build_failed error=%s", exc.__class__.__name__)
        return _public_json(_SIGNING_UNAVAILABLE_BODY, status.HTTP_503_SERVICE_UNAVAILABLE)

    response = Response(
        content=bundle,
        media_type=WALLET_PASS_CONTENT_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{WALLET_PASS_FILENAME}"'},
    )
    _apply_public_headers(response)
    return response
