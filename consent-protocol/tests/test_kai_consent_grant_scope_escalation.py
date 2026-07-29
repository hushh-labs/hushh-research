"""Prove that privileged scopes cannot be self-granted via POST /kai/consent/grant."""

from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.kai import consent as consent_module

_app = FastAPI()
_app.include_router(consent_module.router, prefix="/kai")


class TestScopeBlocklist:
    """Canonical attach point: POST /kai/consent/grant scope validation."""

    @pytest.fixture(autouse=True)
    def setup(self):
        _app.dependency_overrides.clear()
        yield
        _app.dependency_overrides.clear()

    def _client(self):
        return TestClient(_app, raise_server_exceptions=False)

    def _post_grant(self, scopes):
        _app.dependency_overrides[consent_module.require_firebase_auth] = lambda: "user_123"

        with patch.object(consent_module, "verify_user_id_match"):
            resp = self._client().post(
                "/kai/consent/grant",
                json={"user_id": "user_123", "scopes": scopes},
            )
        return resp

    def test_vault_owner_blocked(self):
        """vault.owner scope must be rejected with 403 and not echoed in the response."""
        resp = self._post_grant(["vault.owner"])
        assert resp.status_code == 403
        assert "vault.owner" not in resp.json().get("detail", "")

    def test_agent_nav_revoke_blocked(self):
        """agent.nav.revoke scope must be rejected with 403 and not echoed in the response."""
        resp = self._post_grant(["agent.nav.revoke"])
        assert resp.status_code == 403
        assert "agent.nav.revoke" not in resp.json().get("detail", "")

    def test_pkm_write_blocked(self):
        """pkm.write scope must be rejected with 403 and not echoed in the response."""
        resp = self._post_grant(["pkm.write"])
        assert resp.status_code == 403
        assert "pkm.write" not in resp.json().get("detail", "")

    def test_safe_attr_scope_accepted(self):
        """Safe attr.financial.* scopes must still be accepted."""
        _app.dependency_overrides[consent_module.require_firebase_auth] = lambda: "user_123"

        with patch.object(consent_module, "verify_user_id_match"), \
             patch.object(consent_module, "issue_token") as mock_issue:
            mock_token = MagicMock()
            mock_token.token = "fake_token"  # noqa: S105
            mock_token.expires_at = 9999999999
            mock_issue.return_value = mock_token

            with patch.object(consent_module.ConsentDBService, "insert_internal_event"):
                resp = self._client().post(
                    "/kai/consent/grant",
                    json={"user_id": "user_123", "scopes": ["attr.financial.*"]},
                )

        assert resp.status_code == 200
        assert "tokens" in resp.json()

    def test_kai_agent_scope_accepted(self):
        """Safe agent.kai.* scopes must still be accepted."""
        _app.dependency_overrides[consent_module.require_firebase_auth] = lambda: "user_123"

        with patch.object(consent_module, "verify_user_id_match"), \
             patch.object(consent_module, "issue_token") as mock_issue:
            mock_token = MagicMock()
            mock_token.token = "fake_token"  # noqa: S105
            mock_token.expires_at = 9999999999
            mock_issue.return_value = mock_token

            with patch.object(consent_module.ConsentDBService, "insert_internal_event"):
                resp = self._client().post(
                    "/kai/consent/grant",
                    json={"user_id": "user_123", "scopes": ["agent.kai.analyze"]},
                )

        assert resp.status_code == 200
        assert "tokens" in resp.json()

    def test_out_of_contract_attr_domain_still_rejected(self):
        """attr.health.* must still be rejected by the existing Kai-contract check."""
        resp = self._post_grant(["attr.health.*"])
        assert resp.status_code == 400
