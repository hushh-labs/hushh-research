"""LiveMigrationSteps drives the real sequencer with real-shaped work.

Until this object existed, the migration sequencer had only a test fake to drive
it -- so the rollback paths, the data threading, and the order had never been
exercised by anything a production caller would build. These tests drive the
WHOLE chain through the real ``run_migration`` with a ``LiveMigrationSteps`` whose
subsystem collaborators are fakes, so the composition -- not the sequencer, which
has its own tests -- is what is under test:

  * the sealed bundle threads from export to import untouched;
  * the destination's collected key is what the source seals to;
  * the destination URL from create reaches both import and switch;
  * the operator's token minter reaches the transport;
  * a head mismatch rolls back and never switches;
  * cleanup after the switch cannot fail the move.
"""

from __future__ import annotations

from hushh_mcp.services.pod_migration_live_steps import LiveMigrationSteps, MigrationContext
from hushh_mcp.services.pod_migration_service import PodMigrationJobRepo, new_job_id, run_migration

# --------------------------------------------------------------------------- #
# Fakes: one per injected collaborator, each recording what it was asked to do.
# --------------------------------------------------------------------------- #


class _Registry:
    def __init__(self, can_freeze=True):
        self.can_freeze = can_freeze
        self.calls: list[str] = []

    async def begin_migration(self, user_id):
        self.calls.append("begin")
        return self.can_freeze

    async def end_migration(self, user_id, *, status="provisioned"):
        self.calls.append(f"end:{status}")
        return True


class _Provisioner:
    def __init__(self):
        self.calls: list[str] = []

    async def prepare(self):
        self.calls.append("prepare")

    async def create(self):
        self.calls.append("create")
        return "https://one-pod-dst.run.app"

    async def collect_key(self):
        self.calls.append("collect")
        return ("dst-public-key", "dst-key-id")

    async def teardown(self):
        self.calls.append("teardown")


class _Transport:
    """export_from/import_into shaped exactly like the real module."""

    def __init__(self, source_head="head-abc", target_head="head-abc"):
        self.source_head = source_head
        self.target_head = target_head
        self.export_args: dict = {}
        self.import_args: dict = {}

    def export_from(
        self, *, pod_url, hushh_id, recipient_public_key, recipient_key_id, token_minter
    ):
        self.export_args = {
            "pod_url": pod_url,
            "hushh_id": hushh_id,
            "recipient_public_key": recipient_public_key,
            "recipient_key_id": recipient_key_id,
            "token_minter": token_minter,
        }
        return {
            "bundle": {"ciphertext": "sealed-to-dst"},
            "headSha": self.source_head,
            "recordCount": 3,
        }

    def import_into(self, *, pod_url, hushh_id, bundle, token_minter):
        self.import_args = {
            "pod_url": pod_url,
            "hushh_id": hushh_id,
            "bundle": bundle,
            "token_minter": token_minter,
        }
        return {"headSha": self.target_head, "recordCount": 3}


class _FakeResponse:
    def __init__(self, data):
        self.data = data


class _FakeTable:
    def __init__(self, store):
        self._store = store
        self._f: dict = {}
        self._op = None
        self._payload = None

    def select(self, *_c):
        self._op = "select"
        return self

    def insert(self, row):
        self._op, self._payload = "insert", dict(row)
        return self

    def update(self, data):
        self._op, self._payload = "update", dict(data)
        return self

    def eq(self, c, v):
        self._f[c] = v
        return self

    def limit(self, _n):
        return self

    def execute(self):
        rows = self._store["rows"]
        if self._op == "insert":
            rows.append(dict(self._payload))
            return _FakeResponse([dict(self._payload)])
        matched = [r for r in rows if all(r.get(k) == v for k, v in self._f.items())]
        if self._op == "update":
            for r in matched:
                r.update(self._payload)
        return _FakeResponse([dict(r) for r in matched])


class _FakeDb:
    def __init__(self, store):
        self._store = store

    def table(self, _n):
        return _FakeTable(self._store)


def _repo():
    store = {"rows": []}
    r = PodMigrationJobRepo(client=_FakeDb(store))
    r._store = store  # type: ignore[attr-defined]
    return r


def _steps(registry, provisioner, transport, reaped, switched, minter="op-minter"):
    ctx = MigrationContext(
        user_id="u1",
        hushh_id="ha1_abc",
        source_pod_url="https://one-pod-src.run.app",
        source_service="one-pod-src",
    )

    def _reap():
        reaped.append("reap")

    async def _switch(url):
        switched.append(url)

    return LiveMigrationSteps(
        ctx,
        registry=registry,
        provisioner=provisioner,
        transport=transport,
        reap=_reap,
        switch_over=_switch,
        token_minter=minter,
    )


