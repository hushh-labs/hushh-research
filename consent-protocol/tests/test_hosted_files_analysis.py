"""Hosted Files never dispatch document model work during the pilot."""

from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from hushh_mcp.services.pod_files import jobs
from hushh_mcp.services.pod_files.library import FilesRefused
from tests.test_pod_files_jobs import queued_library as queued_library


@pytest.mark.asyncio
async def test_hosted_upload_never_enqueues_analysis_even_if_old_setting_was_enabled(
    queued_library, monkeypatch
):
    from hushh_mcp.services.pod_files.completion import complete_upload
    from hushh_mcp.services.private_gcp_deployment import HOSTING_ENV

    library, _ = queued_library
    monkeypatch.setenv(HOSTING_ENV, '{"hostingMode":"hussh_hosted"}')
    new = await library.create(name="private", parent="root", size=0, request_id="hosted-upload")

    @asynccontextmanager
    async def mutation():
        yield

    result = await complete_upload(library, new["id"], mutation=mutation())
    assert result["organization"] == {"state": "not_requested"}
    assert (await library.stat(new["id"]))["state"] == "ready"
    with pytest.raises(FilesRefused, match="FILES_MODEL_UNAVAILABLE"):
        await jobs.prepare_delivery(library, file_id=new["id"])
    with pytest.raises(FilesRefused, match="FILES_MODEL_UNAVAILABLE"):
        await jobs.deliver(library, {"id": new["id"], "state": "pending_delivery"})
    with pytest.raises(FilesRefused, match="FILES_NOT_FOUND"):
        await jobs.status(library, new["id"])


@pytest.mark.asyncio
async def test_hosted_old_queued_job_fails_without_provider_and_remains_cancellable(
    queued_library, monkeypatch
):
    from hushh_mcp.runtime_providers.factory import ManagedGeminiRuntimeBinding
    from hushh_mcp.services import pod_role
    from hushh_mcp.services.private_gcp_deployment import HOSTING_ENV

    library, entry = queued_library
    await jobs.enqueue(library, file_id=entry["id"])
    job, _ = await library._read(f"jobs/{entry['id']}.bin")
    monkeypatch.setenv(HOSTING_ENV, '{"hostingMode":"hussh_hosted"}')

    async def held():
        pass

    @asynccontextmanager
    async def operation(**_kwargs):
        yield library

    monkeypatch.setattr(jobs, "operation", operation)
    monkeypatch.setattr(pod_role, "require_serving_role", held)
    monkeypatch.setattr(
        "hushh_mcp.services.pod_session_authority.active_session_authority",
        lambda: SimpleNamespace(require_held=held),
    )
    monkeypatch.setattr(
        ManagedGeminiRuntimeBinding,
        "from_environment",
        lambda **_kwargs: pytest.fail("Hosted Files constructed a provider"),
    )
    assert await jobs.run_job(entry["id"], job["delivery"]) == {"state": "failed"}
    assert (await library.stat(entry["id"]))["name"] == "original"
    assert (await jobs.status(library, entry["id"], cancel=True))["state"] == "cancelled"


@pytest.mark.parametrize("marker", ['{"hostingMode":"hussh_hosted"}', "invalid", ""])
def test_hosted_marker_refuses_files_model_even_if_project_local(monkeypatch, marker):
    from hushh_mcp.services.pod_files.model_binding import (
        organization_model_binding,
        organization_model_status,
    )
    from hushh_mcp.services.private_gcp_deployment import HOSTING_ENV

    monkeypatch.setenv(HOSTING_ENV, marker)
    with pytest.raises(FilesRefused, match="FILES_MODEL_UNAVAILABLE"):
        organization_model_binding()
    assert organization_model_status() == {"backgroundAvailable": False, "backgroundProvider": None}
