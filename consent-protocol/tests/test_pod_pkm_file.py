"""Process-isolation boundary for the derived PKM index, using real log replay."""

import pytest

from hushh_mcp.services.pod_pkm_resolver import (
    rebuild_stats,
    reset_for_tests,
    resolve_pod_pkm_store,
)


@pytest.fixture(autouse=True)
def private_index_enabled(monkeypatch):
    reset_for_tests()
    monkeypatch.setenv("POD_LOCAL_PKM_ENABLED", "1")
    yield
    reset_for_tests()


async def private_log(tmp_path):
    from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog

    log = PodCommitLog(LocalObjectStore(str(tmp_path / "log")), b"K" * 32)
    await log.append(
        "pkm_merge_summary",
        {
            "p_user_id": "owner-a",
            "p_domain": "travel",
            "p_patch": {"readable_summary": "synthetic private summary"},
            "p_domains_list": ["travel"],
        },
    )
    return log


async def test_pod_index_and_wal_are_private_even_with_a_permissive_process_umask(
    tmp_path, monkeypatch
):
    import os
    import sqlite3
    import stat
    from pathlib import Path

    path = tmp_path / "owner-private" / "pkm.sqlite3"
    path.parent.mkdir(mode=0o700)
    monkeypatch.setenv("POD_PKM_SQLITE_PATH", str(path))
    log = await private_log(tmp_path)
    previous = os.umask(0o022)
    connection = None
    try:
        assert await resolve_pod_pkm_store("owner-a", log=log) is not None
        connection = sqlite3.connect(path)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("SELECT * FROM pkm_index").fetchall()
        assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
        for candidate in (path, Path(str(path) + "-wal"), Path(str(path) + "-shm")):
            assert candidate.is_file()
            assert stat.S_IMODE(candidate.stat().st_mode) == 0o600
    finally:
        if connection is not None:
            connection.close()
        os.umask(previous)


@pytest.mark.parametrize("unsafe", ["readable-parent", "linked-index"])
async def test_pod_index_refuses_an_unsafe_override_without_touching_its_target(
    tmp_path, monkeypatch, unsafe
):
    private = tmp_path / "index"
    private.mkdir(mode=0o700)
    import sqlite3

    victim = tmp_path / "unrelated-information"
    connection = sqlite3.connect(victim)
    try:
        connection.execute("CREATE TABLE private_fixture (payload TEXT)")
        connection.execute("INSERT INTO private_fixture VALUES ('synthetic-preserved-information')")
        connection.commit()
    finally:
        connection.close()
    original = victim.read_bytes()
    path = private / "pkm.sqlite3"
    if unsafe == "readable-parent":
        private.chmod(0o755)
    else:
        path.symlink_to(victim)
    monkeypatch.setenv("POD_PKM_SQLITE_PATH", str(path))
    log = await private_log(tmp_path)
    assert await resolve_pod_pkm_store("owner-a", log=log) is None
    assert victim.read_bytes() == original
    assert rebuild_stats() is None
