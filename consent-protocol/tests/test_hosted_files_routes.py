"""Managed Files offer and analysis controls."""

from contextlib import asynccontextmanager

import pytest
from fastapi import HTTPException

from api.routes.one import pod_files
from tests.test_pod_files_jobs import queued_library as queued_library


@pytest.mark.asyncio
@pytest.mark.parametrize("case", ["ready", "stale-schema", "changed-placement"])
async def test_hosted_files_offer_requires_retained_authority_and_read_only_inspection(
    monkeypatch, case
):
    import asyncio
    from copy import deepcopy
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, Mock

    from hushh_mcp.services.pod_files import update_offer
    from tests.test_hosted_files_provisioning import hosted_files_fixture

    row, target, service, _ = hosted_files_fixture(monkeypatch)
    monkeypatch.setenv("HUSSH_POD_FILES_ENABLED", "true")
    changed = deepcopy(row)
    changed["backend_metadata"]["provisionAttempt"]["hostedAdmission"]["assignment"][
        "extraAuthority"
    ] = "changed"
    current = changed if case == "changed-placement" else row
    db = Mock()
    db.execute_raw.return_value = SimpleNamespace(data=[])
    if case == "stale-schema":
        db.execute_raw.side_effect = RuntimeError("synthetic custody qualification refused")
    repo = Mock(
        _db=Mock(return_value=db),
        files_upgrade_admission_ready=AsyncMock(return_value=True),
        hosted_retained_current=AsyncMock(return_value=True),
        get=AsyncMock(side_effect=[row, current, current]),
    )
    inspected = []

    async def inspect(spec):
        assert spec.hosted_admission_guard.operation == "inspect"
        await asyncio.to_thread(spec.hosted_admission_guard)
        inspected.append(spec)
        return service

    monkeypatch.setattr(
        update_offer,
        "resolve_compute_backend_for_spec",
        lambda _: SimpleNamespace(inspect_files_capability=inspect),
    )
    monkeypatch.setattr(update_offer, "verify_storage_prerequisite", AsyncMock())
    if case != "ready":
        with pytest.raises(ValueError):
            await update_offer.inspect_files_offer(repo, row, target)
        assert not inspected
        return
    plan = await update_offer.inspect_files_offer(repo, row, target)
    offer = update_offer.public_files_offer(plan, hosted=True)
    assert plan.project == row["backend_metadata"]["project"]
    assert offer["modelProcessing"] == "Files analysis is not available in this pilot."
    assert "managed pod" in offer["summary"]
    assert len(inspected) == 1
    db.execute_raw.assert_called_once()
    assert db.execute_raw.call_args.args[1] == {}
    repo.approve_upgrade.assert_not_called()


@pytest.mark.asyncio
async def test_hosted_files_refuses_automatic_analysis_and_permits_withdrawal(
    queued_library, monkeypatch
):
    from hushh_mcp.services.private_gcp_deployment import HOSTING_ENV

    library, entry = queued_library
    monkeypatch.setenv(HOSTING_ENV, '{"hostingMode":"hussh_hosted"}')

    @asynccontextmanager
    async def operation(**_kwargs):
        yield library

    monkeypatch.setattr(pod_files, "operation", operation)
    settings = await library.settings()
    with pytest.raises(HTTPException) as refused:
        await pod_files.update_settings(
            pod_files.AnalysisSettings(
                revision=settings["revision"],
                analysis=True,
                automatic=True,
                excluded=[entry["id"]],
            ),
            {},
        )
    assert refused.value.detail == {"code": "FILES_MODEL_UNAVAILABLE"}
    paused = await pod_files.update_settings(
        pod_files.AnalysisSettings(
            revision=settings["revision"], analysis=False, automatic=False, excluded=[]
        ),
        {},
    )
    assert not paused["analysis"] and not paused["automatic"]
