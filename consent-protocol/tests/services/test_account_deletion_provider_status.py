from contextlib import contextmanager
from unittest.mock import MagicMock
from uuid import uuid4

import pytest

from hushh_mcp.services import account_deletion_provider_journal as journal
from hushh_mcp.services.account_deletion_lifecycle_service import account_deletion_user_hash


@pytest.mark.parametrize("phase", ["provider_cleanup", "erased"])
def test_identity_scoped_cleanup_exposes_hash_but_not_completed_raw_owner(monkeypatch, phase):
    owner = "acct_" + "d" * 32
    operation = uuid4()
    row = {
        "account_owner_id": owner,
        "user_id_hash": account_deletion_user_hash(owner),
        "provider_cleanup_id": operation,
        "erasure_phase": phase,
        "cleanup_status": "pending",
        "provider_cleanup_inventory": {},
        "provider_cleanup_receipt": {"inventorySha256": "a" * 64},
        "delayed": False,
    }
    connection = MagicMock()
    connection.execute.return_value.mappings.return_value.first.return_value = row

    @contextmanager
    def connection_scope():
        yield connection

    monkeypatch.setattr(journal, "get_db_connection", connection_scope)
    result = journal.inspect_for_identity("firebase-identity", operation_id=str(operation))
    assert result["id"] == str(operation)
    assert result["owner_hash"] == account_deletion_user_hash(owner)
    assert result["owner_id"] == (owner if phase == "provider_cleanup" else None)
    assert result["state"] == ("cleaning_up" if phase == "provider_cleanup" else "complete")
    assert connection.execute.call_args.args[1]["operation_id"] == str(operation)
