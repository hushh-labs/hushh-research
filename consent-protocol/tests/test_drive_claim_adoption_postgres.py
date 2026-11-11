"""Release adoption needs a Drive key only for existing uncertain writes."""

# ruff: noqa: F401, F811 -- canonical isolated PostgreSQL fixtures

import json
import os
import runpy
import sys
from pathlib import Path
from unittest.mock import Mock

import pytest
from sqlalchemy import text

from hushh_mcp.services import external_connector_lifecycle_store as lifecycle_store
from hushh_mcp.services.drive_permission_file_claims import has_unclaimed_uncertainty
from tests.services.test_drive_bulk_share_postgres import (
    _approved_share,
    bulk,
    connector_postgres_url,
    lifecycle,
)


@pytest.mark.asyncio
@pytest.mark.parametrize("pending", [False, True])
async def test_dev_adoption_requires_keys_only_for_real_pending_work(
    bulk, monkeypatch, capsys, pending
):
    # The minimal bulk fixture omits this full release-schema removal column.
    with bulk.db.engine.begin() as connection:
        connection.execute(text("ALTER TABLE drive_request_bulk_removals ADD COLUMN user_id TEXT"))
    key = os.environ["DRIVE_SHARING_KEY_V1"]
    if pending:
        share = await _approved_share(bulk)
        with bulk.db.engine.begin() as connection:
            connection.execute(
                text("UPDATE drive_bulk_share_effects SET state='unknown' WHERE share_id=:share"),
                {"share": share},
            )
    monkeypatch.delenv("DRIVE_SHARING_KEY_V1")
    monkeypatch.setenv("GCP_PROJECT_ID", "hushh-pda-dev")
    monkeypatch.setattr(sys, "path", sys.path.copy())
    script = Path(__file__).resolve().parents[1] / "scripts/adopt_drive_permission_file_claims.py"
    main = runpy.run_path(str(script))["main"]
    read_key = Mock(side_effect=lambda _: monkeypatch.setenv("DRIVE_SHARING_KEY_V1", key))
    monkeypatch.setitem(main.__globals__, "release_keys", read_key)
    monkeypatch.setattr(lifecycle_store, "ExternalConnectorLifecycleStore", lambda: bulk)
    await main("dev")
    assert read_key.call_count == int(pending)
    if pending:
        read_key.assert_called_once_with("dev")
    assert json.loads(capsys.readouterr().out) == {
        "schema_version": 1,
        "adopted_claims": int(pending),
        "provider_calls": 0,
    }
    assert not await bulk._transaction(has_unclaimed_uncertainty)
    monkeypatch.setenv("GCP_PROJECT_ID", "hushh-pda-uat")
    with pytest.raises(ValueError, match="environment_mismatch"):
        await main("dev")
