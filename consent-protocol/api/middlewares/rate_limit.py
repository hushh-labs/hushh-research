# api/middlewares/rate_limit.py
"""
Rate Limiting Middleware for Hussh Consent Protocol

Implements safe rate limits for the 2-step consent flow:
1. Step 1 (consent_request): 10/min per user
2. Step 2 (consent_action): 20/min per user
3. Token validation: 60/min (higher for polling scenarios)

SCALE SEAM (Agent Architecture Doctrine, AGENTS.md): with no
RATE_LIMIT_STORAGE_URI configured, slowapi uses in-memory storage, so the
effective limit multiplies by gunicorn workers x Cloud Run instances
(2 workers x N instances today). The documented upgrade path is a shared
backend via RATE_LIMIT_STORAGE_URI (e.g. redis://... on Memorystore); the
limits library consumes that URI directly, so the swap is config-only.
Postgres is NOT a supported limits backend, which is why this seam jumps
straight to Redis when cross-instance precision becomes a requirement.
"""

import logging
import os
from functools import lru_cache

from fastapi import Request
from fastapi.responses import JSONResponse
from limits import parse
from limits.limits import RateLimitItem
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from hushh_mcp.consent.token import validate_token

logger = logging.getLogger(__name__)

_HUSHH_TECH_PRODUCT_PREFIX = "/api/v1/products/hushh-tech/"


def rate_limit_exceeded_handler(request: Request, exc: RateLimitExceeded):
    """Keep the product API typed and non-cacheable without changing other routes."""
    if not request.url.path.startswith(_HUSHH_TECH_PRODUCT_PREFIX):
        return _rate_limit_exceeded_handler(request, exc)
    response = JSONResponse(
        status_code=429,
        content={
            "detail": {
                "code": "RATE_LIMITED",
                "message": "Try again shortly.",
            }
        },
        headers={
            "Cache-Control": "private, no-store",
            "Pragma": "no-cache",
        },
    )
    return request.app.state.limiter._inject_headers(  # noqa: SLF001
        response,
        request.state.view_rate_limit,
    )


def get_rate_limit_key(request: Request) -> str:
    """
    Extract rate limit key from request.

    Reads the user_id decoded by ``observability_middleware`` from
    ``request.state.rate_limit_user_id`` on the normal request path, avoiding
    a second JWT decode. If a caller reaches this function without middleware
    state, validate the bearer token here so authenticated traffic still gets
    the signed user bucket instead of silently falling back to the IP bucket.
    """
    state = getattr(request, "state", None)
    user_id = getattr(state, "rate_limit_user_id", None)
    if user_id:
        return f"user:{user_id}"

    authorization = request.headers.get("Authorization") or request.headers.get("authorization")
    if authorization and authorization.startswith("Bearer "):
        consent_token = authorization.removeprefix("Bearer ").strip()
        if consent_token:
            valid, _reason, payload = validate_token(consent_token)
            if valid and payload and payload.user_id:
                return f"user:{payload.user_id}"

    return get_remote_address(request)


def get_trusted_forwarded_client_ip(
    request: Request,
    *,
    trusted_proxy_hops_env: str | None = None,
) -> str:
    """Resolve the rightmost edge-attested visitor IP for public rate limits."""
    trusted_hops = 0
    if trusted_proxy_hops_env:
        raw = str(os.getenv(trusted_proxy_hops_env) or "").strip()
        try:
            trusted_hops = max(0, int(raw))
        except ValueError:
            trusted_hops = 0
    forwarded = str(request.headers.get("x-forwarded-for") or "")
    chain = [part.strip() for part in forwarded.split(",") if part.strip()]
    if not chain:
        return get_remote_address(request) or "unknown"
    index = max(len(chain) - 1 - trusted_hops, 0)
    return chain[index][:64]


# Rate limiting is enabled by default but disabled under the pytest harness so
# deterministic route tests are not throttled by shared per-key buckets. Real
# environments never set TESTING, so production/UAT keep enforcement on.
_rate_limit_enabled = os.getenv("TESTING", "").strip().lower() not in {"1", "true", "yes"}

