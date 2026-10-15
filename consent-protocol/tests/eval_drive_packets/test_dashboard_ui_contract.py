"""The dashboard page speaks exactly the dashboard API contract, and only to its own server.

Static checks over ``hushh_eval/drive_packets/dashboard/static``, a round trip through the
synthetic preview server (``tests/fixtures/drive_packet_eval/dashboard_ui``), and, when
Node 18+ is installed, a click-through of the real page in a tiny fake DOM
(``dom_harness.js``): every verdict, Save, filter and link, with every body checked by the
preview server. No browser, no UAT, no network beyond 127.0.0.1, synthetic data only.

Negative controls: the off-machine checker flags a CDN script, a protocol-relative fetch
and HTML injection; the preview server refuses an off-contract body, a reason-less Wrong,
a label for a document the answer did not return, and another owner's packet.
"""

import importlib.util
import json
import re
import shutil
import socket
import subprocess
import threading
import urllib.error
import urllib.request
from datetime import date, timedelta
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
STATIC = ROOT / "hushh_eval" / "drive_packets" / "dashboard" / "static"
FIXTURES = ROOT / "tests" / "fixtures" / "drive_packet_eval" / "dashboard_ui"
PREVIEW = FIXTURES / "preview_server.py"
HARNESS = FIXTURES / "dom_harness.js"

CONTRACT = {
    ("GET", "/api/engine"): None,
    ("GET", "/api/owner"): None,
    ("GET", "/api/health"): None,
    ("GET", "/api/packets"): None,
    ("GET", "/api/packets/{packet_id}"): None,
    ("POST", "/api/packets/{packet_id}/label"): {"verdict", "reason", "note"},
    ("GET", "/api/requests"): None,
    ("GET", "/api/requests/{request_id}"): None,
    ("POST", "/api/requests/{request_id}/label"): {"document_id", "verdict", "note"},
    ("GET", "/api/presets"): None,
    ("POST", "/api/ask"): {"prompt", "period_start", "period_end"},
    ("POST", "/api/ask/{ask_id}/label"): {"document_id", "verdict", "note"},
    ("GET", "/api/accuracy"): None,
    ("GET", "/api/eval"): None,
}
PACKET_VERDICTS = ["correct", "wrong", "unsure"]
REQUEST_VERDICTS = ["right", "wrong", "unsure", "missed"]
WRONG_REASONS = ["wrong_period", "wrong_person", "duplicate", "overclaims_complete", "other"]
REQUEST_ROW = {
    "request_id",
    "created_at",
    "requester_display_name",
    "purpose_text",
    "period_start",
    "period_end",
    "status",
    "selected_count",
    "paid",
    "delivered",
    "human_label",
}
# The label endpoints key on document_id, so a document may carry it next to the contract keys.
DOCUMENT = {
    "file_name",
    "kind",
    "indexed_state",
    "extraction_state",
    "facts_state",
    "period_start",
    "period_end",
    "period_role",
    "evidence_quote",
    "page",
    "selected",
    "reason",
    "flags",
}
KEYS = {
    "engine": {"deployed_revision", "deployed_sha", "engine_sha", "match", "checked_at"},
    "owner": {"display_name", "files_found", "packets", "ready", "listed"},
    "health": {
        "as_of",
        "files_found",
        "extracted",
        "facts_complete",
        "facts_waiting",
        "failed_by_reason",
        "extracted_last_hour",
        "facts_last_hour",
        "packets_by_status",
    },
    "packet_row": {
        "packet_id",
        "version_id",
        "title",
        "status",
        "member_count",
        "period_label",
        "price_cents",
        "listed",
        "updated_at",
        "ai_verdict",
        "human_label",
    },
    "packet": {
        "packet_id",
        "version_id",
        "title",
        "status",
        "status_reason",
        "buyer_title",
        "buyer_summary",
        "price_cents",
        "listed",
        "members",
        "checks",
        "eval_verdicts",
        "human_label",
    },
    "member": {
        "document_id",
        "file_name",
        "kind",
        "pages",
        "period_start",
        "period_end",
        "period_role",
        "quotes",
        "issuer",
        "account_mask",
        "holder_name",
    },
    "check": {"name", "ok", "reason"},
    "eval_verdict": {"batch", "judge", "verdict", "severity"},
    "request_row": REQUEST_ROW,
    "request": REQUEST_ROW
    | {"plan", "drive_api", "steps", "documents", "owner_review", "payment", "delivery", "logs"},
    "payment": {"status", "amount_cents", "refunded"},
    "delivery": {"file_name", "outcome"},
    "preset": {"id", "label", "prompt", "period_start", "period_end", "as_of"},
    "ask": {
        "ask_id",
        "as_buyer",
        "owner",
        "engine",
        "understood",
        "drive_api",
        "steps",
        "documents",
        "owner_review",
        "buyer_checks",
        "matching_packets",
        "counts",
        "rejected_by_reason",
        "logs",
        "timings_ms",
        "model_calls",
        "est_cost_usd",
    },
    "ask_engine": {"entry_point", "engine_sha", "deployed_sha", "match", "dry_run"},
    "understood": {"summary", "kinds", "period_start", "period_end", "terms"},
    "drive_api": {"calls", "rows"},
    "call": {"q", "page", "rows", "ms"},
    "row": {
        "file_name",
        "mime",
        "modified_time",
        "created_time",
        "kept",
        "drop_stage",
        "drop_reason",
    },
    "step": {"name", "in", "kept", "dropped", "ms", "notes"},
    "owner_review": {"files", "coverage_text", "price_cents", "would_allow_now", "why_not"},
    "review_file": {"file_name", "period_start", "period_end"},
    "buyer_check": {"name", "status", "note"},
    "matching_packet": {
        "packet_id",
        "title",
        "status",
        "period_label",
        "member_count",
        "listed",
        "price_cents",
        "why_matched",
    },
    "counts": {"drive_rows", "candidates", "indexed", "period_proven", "selected", "not_indexed"},
    "log": {"t", "level", "logger", "msg"},
    "timings_ms": {"plan", "drive", "filter", "select", "total"},
    "accuracy": {"packets", "requests"},
    "accuracy_packets": {"ai", "human", "agreement", "bars"},
    "ai": {"correct", "wrong", "undecided", "n"},
    "human_packets": {"correct", "wrong", "unsure", "n"},
    "agreement": {"both", "agree", "disagree", "disagreements"},
    "disagreement": {"packet_id", "ai", "human"},
    "bars": {"n95", "n999"},
    "accuracy_requests": {"system_selected", "human", "by_source"},
    "human_requests": {"right", "wrong", "unsure", "missed", "n", "precision"},
    "eval": {"batches", "human_queue"},
    "batch": {
        "batch_id",
        "code_sha",
        "founder_report_lines",
        "gates",
        "ready_wrong",
        "ready_total",
        "undecided",
        "human_checked",
    },
    "gates": {"listing", "ready", "deploy"},
    "human_queue": {"wrong", "undecided", "high_risk"},
}
STRIPE_BANNER = (
    "UAT checkout uses live Stripe keys: a real request you pay for in the app charges real money."
)

