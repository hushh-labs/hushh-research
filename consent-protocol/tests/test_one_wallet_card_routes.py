"""Route contract for the Wallet Profile surfaces.

Six guarantees are locked in here:

- every owner route needs a VAULT_OWNER token **and** a matching ``user_id``;
- the two public routes need no authentication at all;
- the feature flag removes the whole surface;
- a paused card is byte-identically indistinguishable from an unknown token,
  while revoked and expired answer an honest 410;
- the `.pkpass` route returns the Apple content type, and degrades to the
  contract's friendly 503 when signing material is absent;
- **publishing a Wallet card never touches
  ``pkm_default_available_projections`` and never reaches the Information
  Marketplace catalogue.** That is the specific privacy defect this design
  exists to avoid, so it is asserted structurally rather than left to review.

The service is faked at the route seam so these tests exercise HTTP behaviour
only; the persistence contract lives in ``test_one_wallet_card_service.py``.
"""

from __future__ import annotations

import ast
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from slowapi.errors import RateLimitExceeded
from slowapi.extension import _rate_limit_exceeded_handler

from api.middleware import require_vault_owner_token
from api.middlewares.rate_limit import limiter
from api.routes import one_wallet_card
from db.db_client import DatabaseExecutionError
from hushh_mcp.services.one_wallet_card_service import OneWalletCardError

ROOT = Path(__file__).resolve().parents[1]

OWNER_ID = "user_123"
SHARE_TOKEN = "wallet-card-test-token-not-a-real-secret"
PUBLIC_CARD_URL = f"https://one.hushh.ai/c/{SHARE_TOKEN}"
PASS_SERIAL = "6f2f0e6a-6d5e-4b0a-9f0a-0d1c2b3a4e5f"

NOINDEX = "noindex, nofollow, noarchive"
PRIVATE_CACHE = "private, max-age=0, must-revalidate"

CARD_PAYLOAD = {
    "fullName": "Ada Lovelace",
    "headline": "Founder, Hussh",
    "organisation": "Hussh Labs",
    "locationLabel": "Mumbai, India",
    "summary": "Builds private agents.",
    "skills": ["Python", "Cryptography"],
    "email": "ada@example.com",
    "phone": "+91 99999 90000",
    "website": "https://ada.example.com",
    "linkedin": "https://www.linkedin.com/in/ada",
    "github": "https://github.com/ada",
    "portfolio": "https://ada.example.com/work",
    "preferredContact": "email",
}

OWNER_CARD_VIEW: dict[str, Any] = {
    "passSerial": PASS_SERIAL,
    "status": "active",
    "shareTokenVersion": 1,
    "cardPayload": {"full_name": "Ada Lovelace"},
    "displayName": "Ada Lovelace",
    "headline": "Founder, Hussh",
    "avatarUrl": None,
    "expiresAt": None,
    "createdAt": "2026-08-01T00:00:00+00:00",
    "updatedAt": "2026-08-02T00:00:00+00:00",
    "revokedAt": None,
    "lastScannedAt": None,
    "scanCount": 3,
}

PUBLIC_PROJECTION: dict[str, Any] = {
    "fullName": "Ada Lovelace",
    "headline": "Founder, Hussh",
    "organisation": "Hussh Labs",
    "locationLabel": "Mumbai, India",
    "summary": "Builds private agents.",
    "skills": ["Python", "Cryptography"],
    "email": "ada@example.com",
    "phone": "+91 99999 90000",
    "website": "https://ada.example.com",
    "linkedin": "https://www.linkedin.com/in/ada",
    "github": "https://github.com/ada",
    "portfolio": "https://ada.example.com/work",
    "preferredContact": "email",
    "avatarUrl": None,
    "updatedOn": "2026-08-02",
}

PASS_MATERIAL: dict[str, Any] = {
    "passSerial": PASS_SERIAL,
    "publicCardUrl": PUBLIC_CARD_URL,
    "cardPayload": {"full_name": "Ada Lovelace", "headline": "Founder, Hussh"},
    "displayName": "Ada Lovelace",
    "headline": "Founder, Hussh",
    "expiresAt": None,
}


