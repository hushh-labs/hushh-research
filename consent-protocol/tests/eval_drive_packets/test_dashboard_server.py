"""The dashboard server: one owner, 127.0.0.1 only, private labels, and the API contract.

Synthetic owners and rows only (``_dashboard_fakes``): no UAT, Drive, Vertex or
network. Another owner's packet or request id is a 404 and writes no label.
"""

import json
import os
import stat
import types
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hushh_eval.drive_packets.dashboard import launch, server
from hushh_eval.drive_packets.dashboard.eval_view import EvalView
from hushh_eval.drive_packets.dashboard.labels import LabelStore
from hushh_eval.drive_packets.dashboard.owner import OwnerConfig, OwnerConfigError, resolve_owner
from hushh_eval.drive_packets.dashboard.queries import DashboardData, OwnerScopedReader
from hushh_eval.drive_packets.dashboard.real_requests import RealRequests
from hushh_eval.drive_packets.dashboard.server import (
    BindRefused,
    DashboardContext,
    check_bind,
    create_app,
)
from hushh_eval.drive_packets.privacy import PrivacyError

from ._dashboard_fakes import (
    MY_PACKET,
    MY_REQUEST,
    OTHER,
    OWNER,
    REQUESTER_EMAIL,
    THEIR_PACKET,
    THEIR_REQUEST,
    FakeEngine,
    PlainCipher,
    owner_rows,
    write_batch,
)

JSON = {"content-type": "application/json"}


class Engine:
    def snapshot(self, refresh=False):
        return {
            "deployed_revision": "consent-protocol-00001-syn",
            "deployed_sha": "a" * 40,
            "engine_sha": "a" * 40,
            "match": True,
            "checked_at": "2026-10-16T00:00:00+00:00",
            "engine_root": "/synthetic",
            "engine_clean": True,
            "reason": "",
        }


@pytest.fixture
def private_dir(tmp_path):
    path = tmp_path / "dashboard-private"
    path.mkdir(mode=0o700)
    return path


@pytest.fixture
def context(tmp_path, private_dir):
    eval_root = tmp_path / "eval"
    eval_root.mkdir(mode=0o700)
    write_batch(eval_root, "B001", {"k1": "pass", "k2": "fail", "k3": "unknown"})
    owner = OwnerConfig(
        owner_id=OWNER, display_name="Manish", eval_workdir=eval_root, sources=("live-env",)
    )
    labels = LabelStore(private_dir)
    reader = OwnerScopedReader(FakeEngine(owner_rows()), OWNER)
    data = DashboardData(
        reader,
        owner_label="Manish",
        labels=labels,
        code_policy="policy-x",
        profile="profile-x",
        cipher=PlainCipher(),
    )
    return DashboardContext(
        owner=owner,
        labels=labels,
        evals=EvalView(eval_root),
        engine=Engine(),
        data=data,
        requests=RealRequests(reader, labels=labels, cipher=PlainCipher()),
        reader=reader,
    )


def client_for(context, **kwargs):
    return TestClient(create_app(context, allowed_hosts={"testserver"}, **kwargs))


def label_lines(private_dir: Path, name: str) -> list[dict]:
    path = private_dir / name
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


# --- Owner isolation ------------------------------------------------------------------
def test_another_owners_packet_is_404_and_writes_nothing(context, private_dir):
    client = client_for(context)
    assert client.get(f"/api/packets/{THEIR_PACKET}").status_code == 404
    body = {"verdict": "wrong", "reason": "wrong_period", "note": "x"}
    assert client.post(f"/api/packets/{THEIR_PACKET}/label", json=body).status_code == 404
    assert client.post("/api/packets/not-a-uuid/label", json=body).status_code == 404
    assert label_lines(private_dir, "packet_labels.jsonl") == []