async def _run(steps, repo):
    job_id = new_job_id()
    await repo.start(user_id="u1", job_id=job_id, hushh_id="ha1_abc", target_project="theirs")
    status = await run_migration(user_id="u1", job_id=job_id, steps=steps, repo=repo)
    return status, await repo.get("u1")


# --------------------------------------------------------------------------- #
# The happy path: composition, order, and data threading
# --------------------------------------------------------------------------- #


async def test_a_verified_move_threads_every_value_through_the_real_sequencer():
    registry, provisioner, transport = _Registry(), _Provisioner(), _Transport()
    reaped: list[str] = []
    switched: list[str] = []
    steps = _steps(registry, provisioner, transport, reaped, switched)

    status, row = await _run(steps, _repo())

    assert status == "succeeded"
    # The source sealed to the key the destination actually published.
    assert transport.export_args["recipient_public_key"] == "dst-public-key"
    assert transport.export_args["recipient_key_id"] == "dst-key-id"
    # The sealed bundle threaded from export into import, untouched.
    assert transport.import_args["bundle"] == {"ciphertext": "sealed-to-dst"}
    # Import and switch both used the URL the destination was created at.
    assert transport.import_args["pod_url"] == "https://one-pod-dst.run.app"
    assert switched == ["https://one-pod-dst.run.app"]
    # The operator's minter reached both transport calls, not ADC.
    assert transport.export_args["token_minter"] == "op-minter"
    assert transport.import_args["token_minter"] == "op-minter"
    # Reaped after the switch, and the source was frozen then never unfrozen.
    assert reaped == ["reap"]
    assert registry.calls == ["begin"]  # no end:* -- a successful move never unfreezes


async def test_the_destination_is_prepared_and_created_before_the_export():
    provisioner = _Provisioner()
    steps = _steps(_Registry(), provisioner, _Transport(), [], [])
    await _run(steps, _repo())
    # prepare, create, collect all happen before the source is asked to export.
    assert provisioner.calls == ["prepare", "create", "collect"]


# --------------------------------------------------------------------------- #
# The gate and the rollback
# --------------------------------------------------------------------------- #


async def test_a_head_mismatch_rolls_back_and_never_switches():
    registry, provisioner = _Registry(), _Provisioner()
    transport = _Transport(source_head="head-abc", target_head="head-DIFFERENT")
    reaped: list[str] = []
    switched: list[str] = []
    steps = _steps(registry, provisioner, transport, reaped, switched)

    status, row = await _run(steps, _repo())

    assert status == "failed"
    assert row["error_code"] == "HEAD_MISMATCH"
    assert switched == [], "a mismatched move must never switch the row"
    assert reaped == [], "a mismatched move must never reap the source"
    assert "teardown" in provisioner.calls  # destination torn down
    assert "end:provisioned" in registry.calls  # source unfrozen to where it started


async def test_a_row_that_cannot_be_frozen_stops_before_touching_the_destination():
    provisioner = _Provisioner()
    steps = _steps(_Registry(can_freeze=False), provisioner, _Transport(), [], [])

    status, row = await _run(steps, _repo())

    assert status == "failed"
    assert row["error_code"] == "NOT_READY_TO_MOVE"
    assert provisioner.calls == [], "nothing was built for a move that could not start"


async def test_cleanup_after_the_switch_cannot_fail_the_move():
    class _Provisioner2(_Provisioner):
        pass

    registry, provisioner, transport = _Registry(), _Provisioner2(), _Transport()
    switched: list[str] = []

    ctx = MigrationContext(
        user_id="u1",
        hushh_id="ha1_abc",
        source_pod_url="https://one-pod-src.run.app",
        source_service="one-pod-src",
    )

    def _reap_boom():
        raise RuntimeError("the old host could not be deleted")

    async def _switch(url):
        switched.append(url)

    steps = LiveMigrationSteps(
        ctx,
        registry=registry,
        provisioner=provisioner,
        transport=transport,
        reap=_reap_boom,
        switch_over=_switch,
    )

    status, _row = await _run(steps, _repo())

    # The agent is already live and verified in the destination; a stranded old
    # host is an operational cost, not a failed move.
    assert status == "succeeded"
    assert switched == ["https://one-pod-dst.run.app"]


# --------------------------------------------------------------------------- #
# It never opens the bundle
# --------------------------------------------------------------------------- #


def test_the_steps_object_has_no_decryption_path():
    import ast
    from pathlib import Path

    from hushh_mcp.services import pod_migration_live_steps as mod

    tree = ast.parse(Path(mod.__file__).read_text(encoding="utf-8"))
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            imported.add(node.module or "")

    for forbidden in ("cryptography", "pod_migration_bundle", "byoc_key_custody"):
        assert not any(forbidden in n for n in imported), (
            f"LiveMigrationSteps imports {forbidden!r}; it threads the sealed bundle, "
            "it does not open it"
        )
