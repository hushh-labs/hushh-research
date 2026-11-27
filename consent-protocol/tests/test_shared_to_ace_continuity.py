# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Contract tests for zero-plaintext Shared->ACE chat, files, and wiki continuity."""

from __future__ import annotations

import base64
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.hub_route_classes import RouteClass, classify
from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes.one import agent_chat, pod_agent_chat, pod_files, shared_files
from hushh_mcp.one_adk.encrypted_checkpoint_store import session_payload_aad
from hushh_mcp.one_adk.encrypted_session_service import EncryptedAdkSessionService
from hushh_mcp.one_adk.pod_adk_session_repository import (
    PodAdkSessionProjection,
    PodAdkSessionRepository,
)
from hushh_mcp.services.chat_key import ChatCipher, RequestChatKey, bind_request_chat_key
from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog
from hushh_mcp.services.pod_files import runtime as pod_files_runtime
from hushh_mcp.services.pod_files.library import FilesLibrary
from hushh_mcp.services.pod_files.runtime import files_access
from hushh_mcp.services.pod_files.storage import FilesLocalStore
from hushh_mcp.services.shared_files import bucket_admission, registry
from hushh_mcp.services.wiki_memory import WikiLibrary


def _chat_key_headers(owner: str, chat_key_b64: str) -> dict[str, str]:
    return {"X-Hussh-Chat-Key": chat_key_b64, "X-Hushh-User-Id": owner}


def test_migration_hub_routes_are_classified_as_ciphertext() -> None:
    assert classify("GET", "/api/one/agent-chat/migration/sessions") is RouteClass.CIPHERTEXT
    assert classify("GET", "/api/one/files/migration/manifest") is RouteClass.CIPHERTEXT
    assert classify("GET", "/api/one/files/migration/wiki/{page_id}") is RouteClass.CIPHERTEXT
    assert (
        classify("GET", "/api/one/files/migration/file/{file_id}/chunk/{index}")
        is RouteClass.CIPHERTEXT
    )
    assert classify("POST", "/api/one/files/migration/complete") is RouteClass.CIPHERTEXT


async def test_shared_chat_export_and_pod_idempotent_import_preserve_ciphertext(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    owner = "uid-shared-chat-1"
    hushh_id = "ha1_sharedchat0000000000000000000"
    cipher = ChatCipher()
    raw_key = b"k" * 32

    # Build two real owner-encrypted session documents without exposing plaintext to Hub.
    sealed_rows = []
    for idx, (sid, updated_at) in enumerate(
        [("conv-older", "2026-11-20T01:00:00+00:00"), ("conv-newer", "2026-11-21T02:00:00+00:00")]
    ):
        session_doc = json.dumps(
            {
                "id": sid,
                "appName": "agent_one",
                "userId": owner,
                "state": {"hussh:thread_title": f"Chat {idx}"},
                "events": [],
                "lastUpdateTime": 1700000000.0 + idx,
            }
        )
        holder = RequestChatKey(raw_key)
        holder.bind_owner(owner)
        with bind_request_chat_key(holder):
            sealed = cipher.seal(
                session_doc,
                owner_id=owner,
                aad=session_payload_aad("agent_one", sid),
            )
        sealed_rows.append(
            {
                "app_name": "agent_one",
                "user_id": owner,
                "session_id": sid,
                "payload_ciphertext": sealed.ciphertext,
                "payload_iv": sealed.iv,
                "payload_tag": sealed.tag,
                "payload_algorithm": sealed.algorithm,
                "revision": 4 + idx,
                "updated_at": updated_at,
            }
        )

    class _FakeSharedSessions:
        def __init__(self) -> None:
            self._cipher = type(
                "_NoOpen",
                (),
                {"open": lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("hub decrypted"))},
            )()

        async def _execute(self, _sql: str, params: dict):
            assert params["user"] == owner
            # Return newest first like Postgres ORDER BY updated_at DESC.
            return SimpleNamespace(data=list(reversed(sealed_rows)))

    monkeypatch.setattr(agent_chat, "_shared_sessions", lambda: _FakeSharedSessions())

    hub_app = FastAPI()
    hub_app.include_router(agent_chat.router)
    hub_app.dependency_overrides[require_firebase_auth] = lambda: owner
    hub_client = TestClient(hub_app)

    exported = hub_client.get("/api/one/agent-chat/migration/sessions")
    assert exported.status_code == 200
    body = exported.json()
    assert body["status"] == "ready"
    assert body["count"] == 2
    assert len(body["sessions"]) == 2
    assert body["sessions"][0]["session_id"] == "conv-newer"

    # Now import onto Pod with zero Pod decryption (needs_key=False).
    log = PodCommitLog(
        LocalObjectStore(str(tmp_path / "pod-log")),
        b"p" * 32,
        owner_id=hushh_id,
    )
    projection = PodAdkSessionProjection(owner_id=owner, hushh_id=hushh_id, log=log)

    async def _allow() -> None:
        return None

    pod_repo = PodAdkSessionRepository(projection=projection, require_access=_allow)
    pod_sessions = EncryptedAdkSessionService(repository=pod_repo)
    fake_pod_ctx = SimpleNamespace(
        owner=owner,
        hushh_id=hushh_id,
        sessions=pod_sessions,
        require_access=_allow,
    )

    pod_app = FastAPI()
    pod_app.include_router(pod_agent_chat.router)
    pod_app.dependency_overrides[pod_agent_chat.migration_context] = lambda: fake_pod_ctx
    pod_client = TestClient(pod_app)

    # Negative control: foreign owner session tuple is refused with 403.
    foreign = pod_client.post(
        "/api/one/pod/agent-chat/migration/import",
        json={"sessions": [{**body["sessions"][0], "user_id": "someone-else"}]},
    )
    assert foreign.status_code == 403
    assert foreign.json()["detail"]["code"] == "POD_CHAT_OWNER_MISMATCH"

    first_import = pod_client.post(
        "/api/one/pod/agent-chat/migration/import",
        json={"sessions": body["sessions"]},
    )
    assert first_import.status_code == 200
    assert first_import.json() == {"status": "imported", "imported": 2, "skipped": 0}

    # Repeat import is strictly idempotent.
    second_import = pod_client.post(
        "/api/one/pod/agent-chat/migration/import",
        json={"sessions": body["sessions"]},
    )
    assert second_import.status_code == 200
    assert second_import.json() == {"status": "imported", "imported": 0, "skipped": 2}

    # Verify Pod EncryptedAdkSessionService opens both imported sessions with the owner's chat key,
    # and newest-first order is preserved.
    holder = RequestChatKey(raw_key)
    holder.bind_owner(owner)
    with bind_request_chat_key(holder):
        listed = await pod_sessions.list_sessions(app_name="agent_one", user_id=owner)
    assert [s.id for s in listed.sessions] == ["conv-newer", "conv-older"]
    assert listed.sessions[0].state["hussh:thread_title"] == "Chat 1"


