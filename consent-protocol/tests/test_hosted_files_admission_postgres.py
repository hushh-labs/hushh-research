"""Managed Files remain gated by the real PostgreSQL erasure contract."""

import asyncio

from tests.test_hosted_pilot_admission_postgres import ROOT, _Client
from tests.test_hosted_pilot_admission_postgres import pg as pg
from tests.test_hosted_pilot_admission_postgres import pytestmark as pytestmark


def test_hosted_files_readiness_refuses_974_without_erasure_settlement(pg):
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
    from hushh_mcp.services.pod_files.capability_contract import hosted_schema_ready

    client = _Client(pg)
    repo = PersonalAgentRegistryRepo(client)
    try:
        assert not asyncio.run(hosted_schema_ready(repo))
        pg.apply_file(ROOT / "db/migrations/parked/974_hosted_pod_custody.sql")
        assert not asyncio.run(hosted_schema_ready(repo))
    finally:
        client._engine.dispose()