_CALL = re.compile(r"request\('(GET|POST)', [`']([^`']+)[`'](?:, \{ ([^}]*) \})?\)")
_OFF_MACHINE = (
    r"https?://",
    r"(?<![\w:])//[\w-]+(\.[\w-]+)+",
    r"@import",
    r"url\(\s*(?!['\"]?data:)",
    r"\bWebSocket\b",
    r"\bEventSource\b",
    r"sendBeacon",
    r"XMLHttpRequest",
    r"\.(inner|outer)HTML\b",
    r"insertAdjacentHTML",
    r"document\.write",
    r"\beval\(",
    r"\bnew Function\b",
)


def _snake(name: str) -> str:
    return re.sub(r"(?<!^)([A-Z])", r"_\1", name).lower()


def _js() -> str:
    return (STATIC / "app.js").read_text(encoding="utf-8")


def api_calls(js: str) -> dict:
    """(method, path template) -> POST body keys, read from the page's single API table."""
    calls = {}
    for method, path, body in _CALL.findall(js):
        template = re.sub(r"\$\{enc\((\w+)\)\}", lambda m: "{" + _snake(m.group(1)) + "}", path)
        calls[(method, template)] = {key.strip() for key in body.split(",")} if body else None
    return calls


def js_array(js: str, name: str) -> list[str]:
    match = re.search(rf"const {name} = \[([^\]]*)\];", js)
    assert match, name
    return re.findall(r"'([^']*)'", match.group(1))


def off_machine(text: str) -> list[str]:
    return [pattern for pattern in _OFF_MACHINE if re.search(pattern, text)]


def route_of(method: str, path: str) -> tuple[str, str] | None:
    for key in CONTRACT:
        pattern = "^" + re.sub(r"\{\w+\}", "[^/]+", key[1]) + "$"
        if key[0] == method and re.match(pattern, path):
            return key
    return None