async def test_shared_files_migration_routes_and_read_only_ace_access(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    owner = "uid-shared-files-1"
    monkeypatch.setenv("HUSSH_SHARED_FILES_ENABLED", "true")
    monkeypatch.setenv("HUSSH_SHARED_FILES_BUCKET", "synthetic-shared-bucket")

    objects = {
        "0" * 64 + "/" + "0" * 64: (b"sealed-library-key", "1"),
        "folders/f1.json": (b"sealed-folder-1", "2"),
        "files/file1.json": (b"sealed-file-1", "3"),
        "wiki/wpg_1.json": (b"sealed-wiki-1", "4"),
        "chunks/file1/0": (b"sealed-chunk-0", "5"),
    }
    state = {
        "row": {
            "user_id": owner,
            "library_id": "11111111-1111-4111-8111-111111111111",
            "bucket": "synthetic-shared-bucket",
            "prefix": "shared-files/v1/hash",
            "state": "active",
            "receipt": None,
        }
    }

    class _FakeStore:
        _bucket = "synthetic-shared-bucket"
        _prefix = "shared-files/v1/hash/11111111-1111-4111-8111-111111111111"

        async def get_bounded_with_generation(self, rel: str, *, max_bytes: int):
            del max_bytes
            return objects.get(rel, (None, ""))

        async def list_page(self, prefix: str, cursor: str = "", limit: int = 100):
            del prefix, cursor, limit
            return [], ""

    fake_store = _FakeStore()
    monkeypatch.setattr(shared_files, "_configured_store", lambda _b, _p: fake_store)
    monkeypatch.setattr(shared_files, "_security", AsyncMock(return_value={"versioning": True}))
    monkeypatch.setattr(
        shared_files, "_list_library_objects", AsyncMock(return_value=list(objects))
    )
    monkeypatch.setattr(registry, "resource", AsyncMock(side_effect=lambda _u, **_kw: state["row"]))
    monkeypatch.setattr(registry, "active", AsyncMock(side_effect=lambda _u, _lid: state["row"]))
    monkeypatch.setattr(bucket_admission, "observe", AsyncMock(return_value={}))
    monkeypatch.setattr(bucket_admission, "verify", lambda *_a: None)
    monkeypatch.setattr(
        "hushh_mcp.services.shared_files.reconciliation.reconcile", AsyncMock(return_value=None)
    )

    async def _mark(user_id: str, *, migrated_files: int, migrated_wiki_pages: int) -> None:
        assert user_id == owner
        state["row"]["receipt"] = {
            "ace_migration": {
                "status": "migrated",
                "migrated_files": migrated_files,
                "migrated_wiki_pages": migrated_wiki_pages,
            }
        }

    monkeypatch.setattr(shared_files, "_mark_ace_migration_complete", _mark)
    monkeypatch.setattr(
        shared_files, "get_owner_hosting_mode", AsyncMock(return_value="hussh_pods")
    )
    monkeypatch.setattr(
        shared_files, "require_vault_owner_token", AsyncMock(return_value={"user_id": owner})
    )
    monkeypatch.setattr(
        shared_files,
        "admit_hub_content",
        AsyncMock(side_effect=AssertionError("write must stay blocked")),
    )
    monkeypatch.setattr("api.utils.firebase_auth._assert_account_not_deleted", lambda _u: None)

    app = FastAPI()
    app.include_router(shared_files.router)
    app.dependency_overrides[require_firebase_auth] = lambda: owner
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": owner}
    client = TestClient(app)

    manifest = client.get("/api/one/files/migration/manifest")
    assert manifest.status_code == 200
    m = manifest.json()
    assert m["status"] == "ready"
    assert len(m["folders"]) == 1
    assert len(m["files"]) == 1
    assert len(m["wiki_pages"]) == 1
    assert base64.b64decode(m["keyEnvelope"]["ciphertext"]) == b"sealed-library-key"

    chunk = client.get("/api/one/files/migration/file/file1/chunk/0")
    assert chunk.status_code == 200
    assert base64.b64decode(chunk.json()["ciphertext"]) == b"sealed-chunk-0"

    wiki_blob = client.get("/api/one/files/migration/wiki/wpg_1")
    assert wiki_blob.status_code == 200
    assert base64.b64decode(wiki_blob.json()["ciphertext"]) == b"sealed-wiki-1"

    # Existing read-only SharedFilesStore endpoints also work for promoted ACE owners.
    storage_resp = client.get("/api/one/files/storage")
    assert storage_resp.status_code == 200
    assert storage_resp.json()["libraryId"] == state["row"]["library_id"]

    # Complete marks migration idempotently, and subsequent manifest returns "migrated".
    done = client.post(
        "/api/one/files/migration/complete",
        json={"migrated_files": 1, "migrated_wiki_pages": 1},
    )
    assert done.status_code == 200
    assert done.json()["status"] == "migrated"

    manifest_after = client.get("/api/one/files/migration/manifest")
    assert manifest_after.status_code == 200
    assert manifest_after.json()["status"] == "migrated"


async def test_pod_files_wiki_create_and_file_create_are_idempotent_for_migration(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    store = FilesLocalStore(str(tmp_path / "pod-files"))
    store.verify_bucket = AsyncMock(return_value={"versioning": True})  # type: ignore[attr-defined]
    app = FastAPI()
    app.include_router(pod_files.router)
    app.dependency_overrides[pod_files.access] = lambda: {"user_id": "uid-mig-1"}

    async def _allow() -> None:
        return None

    files_lib = FilesLibrary(owner="uid-mig-1", key=b"z" * 32, store=store, check=_allow)
    wiki_lib = WikiLibrary(
        owner="uid-mig-1",
        key=b"z" * 32,
        store=store,
        check=_allow,
        account_generation=1,
        library_id="default",
    )
    monkeypatch.setattr(pod_files_runtime, "_library", files_lib)
    monkeypatch.setattr(pod_files_runtime, "_wiki_library", wiki_lib)
    monkeypatch.setenv("POD_FILES_ENABLED", "true")

    with files_access(_allow, manage=_allow):
        client = TestClient(app)
        # Idempotent folder creation with deterministic request_id
        folder_req = {
            "name": "Migrated",
            "parent": "root",
            "size": 0,
            "request_id": "mig-folder-root-1",
            "folder": True,
        }
        f1 = client.post("/api/one/pod/files/create", json=folder_req)
        f2 = client.post("/api/one/pod/files/create", json=folder_req)
        assert f1.status_code == 200 and f2.status_code == 200
        assert f1.json()["id"] == f2.json()["id"]

        # Idempotent Wiki page creation with expected_revision=0 and deterministic request_id
        wiki_req = {
            "page_id": "wpg_0123456789abcdef",
            "expected_revision": 0,
            "title": "Migrated Note",
            "folder": "root",
            "tldr": "Imported from Shared",
            "body": "Preserved private wiki body.",
            "request_id": "mig-wiki-wpg_0123456789abcdef",
        }
        w1 = client.post("/api/one/pod/files/wiki/page", json=wiki_req)
        w2 = client.post("/api/one/pod/files/wiki/page", json=wiki_req)
        assert w1.status_code == 200 and w2.status_code == 200
        assert w1.json()["pageId"] == "wpg_0123456789abcdef"
        assert w1.json()["revision"] == 1
        assert w2.json() == w1.json()


async def test_fresh_and_shared_cohorts_auto_place_into_ace_without_manual_cloud_detour(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from api.routes.one import personal_agent as pa
    from hushh_mcp.services import pooled_sandbox_cutover as cutover
    from hushh_mcp.services.personal_agent_hosting import resolve_hosting_mode

    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    monkeypatch.setenv("HUSSH_AGENT_SANDBOX_CUTOVER_ENABLED", "1")
    monkeypatch.setenv("HUSSH_SANDBOX_EDGE_PUBLIC_URL", "https://sandbox-edge.dev.one.hussh.ai")
    monkeypatch.setenv(
        "HUSSH_SANDBOX_IDENTITY_MASTER_KEY",
        "unit-test-sandbox-master-seed-32-bytes-minimum",
    )

    rows: dict[str, dict] = {}
    cloud_markers: list[str] = []

    class _Reg:
        async def get(self, uid: str):
            return rows.get(uid)

        async def tombstone_exists(self, _uid: str) -> bool:
            return False

        async def upsert(self, **kwargs):
            uid = kwargs["user_id"]
            rows[uid] = {**rows.get(uid, {}), **kwargs}

    class _NoJobs:
        async def _current(self, _uid: str):
            return None

    class _Grants:
        async def issue_or_reuse_standing_pkm_read(self, _uid: str):
            return {"token_id": "t1", "token": "c1"}

    monkeypatch.setattr(pa, "PersonalAgentRegistryRepo", lambda: _Reg())
    monkeypatch.setattr(cutover, "has_blocking_byoc_setup_job", AsyncMock(return_value=False))
    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_grant_service.PersonalAgentGrantService",
        lambda: _Grants(),
    )
    monkeypatch.setattr(
        "hushh_mcp.services.owner_hosting_choice.write_cloud_setup_marker",
        AsyncMock(side_effect=lambda uid: cloud_markers.append(uid)),
    )
    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_hosting._read_shared_choice",
        AsyncMock(
            return_value=({"tier": "shared", "chosen_at": "2026-10-15T00:00:00+00:00"}, True)
        ),
    )

    # Cohort 1: Fresh account pre-phone stays unplaced; post-phone auto-places onto ACE.
    fresh_uid = "cohort-fresh-1"
    phone_state = {"verified": False}
    monkeypatch.setattr(
        pa,
        "ActorIdentityService",
        lambda: SimpleNamespace(
            get_many=AsyncMock(
                side_effect=lambda _ids: {fresh_uid: {"phone_verified": phone_state["verified"]}}
            )
        ),
    )
    pre_verify = await pa.resolve_personal_agent_status(user_id=fresh_uid)
    assert pre_verify["state"] == "none"
    assert fresh_uid not in rows

    phone_state["verified"] = True
    post_verify = await pa.resolve_personal_agent_status(user_id=fresh_uid)
    assert post_verify["state"] == "active"
    assert post_verify["hostingMode"] == "hussh_pods"
    assert post_verify["deploymentTarget"] == "ace"
    assert fresh_uid in cloud_markers

    # Cohort 2: Existing Hussh Shared account promotes idempotently onto ACE.
    shared_uid = "cohort-shared-1"
    assert (
        resolve_hosting_mode(
            row=None,
            registry_read_ok=True,
            setup_job=None,
            setup_job_read_ok=True,
            shared_choice={"tier": "shared", "chosen_at": "2026-10-15T00:00:00+00:00"},
            shared_choice_read_ok=True,
        )
        == "shared"
    )
    monkeypatch.setattr(
        pa,
        "ActorIdentityService",
        lambda: SimpleNamespace(
            get_many=AsyncMock(return_value={shared_uid: {"phone_verified": True}})
        ),
    )
    shared_promoted = await pa.resolve_personal_agent_status(user_id=shared_uid)
    assert shared_promoted["state"] == "active"
    assert shared_promoted["hostingMode"] == "hussh_pods"
    assert shared_promoted["deploymentTarget"] == "ace"
    assert shared_uid in cloud_markers