def test_own_packet_label_is_saved_privately(context, private_dir):
    client = client_for(context)
    body = {"verdict": "wrong", "reason": "wrong period", "note": "2014 history"}
    response = client.post(f"/api/packets/{MY_PACKET.upper()}/label", json=body)
    assert response.status_code == 200 and response.json() == {"saved": True}
    [line] = label_lines(private_dir, "packet_labels.jsonl")
    assert line["packet_id"] == MY_PACKET and line["version"] == 3
    assert line["verdict"] == "wrong" and line["reason"] == "wrong_period"
    assert stat.S_IMODE(os.stat(private_dir).st_mode) == 0o700
    for name in ("packet_labels.jsonl", "judgments.served.jsonl"):
        assert stat.S_IMODE(os.stat(private_dir / name).st_mode) == 0o600


def test_another_owners_request_is_404_and_writes_nothing(context, private_dir):
    client = client_for(context)
    assert client.get(f"/api/requests/{THEIR_REQUEST}").status_code == 404
    body = {"document_id": None, "verdict": "wrong", "note": ""}
    assert client.post(f"/api/requests/{THEIR_REQUEST}/label", json=body).status_code == 404
    assert client.get("/api/requests/not-a-uuid").status_code == 404
    assert label_lines(private_dir, "request_labels.jsonl") == []
    listed = client.get("/api/requests").json()
    assert [item["request_id"] for item in listed] == [MY_REQUEST]


def test_own_request_shows_display_name_only_and_marks_what_was_not_stored(context, private_dir):
    client = client_for(context)
    response = client.get(f"/api/requests/{MY_REQUEST}")
    assert response.status_code == 200
    detail = response.json()
    assert detail["requester_display_name"] == "Synthetic Buyer"
    assert REQUESTER_EMAIL not in response.text and "buyer-synthetic-9" not in response.text
    assert detail["purpose_text"] == "Recent brokerage statements (synthetic)"
    assert (detail["period_start"], detail["period_end"]) == ("2026-09-01", "2026-10-09")
    assert detail["plan"] == "not recorded" and detail["logs"] == "not recorded"
    assert detail["drive_api"]["calls"] == "not recorded"
    assert detail["payment"]["status"] == "paid" and detail["payment"]["refunded"] is False
    for key in (
        "request_id",
        "created_at",
        "status",
        "selected_count",
        "paid",
        "delivered",
        "human_label",
        "steps",
        "documents",
        "owner_review",
        "delivery",
    ):
        assert key in detail
    body = {"document_id": "p1", "verdict": "missed", "note": "the September statement"}
    assert client.post(f"/api/requests/{MY_REQUEST}/label", json=body).json() == {"saved": True}
    [line] = label_lines(private_dir, "request_labels.jsonl")
    assert line["request_id"] == MY_REQUEST and line["verdict"] == "missed"
    assert stat.S_IMODE(os.stat(private_dir / "request_labels.jsonl").st_mode) == 0o600
    listed = client.get("/api/requests").json()[0]
    assert listed["requester_display_name"] == "Synthetic Buyer"
    assert listed["paid"] is True and listed["already_had_access"] == 1 and listed["delivered"] == 0


def test_technical_requester_names_are_never_shown():
    from hushh_eval.drive_packets.dashboard.real_requests import NO_NAME, requester_name

    assert requester_name("RPNmQAmVdlNz84GVfXxta50wnYx1") == NO_NAME
    assert requester_name(None) == NO_NAME
    assert requester_name("Synthetic Buyer") == "Synthetic Buyer"


# --- Binding and request fences ----------------------------------------------------------
@pytest.mark.parametrize(
    "host",
    ["0.0.0.0", "::", "localhost", "192.168.1.10", "127.0.0.2", ""],  # noqa: S104 - refused
)
def test_only_loopback_127_0_0_1_is_bound(host, monkeypatch):
    import uvicorn

    def refuse(*_args, **_kwargs):
        raise AssertionError("uvicorn must not start")

    monkeypatch.setattr(uvicorn, "Server", refuse)
    with pytest.raises(BindRefused):
        check_bind(host)
    with pytest.raises(BindRefused):
        server.serve(object(), host=host, port=8765)
    assert check_bind("127.0.0.1") == "127.0.0.1"