def test_page_calls_exactly_the_contract_and_posts_only_contract_values():
    js = _js()
    assert api_calls(js) == CONTRACT
    assert js.count("fetch(") == 1, "every request must go through the one request helper"
    table = js[
        js.index("const API = Object.freeze({") : js.index(
            "});", js.index("const API = Object.freeze({")
        )
    ]
    defined = set(re.findall(r"^\s+(\w+): \(", table, re.MULTILINE))
    used = set(re.findall(r"\bAPI\.(\w+)\(", js))
    assert used == defined, "every endpoint is wired to the page and nothing else is called"
    assert js_array(js, "PACKET_VERDICT_VALUES") == PACKET_VERDICTS
    assert js_array(js, "REQUEST_VERDICT_VALUES") == REQUEST_VERDICTS
    assert js_array(js, "WRONG_REASON_VALUES") == WRONG_REASONS
    assert set(js_array(js, "PICKED_VERDICTS")) <= set(REQUEST_VERDICTS)
    assert set(js_array(js, "LEFT_OUT_VERDICTS")) <= set(REQUEST_VERDICTS)


def test_every_element_the_script_looks_up_is_in_the_page():
    js = _js()
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    wanted = set(re.findall(r"\$\('([\w-]+)'\)", js))
    wanted |= {f"view-{name}" for name in js_array(js, "VIEWS")}
    wanted |= {f"tab-{name}" for name in js_array(js, "TABS")}
    assert wanted and wanted <= set(re.findall(r'\bid="([^"]+)"', html))
    assert "<title>Manish's Drive check</title>" in html


def test_page_never_reaches_off_this_machine():
    for name in ("index.html", "app.js", "styles.css"):
        assert off_machine((STATIC / name).read_text(encoding="utf-8")) == [], name
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    csp = re.search(r'http-equiv="Content-Security-Policy" content="([^"]+)"', html).group(1)
    for directive in (
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "connect-src 'self'",
    ):
        assert directive in csp
    refs = re.findall(r'\b(?:src|href)="([^"]+)"', html)
    assert refs and all(ref.startswith(("/static/", "#/", "data:")) for ref in refs), refs
    assert "'style'" not in _js(), "inline style attributes are blocked by the CSP"
    assert off_machine('<script src="https://cdn.example.com/x.js"></script>')
    assert off_machine("fetch('//collector.example.com/x', { method: 'POST' })")
    assert off_machine("row.innerHTML = file.name")


def _load_preview():
    spec = importlib.util.spec_from_file_location("dashboard_ui_preview_server", PREVIEW)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _serve(engine_match: bool = True):
    server = _load_preview().PreviewServer(0, engine_match=engine_match)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


@pytest.fixture
def preview():
    server = _serve()
    yield server, f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()


def _call(url: str, body: object = None) -> tuple[int, object]:
    assert url.startswith("http://127.0.0.1:")
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})  # noqa: S310
    try:
        with urllib.request.urlopen(req, timeout=10) as res:  # noqa: S310 - 127.0.0.1 only
            return res.status, json.loads(res.read() or b"null")
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b"null")


def _keys(value: dict, name: str) -> None:
    assert set(value) == KEYS[name], (name, sorted(set(value) ^ KEYS[name]))


def _answer_parts(answer: dict) -> None:
    """The parts a dry run and a real request share, each either its contract shape or "not recorded"."""
    if answer.get("drive_api") != "not recorded":
        _keys(answer["drive_api"], "drive_api")
        for call in answer["drive_api"]["calls"]:
            _keys(call, "call")
        for row in answer["drive_api"]["rows"]:
            _keys(row, "row")
    if answer.get("steps") != "not recorded":
        for step in answer["steps"]:
            _keys(step, "step")
    if answer.get("documents") != "not recorded":
        for doc in answer["documents"]:
            assert DOCUMENT <= set(doc) and set(doc) - DOCUMENT <= {"document_id"}, sorted(doc)
    if answer.get("logs") != "not recorded":
        for line in answer["logs"]:
            _keys(line, "log")


