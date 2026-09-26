"""Durability, custody, retries and folder contracts through the real local store."""

import pytest

from hushh_mcp.services.pod_files.library import CHUNK_BYTES, FilesLibrary, FilesRefused
from hushh_mcp.services.pod_files.storage import FilesLocalStore


async def allowed():
    return None


@pytest.fixture
def library(tmp_path):
    return FilesLibrary(
        owner="owner-a", key=b"K" * 32, store=FilesLocalStore(str(tmp_path)), check=allowed
    )


@pytest.mark.asyncio
async def test_resume_restart_exact_bytes_ciphertext_and_idempotent_commit(library, tmp_path):
    payload = b"private information" * 3
    entry = await library.create(
        name="private report.txt", parent="root", size=len(payload), request_id="request-one"
    )
    file_id = entry["id"]
    await library.put_chunk(file_id, 0, payload)
    restarted = FilesLibrary(
        owner="owner-a", key=b"K" * 32, store=FilesLocalStore(str(tmp_path)), check=allowed
    )
    duplicate = await restarted.put_chunk(file_id, 0, payload)
    assert duplicate["received"] == len(payload)
    completed = await restarted.complete(file_id)
    assert await restarted.complete(file_id) == completed
    assert await restarted.read_chunk(file_id, 0) == payload
    assert (await restarted.list_folder())["entries"] == [completed]
    for path in tmp_path.rglob("*.bin"):
        assert payload not in path.read_bytes()
        assert b"private report.txt" not in path.read_bytes()


@pytest.mark.asyncio
async def test_wrong_owner_and_tampered_object_fail_closed(library, tmp_path):
    entry = await library.create(name="file", parent="root", size=3, request_id="request-one")
    await library.put_chunk(entry["id"], 0, b"abc")
    await library.complete(entry["id"])
    other = FilesLibrary(owner="owner-b", key=b"K" * 32, store=library.store, check=allowed)
    with pytest.raises(FilesRefused, match="INTEGRITY"):
        await other.stat(entry["id"])
    chunk = next((tmp_path / "chunks").rglob("*.bin"))
    chunk.write_bytes(chunk.read_bytes()[:-1] + bytes([chunk.read_bytes()[-1] ^ 1]))
    with pytest.raises(FilesRefused, match="INTEGRITY"):
        await library.read_chunk(entry["id"], 0)


@pytest.mark.asyncio
async def test_incomplete_conflicting_retry_and_out_of_order_are_refused(library):
    entry = await library.create(
        name="file", parent="root", size=CHUNK_BYTES + 1, request_id="request-one"
    )
    file_id = entry["id"]
    with pytest.raises(FilesRefused, match="INCOMPLETE"):
        await library.complete(file_id)
    with pytest.raises(FilesRefused, match="NOT_WRITABLE"):
        await library.put_chunk(file_id, 1, b"x")
    await library.put_chunk(file_id, 0, b"a" * CHUNK_BYTES)
    with pytest.raises(FilesRefused, match="RETRY_CONFLICT"):
        await library.put_chunk(file_id, 0, b"b" * CHUNK_BYTES)
    await library.put_chunk(file_id, 1, b"x")
    assert (await library.complete(file_id))["received"] == CHUNK_BYTES + 1


@pytest.mark.asyncio
async def test_move_revision_trash_confirmation_and_undo(library):
    folder = await library.create(
        name="Folder", parent="root", size=0, request_id="folder-request", folder=True
    )
    entry = await library.create(name="file", parent="root", size=0, request_id="file-request")
    entry = await library.complete(entry["id"])
    moved = await library.mutate(
        entry["id"], revision=entry["revision"], operation="move", parent=folder["id"]
    )
    assert [e["id"] for e in (await library.list_folder())["entries"]] == [folder["id"]]
    with pytest.raises(FilesRefused, match="REVISION"):
        await library.mutate(
            entry["id"], revision=entry["revision"], operation="rename", name="stale"
        )
    with pytest.raises(FilesRefused, match="CONFIRMATION"):
        await library.mutate(entry["id"], revision=moved["revision"], operation="trash")
    restored = await library.mutate(entry["id"], revision=moved["revision"], operation="undo")
    assert restored["parent"] == "root"
    with pytest.raises(FilesRefused, match="CYCLE"):
        await library.mutate(
            folder["id"], revision=folder["revision"], operation="move", parent=folder["id"]
        )


@pytest.mark.asyncio
async def test_library_fence_prevents_reads_and_writes(library):
    entry = await library.create(name="file", parent="root", size=0, request_id="request-one")

    async def fenced():
        raise FilesRefused("FILES_FENCED")

    library.check = fenced
    with pytest.raises(FilesRefused, match="FENCED"):
        await library.complete(entry["id"])
    with pytest.raises(FilesRefused, match="FENCED"):
        await library.stat(entry["id"])


@pytest.mark.asyncio
async def test_undo_rename_never_rewinds_completed_upload(library):
    entry = await library.create(name="first", parent="root", size=3, request_id="rename-upload")
    await library.mutate(entry["id"], revision=1, operation="rename", name="second")
    await library.put_chunk(entry["id"], 0, b"abc")
    completed = await library.complete(entry["id"])
    undone = await library.mutate(entry["id"], revision=completed["revision"], operation="undo")
    assert undone["state"] == "ready" and undone["name"] == "first"
    assert await library.read_chunk(entry["id"], 0) == b"abc"


@pytest.mark.asyncio
async def test_invalid_folder_and_restore_to_trashed_parent_refused(library):
    with pytest.raises(FilesRefused, match="INVALID_UPLOAD"):
        await library.create(
            name="folder", parent="root", size=3, folder=True, request_id="folder-invalid"
        )
    folder = await library.create(
        name="folder", parent="root", size=0, folder=True, request_id="folder-valid"
    )
    child = await library.create(
        name="child", parent=folder["id"], size=0, request_id="child-valid"
    )
    child = await library.mutate(child["id"], revision=1, operation="trash", confirmed=True)
    await library.mutate(folder["id"], revision=1, operation="trash", confirmed=True)
    with pytest.raises(FilesRefused, match="FOLDER_UNAVAILABLE"):
        await library.mutate(child["id"], revision=child["revision"], operation="restore")


@pytest.mark.asyncio
async def test_rebuild_restores_visibility_from_encrypted_manifest(library, tmp_path):
    entry = await library.create(
        name="recovered", parent="root", size=0, request_id="recover-index"
    )
    hint = tmp_path / "folders" / "root" / (entry["id"] + ".bin")
    hint.unlink()
    hint.with_suffix(".bin.gen").unlink()
    assert (await library.list_folder())["entries"] == []
    assert await library.rebuild_index_page() == {"repaired": 1, "cursor": ""}
    assert [value["id"] for value in (await library.list_folder())["entries"]] == [entry["id"]]


@pytest.mark.asyncio
async def test_revocation_during_metadata_fetch_refuses_result(library, monkeypatch):
    entry = await library.create(
        name="private", parent="root", size=0, request_id="read-revocation"
    )
    read = library.store.get_with_generation

    async def delayed(path):
        result = await read(path)

        async def revoked():
            raise FilesRefused("FILES_AUTHORITY_REVOKED", 403)

        library.check = revoked
        return result

    monkeypatch.setattr(library.store, "get_with_generation", delayed)
    with pytest.raises(FilesRefused, match="AUTHORITY_REVOKED"):
        await library.stat(entry["id"])