def test_foreign_host_origin_and_non_json_posts_are_refused(context):
    client = client_for(context)
    assert client.get("/api/engine", headers={"host": "evil.example"}).status_code == 421
    body = {"verdict": "correct", "reason": None, "note": ""}
    refused = client.post(
        f"/api/packets/{MY_PACKET}/label", json=body, headers={"origin": "http://evil.example"}
    )
    assert refused.status_code == 403
    plain = client.post(
        f"/api/packets/{MY_PACKET}/label",
        content="verdict=correct",
        headers={"content-type": "application/x-www-form-urlencoded"},
    )
    assert plain.status_code == 415
    response = client.get("/api/engine")
    assert response.headers["cache-control"] == "no-store"
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]


def test_default_hosts_are_this_machine_only(context):
    app = create_app(context, port=8765)
    client = TestClient(app, base_url="http://127.0.0.1:8765")
    assert client.get("/api/engine").status_code == 200
    local = TestClient(app, base_url="http://localhost:8765")
    assert local.get("/api/engine").status_code == 200
    other = TestClient(app, base_url="http://127.0.0.1:9999")
    assert other.get("/api/engine").status_code == 421


# --- Owner configuration -------------------------------------------------------------
def _live_env(tmp_path, line: str, extra: str = "") -> Path:
    path = tmp_path / "live-env.sh"
    path.write_text(f"# synthetic\n{line}\n{extra}export W=/synthetic/eval\n")
    return path


def _evidence(tmp_path) -> Path:
    path = tmp_path / "evidence.json"
    path.write_text(
        json.dumps({"identities": {"owner": {"user_id": OWNER}, "requester": {"user_id": OTHER}}})
    )
    return path


def test_owner_comes_from_the_eval_config_owner_identity_only(tmp_path):
    evidence = _evidence(tmp_path)
    line = (
        "export DRIVE_PACKET_EVAL_OWNER=\"$(python3 -c 'import json;print(json.load(open("
        f'"{evidence}"))["identities"]["owner"]["user_id"])\')"'
    )
    config = resolve_owner(live_env=_live_env(tmp_path, line), environ={})
    assert config.owner_id == OWNER and config.display_name == "Manish"
    assert config.eval_workdir == Path("/synthetic/eval")
    assert OWNER not in repr(config)
    same = resolve_owner(
        live_env=_live_env(tmp_path, line), environ={"DRIVE_PACKET_EVAL_OWNER": OWNER}
    )
    assert same.sources == ("live-env", "env")


@pytest.mark.parametrize(
    ("setup", "code"),
    [
        ("missing", "owner_config_missing"),
        ("no_line", "owner_not_configured"),
        ("two_lines", "owner_config_ambiguous"),
        ("conflict", "owner_config_conflict"),
        ("invalid", "owner_config_unsupported"),
        ("other_identity", "owner_config_unsupported"),
    ],
)
def test_start_is_refused_without_exactly_one_owner_id(tmp_path, setup, code):
    literal = f"export DRIVE_PACKET_EVAL_OWNER={OWNER}"
    environ = {}
    if setup == "missing":
        path = tmp_path / "absent.sh"
    elif setup == "no_line":
        path = _live_env(tmp_path, "export DRIVE_PACKET_EVAL_LIVE=1")
    elif setup == "two_lines":
        path = _live_env(tmp_path, literal, f"export DRIVE_PACKET_EVAL_OWNER={OTHER}\n")
    elif setup == "conflict":
        path = _live_env(tmp_path, literal)
        environ = {"DRIVE_PACKET_EVAL_OWNER": OTHER}
    elif setup == "invalid":
        path = _live_env(tmp_path, "export DRIVE_PACKET_EVAL_OWNER=$(whoami; id)")
    else:
        evidence = _evidence(tmp_path)
        path = _live_env(
            tmp_path,
            "export DRIVE_PACKET_EVAL_OWNER=\"$(python3 -c 'import json;print(json.load(open("
            f'"{evidence}"))["identities"]["requester"]["user_id"])\')"',
        )
    with pytest.raises(OwnerConfigError, match=code):
        resolve_owner(live_env=path, environ=environ)