class FakeCardService:
    """Records every call and returns whatever the test configured."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.card: dict[str, Any] | None = dict(OWNER_CARD_VIEW)
        self.mutation: dict[str, Any] = {"card": dict(OWNER_CARD_VIEW)}
        self.public_result: dict[str, Any] = {
            "status": "active",
            "card": dict(PUBLIC_PROJECTION),
        }
        self.preview_result: dict[str, Any] = {
            "status": "active",
            "card": dict(PUBLIC_PROJECTION),
        }
        self.pass_result: dict[str, Any] = {
            "status": "active",
            "material": dict(PASS_MATERIAL),
        }
        self.raises: Exception | None = None
        self.scan_error: Exception | None = None

    def _record(self, name: str, **kwargs: Any) -> None:
        self.calls.append((name, kwargs))
        if self.raises is not None:
            raise self.raises

    def called(self, name: str) -> bool:
        return any(call == name for call, _ in self.calls)

    # --- owner plane ---

    def get_card(self, *, user_id: str) -> dict[str, Any] | None:
        self._record("get_card", user_id=user_id)
        return self.card

    def upsert_card(self, **kwargs: Any) -> dict[str, Any]:
        self._record("upsert_card", **kwargs)
        return self.mutation

    def rotate_share_token(self, *, user_id: str) -> dict[str, Any]:
        self._record("rotate_share_token", user_id=user_id)
        return self.mutation

    def pause_card(self, *, user_id: str) -> dict[str, Any]:
        self._record("pause_card", user_id=user_id)
        return self.mutation

    def resume_card(self, *, user_id: str) -> dict[str, Any]:
        self._record("resume_card", user_id=user_id)
        return self.mutation

    def revoke_card(self, *, user_id: str) -> dict[str, Any]:
        self._record("revoke_card", user_id=user_id)
        return self.mutation

    def preview_public_card(self, *, user_id: str) -> dict[str, Any]:
        self._record("preview_public_card", user_id=user_id)
        return self.preview_result

    # --- public plane ---

    def resolve_public_card(self, *, share_token: str) -> dict[str, Any]:
        self._record("resolve_public_card", share_token=share_token)
        return self.public_result

    def resolve_pass_material(self, *, share_token: str) -> dict[str, Any]:
        self._record("resolve_pass_material", share_token=share_token)
        return self.pass_result

    def record_scan(self, *, share_token: str) -> None:
        self.calls.append(("record_scan", {"share_token": share_token}))
        if self.scan_error is not None:
            raise self.scan_error


@pytest.fixture(autouse=True)
def feature_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ONE_WALLET_CARD_ENABLED", "true")


@pytest.fixture
def service(monkeypatch: pytest.MonkeyPatch) -> FakeCardService:
    fake = FakeCardService()
    monkeypatch.setattr(one_wallet_card, "_card_service", lambda: fake)
    return fake


def _app(*, authenticated_as: str | None = OWNER_ID) -> FastAPI:
    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    app.include_router(one_wallet_card.router)
    if authenticated_as is not None:
        app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": authenticated_as}
    return app


def _client(*, authenticated_as: str | None = OWNER_ID) -> TestClient:
    return TestClient(_app(authenticated_as=authenticated_as))


def _assert_public_headers(response) -> None:
    assert response.headers["X-Robots-Tag"] == NOINDEX
    assert response.headers["Cache-Control"] == PRIVATE_CACHE


# ---------------------------------------------------------------------------
# Owner authentication
# ---------------------------------------------------------------------------


def test_owner_routes_reject_a_missing_vault_owner_token(service: FakeCardService) -> None:
    client = _client(authenticated_as=None)

    responses = [
        client.get(f"/api/one/wallet-card?user_id={OWNER_ID}"),
        client.post("/api/one/wallet-card", json={"userId": OWNER_ID, "cardPayload": {}}),
        client.post("/api/one/wallet-card/rotate", json={"userId": OWNER_ID}),
        client.post("/api/one/wallet-card/pause", json={"userId": OWNER_ID}),
        client.post("/api/one/wallet-card/resume", json={"userId": OWNER_ID}),
        client.request("DELETE", f"/api/one/wallet-card?user_id={OWNER_ID}"),
        client.get(f"/api/one/wallet-card/preview?user_id={OWNER_ID}"),
    ]

    for response in responses:
        assert response.status_code in {401, 403}, response.text
    assert service.calls == []


def test_owner_routes_reject_a_token_for_a_different_user(service: FakeCardService) -> None:
    client = _client(authenticated_as="someone_else")

    response = client.get(f"/api/one/wallet-card?user_id={OWNER_ID}")

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "WALLET_CARD_FORBIDDEN"
    assert service.calls == []


def test_owner_mutations_reject_a_token_for_a_different_user(
    service: FakeCardService,
) -> None:
    client = _client(authenticated_as="someone_else")

    for path in ("/api/one/wallet-card/rotate", "/api/one/wallet-card/pause"):
        response = client.post(path, json={"userId": OWNER_ID})
        assert response.status_code == 403, path
    assert service.calls == []


def test_owner_read_returns_the_card_without_a_plaintext_token(
    service: FakeCardService,
) -> None:
    response = _client().get(f"/api/one/wallet-card?user_id={OWNER_ID}")

    assert response.status_code == 200
    body = response.json()
    assert body["card"]["passSerial"] == PASS_SERIAL
    assert body["card"]["status"] == "active"
    assert body["shareToken"] is None
    assert body["shareUrl"] is None
    assert service.called("get_card")


def test_owner_read_reports_a_missing_card_as_an_empty_state(
    service: FakeCardService,
) -> None:
    service.card = None

    response = _client().get(f"/api/one/wallet-card?user_id={OWNER_ID}")

    assert response.status_code == 200
    assert response.json()["card"] is None


def test_create_returns_the_plaintext_token_exactly_once(service: FakeCardService) -> None:
    service.mutation = {
        "card": dict(OWNER_CARD_VIEW),
        "shareToken": SHARE_TOKEN,
        "shareUrl": PUBLIC_CARD_URL,
    }

    created = _client().post(
        "/api/one/wallet-card",
        json={"userId": OWNER_ID, "cardPayload": CARD_PAYLOAD},
    )

    service.mutation = {"card": dict(OWNER_CARD_VIEW)}
    read = _client().get(f"/api/one/wallet-card?user_id={OWNER_ID}")

    assert created.status_code == 200
    assert created.json()["shareToken"] == SHARE_TOKEN
    assert created.json()["shareUrl"] == PUBLIC_CARD_URL
    assert read.json()["shareToken"] is None


def test_rotate_returns_a_new_plaintext_token(service: FakeCardService) -> None:
    service.mutation = {
        "card": {**OWNER_CARD_VIEW, "shareTokenVersion": 2},
        "shareToken": SHARE_TOKEN,
        "shareUrl": PUBLIC_CARD_URL,
    }

    response = _client().post("/api/one/wallet-card/rotate", json={"userId": OWNER_ID})

    assert response.status_code == 200
    assert response.json()["shareToken"] == SHARE_TOKEN
    assert response.json()["card"]["shareTokenVersion"] == 2
    assert service.called("rotate_share_token")


def test_upsert_rejects_a_field_outside_the_allowlist(service: FakeCardService) -> None:
    response = _client().post(
        "/api/one/wallet-card",
        json={
            "userId": OWNER_ID,
            "cardPayload": {"fullName": "Ada Lovelace", "vaultKey": "secret"},
        },
    )

    assert response.status_code == 422
    assert not service.called("upsert_card")


def test_upsert_rejects_a_non_https_link(service: FakeCardService) -> None:
    for bad in (
        "javascript:alert(1)",
        "data:text/html;base64,PHNjcmlwdD4=",
        "http://ada.example.com",
        "https://ada@evil.example",
    ):
        response = _client().post(
            "/api/one/wallet-card",
            json={"userId": OWNER_ID, "cardPayload": {"website": bad}},
        )
        assert response.status_code == 422, bad
    assert not service.called("upsert_card")


def test_service_errors_are_translated_without_leaking_internals(
    service: FakeCardService,
) -> None:
    service.raises = OneWalletCardError(
        "WALLET_CARD_NOT_SET_UP", "Set up your Wallet Profile first.", status_code=404
    )

    response = _client().post("/api/one/wallet-card/pause", json={"userId": OWNER_ID})

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "WALLET_CARD_NOT_SET_UP"


def test_unexpected_service_failures_become_a_generic_500(
    service: FakeCardService,
) -> None:
    service.raises = RuntimeError("connection to db-prod-1 refused")

    response = _client().post("/api/one/wallet-card/pause", json={"userId": OWNER_ID})

    assert response.status_code == 500
    assert response.json()["detail"]["code"] == "ONE_WALLET_CARD_API_FAILED"
    assert "db-prod-1" not in response.text


def test_preview_uses_the_same_projection_a_visitor_receives(
    service: FakeCardService,
) -> None:
    preview = _client().get(f"/api/one/wallet-card/preview?user_id={OWNER_ID}")
    public = _client().get(f"/api/one/wallet-card/public/{SHARE_TOKEN}")

    assert preview.status_code == 200
    assert public.status_code == 200
    assert preview.json()["card"] == public.json()["card"]
    assert service.called("preview_public_card")


# ---------------------------------------------------------------------------
# Public plane — no authentication
# ---------------------------------------------------------------------------


def test_public_resolve_needs_no_authentication(service: FakeCardService) -> None:
    client = _client(authenticated_as=None)

    response = client.get(f"/api/one/wallet-card/public/{SHARE_TOKEN}")

    assert response.status_code == 200
    assert response.json()["card"]["fullName"] == "Ada Lovelace"
    _assert_public_headers(response)


def test_public_resolve_never_returns_an_internal_identifier(
    service: FakeCardService,
) -> None:
    response = _client(authenticated_as=None).get(f"/api/one/wallet-card/public/{SHARE_TOKEN}")

    body = response.text
    assert "user_id" not in body
    assert "userId" not in body
    assert "passSerial" not in body
    assert "pass_serial" not in body
    assert PASS_SERIAL not in body
    assert "shareToken" not in body


def test_public_resolve_sets_the_noindex_and_private_cache_headers(
    service: FakeCardService,
) -> None:
    _assert_public_headers(
        _client(authenticated_as=None).get(f"/api/one/wallet-card/public/{SHARE_TOKEN}")
    )


def test_a_paused_card_is_indistinguishable_from_an_unknown_token(
    service: FakeCardService,
) -> None:
    client = _client(authenticated_as=None)

    service.public_result = {"status": "not_found", "card": None}
    unknown = client.get(f"/api/one/wallet-card/public/{SHARE_TOKEN}")

    # A paused card must not be told apart even if the service names the state.
    service.public_result = {"status": "paused", "card": dict(PUBLIC_PROJECTION)}
    paused = client.get(f"/api/one/wallet-card/public/{SHARE_TOKEN}")

    assert unknown.status_code == paused.status_code == 404
    assert unknown.json() == paused.json() == {"status": "not_found"}
    assert unknown.headers["X-Robots-Tag"] == paused.headers["X-Robots-Tag"]
    assert "Ada Lovelace" not in paused.text


def test_a_revoked_card_answers_an_honest_410(service: FakeCardService) -> None:
    service.public_result = {"status": "revoked", "card": None}

    response = _client(authenticated_as=None).get(f"/api/one/wallet-card/public/{SHARE_TOKEN}")

    assert response.status_code == 410
    assert response.json() == {"status": "revoked"}
    _assert_public_headers(response)


def test_an_expired_card_answers_an_honest_410(service: FakeCardService) -> None:
    service.public_result = {"status": "expired", "card": None}

    response = _client(authenticated_as=None).get(f"/api/one/wallet-card/public/{SHARE_TOKEN}")

    assert response.status_code == 410
    assert response.json() == {"status": "expired"}


def test_a_service_rejection_is_collapsed_into_the_generic_404(
    service: FakeCardService,
) -> None:
    service.raises = OneWalletCardError(
        "WALLET_CARD_NOT_FOUND", "This profile isn't available.", status_code=404
    )

    response = _client(authenticated_as=None).get(f"/api/one/wallet-card/public/{SHARE_TOKEN}")

    assert response.status_code == 404
    assert response.json() == {"status": "not_found"}


def test_an_unexpected_public_failure_never_leaks_internals(
    service: FakeCardService,
) -> None:
    service.raises = RuntimeError("connection to db-prod-1 refused")

    response = _client(authenticated_as=None).get(f"/api/one/wallet-card/public/{SHARE_TOKEN}")

    assert response.status_code == 503
    assert response.json() == {"status": "unavailable"}
    assert "db-prod-1" not in response.text


def test_a_malformed_token_is_rejected_before_any_lookup(
    service: FakeCardService,
) -> None:
    client = _client(authenticated_as=None)

    for token in ("short", "a" * 200, "has%20space%20and%20is%20long%20enough"):
        response = client.get(f"/api/one/wallet-card/public/{token}")
        assert response.status_code == 422, token
    assert not service.called("resolve_public_card")


def test_the_scan_counter_failing_does_not_fail_the_read(
    service: FakeCardService,
) -> None:
    service.scan_error = RuntimeError("counter write failed")

    response = _client(authenticated_as=None).get(f"/api/one/wallet-card/public/{SHARE_TOKEN}")

    assert response.status_code == 200
    assert response.json()["card"]["fullName"] == "Ada Lovelace"
    assert service.called("record_scan")


def test_the_scan_counter_runs_only_for_a_card_that_resolved(
    service: FakeCardService,
) -> None:
    service.public_result = {"status": "revoked", "card": None}

    _client(authenticated_as=None).get(f"/api/one/wallet-card/public/{SHARE_TOKEN}")

    assert not service.called("record_scan")


# ---------------------------------------------------------------------------
# Pass download
# ---------------------------------------------------------------------------


def test_pass_route_returns_the_apple_content_type(
    service: FakeCardService, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(one_wallet_card, "wallet_pass_signing_available", lambda: True)
    monkeypatch.setattr(
        one_wallet_card, "build_pkpass", lambda content, **kwargs: b"PK\x03\x04pkpass"
    )

    response = _client(authenticated_as=None).get(f"/api/one/wallet-card/pass/{SHARE_TOKEN}.pkpass")

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/vnd.apple.pkpass"
    assert response.headers["Content-Disposition"] == 'attachment; filename="hushh-one.pkpass"'
    assert response.content == b"PK\x03\x04pkpass"
    _assert_public_headers(response)


def test_pass_route_needs_no_authentication(
    service: FakeCardService, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(one_wallet_card, "wallet_pass_signing_available", lambda: True)
    monkeypatch.setattr(one_wallet_card, "build_pkpass", lambda content, **kwargs: b"pass")

    response = _client(authenticated_as=None).get(f"/api/one/wallet-card/pass/{SHARE_TOKEN}.pkpass")

    assert response.status_code == 200


def test_pass_route_returns_the_friendly_503_when_signing_material_is_absent(
    service: FakeCardService, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(one_wallet_card, "wallet_pass_signing_available", lambda: False)

    response = _client(authenticated_as=None).get(f"/api/one/wallet-card/pass/{SHARE_TOKEN}.pkpass")

    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "unavailable"
    assert body["code"] == one_wallet_card.WALLET_PASS_UNAVAILABLE_CODE
    assert body["message"] == (
        "We couldn't create your Wallet pass right now. Please try again in a moment."
    )
    _assert_public_headers(response)


def test_pass_route_hides_a_signing_failure_behind_the_same_503(
    service: FakeCardService, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _explode(content, **kwargs):
        raise one_wallet_card.WalletPassError("private key /secrets/pass.key is malformed")

    monkeypatch.setattr(one_wallet_card, "wallet_pass_signing_available", lambda: True)
    monkeypatch.setattr(one_wallet_card, "build_pkpass", _explode)

    response = _client(authenticated_as=None).get(f"/api/one/wallet-card/pass/{SHARE_TOKEN}.pkpass")

    assert response.status_code == 503
    assert "/secrets/pass.key" not in response.text
    assert response.json()["code"] == one_wallet_card.WALLET_PASS_UNAVAILABLE_CODE


def test_pass_route_applies_the_same_status_rules_as_resolve(
    service: FakeCardService, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(one_wallet_card, "wallet_pass_signing_available", lambda: True)
    monkeypatch.setattr(one_wallet_card, "build_pkpass", lambda content, **kwargs: b"pass")
    client = _client(authenticated_as=None)

    service.pass_result = {"status": "paused", "material": dict(PASS_MATERIAL)}
    paused = client.get(f"/api/one/wallet-card/pass/{SHARE_TOKEN}.pkpass")

    service.pass_result = {"status": "revoked", "material": None}
    revoked = client.get(f"/api/one/wallet-card/pass/{SHARE_TOKEN}.pkpass")

    service.pass_result = {"status": "expired", "material": None}
    expired = client.get(f"/api/one/wallet-card/pass/{SHARE_TOKEN}.pkpass")

    assert paused.status_code == 404
    assert paused.json() == {"status": "not_found"}
    assert revoked.status_code == 410
    assert revoked.json() == {"status": "revoked"}
    assert expired.status_code == 410
    assert expired.json() == {"status": "expired"}


# ---------------------------------------------------------------------------
# Feature flag
# ---------------------------------------------------------------------------


def test_the_feature_flag_removes_the_owner_surface(
    service: FakeCardService, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ONE_WALLET_CARD_ENABLED", "false")
    client = _client()

    response = client.get(f"/api/one/wallet-card?user_id={OWNER_ID}")

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "ONE_WALLET_CARD_DISABLED"
    assert service.calls == []


def test_the_feature_flag_removes_the_public_surface(
    service: FakeCardService, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ONE_WALLET_CARD_ENABLED", "false")
    client = _client(authenticated_as=None)

    card = client.get(f"/api/one/wallet-card/public/{SHARE_TOKEN}")
    pkpass = client.get(f"/api/one/wallet-card/pass/{SHARE_TOKEN}.pkpass")

    assert card.status_code == 404
    assert card.json() == {"status": "not_found"}
    assert pkpass.status_code == 404
    assert service.calls == []


def test_the_flag_defaults_to_off_when_unset(
    service: FakeCardService, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("ONE_WALLET_CARD_ENABLED", raising=False)

    response = _client().get(f"/api/one/wallet-card?user_id={OWNER_ID}")

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "ONE_WALLET_CARD_DISABLED"


# ---------------------------------------------------------------------------
# Rate limiting on the unauthenticated surfaces
# ---------------------------------------------------------------------------


def test_public_routes_carry_an_explicit_per_ip_rate_limit() -> None:
    """`SlowAPIMiddleware` is never added and `GLOBAL_PER_IP` is never applied,
    so an undecorated public route would carry no limit at all (plan D8).

    The decorator must be ``shared_limit``, not ``limit``: see
    ``test_the_rate_limit_bucket_is_not_subdivided_by_the_share_token``.
    """
    source = (ROOT / "api" / "routes" / "one_wallet_card.py").read_text(encoding="utf-8")

    assert source.count("@limiter.shared_limit(") == 2
    assert "@limiter.limit(" not in source
    assert "key_func=public_rate_limit_key" in source
    assert one_wallet_card.PUBLIC_CARD_RESOLVE_RATE_LIMIT.endswith("/minute")
    assert one_wallet_card.PUBLIC_CARD_PASS_RATE_LIMIT.endswith("/minute")
    assert (
        one_wallet_card.PUBLIC_CARD_RESOLVE_RATE_LIMIT_SCOPE
        != one_wallet_card.PUBLIC_CARD_PASS_RATE_LIMIT_SCOPE
    )


def test_the_route_module_never_imports_the_database_client() -> None:
    """Routes talk to services, not to ``db.*``
    (``tests/quality/test_architecture_compliance.py``). The tempting import
    here is ``DatabaseExecutionError`` for the ``_handle_error`` branch; it is
    matched by class name instead, which is the same duck-type the Location
    routes use.
    """
    source = (ROOT / "api" / "routes" / "one_wallet_card.py").read_text(encoding="utf-8")

    assert "from db." not in source
    assert "import db" not in source
    assert '__name__ == "DatabaseExecutionError"' in source


@pytest.fixture
def enforcing_limiter():
    """Turn the shared limiter on for one test and leave no residue.

    ``api.middlewares.rate_limit`` disables the limiter whenever ``TESTING`` is
    set so ordinary route tests are not throttled — which also means a rate
    limit could regress to "no limit at all" and every other test here would
    still pass. These tests opt back in, and reset the in-memory storage on both
    sides because the whole point of the fix is that the bucket now *outlives*
    the request path.
    """
    previous = limiter.enabled
    limiter.enabled = True
    limiter.reset()
    try:
        yield limiter
    finally:
        limiter.reset()
        limiter.enabled = previous


def test_the_rate_limit_bucket_is_not_subdivided_by_the_share_token(
    service: FakeCardService, enforcing_limiter
) -> None:
    """Token enumeration is exactly the traffic this limit exists to bound.

    slowapi's default ``key_style`` is ``"url"``, so an ``@limiter.limit``
    bucket is keyed by ``(key_func, request.path)``. With ``{share_token}`` in
    the path, every guessed token opens a *fresh* bucket and a scraper walking
    the token space would never be throttled once. Binding an explicit scope
    drops the path out of the storage key.
    """
    client = _client(authenticated_as=None)
    headers = {"x-forwarded-for": "203.0.113.42"}
    budget = int(one_wallet_card.PUBLIC_CARD_RESOLVE_RATE_LIMIT.split("/")[0])

    statuses = [
        client.get(
            f"/api/one/wallet-card/public/enumerated-token-{index}", headers=headers
        ).status_code
        for index in range(budget + 1)
    ]

    assert statuses[:budget] == [200] * budget, "the honest budget must be spendable"
    assert statuses[budget] == 429, (
        "a distinct token opened a new bucket — the limit is keyed by path, "
        "so enumeration is unbounded"
    )


def test_the_two_public_routes_keep_independent_buckets(
    service: FakeCardService, enforcing_limiter
) -> None:
    """Dropping the path out of the key must not merge the two surfaces:
    exhausting the cheap page read cannot lock a visitor out of their pass."""
    client = _client(authenticated_as=None)
    headers = {"x-forwarded-for": "203.0.113.43"}
    budget = int(one_wallet_card.PUBLIC_CARD_RESOLVE_RATE_LIMIT.split("/")[0])

    for index in range(budget + 1):
        client.get(f"/api/one/wallet-card/public/token-{index}", headers=headers)

    pkpass = client.get(f"/api/one/wallet-card/pass/{SHARE_TOKEN}.pkpass", headers=headers)

    assert pkpass.status_code != 429


def test_the_rate_limit_still_separates_distinct_visitors(
    service: FakeCardService, enforcing_limiter
) -> None:
    """The scope must not collapse every visitor into one global bucket —
    that would let a single scraper deny the surface to everyone else."""
    client = _client(authenticated_as=None)
    budget = int(one_wallet_card.PUBLIC_CARD_RESOLVE_RATE_LIMIT.split("/")[0])

    for index in range(budget + 1):
        client.get(
            f"/api/one/wallet-card/public/token-{index}",
            headers={"x-forwarded-for": "203.0.113.44"},
        )

    bystander = client.get(
        f"/api/one/wallet-card/public/{SHARE_TOKEN}",
        headers={"x-forwarded-for": "203.0.113.45"},
    )

    assert bystander.status_code == 200


def test_the_rate_limit_bucket_is_derived_from_the_forwarded_client_ip() -> None:
    class _Request:
        def __init__(self, headers: dict[str, str]) -> None:
            self.headers = headers

    visitor = one_wallet_card.public_rate_limit_key(
        _Request({"x-forwarded-for": "203.0.113.9, 198.51.100.7"})
    )
    other = one_wallet_card.public_rate_limit_key(
        _Request({"x-forwarded-for": "203.0.113.9, 198.51.100.8"})
    )

    assert visitor != other
    assert visitor.startswith("one_wallet_card_public:")


# ---------------------------------------------------------------------------
# Storage failures never reach the caller carrying the row
# ---------------------------------------------------------------------------

# Shaped exactly like ``str(<SQLAlchemy StatementError>)``: the driver message,
# then the statement, then every bound value, then the doc-link tail. Nothing
# strips the parameters unless the engine was built with ``hide_parameters=True``
# — and none of ours are — so ``DatabaseExecutionError.details`` carries the row.
LEAKY_DB_DETAILS = (
    "(psycopg2.errors.UniqueViolation) duplicate key value violates unique "
    'constraint "one_wallet_cards_pkey"\n'
    "[SQL: INSERT INTO one_wallet_cards (user_id, card_payload) "
    "VALUES (%(user_id)s, %(card_payload)s)]\n"
    "[parameters: {'user_id': 'user_123', 'card_payload': "
    '\'{"full_name": "Ada Lovelace", "email": "ada@example.com", '
    '"phone": "+91 99999 90000"}\'}]\n'
    "(Background on this error at: https://sqlalche.me/e/20/gkpj)"
)

LEAKED_VALUES = ("Ada Lovelace", "ada@example.com", "+91 99999 90000", "INSERT INTO")


def _database_error(status_code: int) -> DatabaseExecutionError:
    return DatabaseExecutionError(
        table_name="one_wallet_cards",
        operation="execute_raw",
        details=LEAKY_DB_DETAILS,
        status_code=status_code,
        code="DATABASE_UNAVAILABLE" if status_code == 503 else "DATABASE_EXECUTION_ERROR",
        hint="Retry shortly." if status_code == 503 else None,
    )


@pytest.mark.parametrize("status_code", [503, 500])
def test_a_storage_failure_never_echoes_the_bound_sql_parameters(
    service: FakeCardService, status_code: int
) -> None:
    """The owner's own name and email are in that blob, and on the public
    routes so is a stranger's card. Forwarding ``exc.details`` verbatim turns
    every transient database fault into a disclosure the caller cannot even
    act on, so the response carries the stable code and static text only."""
    service.raises = _database_error(status_code)

    response = _client().post(
        "/api/one/wallet-card",
        json={"userId": OWNER_ID, "cardPayload": CARD_PAYLOAD},
    )

    assert response.status_code == status_code
    body = response.text
    for leaked in LEAKED_VALUES:
        assert leaked not in body, f"response echoed {leaked!r}"
    assert "parameters:" not in body
    detail = response.json()["detail"]
    assert detail["code"] == (
        "DATABASE_UNAVAILABLE" if status_code == 503 else "DATABASE_EXECUTION_ERROR"
    )
    assert detail["message"] == (
        one_wallet_card._DB_UNAVAILABLE_MESSAGE
        if status_code == 503
        else one_wallet_card._DB_FAILED_MESSAGE
    )


def test_a_storage_failure_on_the_public_route_leaks_nothing_either(
    service: FakeCardService,
) -> None:
    """The public plane has no authentication at all, so the same blob would be
    readable by anyone holding — or guessing — a token."""
    service.raises = _database_error(503)

    response = _client(authenticated_as=None).get(f"/api/one/wallet-card/public/{SHARE_TOKEN}")

    assert response.status_code in {404, 500, 503}
    for leaked in LEAKED_VALUES:
        assert leaked not in response.text, f"response echoed {leaked!r}"


def test_the_database_error_log_line_carries_no_parameters(
    service: FakeCardService, caplog: pytest.LogCaptureFixture
) -> None:
    """Not leaking to the caller is only half of it — the same string must not
    be handed to the logger either (contract §10.3)."""
    service.raises = _database_error(503)

    with caplog.at_level("ERROR"):
        _client().post(
            "/api/one/wallet-card",
            json={"userId": OWNER_ID, "cardPayload": CARD_PAYLOAD},
        )

    emitted = "\n".join(record.getMessage() for record in caplog.records)
    assert "wallet_card.database_error" in emitted
    for leaked in LEAKED_VALUES:
        assert leaked not in emitted, f"log echoed {leaked!r}"


# ---------------------------------------------------------------------------
# The privacy defect this design exists to avoid
# ---------------------------------------------------------------------------


def _imported_modules(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            modules.add(node.module)
    return modules


def _executable_source(path: Path) -> str:
    """Return the module's executable source with docstrings stripped.

    The wallet-card modules deliberately *name* the projection plane in their
    docstrings to explain why they must never use it. Grepping raw source would
    therefore flag the very comment that documents the rule, so this strips
    docstrings and reports only real code — an actual read/write of the table
    still shows up as a SQL string constant or an identifier.
    """
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        body = getattr(node, "body", [])
        if (
            body
            and isinstance(body[0], ast.Expr)
            and isinstance(body[0].value, ast.Constant)
            and isinstance(body[0].value.value, str)
        ):
            body.pop(0)
            if not body:
                body.append(ast.Pass())
    return ast.unparse(ast.fix_missing_locations(tree))


def test_publishing_a_wallet_card_never_touches_the_projection_plane() -> None:
    """A Wallet card must never become a marketplace listing.

    ``marketplace_catalog_service.list_available_listings`` selects
    ``pkm_default_available_projections`` with no source filter and exposes the
    owner's real display name, so a card written there would silently list the
    owner for sale. Neither the routes nor the service may read, write, or even
    import that plane.
    """
    for relative in (
        "api/routes/one_wallet_card.py",
        "hushh_mcp/services/one_wallet_card_service.py",
    ):
        path = ROOT / relative
        statements = _executable_source(path)

        assert "pkm_default_available_projections" not in statements, relative
        assert "public_profile_handle" not in statements, relative
        assert "publication_provenance" not in statements, relative
        assert "marketplace_public_profiles" not in statements, relative

        imports = _imported_modules(path)
        for forbidden in (
            "hushh_mcp.services.marketplace_catalog_service",
            "hushh_mcp.services.personal_knowledge_model_service",
            "api.routes.pkm_routes_shared",
        ):
            assert forbidden not in imports, f"{relative} imports {forbidden}"


def test_the_marketplace_catalogue_cannot_see_the_wallet_card_table() -> None:
    """The other direction: the catalogue must not learn about the card plane."""
    catalogue = (ROOT / "hushh_mcp" / "services" / "marketplace_catalog_service.py").read_text(
        encoding="utf-8"
    )

    assert "one_wallet_cards" not in catalogue
    assert "wallet_card" not in catalogue


def test_publishing_a_card_writes_only_to_the_wallet_card_plane(
    service: FakeCardService,
) -> None:
    """Behavioural counterpart: an upsert reaches the wallet service and nothing else."""
    response = _client().post(
        "/api/one/wallet-card",
        json={"userId": OWNER_ID, "cardPayload": CARD_PAYLOAD},
    )

    assert response.status_code == 200
    assert [name for name, _ in service.calls] == ["upsert_card"]
    assert service.calls[0][1]["user_id"] == OWNER_ID
    assert set(service.calls[0][1]["card_payload"]) <= {
        "full_name",
        "headline",
        "organisation",
        "location_label",
        "summary",
        "skills",
        "email",
        "phone",
        "website",
        "linkedin",
        "github",
        "portfolio",
        "preferred_contact",
    }