def test_synthetic_preview_answers_the_contract_and_refuses_anything_else(preview):
    _, base = preview
    _keys(_call(f"{base}/api/engine")[1], "engine")
    _keys(_call(f"{base}/api/owner")[1], "owner")
    _keys(_call(f"{base}/api/health")[1], "health")
    presets = _call(f"{base}/api/presets")[1]
    assert presets and all(set(p) == KEYS["preset"] for p in presets)

    packets = _call(f"{base}/api/packets")[1]
    assert packets
    for row in packets:
        _keys(row, "packet_row")
        status, detail = _call(f"{base}/api/packets/{row['packet_id']}")
        assert status == 200
        _keys(detail, "packet")
        assert len(detail["members"]) == row["member_count"]
        for member in detail["members"]:
            _keys(member, "member")
        for check in detail["checks"]:
            _keys(check, "check")
        for verdict in detail["eval_verdicts"]:
            _keys(verdict, "eval_verdict")

    requests = _call(f"{base}/api/requests")[1]
    assert requests
    for row in requests:
        _keys(row, "request_row")
        status, detail = _call(f"{base}/api/requests/{row['request_id']}")
        assert status == 200
        _keys(detail, "request")
        # The header repeats the list row. A saved label may be one verdict or
        # {overall, documents}; the fixtures use both shapes, so it is left out here.
        header = REQUEST_ROW - {"human_label"}
        assert {key: detail[key] for key in header} == {key: row[key] for key in header}
        _answer_parts(detail)
        if detail["payment"] != "not recorded":
            _keys(detail["payment"], "payment")
        for item in detail["delivery"]:
            _keys(item, "delivery")
            assert item["outcome"] in {"shared", "already_had_access", "failed"}

    status, ask = _call(
        f"{base}/api/ask", {"prompt": "six months", "period_start": None, "period_end": None}
    )
    assert status == 200
    _keys(ask, "ask")
    for part in ("understood", "counts", "timings_ms", "owner_review"):
        _keys(ask[part], part)
    _keys(ask["engine"], "ask_engine")
    assert ask["engine"]["dry_run"] is True and ask["as_buyer"] == "Chris (simulated)"
    _answer_parts(ask)
    for item in ask["owner_review"]["files"]:
        _keys(item, "review_file")
    for check in ask["buyer_checks"]:
        _keys(check, "buyer_check")
    for packet in ask["matching_packets"]:
        _keys(packet, "matching_packet")

    accuracy = _call(f"{base}/api/accuracy")[1]
    _keys(accuracy, "accuracy")
    _keys(accuracy["packets"], "accuracy_packets")
    _keys(accuracy["packets"]["ai"], "ai")
    _keys(accuracy["packets"]["human"], "human_packets")
    _keys(accuracy["packets"]["agreement"], "agreement")
    for item in accuracy["packets"]["agreement"]["disagreements"]:
        _keys(item, "disagreement")
    assert accuracy["packets"]["bars"] == {"n95": 59, "n999": 2995}
    _keys(accuracy["requests"], "accuracy_requests")
    _keys(accuracy["requests"]["human"], "human_requests")
    assert set(accuracy["requests"]["by_source"]) == {"dry_run", "real"}
    evals = _call(f"{base}/api/eval")[1]
    _keys(evals, "eval")
    _keys(evals["human_queue"], "human_queue")
    for batch in evals["batches"]:
        _keys(batch, "batch")
        _keys(batch["gates"], "gates")

    document = next(d["document_id"] for d in ask["documents"] if d.get("document_id"))
    ask_label = f"{base}/api/ask/{ask['ask_id']}/label"
    assert _call(ask_label, {"document_id": None, "verdict": "missed", "note": "x"}) == (
        200,
        {"saved": True},
    )
    assert _call(ask_label, {"document_id": document, "verdict": "right", "note": ""}) == (
        200,
        {"saved": True},
    )
    assert (
        _call(ask_label, {"document_id": "doc-not-in-answer", "verdict": "right", "note": ""})[0]
        == 422
    )
    assert _call(ask_label, {"verdict": "right", "note": ""})[0] == 422
    request_label = f"{base}/api/requests/{requests[0]['request_id']}/label"
    assert _call(request_label, {"document_id": None, "verdict": "wrong", "note": ""}) == (
        200,
        {"saved": True},
    )
    assert _call(request_label, {"document_id": None, "verdict": "correct", "note": ""})[0] == 422
    packet_label = f"{base}/api/packets/{packets[0]['packet_id']}/label"
    wrong = {"verdict": "wrong", "reason": "wrong_period", "note": "2014 history"}
    assert _call(packet_label, wrong) == (200, {"saved": True})
    assert _call(packet_label, {"verdict": "wrong", "reason": None, "note": ""})[0] == 422
    assert _call(packet_label, {"verdict": "correct", "reason": "duplicate", "note": ""})[0] == 422

    assert _call(f"{base}/api/packets/not-this-owners")[0] == 404
    assert _call(f"{base}/api/packets/not-this-owners/label", wrong)[0] == 404
    assert _call(f"{base}/api/requests/not-to-this-owner")[0] == 404
    assert (
        _call(
            f"{base}/api/ask/never-asked/label",
            {"document_id": None, "verdict": "right", "note": ""},
        )[0]
        == 404
    )
    extra = {"prompt": "x", "period_start": None, "period_end": None, "as_of": "2026-10-13"}
    assert _call(f"{base}/api/ask", extra)[0] == 422
    one_date = {"prompt": "x", "period_start": "2026-01-01", "period_end": None}
    assert _call(f"{base}/api/ask", one_date)[0] == 422


