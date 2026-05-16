"""Auth parity tests: ZKP header vs bearer-token path in require_vault_owner_token.

Verifies that the ``X-Hushh-ZK-Proof`` injection into the existing
``require_vault_owner_token`` FastAPI dependency works correctly:

    ZKP path      — valid proof → 200, returns zk_proof=True sentinel
    ZKP priority  — proof present + valid bearer → ZKP wins; invalid proof
                    → 401 even if bearer would have passed
    Standard path — no proof header → existing bearer / X-Hushh-Consent
                    behaviour unchanged
    _validate_zk_proof unit — format checks, field validation, HMAC check

No DB, no network.  Tests use a minimal FastAPI app with a ``/profile``
route that depends on ``require_vault_owner_token``.

Integrated by Abdul Gaffar — ZKP auth parity.
"""

from __future__ import annotations

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

import api.middleware as mw
from api.middleware import _validate_zk_proof, _zkp_sign, require_vault_owner_token

# ---------------------------------------------------------------------------
# Helpers — build a valid ZK proof for tests
# ---------------------------------------------------------------------------

_USER = "user-zkp-parity-001"
_AGENT = "agent:zkp-test-firm"
_SCOPE = "vault.owner"
_NONCE = "nonce-abc-123"


def _make_proof(
    user_id: str = _USER,
    agent_id: str = _AGENT,
    scope: str = _SCOPE,
    nonce: str = _NONCE,
    *,
    tamper_sig: bool = False,
) -> str:
    """Build a well-formed ZK proof string using the real signing key.

    Format: ZKP|<user_id>|<agent_id>|<scope>|<nonce>|<hmac-sha256>
    Pipe separators avoid ambiguity with colon-containing agent IDs like
    'ria:firm-001'.
    """
    payload = f"{user_id}|{agent_id}|{scope}|{nonce}"
    sig = _zkp_sign(payload)
    if tamper_sig:
        sig = sig[:-4] + "xxxx"
    return f"ZKP|{user_id}|{agent_id}|{scope}|{nonce}|{sig}"


# ---------------------------------------------------------------------------
# Minimal test app — GET /profile protected by require_vault_owner_token
# ---------------------------------------------------------------------------


def _build_app() -> FastAPI:
    app = FastAPI()

    @app.get("/profile")
    async def profile(token_data: dict = Depends(require_vault_owner_token)):
        return {
            "user_id": token_data["user_id"],
            "zk_proof": token_data.get("zk_proof", False),
        }

    return app


# ===========================================================================
# ZKP path — valid proof returns 200
# ===========================================================================


class TestValidZKProof:
    def test_valid_proof_returns_200(self):
        client = TestClient(_build_app(), raise_server_exceptions=False)
        response = client.get("/profile", headers={"X-Hushh-ZK-Proof": _make_proof()})
        assert response.status_code == 200

    def test_valid_proof_sets_user_id(self):
        client = TestClient(_build_app(), raise_server_exceptions=False)
        data = client.get("/profile", headers={"X-Hushh-ZK-Proof": _make_proof()}).json()
        assert data["user_id"] == _USER

    def test_valid_proof_sets_zk_proof_sentinel(self):
        client = TestClient(_build_app(), raise_server_exceptions=False)
        data = client.get("/profile", headers={"X-Hushh-ZK-Proof": _make_proof()}).json()
        assert data["zk_proof"] is True

    def test_valid_proof_different_scope(self):
        proof = _make_proof(scope="attr.financial.read")
        client = TestClient(_build_app(), raise_server_exceptions=False)
        response = client.get("/profile", headers={"X-Hushh-ZK-Proof": proof})
        assert response.status_code == 200


# ===========================================================================
# ZKP path — invalid proof returns 401
# ===========================================================================


