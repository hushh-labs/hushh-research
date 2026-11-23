from contextlib import asynccontextmanager
from datetime import datetime, timezone
from unittest.mock import AsyncMock

import pytest

from scripts.ops import one_adoption_reference as reference


@pytest.mark.parametrize("day", ["2026-11-23", "2026-11-15", "20261122"])
def test_reference_requires_closed_utc_day(day):
    with pytest.raises(ValueError):
        reference.period(day, datetime(2026, 11, 23).date())


@pytest.mark.asyncio
@pytest.mark.parametrize("limited", [False, True])
async def test_reference_reconciles_per_owner_effects_in_read_only_snapshot(monkeypatch, limited):
    observed = datetime.now(timezone.utc)
    day = (observed - reference.timedelta(days=1)).date().isoformat()
    policy = reference.plg_reporting.ReportingPolicy(
        frozenset({"excluded"}), frozenset(), frozenset(), "a" * 64
    )
    monkeypatch.setattr(reference.plg_reporting, "reporting_policy", lambda: policy)
    app = object()
    monkeypatch.setattr(reference.plg_reporting, "reporting_auth_app", lambda: app)
    monkeypatch.setattr(
        reference.plg_reporting,
        "current_reporting_records",
        AsyncMock(return_value={uid: {"emails": []} for uid in ["original", "excluded", "legacy"]}),
    )
    effects = AsyncMock(side_effect=[({"receipt": observed}, limited), ({}, False)])
    monkeypatch.setattr(reference.plg_outcomes, "value_effects", effects)

    class Connection:
        execute = AsyncMock()
        fetchval = AsyncMock(side_effect=[False, observed])
        fetchrow = AsyncMock(
            return_value={
                "database_name": "hushh_vault",
                "database_role": "hushh_app",
                "server_version_num": 150000,
                "system_identifier": "7583196663345094671",
            }
        )
        fetch = AsyncMock(
            side_effect=[
                [{"user_id": owner} for owner in ["replacement", "blocked", "legacy"]],
                [
                    {"owner": owner, "uid": uid, "email": "fixture@example.test"}
                    for owner, uid in [
                        ("replacement", "original"),
                        ("blocked", "excluded"),
                        ("legacy", "legacy"),
                    ]
                ],
                [],
                [{"user_id": "legacy"}],
            ]
        )

        @asynccontextmanager
        async def transaction(self, *, isolation, readonly):
            assert isolation == "repeatable_read" and readonly
            yield

    if limited:
        with pytest.raises(ValueError, match="Incomplete outcomes"):
            await reference.reference(Connection(), day, policy.revision, "b" * 40)
    else:
        receipt = await reference.reference(Connection(), day, policy.revision, "b" * 40)
        assert receipt["activeAccounts"] == 2 and receipt["confirmedOutcomes"] == 1
        assert [call.args[1] for call in effects.await_args_list] == ["replacement", "legacy"]
