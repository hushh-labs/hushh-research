"""The pod grounds itself from its own log, and refuses to ground anyone else.

`PodPkmStore` was written, made oracle-conformant, covered by tests, and then
constructed nowhere outside those tests. Every running pod has been grounded
instead by `pkmContext`: a 20,000-character string the hub computes from
Postgres and pushes in on every turn. That is a thin client with a local model,
which the north star permits as a transitional step and rules out as the end
state.

These tests pin the resolver that closes it, and most of them are about the ways
it must DEGRADE rather than the happy path, because a pod that cannot rebuild its
index must still answer the person's question.

The one case that is not a degrade is the owner mismatch. A pod serves one
person. Being asked for a second is a recycled pod or a routing fault, and
quietly rebuilding a different person's PKM into this pod's index is the single
outcome that must be unreachable.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services import pod_pkm_resolver as resolver
from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog
from hushh_mcp.services.pod_pkm_resolver import (
    PodPkmOwnerMismatch,
    rebuild_stats,
    reset_for_tests,
    resolve_pod_pkm_store,
    sqlite_path,
)


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    reset_for_tests()
    monkeypatch.setenv("POD_LOCAL_PKM_ENABLED", "1")
    yield
    reset_for_tests()


def _commit(user_id: str, domain: str = "travel") -> tuple[str, dict]:
    """One PKM mutation in the shape `PodPkmStore` logs and replays.

    A summary merge rather than a full commit: it is the smallest complete
    payload the SQLite engine accepts, taken from the existing commit-log suite
    rather than invented here, so this fixture exercises the real replay path.
    """
    return (
        "pkm_merge_summary",
        {
            "p_user_id": user_id,
            "p_domain": domain,
            "p_patch": {"readable_summary": f"{domain} summary"},
            "p_domains_list": [domain],
        },
    )


async def _log_with(tmp_path, records, name="log") -> PodCommitLog:
    log = PodCommitLog(LocalObjectStore(str(tmp_path / name)), b"K" * 32)
    for kind, payload in records:
        await log.append(kind, payload)
    return log


# --------------------------------------------------------------------------- #
# It ships dark
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("value", ["", "0", "false", "no", "off"])
async def test_the_flag_is_off_by_default(monkeypatch, tmp_path, value):
    """Off means the hub keeps pushing pkmContext exactly as it does today, so
    turning this on is a decision rather than a side effect of deploying."""
    monkeypatch.setenv("POD_LOCAL_PKM_ENABLED", value)
    log = await _log_with(tmp_path, [_commit("owner-a")])

    assert await resolve_pod_pkm_store("owner-a", log=log) is None


async def test_a_blank_owner_resolves_to_nothing(tmp_path):
    log = await _log_with(tmp_path, [_commit("owner-a")])
    assert await resolve_pod_pkm_store("   ", log=log) is None


# --------------------------------------------------------------------------- #
# The happy path: grounded by its own log
# --------------------------------------------------------------------------- #


async def test_the_pod_rebuilds_its_own_index_from_its_own_log(tmp_path, monkeypatch):
    monkeypatch.setenv("POD_PKM_SQLITE_PATH", str(tmp_path / "pkm.sqlite3"))
    log = await _log_with(tmp_path, [_commit("owner-a", "travel"), _commit("owner-a", "food")])

    store = await resolve_pod_pkm_store("owner-a", log=log)

    assert store is not None
    assert store.engine_id == "sqlite+log"


async def test_the_store_is_cached_rather_than_rebuilt_per_turn(tmp_path, monkeypatch):
    """Rebuild replays the whole log. Doing that on every turn would make the
    pod slower the longer the person has used it, which is precisely backwards."""
    monkeypatch.setenv("POD_PKM_SQLITE_PATH", str(tmp_path / "pkm.sqlite3"))
    log = await _log_with(tmp_path, [_commit("owner-a")])

    first = await resolve_pod_pkm_store("owner-a", log=log)
    second = await resolve_pod_pkm_store("owner-a", log=log)

    assert first is second


async def test_the_rebuild_cost_is_measured_not_estimated(tmp_path, monkeypatch):
    """Cold-start time grows with history, and the only honest way to know when
    that stops being acceptable is to measure it every time."""
    monkeypatch.setenv("POD_PKM_SQLITE_PATH", str(tmp_path / "pkm.sqlite3"))
    log = await _log_with(tmp_path, [_commit("owner-a", d) for d in ("a", "b", "c")])

    await resolve_pod_pkm_store("owner-a", log=log)
    stats = rebuild_stats()

    assert stats is not None
    assert stats.owner_user_id == "owner-a"
    assert stats.records_replayed == 3
    assert stats.duration_ms >= 0
    assert stats.sqlite_path.endswith("pkm.sqlite3")


# --------------------------------------------------------------------------- #
# One pod, one owner. The one case that raises.
# --------------------------------------------------------------------------- #


async def test_a_second_owner_is_refused_loudly(tmp_path, monkeypatch):
    """A shared bucket plus a shared key would otherwise let one pod rebuild
    another person's PKM into its own index. `rebuild` guards that at its layer;
    this guards it at the layer above, where a cache would have hidden it."""
    monkeypatch.setenv("POD_PKM_SQLITE_PATH", str(tmp_path / "pkm.sqlite3"))
    log = await _log_with(tmp_path, [_commit("owner-a")])

    await resolve_pod_pkm_store("owner-a", log=log)

    with pytest.raises(PodPkmOwnerMismatch) as excinfo:
        await resolve_pod_pkm_store("owner-b", log=log)

    assert "owner-a" in str(excinfo.value)
    assert "owner-b" in str(excinfo.value)


async def test_another_persons_records_never_enter_this_index(tmp_path, monkeypatch):
    """The filter that makes a shared log safe, exercised end to end."""
    monkeypatch.setenv("POD_PKM_SQLITE_PATH", str(tmp_path / "pkm.sqlite3"))
    log = await _log_with(tmp_path, [_commit("owner-a", "mine"), _commit("owner-b", "theirs")])

    store = await resolve_pod_pkm_store("owner-a", log=log)
    assert store is not None

    # The foreign record was skipped during rebuild, so owner-b's domain simply
    # is not in this index. The rebuild reports the skip rather than hiding it.
    stats = rebuild_stats()
    assert stats is not None and stats.owner_user_id == "owner-a"

    snapshot = await store.get_domain_snapshot(
        {"p_user_id": "owner-b", "p_domain": "theirs", "p_segment_ids": []}
    )
    body = snapshot if isinstance(snapshot, dict) else {}
    assert not body.get("segments"), "another person's records reached this pod's index"


# --------------------------------------------------------------------------- #
# Every other failure degrades to hub grounding, never to a broken turn
# --------------------------------------------------------------------------- #


async def test_a_tampered_log_degrades_instead_of_taking_the_turn_down(tmp_path, monkeypatch):
    """Refusing to materialise altered history is correct. Also taking the
    person's question down with it is not."""
    monkeypatch.setenv("POD_PKM_SQLITE_PATH", str(tmp_path / "pkm.sqlite3"))

    class _Tampered:
        async def replay(self):
            from hushh_mcp.services.pod_commit_log import PodLogTampered

            raise PodLogTampered("hash chain broke at seq 2")

    assert await resolve_pod_pkm_store("owner-a", log=_Tampered()) is None
    assert rebuild_stats() is None