# Initialize limiter with custom key function. Storage is per-process memory
# unless RATE_LIMIT_STORAGE_URI points at a shared backend (see module note).
_storage_uri = os.getenv("RATE_LIMIT_STORAGE_URI", "").strip()
if _storage_uri:
    limiter = Limiter(
        key_func=get_rate_limit_key,
        storage_uri=_storage_uri,
        enabled=_rate_limit_enabled,
    )
    logger.info("rate_limit.shared_storage_enabled")
else:
    limiter = Limiter(key_func=get_rate_limit_key, enabled=_rate_limit_enabled)


# Rate limit constants (per minute)
class RateLimits:
    """Safe rate limits for 2-step consent flow."""

    # Step 1: Request consent - conservative limit
    CONSENT_REQUEST = "10/minute"  # noqa: S105

    # Step 2: Approve/deny - slightly higher
    CONSENT_ACTION = "20/minute"  # noqa: S105

    # Scope discovery/search - cheap, higher-frequency read. Given its own bucket
    # so search traffic cannot starve the CONSENT_REQUEST budget. Shares the same
    # RATE_LIMIT_STORAGE_URI seam (Redis-later; in-memory per process when unset).
    SEARCH_SCOPES = "60/minute"  # noqa: S105

    # Token validation - higher for polling (soon replaced by SSE)
    TOKEN_VALIDATION = "60/minute"  # noqa: S105

    # UAT-only HushhTech product entry. The public PKCE exchange remains IP
    # keyed because it has no bearer identity; fixed scopes prevent route/path
    # changes from creating fresh buckets. Writes are deliberately tighter
    # than status and compatibility reads.
    HUSHH_TECH_LAUNCH_AUTHORIZE = "10/minute"  # noqa: S105
    HUSHH_TECH_PROXY_ATTESTATION = "240/minute"  # noqa: S105
    HUSHH_TECH_FIREBASE_PREAUTH = "120/minute"  # noqa: S105
    HUSHH_TECH_LAUNCH_EXCHANGE = "20/minute"  # noqa: S105
    HUSHH_TECH_LINK_WRITE = "10/minute"  # noqa: S105
    HUSHH_TECH_CLIENT_READ = "60/minute"  # noqa: S105

    # Agent chat - moderate limit
    AGENT_CHAT = "30/minute"  # noqa: S105

    # Human-entered Circle codes are deliberately short enough to type. Keep
    # resolve/join attempts in their own authenticated-user bucket so guessing
    # cannot consume unrelated consent budgets. RATE_LIMIT_STORAGE_URI remains
    # the Redis/Memorystore upgrade seam for cross-instance precision.
    ONE_LOCATION_CIRCLE_JOIN = "10/minute"  # noqa: S105

    # Owners can rotate/revoke a code, but rapid churn is never a normal flow.
    ONE_LOCATION_CIRCLE_MUTATION = "6/minute"  # noqa: S105

    # The owner's own position heartbeat onto their live public link. Unlike
    # every other mutation on this router this one is SUPPOSED to repeat: the
    # web client publishes on a twenty-second heartbeat plus a movement watch
    # throttled to one publish per eight seconds, so a walking owner can
    # legitimately reach the high single digits per minute. Sized with headroom
    # for that and nothing more -- it still writes one row per call.
    ONE_LOCATION_PUBLIC_LINK_HEARTBEAT = "30/minute"  # noqa: S105
    # UAT-only One Location nearby-presence simulation. The roster is a stable,
    # bounded sample, and these per-principal limits additionally bound polling,
    # check-in churn, and alias-based connection attempts. Shared enforcement
    # keeps the existing RATE_LIMIT_STORAGE_URI Redis-later seam.
    ONE_LOCATION_NEARBY_READ = "8/minute"  # noqa: S105

    ONE_LOCATION_NEARBY_WRITE = "6/minute"  # noqa: S105
    ONE_LOCATION_NEARBY_CONNECT = "10/minute"  # noqa: S105
    # Provider-backed search/details incur external cost. Keep a separate,
    # comfortably interactive bucket so search cannot consume nearby roster or
    # check-in budgets while still bounding scripted abuse per signed owner.
    ONE_LOCATION_MAPS_PROVIDER = "30/minute"  # noqa: S105

    # Advisor directory (FINRA BrokerCheck proxy). Every miss is an upstream
    # call against a quota we own, so this stays bounded per principal. Paging
    # is served from the upstream's own ranking cache and is therefore cheap;
    # the limit is sized for browse-and-page, not for scraping the directory.
    ONE_ADVISORS_DIRECTORY_READ = "20/minute"  # noqa: S105

    # Insurance agent directory (Nationwide locator proxy). Same reasoning as
    # the advisor directory, and deliberately the same number: both are browsed
    # the same way from the same tab, and a caller allowed to page one of them
    # at this rate has no reason to be held to a different rate on the other.
    ONE_INSURANCE_AGENTS_DIRECTORY_READ = "20/minute"  # noqa: S105

    # Places directory (Google Places proxy) on the same Connect tab. One open
    # of a category is one provider call, and a reader flicking along the chip
    # rail spends one per chip, so this sits above the two registry directories
    # rather than beside them. It is still far below what scraping would need.
    ONE_PLACES_DIRECTORY_READ = "40/minute"  # noqa: S105

    # NWS Nearby Intelligence on the RIA clients screen. Deliberately tighter
    # than the Connect directories: the upstream rate-limits on
    # {api_key}:{client_ip} in process, and every Hushh caller reaches it from
    # this backend's egress address under one key, so its 60/min is the whole
    # surface's budget rather than one principal's. Most repeat queries are
    # served from the service-layer cache and never reach it at all; this bound
    # is what stops one principal from spending the shared allowance.
    RIA_NEARBY_DIRECTORY_READ = "20/minute"  # noqa: S105

    # Shortlisting is a local upsert with no upstream call, so it is bounded for
    # write hygiene rather than to protect a quota.
    RIA_NEARBY_SHORTLIST_WRITE = "30/minute"  # noqa: S105

    # The v4 net-worth lookup. Tighter again than the directory read, for two
    # reasons. Our registered consumer grant is 30 requests a minute for the
    # whole product, not per advisor. And a coordinate lookup costs two upstream
    # calls, because the consent receipt has to be minted before the search and
    # is spent whether or not the search succeeds.
    RIA_NEARBY_NETWORTH_READ = "10/minute"  # noqa: S105

    # Preference Subscription Fabric (PCHP RFC-002).
    # FABRIC_READ is the third-party-facing, monetizable subscriber read path;
    # it must be firmly bounded per principal so no brand can drain an owner's
    # data or flood the receipt ledger (SC-5 / CWE-400). Owner grant writes are
    # conservative; owner reads (list/verify) are cheap and higher-frequency.
    FABRIC_READ = "60/minute"  # noqa: S105 - subscriber read of granted fields
    FABRIC_GRANT_WRITE = "20/minute"  # noqa: S105 - owner create/revoke a grant
    FABRIC_OWNER_READ = "60/minute"  # noqa: S105 - owner list grants/receipts
    # Pairing-code lookup is the code-probe surface of the handshake; bound it
    # tightly (defense-in-depth on top of the CSPRNG code + 15-min TTL + the
    # sign-in requirement) so no authenticated caller can farm codes.
    FABRIC_REQUEST_LOOKUP = "20/minute"  # noqa: S105 - owner lookup of a pairing code
    PWM_WRITE = "30/minute"  # noqa: S105 - owner PUT/DELETE own PWM
    PWM_READ = "60/minute"  # noqa: S105 - owner GET own PWM

    # Global fallback per IP
    GLOBAL_PER_IP = "100/minute"  # noqa: S105


@lru_cache(maxsize=32)
def _parsed_limit(limit_value: str) -> RateLimitItem:
    return parse(limit_value)


def consume_shared_rate_limit_budget(*, limit_value: str, scope: str, key: str) -> bool:
    """Consume a budget before FastAPI dependency work starts."""
    if not limiter.enabled:
        return True
    return bool(limiter.limiter.hit(_parsed_limit(limit_value), scope, key))


def log_rate_limit_hit(request: Request, limit: str):
    """Log when rate limit is exceeded."""
    key = get_rate_limit_key(request)
    logger.warning(
        "Rate limit exceeded",
        extra={
            "key": key,
            "limit": limit,
            "path": request.url.path,
            "event_type": "rate_limit_exceeded",
        },
    )
