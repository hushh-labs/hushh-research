"""Fresh consent refresh bootstrap includes the canonical timestamp function."""

from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from db.migrate import create_consent_export_refresh_jobs


@pytest.mark.asyncio
async def test_refresh_bootstrap_defines_timestamp_function_before_trigger():
    pool = AsyncMock()
    await create_consent_export_refresh_jobs(pool)
    statements = [call.args[0] for call in pool.execute.await_args_list]
    definition = next(sql for sql in statements if "CREATE OR REPLACE FUNCTION" in sql)
    trigger = next(sql for sql in statements if "CREATE TRIGGER" in sql)
    assert statements.index(definition) < statements.index(trigger)
    # The bootstrap preserves the historical shared function's body, rather
    # than assigning different timestamp semantics to existing consumers.
    historical = (Path(__file__).parents[1] / "db/migrations/006_fix_triggers.sql").read_text()
    historical_body = historical.split("RETURNS TRIGGER AS $$", 1)[1].split("$$", 1)[0]
    bootstrap_body = definition.split("RETURNS TRIGGER AS $$", 1)[1].split("$$", 1)[0]
    assert " ".join(bootstrap_body.split()) == " ".join(historical_body.split())