async def test_no_durable_log_means_the_hub_keeps_grounding(monkeypatch):
    """A pod without durable storage has always been grounded by the hub, and
    still is. This must read as 'unavailable', never as 'broken'."""
    import hushh_mcp.services.pod_storage as pod_storage

    class _Null:
        backend_id = "null"

    monkeypatch.setattr(pod_storage, "resolve_pod_storage", lambda: _Null())

    assert await resolve_pod_pkm_store("owner-a") is None


async def test_a_storage_resolver_that_raises_is_survivable(monkeypatch):
    import hushh_mcp.services.pod_storage as pod_storage

    def _boom():
        raise RuntimeError("pod storage 'commit_log' needs exactly one of ...")

    monkeypatch.setattr(pod_storage, "resolve_pod_storage", _boom)

    assert await resolve_pod_pkm_store("owner-a") is None


# --------------------------------------------------------------------------- #
# The index is disposable, and the code says so
# --------------------------------------------------------------------------- #


def test_the_index_defaults_to_a_disposable_path(monkeypatch):
    """Cloud Run's filesystem is an in-memory tmpfs, so the SQLite file does not
    survive a restart and its bytes count against the memory limit. That is the
    design: the log is the truth and the index is derived."""
    monkeypatch.delenv("POD_PKM_SQLITE_PATH", raising=False)
    # noqa justification: asserting the path IS the tmpfs default is the point.
    assert sqlite_path().startswith("/tmp/")  # noqa: S108