class TestInvalidZKProof:
    def test_tampered_signature_returns_401(self):
        proof = _make_proof(tamper_sig=True)
        client = TestClient(_build_app(), raise_server_exceptions=False)
        assert client.get("/profile", headers={"X-Hushh-ZK-Proof": proof}).status_code == 401

    def test_wrong_prefix_returns_401(self):
        proof = _make_proof().replace("ZKP|", "BAD|", 1)
        client = TestClient(_build_app(), raise_server_exceptions=False)
        assert client.get("/profile", headers={"X-Hushh-ZK-Proof": proof}).status_code == 401

    def test_missing_field_returns_401(self):
        # Only 5 fields instead of 6 — missing hmac
        proof = f"ZKP|{_USER}|{_AGENT}|{_SCOPE}|{_NONCE}"
        client = TestClient(_build_app(), raise_server_exceptions=False)
        assert client.get("/profile", headers={"X-Hushh-ZK-Proof": proof}).status_code == 401

    def test_empty_user_id_returns_401(self):
        # user_id field is blank — valid HMAC over empty user_id
        payload = f"|{_AGENT}|{_SCOPE}|{_NONCE}"
        sig = _zkp_sign(payload)
        proof = f"ZKP||{_AGENT}|{_SCOPE}|{_NONCE}|{sig}"
        client = TestClient(_build_app(), raise_server_exceptions=False)
        assert client.get("/profile", headers={"X-Hushh-ZK-Proof": proof}).status_code == 401

    def test_401_has_www_authenticate_header(self):
        proof = _make_proof(tamper_sig=True)
        client = TestClient(_build_app(), raise_server_exceptions=False)
        response = client.get("/profile", headers={"X-Hushh-ZK-Proof": proof})
        assert response.headers.get("WWW-Authenticate") == "Bearer"


# ===========================================================================
# ZKP priority — proof takes precedence over bearer token
# ===========================================================================


class TestZKPPriority:
    def test_invalid_proof_blocks_even_with_valid_bearer(self, monkeypatch):
        """When ZK header is present and invalid, bearer token must NOT be tried."""
        proof = _make_proof(tamper_sig=True)
        # Monkeypatch validate_token_with_db to prove it is never called.
        called: list[str] = []

        async def _fake_validate(token, scope=None):
            called.append(token)
            return True, None, object()

        monkeypatch.setattr(mw, "validate_token_with_db", _fake_validate)
        client = TestClient(_build_app(), raise_server_exceptions=False)
        response = client.get(
            "/profile",
            headers={
                "X-Hushh-ZK-Proof": proof,
                "Authorization": "Bearer some-would-be-valid-token",
            },
        )
        assert response.status_code == 401
        assert called == [], "validate_token_with_db must not be called when ZK header is present"

    def test_valid_proof_bypasses_bearer_entirely(self, monkeypatch):
        """Valid ZK proof returns 200 without ever touching bearer validation."""
        called: list[str] = []

        async def _fake_validate(token, scope=None):
            called.append(token)
            return False, "should not reach here", None

        monkeypatch.setattr(mw, "validate_token_with_db", _fake_validate)
        client = TestClient(_build_app(), raise_server_exceptions=False)
        response = client.get("/profile", headers={"X-Hushh-ZK-Proof": _make_proof()})
        assert response.status_code == 200
        assert called == []


# ===========================================================================
# Standard bearer path — unchanged when no ZK header
# ===========================================================================


class TestStandardPathUnchanged:
    def test_no_header_at_all_returns_401(self):
        client = TestClient(_build_app(), raise_server_exceptions=False)
        assert client.get("/profile").status_code == 401

    def test_missing_zk_header_falls_through_to_bearer(self, monkeypatch):
        """Without X-Hushh-ZK-Proof the existing bearer path is still tried."""
        from types import SimpleNamespace

        async def _fake_validate(token, scope=None):
            return True, None, SimpleNamespace(
                user_id="bearer-user", agent_id="agent:bearer",
                scope=None, scope_str="vault.owner",
            )

        monkeypatch.setattr(mw, "validate_token_with_db", _fake_validate)
        client = TestClient(_build_app(), raise_server_exceptions=False)
        response = client.get("/profile", headers={"Authorization": "Bearer fake-but-mocked"})
        assert response.status_code == 200
        assert response.json()["user_id"] == "bearer-user"
        assert response.json()["zk_proof"] is False


# ===========================================================================
# _validate_zk_proof — unit tests (no route, no HTTP)
# ===========================================================================


