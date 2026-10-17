"""The PkmWriteEngine seam: named operations, byte-identical Postgres delegation.

S1 of the pod-native PKM work. The seam's whole value is that it is provably a
no-op today: every operation forwards to the SAME stored procedure with the SAME
params dict the service used to pass to ``_run_rpc`` directly. These tests pin
that -- so when a second engine arrives, "the seam changed behaviour" is a claim
the suite can refute rather than a hope.
"""

from __future__ import annotations

from typing import Any, Optional

import pytest

from hushh_mcp.services.pkm_write_engine import (
    ENGINE_POSTGRES,
    PKM_WRITE_ENGINE_ENV,
    PkmWriteEngine,
    PostgresPkmWriteEngine,
    resolve_pkm_write_engine,
)


class _RecordingRpc:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Optional[dict]]] = []

    async def __call__(self, function_name: str, params: Optional[dict] = None) -> Any:
        self.calls.append((function_name, params))
        return {"ok": True, "fn": function_name}


# Operation -> the stored procedure it must reach. This mapping IS the contract;
# a typo here is a wrong-procedure call in production.
_EXPECTED = [
    ("commit_domain_mutation", "commit_pkm_domain_mutation_v4"),
    ("merge_domain_summary", "merge_pkm_domain_summary"),
    ("get_domain_snapshot", "get_pkm_domain_snapshot_v1"),
    ("delete_domain", "delete_pkm_domain_v3"),
    ("delete_domain_legacy", "delete_pkm_domain_v2"),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("method,procedure", _EXPECTED)
async def test_each_operation_reaches_its_exact_stored_procedure(method: str, procedure: str):
    rpc = _RecordingRpc()
    engine = PostgresPkmWriteEngine(rpc)
    params = {"p_user_id": "u1", "p_domain": "finance", "marker": method}

    result = await getattr(engine, method)(params)

    assert rpc.calls == [(procedure, params)]
    # The raw rpc result passes through untouched -- unwrapping stays in the
    # service, exactly where it was.
    assert result == {"ok": True, "fn": procedure}


@pytest.mark.asyncio
async def test_params_are_forwarded_by_reference_not_reshaped():
    """The engine must not normalize, copy, or 'improve' the params. The service
    already built them for the stored procedure; any reshaping here is silent drift."""
    rpc = _RecordingRpc()
    engine = PostgresPkmWriteEngine(rpc)
    params = {"p_user_id": "u1", "nested": {"deep": [1, 2, 3]}}

    await engine.commit_domain_mutation(params)

    assert rpc.calls[0][1] is params


def test_postgres_engine_satisfies_the_protocol():
    assert isinstance(PostgresPkmWriteEngine(_RecordingRpc()), PkmWriteEngine)
    assert PostgresPkmWriteEngine(_RecordingRpc()).engine_id == ENGINE_POSTGRES


def test_resolver_defaults_to_postgres(monkeypatch: pytest.MonkeyPatch):
    for value in (None, "", "postgres", "POSTGRES"):
        if value is None:
            monkeypatch.delenv(PKM_WRITE_ENGINE_ENV, raising=False)
        else:
            monkeypatch.setenv(PKM_WRITE_ENGINE_ENV, value)
        engine = resolve_pkm_write_engine(_RecordingRpc())
        assert engine.engine_id == ENGINE_POSTGRES


def test_an_unknown_engine_fails_loud(monkeypatch: pytest.MonkeyPatch):
    """'Which engine holds the user's PKM' is never answered by silent fallback."""
    monkeypatch.setenv(PKM_WRITE_ENGINE_ENV, "cloud-magic")
    with pytest.raises(NotImplementedError):
        resolve_pkm_write_engine(_RecordingRpc())


@pytest.mark.asyncio
async def test_the_service_routes_its_data_plane_through_the_engine():
    """An injected engine sees the service's calls -- proof the call sites moved."""
    from hushh_mcp.services.personal_knowledge_model_service import (
        PersonalKnowledgeModelService,
    )

    class _RecordingEngine:
        engine_id = "recording"

        def __init__(self) -> None:
            self.snapshot_params: Optional[dict] = None

        async def commit_domain_mutation(self, params: dict) -> Any:
            return None

        async def merge_domain_summary(self, params: dict) -> Any:
            return None

        async def get_domain_snapshot(self, params: dict) -> Any:
            self.snapshot_params = params
            return {"segments": []}

        async def delete_domain(self, params: dict) -> Any:
            return None

        async def delete_domain_legacy(self, params: dict) -> Any:
            return None

    engine = _RecordingEngine()
    service = PersonalKnowledgeModelService(write_engine=engine)
    assert service.write_engine is engine

    try:
        await service.get_domain_snapshot("user-1", "finance", segment_ids=["core"])
    except Exception:
        # Downstream normalization may object to the fake's minimal payload; the
        # assertion that matters is that the ENGINE received the call.
        pass

    assert engine.snapshot_params is not None
    assert engine.snapshot_params["p_user_id"] == "user-1"
    assert engine.snapshot_params["p_domain"] == "finance"