def test_the_resolver_never_reaches_for_a_database():
    """The pod holds no database credential, and this seam is exactly where one
    would be convenient. Parsed rather than grepped so the module's own prose
    about not holding a credential cannot trip the guard."""
    import ast
    from pathlib import Path

    tree = ast.parse(Path(resolver.__file__).read_text(encoding="utf-8"))
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            imported.add(node.module or "")
            imported.update(a.name for a in node.names)

    for forbidden in ("db.connection", "db_client", "psycopg", "get_db", "asyncpg"):
        assert not any(forbidden in name for name in imported), (
            f"the pod's PKM resolver imports {forbidden!r}; a pod holds no database credential"
        )


# --------------------------------------------------------------------------- #
# The projection: what the pod actually grounds itself WITH
# --------------------------------------------------------------------------- #


async def test_local_grounding_projects_the_index_into_context(tmp_path, monkeypatch):
    """The reason the resolver has a caller at all.

    `pkmContext` originates in the browser and the hub only forwards it, so a
    turn with no browser attached arrives with no grounding. That is every
    background tick.
    """
    from hushh_mcp.services.pod_pkm_resolver import local_grounding

    monkeypatch.setenv("POD_PKM_SQLITE_PATH", str(tmp_path / "pkm.sqlite3"))
    log = await _log_with(tmp_path, [_commit("owner-a", "travel"), _commit("owner-a", "food")])

    text = await local_grounding("owner-a", log=log)

    assert text is not None
    assert "travel: travel summary" in text
    assert "food: food summary" in text


async def test_local_grounding_is_empty_when_there_is_nothing_to_say(tmp_path, monkeypatch):
    """An empty index must produce None rather than an empty string. An empty
    string would count as grounding and report `grounded: true` for a turn that
    learned nothing, which is the exact lie the normalisation above it prevents."""
    from hushh_mcp.services.pod_pkm_resolver import local_grounding

    monkeypatch.setenv("POD_PKM_SQLITE_PATH", str(tmp_path / "empty.sqlite3"))
    log = await _log_with(tmp_path, [("memory_record", {"text": "not a pkm record"})])

    assert await local_grounding("owner-a", log=log) is None


async def test_local_grounding_never_leaks_another_owner(tmp_path, monkeypatch):
    from hushh_mcp.services.pod_pkm_resolver import local_grounding

    monkeypatch.setenv("POD_PKM_SQLITE_PATH", str(tmp_path / "pkm.sqlite3"))
    log = await _log_with(tmp_path, [_commit("owner-a", "mine"), _commit("owner-b", "theirs")])

    text = await local_grounding("owner-a", log=log)

    assert text is not None
    assert "mine" in text
    assert "theirs" not in text


async def test_local_grounding_is_off_when_the_flag_is_off(tmp_path, monkeypatch):
    from hushh_mcp.services.pod_pkm_resolver import local_grounding

    monkeypatch.setenv("POD_LOCAL_PKM_ENABLED", "0")
    log = await _log_with(tmp_path, [_commit("owner-a")])

    assert await local_grounding("owner-a", log=log) is None


async def test_the_turn_prefers_the_browsers_projection_over_the_local_index(monkeypatch):
    """Second, never first. When the browser sent a projection it is the fresher
    of the two, because it holds the decrypted PKM while this index is rebuilt
    from the log. Preferring the local copy would answer from older holdings on
    exactly the turns a person is watching."""
    from pathlib import Path

    source = Path("api/routes/one/pod_turn.py").read_text(encoding="utf-8")

    pushed = source.index("grounding = (payload.pkm_context")
    local = source.index("local_grounding(user_id)")
    guard = source.index("if grounding is None:")

    assert pushed < guard < local, "the local index is consulted before the pushed context"
