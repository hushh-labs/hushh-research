import asyncio

import pytest
from google.adk.sessions import Session

from db.db_client import DatabaseExecutionError
from hushh_mcp.one_adk.encrypted_session_service import (
    EncryptedAdkSessionService,
    EncryptedAdkSessionUnavailableError,
)


def test_session_document_encrypts_state_and_messages(monkeypatch) -> None:
    monkeypatch.setenv("APP_SIGNING_KEY", "a" * 32)
    monkeypatch.setenv("VAULT_DATA_KEY", "01" * 32)
    service = EncryptedAdkSessionService()
    session = Session(
        id="thread-1",
        app_name="hussh_one",
        user_id="owner-1",
        state={"private": "sensitive profile value"},
        events=[],
    )
    encoded = service._encode(session)
    assert "sensitive profile value" not in encoded["ciphertext"]
    decoded = service._decode(
        {
            "payload_ciphertext": encoded["ciphertext"],
            "payload_iv": encoded["iv"],
            "payload_tag": encoded["tag"],
            "payload_algorithm": encoded["algorithm"],
        }
    )
    assert decoded.state == session.state


def test_database_failure_never_exposes_sql_or_bound_values(monkeypatch) -> None:
    service = EncryptedAdkSessionService()
    private_value = "owner-secret-ciphertext"

    def fail_execute(*_args, **_kwargs):
        raise DatabaseExecutionError(
            table_name="<raw_sql>",
            operation="execute_raw",
            details=f"INSERT INTO one_adk_sessions [parameters: {private_value}]",
        )

    monkeypatch.setattr(
        "hushh_mcp.one_adk.encrypted_session_service.get_db",
        lambda: type(
            "FailingDatabase",
            (),
            {"execute_raw": staticmethod(fail_execute)},
        )(),
    )

    with pytest.raises(EncryptedAdkSessionUnavailableError) as caught:
        asyncio.run(service._execute("INSERT secret", {"payload": private_value}))

    rendered = str(caught.value)
    assert rendered == "Conversation storage is temporarily unavailable."
    assert private_value not in rendered
    assert "INSERT" not in rendered