NODE = shutil.which("node")


def _node_major() -> int:
    if not NODE:
        return 0
    out = subprocess.run(  # noqa: S603 - the installed node, fixed arguments
        [NODE, "--version"], capture_output=True, text=True, timeout=20, check=False
    )
    match = re.match(r"v(\d+)\.", out.stdout.strip())
    return int(match.group(1)) if match else 0


needs_node = pytest.mark.skipif(
    _node_major() < 18, reason="the click-through needs Node 18+ (fetch)"
)


def _drive_page(base: str, scenario: str) -> dict:
    out = subprocess.run(  # noqa: S603 - fixed in-repo script, 127.0.0.1 only
        [NODE, str(HARNESS), str(STATIC), base, scenario],
        capture_output=True,
        text=True,
        timeout=240,
        check=False,
    )
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def _months_back(today: date, months: int) -> date:
    year, month = divmod(today.year * 12 + today.month - 1 - months, 12)
    month += 1
    last = (date(year + month // 12, month % 12 + 1, 1) - timedelta(days=1)).day
    return date(year, month, min(today.day, last))


@needs_node
def test_clicking_every_button_posts_only_contract_bodies(preview):
    server, base = preview
    report = _drive_page(base, "full")
    texts = report["texts"]
    assert report["errors"] == []

    # Every call the page made is a contract route, and the server accepted every body.
    routes = [route_of(call["method"], call["path"]) for call in report["calls"]]
    assert None not in routes, [
        c for c, r in zip(report["calls"], routes, strict=True) if r is None
    ]
    assert set(routes) == set(CONTRACT), sorted(set(CONTRACT) - set(routes))
    for call, key in zip(report["calls"], routes, strict=True):
        if CONTRACT[key] is not None:
            assert set(call["body"]) == CONTRACT[key], call
    deliberate_404 = (
        "/api/packets/not-a-synthetic-packet",
        "/api/requests/not-a-synthetic-request",
    )
    statuses = [
        (m, p, s)
        for m, p, body, s in server.requests
        if p not in deliberate_404
        and not (isinstance(body, dict) and body.get("prompt") == "engine failure")
    ]
    assert statuses and all(s == 200 for _, _, s in statuses), [x for x in statuses if x[2] != 200]

    def verdicts(template: str, whole: bool | None = None) -> set:
        return {
            call["body"]["verdict"]
            for call, key in zip(report["calls"], routes, strict=True)
            if key == ("POST", template)
            and (whole is None or (call["body"].get("document_id") is None) == whole)
        }

    for template in ("/api/ask/{ask_id}/label", "/api/requests/{request_id}/label"):
        assert verdicts(template, whole=True) == set(REQUEST_VERDICTS), template
        assert verdicts(template, whole=False) == set(REQUEST_VERDICTS), template
    packet_label = ("POST", "/api/packets/{packet_id}/label")
    packet_posts = [
        c["body"] for c, k in zip(report["calls"], routes, strict=True) if k == packet_label
    ]
    assert {b["verdict"] for b in packet_posts} == set(PACKET_VERDICTS)
    assert all((b["reason"] in WRONG_REASONS) == (b["verdict"] == "wrong") for b in packet_posts)
    assert all(value is True for key, value in texts.items() if key.endswith("WrongNeedsReason"))

    # What the founder reads.
    assert texts["engine"].startswith(
        "Testing deployed UAT: consent-protocol-00042-syn @ 0123456789"
    )
    assert "engine-ok" in texts["engineClass"]
    assert texts["title"] == "Request · Manish's Drive check"
    today = date.today()
    yesterday = (today - timedelta(days=1)).isoformat()
    assert texts["range6"] == [_months_back(today, 6).isoformat(), yesterday]
    assert texts["range8"] == [_months_back(today, 8).isoformat(), yesterday]
    numbered = [
        "1What Agent One understood",
        "2Google Drive search",
        "3Funnel",
        "4Documents",
        "5What Manish would approve",
        "6Packets Chris could buy instead",
        "7Buyer checks",
        "8Logs",
    ]
    assert [s[: len(n)] for s, n in zip(texts["askSections"], numbered, strict=True)] == numbered
    assert texts["askSummary"] == (
        "Understood: bank, brokerage and card statements, Apr 16 – Oct 15, 2026 · 12 Drive rows · "
        "4 matched · 3 left out · 2 not indexed yet · 2.5 s · $0.0021"
    )
    assert "Chris (simulated) asked" in texts["askMeta"] and "dry run" in texts["askMeta"]
    assert "Google Drive API: 3 searches, 12 files returned." in texts["askLead"][1]
    assert (texts["driveRowsAll"], texts["driveRowsDropped"], texts["driveRowsOneReason"]) == (
        12,
        3,
        1,
    )
    assert texts["askAudit"].startswith("No sign of the 13 Oct mistake")
    assert [shown for shown, _ in texts["many"]] == [100, 200, 1212]
    assert texts["many"][0][1].startswith("Showing 100 of 1,212")
    assert texts["manyDocs"] == [106, 159]
    assert texts["failure"] == "The request failed: Synthetic engine failureRetry"
    assert texts["sendAfterFailure"] == "Send"
    clean, replay, regression = texts["replayAudits"]
    assert clean["audit"].startswith("No sign") and replay["audit"].startswith("No sign")
    assert regression["audit"] == "The 13 Oct mistake shows up here3 of 4 checks failed"
    assert "example-brokerage-account-history.pdf" in regression["failed"]
    assert texts["askMissedNote"].startswith("Missed: ")
    assert texts["emptyPromptError"] and texts["oneDateError"] and texts["reversedError"]

    assert texts["realBanner"] == STRIPE_BANNER
    assert len(texts["real"]) == 2
    real_numbered = [
        "1What Agent One understood",
        "2Google Drive search",
        "3Steps",
        "4Documents",
        "5What Manish saw",
        "6Payment",
        "7Delivery",
        "8Logs",
    ]
    for detail in texts["real"].values():
        assert detail["banner"] == STRIPE_BANNER
        assert [
            s[: len(n)] for s, n in zip(detail["sections"], real_numbered, strict=True)
        ] == real_numbered
    assert (
        "Not recorded by the deployed backend."
        in texts["real"]["#/real/req-synthetic-0001"]["text"]
    )
    assert "already open to Test Buyer" in texts["real"]["#/real/req-synthetic-0002"]["text"]

    assert texts["packetFilters"] == {
        "To check": 2,
        "Checked": 2,
        "You and AI disagree": 1,
        "All": 4,
    }
    assert [b[:8] for b in texts["bigNumbers"]] == ["AI says9", "You foun", "AI says7", "You foun"]
    assert "n = 61" in texts["bigNumbers"][0] and "n = 15" in texts["bigNumbers"][1]
    assert "0 wrong of 59" in texts["accuracy"] and "0 wrong of 2,995" in texts["accuracy"]
    assert texts["backFromAccuracy"] == "← Accuracy"
    assert "Files read" in texts["health"] and "Failed by reason" in texts["health"]
    assert texts["evalLinks"] == ["#/packets/pkt-synthetic-0002", "#/packets/pkt-synthetic-0003"]
    assert "Not found" in texts["unknownPacket"] and "Not found" in texts["unknownRequest"]
    assert texts["theme"] == ["light", "Theme: Light"]


@needs_node
def test_a_local_engine_that_is_not_the_deployed_code_turns_the_strip_red():
    server = _serve(engine_match=False)
    try:
        report = _drive_page(f"http://127.0.0.1:{server.server_address[1]}", "engine")
    finally:
        server.shutdown()
        server.server_close()
    assert report["errors"] == []
    assert "engine-bad" in report["texts"]["engineClass"]
    assert "not the deployed code" in report["texts"]["engine"]


@needs_node
def test_when_the_engine_cannot_be_read_the_strip_is_red_not_green():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    report = _drive_page(f"http://127.0.0.1:{port}", "engine")
    assert "engine-bad" in report["texts"]["engineClass"]
    assert report["texts"]["engine"].startswith("Testing deployed UAT: not confirmed")
