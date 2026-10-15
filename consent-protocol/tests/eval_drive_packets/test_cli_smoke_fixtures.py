"""End to end on synthetic fixtures with the fixture model and judge: no network,
no Vertex, no private data, well under a minute."""

import json
import socket
import time

import pytest

from hushh_eval.drive_packets import cli


@pytest.fixture
def no_network(monkeypatch):
    def refuse(*_args, **_kwargs):
        raise OSError("network disabled in the eval smoke test")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)
    monkeypatch.setattr(socket, "getaddrinfo", refuse)


def test_plan_to_deploy_gate_on_fixtures(tmp_path, capsys, no_network):
    started = time.monotonic()
    common = ["--workdir", str(tmp_path / "work"), "--batch-id", "SMOKE"]
    outputs = {}
    for command, extra, expected in [
        ("plan-batch", ["--seed", "7", "--n-clusters", "4", "--n-loose", "3"], 0),
        ("run-batch", [], 0),
        ("judge", ["--judge", "fake"], 0),
        ("label", ["--judge", "fake"], 0),
        ("score", [], 0),
        ("report", [], 0),
        ("gate", ["--gate", "deploy"], 0),
        ("gate", ["--gate", "listing"], 2),
    ]:
        assert cli.main([command, *common, *extra]) == expected, command
        lines = [line for line in capsys.readouterr().out.splitlines() if line.startswith("{")]
        outputs[command + "".join(extra[-1:])] = json.loads(lines[-1]) if lines else None
    assert outputs["plan-batch3"]["sampled"] == 13
    run = outputs["run-batch"]
    assert run["statuses"] == {"extraction:completed": 13, "facts:completed": 13}
    assert run["packets"] == {"ready": 4} and run["budget_exhausted"] is False
    assert outputs["judgefake"]["verdicts"] == {"pass": 4}
    assert outputs["gatedeploy"]["status"] == "pass"
    assert outputs["gatelisting"]["reasons"][0].startswith("needs_59_independent_ready_has_")
    report = (tmp_path / "work/batches/SMOKE/report.md").read_text()
    assert "99.9% bar needs 0 of 2,995" in report
    assert time.monotonic() - started < 60


def test_live_source_without_opt_in_is_a_usage_error(tmp_path, capsys, monkeypatch):
    monkeypatch.delenv("DRIVE_PACKET_EVAL_LIVE", raising=False)
    code = cli.main(
        [
            "plan-batch",
            "--workdir",
            str(tmp_path / "w"),
            "--batch-id",
            "X",
            "--source",
            "uat",
            "--seed",
            "1",
        ]
    )
    assert code == 2
    assert "DRIVE_PACKET_EVAL_LIVE" in capsys.readouterr().out


def test_tampered_plan_is_refused_by_run_batch(tmp_path, capsys):
    common = ["--workdir", str(tmp_path / "work"), "--batch-id", "T1"]
    assert cli.main(["plan-batch", *common, "--seed", "5"]) == 0
    plan_path = tmp_path / "work/batches/T1/plan.json"
    plan = json.loads(plan_path.read_text())
    plan["seed"] = 6
    plan_path.write_text(json.dumps(plan))
    assert cli.main(["run-batch", *common]) == 2
    assert "plan_changed_after_preregistration" in capsys.readouterr().out


def test_owner_name_reaches_the_replay_and_is_never_written(
    tmp_path, capsys, monkeypatch, no_network
):
    from hushh_eval.drive_packets import replay

    seen = []
    original = replay.ReplayRunner.run_owner_path

    async def recording(self, **kwargs):
        seen.append(kwargs.get("owner"))
        return await original(self, **kwargs)

    monkeypatch.setattr(replay.ReplayRunner, "run_owner_path", recording)
    common = ["--workdir", str(tmp_path / "work"), "--batch-id", "OWN"]
    assert (
        cli.main(["plan-batch", *common, "--seed", "7", "--n-clusters", "4", "--n-loose", "3"]) == 0
    )
    capsys.readouterr()
    assert cli.main(["run-batch", *common, "--owner-name", "Avery Quill"]) == 0
    out = capsys.readouterr().out
    summary = json.loads([line for line in out.splitlines() if line.startswith("{")][-1])
    assert seen == [{"names": ["Avery Quill"]}]
    assert summary["owner_check"] == "explicit_name"
    assert "Quill" not in out
    written = [path for path in (tmp_path / "work").rglob("*") if path.is_file()]
    assert written and not [path.name for path in written if b"Quill" in path.read_bytes()]
