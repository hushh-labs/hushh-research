"""Direct Files scopes remain separate; devices cannot enter the library."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.one import pod_files
from hushh_mcp.services.pod_files import runtime
from hushh_mcp.services.pod_files.library import FilesLibrary
from hushh_mcp.services.pod_files.storage import FilesLocalStore
from tests.test_pod_session_authority import Subject, World, _binding
from tests.test_pod_session_authority import hub_key as hub_key


async def test_read_only_app_cannot_write_and_device_cannot_read(tmp_path, hub_key, monkeypatch):
    world = World(tmp_path / "pod")
    authority = await world.boot()
    monkeypatch.setattr("api.routes.one.pod_session.authority_or_503", lambda: authority)
    store = FilesLocalStore(str(tmp_path / "files"))
    store.verify_bucket = AsyncMock(return_value={})
    library = FilesLibrary(
        owner=authority.hushh_id, key=b"K" * 32, store=store, check=runtime.require_files_access
    )
    monkeypatch.setattr(runtime, "active_library", lambda: library)
    permit = SimpleNamespace(release=AsyncMock())
    monkeypatch.setattr(
        "hushh_mcp.services.pod_upgrade_admission.ADMISSION",
        SimpleNamespace(acquire_turn=AsyncMock(return_value=permit)),
    )
    reader, writer, device = (
        Subject("reader", "web"),
        Subject("writer", "web"),
        Subject("device", "macos"),
    )
    read_token, _ = await world.admit(reader, _binding(reader, scopes=["files.read"]))
    write_token, _ = await world.admit(
        writer, _binding(writer, scopes=["files.read", "files.manage"])
    )
    device_token, _ = await world.admit(device, _binding(device))
    app = FastAPI()
    app.include_router(pod_files.router)
    with TestClient(app) as client:
        headers = {"Authorization": "Bearer " + read_token}
        assert client.get("/api/one/pod/files/list", headers=headers).status_code == 200
        body = {"name": "Folder", "folder": True, "request_id": "folder-request"}
        denied = client.post("/api/one/pod/files/create", headers=headers, json=body)
        assert denied.status_code == 403
        assert denied.json()["detail"]["code"] == "scope_not_granted"
        assert (
            client.get(
                "/api/one/pod/files/list", headers={"Authorization": "Bearer " + device_token}
            ).status_code
            == 403
        )
        created = client.post(
            "/api/one/pod/files/create",
            headers={"Authorization": "Bearer " + write_token},
            json=body,
        )
        assert created.status_code == 200
        entries = client.get("/api/one/pod/files/list", headers=headers).json()["entries"]
        assert [entry["name"] for entry in entries] == ["Folder"]
