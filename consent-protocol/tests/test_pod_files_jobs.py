"""Real encrypted outbox with simulated task delivery failures; no provider calls."""
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from hushh_mcp.services.pod_files import jobs
from hushh_mcp.services.pod_files.library import FilesLibrary, FilesRefused
from hushh_mcp.services.pod_files.storage import FilesLocalStore


@pytest.fixture
async def queued_library(tmp_path, monkeypatch):
    async def allowed():
        pass
    library = FilesLibrary(owner="owner-a", key=b"K" * 32,
                           store=FilesLocalStore(str(tmp_path)), check=allowed)
    await library.configure(revision=0, analysis=True, automatic=True, excluded=[])
    entry = await library.create(name="original", parent="root", size=0, request_id="file-request")
    entry = await library.complete(entry["id"])
    monkeypatch.setenv("POD_FILES_TASK_QUEUE", "projects/owner-project/locations/us-central1/queues/files")
    monkeypatch.setenv("POD_FILES_WORKER_SERVICE_ACCOUNT", "worker@owner-project.iam.gserviceaccount.com")
    monkeypatch.setattr(jobs, "worker_origin", lambda: "https://pod.example")
    library.store._authorized = lambda call: call({})
    library.store._session = SimpleNamespace(post=lambda *a, **kw: SimpleNamespace(status_code=200))
    return library, entry


@pytest.mark.asyncio
async def test_lost_delivery_response_reuses_exact_task_and_cancel_is_not_resurrected(queued_library):
    library, entry = queued_library
    names = []
    def deliver(*args, **kwargs):
        task = kwargs["json"]["task"]
        names.append(task["name"])
        if len(names) == 1:
            raise TimeoutError("simulated lost response")
        return SimpleNamespace(status_code=409)
    library.store._session.post = deliver
    with pytest.raises(FilesRefused, match="UNCONFIRMED"):
        await jobs.enqueue(library, file_id=entry["id"], automatic=True)
    assert (await jobs.status(library, entry["id"]))["state"] == "pending_delivery"
    assert (await jobs.enqueue(library, file_id=entry["id"], automatic=True))["state"] == "queued"
    assert len(names) == 2 and names[0] == names[1]
    await jobs.status(library, entry["id"], cancel=True)
    assert (await jobs.enqueue(library, file_id=entry["id"], automatic=True))["state"] == "cancelled"
    assert len(names) == 2


@pytest.mark.asyncio
async def test_existing_upload_is_never_automatically_organized_after_opt_in(queued_library):
    library, _ = queued_library
    await library.configure(revision=1, analysis=False, automatic=False, excluded=[])
    entry = await library.create(name="old", parent="root", size=0, request_id="older-upload")
    await library.complete(entry["id"])
    await library.configure(revision=2, analysis=True, automatic=True, excluded=[])
    assert (await jobs.enqueue(library, file_id=entry["id"], automatic=True))["state"] == "not_requested"


@pytest.mark.asyncio
async def test_old_delivery_and_uncertain_worker_do_not_replay_model(queued_library, monkeypatch):
    library, entry = queued_library
    await jobs.enqueue(library, file_id=entry["id"])
    path = f"jobs/{entry['id']}.bin"
    job, generation = await library._read(path)
    job.update(state="running", leaseUntil=0)
    await library._write(path, job, generation)
    async def held():
        pass
    @asynccontextmanager
    async def operation(**kwargs):
        yield library
    monkeypatch.setattr(jobs, "operation", operation)
    monkeypatch.setattr("hushh_mcp.services.pod_session_authority.active_session_authority",
                        lambda: SimpleNamespace(require_held=held))
    assert await jobs.run_job(entry["id"], "0" * 32) == {"state": "superseded"}
    assert await jobs.run_job(entry["id"], job["delivery"]) == {"state": "review_required"}


@pytest.mark.asyncio
async def test_metadata_is_not_returned_after_concurrent_analysis_withdrawal(queued_library, monkeypatch):
    from hushh_mcp.one_adk import files_tools
    library, _ = queued_library
    original = library.list_folder
    async def withdraw(*args, **kwargs):
        result = await original(*args, **kwargs)
        await library.configure(revision=1, analysis=False, automatic=False, excluded=[])
        return result
    async def allowed():
        pass
    @asynccontextmanager
    async def operation(**kwargs):
        yield library
    monkeypatch.setattr(library, "list_folder", withdraw)
    monkeypatch.setattr(files_tools, "operation", operation)
    monkeypatch.setattr(files_tools, "require_files_access", allowed)
    assert await files_tools.list_files() == {"status": "blocked", "code": "FILES_CONSENT_CHANGED"}
