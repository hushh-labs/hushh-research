# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Current application selection must not inherit historical workflow success."""

import importlib
import subprocess
import sys
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace

import pytest

from tests.helpers.predecessor_acceptance import SHA, _acceptance_fixture


def fixture(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / "scripts/ci"))
    selection = importlib.import_module("uat_application_selection")
    _, acceptance, _, responses, pins = _acceptance_fixture()
    responses["runs/20"] = deepcopy(responses["runs/20/attempts/2"])
    responses["runs/20/artifacts?per_page=100"] = {
        "total_count": 1,
        "artifacts": [responses["artifacts/21"]],
    }
    documents = {
        "deployments?environment=uat&per_page=100&page=1": [{"id": 50}],
        "deployments/50/statuses?per_page=1": [
            {
                "state": "success",
                "log_url": f"https://github.com/{selection.REPOSITORY}/actions/runs/20/job/30",
            }
        ],
    }

    class API:
        def read(self, path):
            return deepcopy(documents[path.removeprefix(selection.PREFIX + "/")])

    return selection, selection.ObservedRepository(API()), acceptance, responses, documents


def test_current_receipt_uses_application_identity_not_main_workflow_sha(monkeypatch):
    module, repository, acceptance, _, _ = fixture(monkeypatch)
    result = module.current_application(repository, acceptance, SHA, "all")
    assert result["noop"] and set(result["services"]) == {"frontend", "backend"}
    assert module.choose(SHA, result, True, ancestor=lambda *_: False)["decision"] == "NO_OP"
    other = "d" * 40
    result = module.current_application(repository, acceptance, other, "all")
    assert not result["noop"]
    assert module.choose(other, result, True, ancestor=lambda *_: True)["sha"] == other
    assert module.choose(other, result, True, ancestor=lambda *_: False)["decision"] == "BLOCKED"


@pytest.mark.parametrize(
    "inventory",
    [
        {"total_count": 2, "artifacts": [{"name": "receipt"}]},
        {"total_count": True, "artifacts": [{"name": "receipt"}]},
        {"total_count": 1, "artifacts": [None]},
        {"total_count": 1, "artifacts": [{"name": None}]},
        {"artifacts": []},
    ],
)
def test_truncated_or_malformed_receipt_inventory_is_refused(inventory):
    module, acceptance, _, responses, _ = _acceptance_fixture()
    responses["runs/20/artifacts?per_page=100"] = inventory
    with pytest.raises(module.Refused, match="Artifact inventory"):
        acceptance.attempt_pins("uat", 20)


@pytest.mark.parametrize(
    "case", ["failed_rerun", "pending_rerun", "status_failure", "lost_artifact", "dev_failure"]
)
def test_current_failure_never_reuses_an_older_green_receipt(monkeypatch, case):
    module, repository, acceptance, responses, documents = fixture(monkeypatch)
    if case in {"failed_rerun", "pending_rerun"}:
        responses["runs/20"].update(run_attempt=3, conclusion="failure")
        if case == "pending_rerun":
            responses["runs/20"].update(status="in_progress", conclusion=None)
    elif case == "status_failure":
        documents["deployments/50/statuses?per_page=1"][0]["state"] = "failure"
    elif case == "lost_artifact":
        responses["runs/20/artifacts?per_page=100"] = {"total_count": 0, "artifacts": []}
    else:
        responses["runs/10/attempts/2"]["conclusion"] = "failure"
    result = module.current_application(repository, acceptance, SHA, "all")
    assert not result["noop"]
    assert result["waiting"] == (case == "pending_rerun")
    assert module.choose(SHA, result, True, ancestor=lambda *_: True)["decision"] in {
        "BLOCKED",
        "DEPLOY_IN_FLIGHT",
    }


def test_partial_later_mutation_blocks_backend_but_not_frontend_receipt(monkeypatch):
    module, repository, acceptance, responses, documents = fixture(monkeypatch)
    documents["deployments?environment=uat&per_page=100&page=1"].insert(0, {"id": 51})
    documents["deployments/51/statuses?per_page=1"] = [
        {"state": "success", "log_url": f"https://github.com/{module.REPOSITORY}/actions/runs/30"}
    ]
    responses["runs/30"] = {**responses["runs/20"], "id": 30, "path": module.CHAT_WORKFLOW}
    assert not module.current_application(repository, acceptance, SHA, "all")["noop"]
    assert module.current_application(repository, acceptance, SHA, "frontend")["noop"]