class TestValidateZkProof:
    def test_valid_proof_returns_true(self):
        proof = _make_proof()
        valid, reason, data = _validate_zk_proof(proof)
        assert valid is True
        assert reason is None
        assert data is not None

    def test_valid_proof_returns_user_id(self):
        valid, _, data = _validate_zk_proof(_make_proof())
        assert data["user_id"] == _USER

    def test_valid_proof_returns_agent_id(self):
        valid, _, data = _validate_zk_proof(_make_proof())
        assert data["agent_id"] == _AGENT

    def test_valid_proof_returns_scope(self):
        valid, _, data = _validate_zk_proof(_make_proof())
        assert data["scope"] == _SCOPE

    def test_tampered_sig_returns_false(self):
        valid, reason, data = _validate_zk_proof(_make_proof(tamper_sig=True))
        assert valid is False
        assert data is None
        assert reason is not None

    def test_wrong_prefix_returns_false(self):
        proof = _make_proof().replace("ZKP|", "XYZ|", 1)
        valid, reason, _ = _validate_zk_proof(proof)
        assert valid is False
        assert "prefix" in (reason or "").lower()

    def test_too_few_fields_returns_false(self):
        valid, reason, _ = _validate_zk_proof("ZKP|u|a|s|n")
        assert valid is False
        assert "malformed" in (reason or "").lower()

    def test_empty_string_returns_false(self):
        valid, reason, _ = _validate_zk_proof("")
        assert valid is False

    def test_empty_user_id_field_returns_false(self):
        payload = f"|{_AGENT}|{_SCOPE}|{_NONCE}"
        sig = _zkp_sign(payload)
        proof = f"ZKP||{_AGENT}|{_SCOPE}|{_NONCE}|{sig}"
        valid, reason, _ = _validate_zk_proof(proof)
        assert valid is False
        assert "empty" in (reason or "").lower()


# ===========================================================================
# _zkp_sign — deterministic and constant-time compatible
# ===========================================================================


class TestZkpSign:
    def test_same_input_produces_same_output(self):
        payload = f"{_USER}|{_AGENT}|{_SCOPE}|{_NONCE}"
        assert _zkp_sign(payload) == _zkp_sign(payload)

    def test_different_input_produces_different_output(self):
        a = _zkp_sign(f"{_USER}|{_AGENT}|{_SCOPE}|nonce-a")
        b = _zkp_sign(f"{_USER}|{_AGENT}|{_SCOPE}|nonce-b")
        assert a != b

    def test_output_is_hex_string(self):
        sig = _zkp_sign("test")
        assert all(c in "0123456789abcdef" for c in sig)

    def test_output_length_is_64(self):
        assert len(_zkp_sign("test")) == 64


# ===========================================================================
# Trust-boundary proof — require_vault_owner_token is the canonical auth gate
# ===========================================================================


class TestTrustBoundaryProof:
    """
    Canonical surface : api.middleware.require_vault_owner_token
                        (FastAPI dependency wired via Depends())
    Canonical caller  : Consent routes protected by this dependency:
                          GET  /api/consent/pending      (line 267 of consent.py)
                          POST /api/consent/pending/approve  (line 318)
                          POST /api/consent/pending/deny     (line 654)
                          POST /api/consent/cancel           (line 703)
                          POST /api/consent/revoke           (line 975)
    ZKP path priority: When X-Hushh-ZK-Proof header is present and valid,
                       the ZKP path takes priority over the bearer token —
                       the same dependency handles both auth methods.
    Attach point proof: The tests below use the same Depends(require_vault_owner_token)
                        wiring on a minimal /profile route and prove both auth paths
                        work correctly — matching the contract on every real consent route.
    """

    def test_require_vault_owner_token_accepts_valid_zkp(self):
        """Valid ZKP header → 200 on a Depends(require_vault_owner_token) route."""
        proof = _make_proof()
        client = TestClient(_build_app(), raise_server_exceptions=False)
        resp = client.get(
            "/profile",
            headers={"X-Hushh-ZK-Proof": proof},
        )
        assert resp.status_code == 200
        assert resp.json()["zk_proof"] is True

    def test_require_vault_owner_token_rejects_tampered_zkp(self):
        """Tampered ZKP header → 401 on a Depends(require_vault_owner_token) route."""
        proof = _make_proof() + "tampered"
        client = TestClient(_build_app(), raise_server_exceptions=False)
        resp = client.get(
            "/profile",
            headers={"X-Hushh-ZK-Proof": proof},
        )
        assert resp.status_code == 401

    def test_require_vault_owner_token_rejects_missing_credentials(self):
        """No token, no ZKP header → 401 on a Depends(require_vault_owner_token) route."""
        client = TestClient(_build_app(), raise_server_exceptions=False)
        resp = client.get("/profile")
        assert resp.status_code == 401

    def test_zkp_is_validated_before_bearer_path(self):
        """When ZKP header is present, it takes priority and does not fall through to bearer."""
        valid_proof = _make_proof()
        client = TestClient(_build_app(), raise_server_exceptions=False)
        resp = client.get(
            "/profile",
            headers={
                "X-Hushh-ZK-Proof": valid_proof,
                "Authorization": "Bearer invalid-bearer-token",
            },
        )
        # ZKP is valid → 200; the invalid bearer is not evaluated
        assert resp.status_code == 200
        assert resp.json()["zk_proof"] is True
