"""The page names the deployed UAT revision and SHA and says, in red, when the engine
running here is not exactly that commit. Fake gcloud and git only."""

import json
from pathlib import Path

import pytest

from hushh_eval.drive_packets.dashboard import launch
from hushh_eval.drive_packets.dashboard.engine_info import (
    EngineInfo,
    describe_serving,
    engine_checkout,
    same_commit,
)

SHA = "812974bf4875130dd8db2a81fc882fa129adf2d1"


def service(traffic, *, template="consent-protocol-00002-new", sha=SHA):
    return {
        "metadata": {"name": "consent-protocol"},
        "spec": {"template": {"metadata": {"name": template, "labels": {"deploy-sha": sha}}}},
        "status": {"traffic": traffic, "latestReadyRevisionName": template},
    }


def gcloud(responses: dict, calls: list):
    def command(*args):
        calls.append(args)
        return json.dumps(responses[args[1]])

    return command


def test_serving_revision_and_label_come_from_one_describe():
    calls = []
    found = describe_serving(
        gcloud(
            {"services": service([{"revisionName": "consent-protocol-00002-new", "percent": 100}])},
            calls,
        )
    )
    assert found == {"revision": "consent-protocol-00002-new", "deploy_sha": SHA, "error": None}
    assert [call[:3] for call in calls] == [("run", "services", "describe")]
    assert "--project" in calls[0] and "hushh-pda-uat" in calls[0]


def test_traffic_pinned_to_an_older_revision_reads_that_revision():
    calls = []
    older = {"metadata": {"labels": {"deploy-sha": "1111111111"}}}
    found = describe_serving(
        gcloud(
            {
                "services": service(
                    [{"revisionName": "consent-protocol-00001-old", "percent": 100}]
                ),
                "revisions": older,
            },
            calls,
        )
    )
    assert found["revision"] == "consent-protocol-00001-old" and found["deploy_sha"] == "1111111111"
    assert calls[1][:4] == ("run", "revisions", "describe", "consent-protocol-00001-old")


def test_split_traffic_or_missing_label_is_never_a_match():
    split = [{"revisionName": "a", "percent": 50}, {"revisionName": "b", "percent": 50}]
    assert describe_serving(gcloud({"services": service(split)}, []))["error"] == "traffic_split"
    unlabeled = service([{"latestRevision": True, "percent": 100}], sha="")
    assert (
        describe_serving(gcloud({"services": unlabeled}, []))["error"] == "deploy_sha_label_missing"
    )


def test_match_needs_the_same_commit_and_no_local_changes():
    deployed = {"revision": "r1", "deploy_sha": SHA}
    clean = {"engine_root": "/e", "engine_sha": SHA, "engine_clean": True}
    assert EngineInfo(describe=lambda: deployed, local=lambda: clean).snapshot()["match"] is True
    short = {"revision": "r1", "deploy_sha": SHA[:10]}
    assert EngineInfo(describe=lambda: short, local=lambda: clean).snapshot()["match"] is True
    dirty = {**clean, "engine_clean": False}
    snap = EngineInfo(describe=lambda: deployed, local=lambda: dirty).snapshot()
    assert snap["match"] is False and "local changes" in snap["reason"]
    other = {**clean, "engine_sha": "33a7db34e0" + "0" * 30}
    assert EngineInfo(describe=lambda: deployed, local=lambda: other).snapshot()["match"] is False

    def broken():
        raise RuntimeError("gcloud_read_failed")

    snap = EngineInfo(describe=broken, local=lambda: clean).snapshot()
    assert snap["match"] is False and snap["deployed_sha"] is None
    assert (
        same_commit("812974b", SHA) and not same_commit("8129", SHA) and not same_commit(None, SHA)
    )


def test_the_deployed_side_is_rechecked_after_the_refresh_window():
    calls, now = [], [0.0]

    def describe():
        calls.append(1)
        return {"revision": "r1", "deploy_sha": SHA}

    info = EngineInfo(
        describe=describe,
        local=lambda: {"engine_root": "/e", "engine_sha": SHA, "engine_clean": True},
        refresh_seconds=300,
        clock=lambda: now[0],
    )
    info.snapshot()
    info.snapshot()
    assert len(calls) == 1
    now[0] = 301
    info.snapshot()
    info.snapshot(refresh=True)
    assert len(calls) == 3


def test_engine_checkout_is_where_hushh_mcp_was_imported_from(tmp_path):
    module = tmp_path / "repo" / "consent-protocol" / "hushh_mcp" / "__init__.py"
    assert engine_checkout(str(module)) == (tmp_path / "repo").resolve()


class FakeGit:
    def __init__(self, heads: dict, known: bool = True):
        self.heads = heads
        self.known = known
        self.calls = []

    def __call__(self, *args):
        self.calls.append(args)
        root, command = args[1], args[2]
        if command == "rev-parse":
            return self.heads.get(root, "")
        if command == "status":
            return ""
        if command == "cat-file":
            return "commit" if self.known else ""
        if command == "fetch":
            self.known = True
            return ""
        if command == "worktree":
            return ""
        raise AssertionError(args)


def test_this_checkout_is_used_when_it_is_the_deployed_commit(tmp_path):
    git = FakeGit({str(tmp_path): SHA})
    assert (
        launch.ensure_engine_checkout(SHA, dashboard_root=tmp_path, parent=tmp_path / "e", git=git)
        == tmp_path
    )
    assert not [call for call in git.calls if call[2] in {"worktree", "fetch"}]


def test_an_engine_worktree_is_added_at_exactly_the_deployed_commit(tmp_path):
    root = tmp_path / "dash"
    git = FakeGit({str(root): "33a7db34e0" + "0" * 30}, known=False)
    target = launch.ensure_engine_checkout(
        SHA, dashboard_root=root, parent=tmp_path / "engines", git=git
    )
    assert target == tmp_path / "engines" / f"dash-engine-{SHA[:12]}"
    assert ("-C", str(root), "fetch", "origin", "--prune") in git.calls
    assert ("-C", str(root), "worktree", "add", str(target), SHA) in git.calls


def test_an_existing_engine_checkout_at_another_commit_is_refused(tmp_path):
    root = tmp_path / "dash"
    target = tmp_path / "engines" / f"dash-engine-{SHA[:12]}"
    target.mkdir(parents=True)
    git = FakeGit({str(root): "0" * 40, str(target): "1" * 40})
    with pytest.raises(launch.LaunchError, match="engine_checkout_wrong_commit"):
        launch.ensure_engine_checkout(
            SHA, dashboard_root=root, parent=tmp_path / "engines", git=git
        )
    assert not [call for call in git.calls if call[2] == "worktree"]


def test_overlay_holds_only_a_link_to_this_checkouts_eval_package(tmp_path):
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    checkout = tmp_path / "dash"
    (checkout / "consent-protocol" / "hushh_eval").mkdir(parents=True)
    overlay = launch.overlay_directory(state, checkout)
    assert [path.name for path in overlay.iterdir()] == ["hushh_eval"]
    assert Path((overlay / "hushh_eval").readlink()) == checkout / "consent-protocol" / "hushh_eval"