def test_selection_rechecks_current_attempt_before_noop(monkeypatch):
    module, repository, acceptance, responses, _ = fixture(monkeypatch)
    read = acceptance.read
    count = 0

    def racing_read(path, **kwargs):
        nonlocal count
        if path == "runs/20":
            count += 1
            if count == 2:
                return {**responses[path], "run_attempt": 3, "status": "in_progress"}
        return deepcopy(read(path, **kwargs))

    acceptance.read = racing_read
    assert not module.current_application(repository, acceptance, SHA, "all")["noop"]


@pytest.mark.parametrize(
    ("remote_tip", "expected_status"),
    [
        ("same", 0),
        ("changed", 2),
        ("missing", 2),
        ("malformed", 2),
        ("unreachable", 2),
        ("timeout", 2),
    ],
)
def test_selection_rechecks_uat_tip_before_output(
    monkeypatch, tmp_path, remote_tip, expected_status
):
    module, repository, acceptance, _, _ = fixture(monkeypatch)
    events = []
    output = tmp_path / "github-output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    monkeypatch.setattr(sys, "argv", ["selector", "--github-output", "--allow-no-op"])

    def run(args, **_kwargs):
        events.append(("fetch", args))

    def check_output(args, **_kwargs):
        if args[:2] == ["git", "rev-parse"]:
            events.append(("snapshot", args))
            return SHA + "\n"
        events.append(("recheck", args))
        if remote_tip == "unreachable":
            raise subprocess.CalledProcessError(128, args)
        if remote_tip == "timeout":
            raise subprocess.TimeoutExpired(args, 30)
        return {
            "same": f"{SHA}\trefs/heads/uat\n",
            "changed": f"{'d' * 40}\trefs/heads/uat\n",
            "missing": "",
            "malformed": f"{SHA}\trefs/heads/other\n",
        }[remote_tip]

    def current(*_args):
        events.append(("inventory", None))
        return {"waiting": False, "noop": True, "reason": "verified"}

    monkeypatch.setattr(
        module,
        "subprocess",
        SimpleNamespace(
            run=run,
            check_output=check_output,
            SubprocessError=subprocess.SubprocessError,
        ),
    )
    monkeypatch.setattr(
        module,
        "importlib",
        SimpleNamespace(
            import_module=lambda _name: SimpleNamespace(GitHub=lambda: acceptance),
        ),
    )
    monkeypatch.setattr(module, "GitHub", lambda *_args: None)
    monkeypatch.setattr(module, "ObservedRepository", lambda _api: repository)
    monkeypatch.setattr(module, "current_application", current)

    assert module.main() == expected_status
    assert [event[0] for event in events] == ["fetch", "snapshot", "inventory", "recheck"]
    assert events[0][1] == ["git", "fetch", "--no-tags", "origin", "refs/heads/uat"]
    assert events[1][1] == ["git", "rev-parse", "--verify", "FETCH_HEAD^{commit}"]
    assert events[3][1] == ["git", "ls-remote", "--refs", "origin", "refs/heads/uat"]
    if expected_status == 0:
        assert f"uat_actual_sha={SHA}\n" in output.read_text()
    else:
        assert not output.exists()


def test_bounded_pagination_never_changes_page_size_or_skips_records(monkeypatch):
    module, repository, acceptance, responses, documents = fixture(monkeypatch)
    documents["deployments?environment=uat&per_page=100&page=1"] = [
        {"id": i} for i in range(100, 200)
    ]
    documents["deployments?environment=uat&per_page=100&page=2"] = [{"id": 50}]
    for i in range(100, 200):
        documents[f"deployments/{i}/statuses?per_page=1"] = [
            {
                "state": "success",
                "log_url": f"https://github.com/{module.REPOSITORY}/actions/runs/30",
            }
        ]
    responses["runs/30"] = {
        **responses["runs/20"],
        "id": 30,
        "path": next(iter(module.READ_ONLY_WORKFLOWS)),
    }
    assert not module.current_application(repository, acceptance, SHA, "all", limit=100)["noop"]
    assert module.current_application(repository, acceptance, SHA, "all", limit=101)["noop"]
