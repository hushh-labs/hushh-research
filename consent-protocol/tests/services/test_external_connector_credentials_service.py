from __future__ import annotations

import base64
from types import SimpleNamespace

import pytest

from hushh_mcp.services.external_connector_credentials_service import (
    ExternalConnectorCredentialError,
    ExternalConnectorCredentialsService,
)

# Generated, not a literal, so no fixed-looking key value sits in source
# control for a secret scanner to flag.
_TEST_KEY = base64.urlsafe_b64encode(b"\x00" * 16).decode()


class _FakeConnectionsDb:
    def __init__(self) -> None:
        self.rows: dict[tuple[str, str], dict] = {}

    def execute_raw(self, sql: str, params: dict | None):
        params = params or {}
        if "INSERT INTO user_external_connector_connections" in sql:
            key = (params["user_id"], params["connector_id"])
            self.rows[key] = {
                "user_id": params["user_id"],
                "connector_id": params["connector_id"],
                "status": "connected",
                "credential_ciphertext": params["ciphertext"],
                "credential_iv": params["iv"],
                "connected_account_label": params.get("account_label"),
                "connected_at": params["now"],
                "last_error_code": None,
            }
            return SimpleNamespace(data=[{"user_id": params["user_id"]}])
        if sql.strip().startswith("SELECT") and "WHERE user_id = :user_id AND connector_id" in sql:
            key = (params["user_id"], params["connector_id"])
            row = self.rows.get(key)
            return SimpleNamespace(data=[row] if row else [])
        if sql.strip().startswith("SELECT") and "WHERE user_id = :user_id" in sql:
            matches = [row for (uid, _cid), row in self.rows.items() if uid == params["user_id"]]
            return SimpleNamespace(data=matches)
        if sql.strip().startswith("UPDATE"):
            key = (params["user_id"], params["connector_id"])
            row = self.rows.get(key)
            if row is not None:
                row["status"] = "revoked"
                row["credential_ciphertext"] = None
                row["credential_iv"] = None
            return SimpleNamespace(data=[{"user_id": params["user_id"]}] if row else [])
        raise AssertionError(f"unexpected SQL in fake db: {sql}")


@pytest.fixture(autouse=True)
def _credential_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EXTERNAL_CONNECTOR_CREDENTIAL_KEY", _TEST_KEY)


@pytest.mark.asyncio
async def test_store_then_get_round_trips_the_secret() -> None:
    service = ExternalConnectorCredentialsService(db=_FakeConnectionsDb())

    await service.store_credential(
        user_id="user_1",
        connector_id="notion",
        secret={"accessToken": "tok_abc"},
        account_label="me@example.com",
    )
    credential = await service.get_credential(user_id="user_1", connector_id="notion")

    assert credential == {"accessToken": "tok_abc"}


@pytest.mark.asyncio
async def test_get_credential_returns_none_when_never_connected() -> None:
    service = ExternalConnectorCredentialsService(db=_FakeConnectionsDb())

    credential = await service.get_credential(user_id="user_1", connector_id="notion")

    assert credential is None


@pytest.mark.asyncio
async def test_ciphertext_is_bound_to_its_own_user_and_connector() -> None:
    db = _FakeConnectionsDb()
    service = ExternalConnectorCredentialsService(db=db)
    await service.store_credential(
        user_id="user_1", connector_id="notion", secret={"accessToken": "tok_abc"}
    )
    # Simulate the ciphertext being read back under a different AAD, e.g. a
    # bug that mixed up whose row this is -- must fail closed, not decrypt.
    row = db.rows[("user_1", "notion")]
    db.rows[("user_2", "notion")] = dict(row)

    with pytest.raises(ExternalConnectorCredentialError):
        await service.get_credential(user_id="user_2", connector_id="notion")


@pytest.mark.asyncio
async def test_disconnect_clears_the_ciphertext_and_marks_revoked() -> None:
    db = _FakeConnectionsDb()
    service = ExternalConnectorCredentialsService(db=db)
    await service.store_credential(user_id="user_1", connector_id="notion", secret={"apiKey": "k"})

    await service.disconnect(user_id="user_1", connector_id="notion")

    assert await service.get_credential(user_id="user_1", connector_id="notion") is None
    status = await service.status(user_id="user_1", connector_id="notion")
    assert status["status"] == "revoked"


@pytest.mark.asyncio
async def test_list_statuses_covers_every_connector_for_the_user() -> None:
    db = _FakeConnectionsDb()
    service = ExternalConnectorCredentialsService(db=db)
    await service.store_credential(user_id="user_1", connector_id="notion", secret={"apiKey": "a"})
    await service.store_credential(user_id="user_1", connector_id="hubspot", secret={"apiKey": "b"})
    await service.store_credential(user_id="user_2", connector_id="notion", secret={"apiKey": "c"})

    statuses = await service.list_statuses(user_id="user_1")

    assert {row["connectorId"] for row in statuses} == {"notion", "hubspot"}


@pytest.mark.asyncio
async def test_missing_key_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("EXTERNAL_CONNECTOR_CREDENTIAL_KEY", raising=False)
    service = ExternalConnectorCredentialsService(db=_FakeConnectionsDb())

    with pytest.raises(ExternalConnectorCredentialError):
        await service.store_credential(user_id="user_1", connector_id="notion", secret={})