def test_launcher_refuses_before_touching_uat_without_an_owner(monkeypatch, capsys):
    def no_owner(**_kwargs):
        raise OwnerConfigError("owner_config_missing")

    def forbidden(*_args, **_kwargs):
        raise AssertionError("UAT must not be contacted")

    monkeypatch.setattr(launch, "resolve_owner", no_owner)
    monkeypatch.setattr(launch, "describe_serving", forbidden)
    monkeypatch.setattr(launch, "build_context", forbidden)
    args = types.SimpleNamespace(
        port=8765, db_port=6657, engine_root=None, no_engine_checkout=False, check=True
    )
    assert launch.run(args) == 2
    assert "owner_config_missing" in capsys.readouterr().out


# --- Labels ------------------------------------------------------------------------
def test_label_store_is_private_and_append_only(tmp_path, private_dir):
    store = LabelStore(private_dir)
    store.save_packet_label(packet_id=MY_PACKET, version=3, verdict="correct")
    store.save_packet_label(packet_id=MY_PACKET, version=3, verdict="wrong", reason="duplicate")
    assert len(label_lines(private_dir, "packet_labels.jsonl")) == 2
    assert store.packet_labels()[MY_PACKET]["verdict"] == "wrong"
    store.save_ask({"ask_id": "ask-1", "documents": []})
    store.save_ask_label(ask_id="ask-1", document_id=None, verdict="right")
    for path in private_dir.iterdir():
        assert stat.S_IMODE(path.stat().st_mode) == 0o600, path.name
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    with pytest.raises(PrivacyError, match="workdir_inside_git_worktree"):
        LabelStore(repo / "labels")
    loose = tmp_path / "loose"
    loose.mkdir(mode=0o755)
    with pytest.raises(PrivacyError, match="workdir_mode_not_0700"):
        LabelStore(loose)


# --- Request engine routes ---------------------------------------------------------------
def test_ask_routes_answer_503_until_the_engine_is_installed(context):
    client = client_for(context, ask_loader=lambda: None)
    assert client.get("/api/presets").status_code == 503
    ask = {
        "prompt": "six months of statements",
        "period_start": "2026-04-16",
        "period_end": "2026-10-15",
    }
    response = client.post("/api/ask", json=ask)
    assert (
        response.status_code == 503 and response.json()["error"] == "request engine not installed"
    )


def test_ask_routes_wrap_the_engine_and_keep_the_record(context, private_dir):
    calls = {}

    def run_ask(prompt, period_start, period_end, owner_id, matching_packets):
        calls.update(prompt=prompt, period_start=period_start, owner_id=owner_id)
        return {"ask_id": "ask-0001", "documents": [{"document_id": "d1", "selected": True}]}

    module = types.SimpleNamespace(run_ask=run_ask, presets=lambda: [{"id": "p1"}])
    client = client_for(context, ask_loader=lambda: module)
    assert client.get("/api/presets").json() == [{"id": "p1"}]
    ask = {
        "prompt": "six months of statements",
        "period_start": "2026-04-16",
        "period_end": "2026-10-15",
    }
    assert client.post("/api/ask", json=ask).json()["ask_id"] == "ask-0001"
    assert calls == {"prompt": ask["prompt"], "period_start": "2026-04-16", "owner_id": OWNER}
    assert client.post("/api/ask", json={**ask, "as_of": "2026-10-13"}).status_code == 422
    assert client.post("/api/ask", json={**ask, "period_start": "Oct 1"}).status_code == 422
    label = {"document_id": "d1", "verdict": "missed", "note": ""}
    assert client.post("/api/ask/ask-0001/label", json=label).json() == {"saved": True}
    assert client.post("/api/ask/ask-9999/label", json=label).status_code == 404
    assert (
        client.post("/api/ask/ask-0001/label", json={**label, "verdict": "great"}).status_code
        == 422
    )
    [record] = label_lines(private_dir, "asks.jsonl")
    assert record["ask_id"] == "ask-0001"
    accuracy = client.get("/api/accuracy").json()
    dry = accuracy["requests"]["by_source"]["dry_run"]
    assert dry["system_selected"] == 1 and dry["human"]["missed"] == 1


