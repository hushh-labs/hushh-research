"""Guards for the provisioning narrative log (migration 907 and its one funnel).

The properties worth pinning are the ones a refactor would silently lose:
the writer is flag-gated OFF, fail-safe, computes its cursor inside the INSERT,
retries the designed PK collision exactly once, and speaks the same stage
vocabulary as the migration's CHECK constraint and the status map -- vocabulary
drift between writers and readers is precisely the defect class this branch
keeps finding, so the JOIN is asserted here rather than trusted.
"""

from __future__ import annotations

import re
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from hushh_mcp.services.pod_lifecycle_log import (
    STAGE_BY_REGISTRY_STATUS,
    STAGE_PROGRESS,
    append_sync,
    substrate_progress,
)

_MIGRATION = (
    Path(__file__).resolve().parents[1] / "db/migrations/parked/907_pod_lifecycle_events.sql"
)


def test_flag_off_is_a_no_op_that_touches_no_database():
    with patch("db.db_client.get_db") as get_db:
        with patch("hushh_mcp.runtime_settings.pod_lifecycle_log_enabled", return_value=False):
            append_sync("user-1", stage="registry_row", registry_status="pending")
    get_db.assert_not_called()


def test_flag_on_writes_one_row_with_the_cursor_computed_inside_the_insert():
    client = MagicMock()
    with patch("db.db_client.get_db", return_value=client):
        with patch("hushh_mcp.runtime_settings.pod_lifecycle_log_enabled", return_value=True):
            append_sync(
                "user-1",
                stage="host_requested",
                registry_status="provisioning",
                hushh_id="ha1_x",
            )
    assert client.execute_raw.call_count == 1
    sql, params = client.execute_raw.call_args.args
    # The seq races two writers can run must fail LOUDLY on the PK, which only
    # happens if the cursor is computed in the same statement that inserts it.
    assert "COALESCE(MAX(seq), 0) + 1" in sql
    assert params["user_id"] == "user-1"
    assert params["stage"] == "host_requested"
    assert params["progress_pct"] == STAGE_PROGRESS["host_requested"]
    assert params["terminal"] is False


def test_the_designed_collision_is_retried_exactly_once():
    client = MagicMock()
    client.execute_raw.side_effect = [RuntimeError("pk collision"), MagicMock()]
    with patch("db.db_client.get_db", return_value=client):
        with patch("hushh_mcp.runtime_settings.pod_lifecycle_log_enabled", return_value=True):
            append_sync("user-1", stage="registry_row", registry_status="pending")
    assert client.execute_raw.call_count == 2


def test_a_second_collision_is_swallowed_never_raised():
    client = MagicMock()
    client.execute_raw.side_effect = RuntimeError("still colliding")
    with patch("db.db_client.get_db", return_value=client):
        with patch("hushh_mcp.runtime_settings.pod_lifecycle_log_enabled", return_value=True):
            # Must not raise: narrative can never break provisioning.
            append_sync("user-1", stage="registry_row", registry_status="pending")


def test_every_funnel_status_is_in_the_migrations_check_constraint():
    """The writer's vocabulary and the schema's must be one vocabulary."""
    sql = _MIGRATION.read_text()
    match = re.search(r"CHECK \(status IN \((.*?)\)\)", sql, re.DOTALL)
    assert match, "the CHECK constraint is gone from migration 907"
    allowed = set(re.findall(r"'([a-z_]+)'", match.group(1)))
    assert set(STAGE_BY_REGISTRY_STATUS) <= allowed, (
        "the funnel maps a status the schema refuses; the write would fail "
        f"loudly in dev and silently nowhere else: {set(STAGE_BY_REGISTRY_STATUS) - allowed}"
    )


def test_substrate_progress_is_monotonic_and_bounded():
    values = [substrate_progress(i) for i in range(0, 18)]
    assert values == sorted(values), "a step counter that goes backwards freezes the bar"
    assert all(STAGE_PROGRESS["substrate"] <= v <= 50 for v in values)


def test_the_lifecycle_endpoints_are_pure_readers():
    """The status surface must never mint authority again. The old defect was a
    GET that performed a 24h standing pkm.read mint per poll; this pins its
    absence from the new surface at the import level, where a regression would
    have to announce itself."""
    import ast

    source = (Path(__file__).resolve().parents[1] / "api/routes/one/pod_lifecycle.py").read_text()
    # Scan CODE, not prose: the module's own docstring legitimately names the
    # defect it replaces. Docstrings are stripped by walking the AST and keeping
    # only the names actually referenced.
    tree = ast.parse(source)
    referenced = (
        {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}
        | {node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)}
        | {
            alias.name
            for node in ast.walk(tree)
            if isinstance(node, (ast.Import, ast.ImportFrom))
            for alias in node.names
        }
    )
    for forbidden in (
        "collect_pod_key_if_pending",
        "upsert",
        "record_provisioning_feed_event_safe",
    ):
        assert forbidden not in referenced, f"pure-reader contract violated: {forbidden}"


def test_the_endpoints_mount_where_the_proxy_looks():
    """The route must exist at /api/one/..., not merely exist.

    The first deploy of this surface answered 404 live while every local check
    passed: the router imported cleanly, its tests ran, and it was registered at
    the APP ROOT, because the one-package routers each carry their own full
    /api/one prefix and this one carried a bare /pod/lifecycle. An import check
    proves a router loads; only the mounted path proves a client can reach it.
    """
    from api.routes.one import router as one_router

    paths = {getattr(r, "path", "") for r in one_router.routes}
    assert "/api/one/pod/lifecycle" in paths, sorted(p for p in paths if "lifecycle" in p)
    assert "/api/one/pod/lifecycle/stream" in paths


@pytest.mark.parametrize("status", list(STAGE_BY_REGISTRY_STATUS))
def test_funnel_stages_have_progress_or_are_terminal(status: str):
    stage = STAGE_BY_REGISTRY_STATUS[status]
    assert stage in STAGE_PROGRESS or stage in {"failed", "reaped"}, (
        f"stage {stage!r} would render progress 0 mid-journey"
    )


def test_the_wake_route_mounts_on_the_hub_and_the_tick_on_the_pod():
    """Phase 5/6 placement: wake is a HUB surface (it reads the registry and
    reaches into the pod), the tick is a POD surface (it is what Cloud Scheduler
    and Pub/Sub push wake). Mounting either on the wrong plane is not a style
    error: a hub-mounted tick would accept scheduler identities against the
    wrong audience, and a pod-mounted wake would need a registry the pod
    deliberately does not have."""
    from api.routes.one import router as one_router
    from pod_server import _POD_ROUTERS

    hub_paths = {getattr(r, "path", "") for r in one_router.routes}
    assert "/api/one/pod/wake" in hub_paths
    pod_paths = {getattr(r, "path", "") for router in _POD_ROUTERS for r in router.routes}
    assert "/pod/tick" in pod_paths
    assert "/api/one/pod/wake" not in pod_paths, "the pod must not mount the wake"


async def test_the_tick_refuses_without_scheduler_identity():
    """Fail-closed is the whole point: no audience, no allowlist, no work.

    An async test under the repo's pytest-asyncio auto mode -- the first cut
    spun its own loop via get_event_loop(), which passed locally (a loop
    happened to exist from neighbouring tests) and raised on CI's Python where
    none did. The test now runs the way every other async test here runs.
    """
    from fastapi import HTTPException

    from api.routes.one.pod_maintenance import pod_tick

    with pytest.raises(HTTPException) as refusal:
        await pod_tick(request=None, authorization=None)
    assert refusal.value.status_code == 403