def test_an_engine_that_needs_a_runtime_gets_one_built_once(context, private_dir):
    built = []

    def build_live_runtime(owner_id, db_port, private_dir):
        built.append((owner_id, db_port, private_dir))
        return {"runtime": len(built)}

    async def run_ask(runtime, prompt, period_start=None, period_end=None, *, as_of=None):
        return {"ask_id": f"ask-{runtime['runtime']}-{len(prompt)}", "documents": []}

    module = types.SimpleNamespace(
        run_ask=run_ask, presets=lambda today=None: [], build_live_runtime=build_live_runtime
    )
    client = client_for(context, ask_loader=lambda: module)
    ask = {"prompt": "brokerage statements", "period_start": None, "period_end": None}
    assert client.post("/api/ask", json=ask).json()["ask_id"] == "ask-1-20"
    assert client.post("/api/ask", json=ask).status_code == 200
    assert built == [(OWNER, 6657, private_dir)]
    assert client.get("/api/presets").json() == []


def test_asks_saved_by_the_engine_itself_can_be_labeled(context, private_dir):
    folder = private_dir / "asks"
    folder.mkdir(mode=0o700)
    record = {
        "result": {
            "ask_id": "ask-20261016T000000Z-abcdef",
            "documents": [{"document_id": "d1", "selected": True}],
        }
    }
    (folder / "ask-20261016T000000Z-abcdef.json").write_text(json.dumps(record))
    client = client_for(context)
    label = {"document_id": "d1", "verdict": "right", "note": ""}
    assert client.post("/api/ask/ask-20261016T000000Z-abcdef/label", json=label).json() == {
        "saved": True
    }
    assert client.post("/api/ask/..%2Fescape/label", json=label).status_code == 404
    dry = client.get("/api/accuracy").json()["requests"]["by_source"]["dry_run"]
    assert dry["system_selected"] == 1 and dry["human"]["right_on_selected"] == 1


# --- Contract shapes -------------------------------------------------------------------
def test_engine_eval_and_accuracy_follow_the_contract(context):
    client = client_for(context)
    engine = client.get("/api/engine").json()
    assert {"deployed_revision", "deployed_sha", "engine_sha", "match", "checked_at"} <= set(engine)
    assert "live Stripe keys" in engine["notices"]["real_requests"]
    evals = client.get("/api/eval").json()
    [batch] = evals["batches"]
    assert {
        "batch_id",
        "code_sha",
        "founder_report_lines",
        "gates",
        "ready_wrong",
        "ready_total",
        "undecided",
        "human_checked",
    } <= set(batch)
    assert (batch["ready_wrong"], batch["ready_total"], batch["undecided"]) == (1, 2, 1)
    assert set(batch["gates"]) == {"listing", "ready", "deploy"}
    assert (
        batch["gates"]["listing"]["status"] == "fail"
        and batch["gates"]["deploy"]["status"] == "not_run"
    )
    assert evals["human_queue"] == {"wrong": 1, "undecided": 1, "high_risk": 3}
    accuracy = client.get("/api/accuracy").json()
    packets = accuracy["packets"]
    assert {key: packets["ai"][key] for key in ("correct", "wrong", "undecided", "n")} == {
        "correct": 1,
        "wrong": 1,
        "undecided": 1,
        "n": 3,
    }
    assert packets["bars"] == {"n95": 59, "n999": 2995}
    assert set(packets["agreement"]) >= {"both", "agree", "disagree", "disagreements"}
    assert set(accuracy["requests"]) >= {"system_selected", "human", "by_source"}
    assert set(accuracy["requests"]["by_source"]) == {"dry_run", "real"}
