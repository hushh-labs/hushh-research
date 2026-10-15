"""Preview the dashboard page on synthetic fixtures, with no UAT, Drive or model access.

    python tests/fixtures/drive_packet_eval/dashboard_ui/preview_server.py [--port 8766] [--engine-mismatch]

Binds 127.0.0.1 only. Serves ``hushh_eval/drive_packets/dashboard/static`` (the page at
``/``, its files under ``/static/``) and answers the dashboard API contract from the JSON
next to this file. POST bodies must match the contract exactly, keys and values, or the
answer is 422. A packet, request or ask that is not in the fixtures is 404, and so is a
label for a document that answer did not return. Labels stay in memory. A prompt that
contains "regression" answers with the 13 Oct mistake, "many files" answers with over a
thousand Drive rows, and "engine failure" answers 500, to preview how each looks.
"""

from __future__ import annotations

import argparse
import copy
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

HERE = Path(__file__).resolve().parent
STATIC = HERE.parents[3] / "hushh_eval" / "drive_packets" / "dashboard" / "static"
STATIC_TYPES = {
    "index.html": "text/html; charset=utf-8",
    "app.js": "text/javascript; charset=utf-8",
    "styles.css": "text/css; charset=utf-8",
}
PACKET_VERDICTS = {"correct", "wrong", "unsure"}
REQUEST_VERDICTS = {"right", "wrong", "unsure", "missed"}
WRONG_REASONS = {"wrong_period", "wrong_person", "duplicate", "overclaims_complete", "other"}
DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
GET_FIXTURES = {
    "/api/engine": "engine.json",
    "/api/owner": "owner.json",
    "/api/health": "health.json",
    "/api/packets": "packets.json",
    "/api/requests": "requests.json",
    "/api/presets": "presets.json",
    "/api/accuracy": "accuracy.json",
    "/api/eval": "eval.json",
}


class ContractError(ValueError):
    """A request body that the dashboard API contract does not allow."""


def _exact_keys(body: object, keys: set[str]) -> dict:
    if not isinstance(body, dict) or set(body) != keys:
        got = sorted(body) if isinstance(body, dict) else type(body).__name__
        raise ContractError(f"body keys must be exactly {sorted(keys)}, got {got}")
    return body


def _note(body: dict) -> None:
    if not isinstance(body["note"], str):
        raise ContractError("note must be a string")


def check_packet_label(body: object) -> None:
    body = _exact_keys(body, {"verdict", "reason", "note"})
    if body["verdict"] not in PACKET_VERDICTS:
        raise ContractError(f"verdict must be one of {sorted(PACKET_VERDICTS)}")
    if body["verdict"] == "wrong" and body["reason"] not in WRONG_REASONS:
        raise ContractError(f"a wrong verdict needs a reason from {sorted(WRONG_REASONS)}")
    if body["verdict"] != "wrong" and body["reason"] is not None:
        raise ContractError("only a wrong verdict carries a reason")
    _note(body)


def check_ask(body: object) -> None:
    body = _exact_keys(body, {"prompt", "period_start", "period_end"})
    if not isinstance(body["prompt"], str) or not body["prompt"].strip():
        raise ContractError("prompt must be a non-empty string")
    start, end = body["period_start"], body["period_end"]
    for value in (start, end):
        if value is not None and not (isinstance(value, str) and DAY.match(value)):
            raise ContractError("period_start and period_end must be YYYY-MM-DD or null")
    if (start is None) != (end is None):
        raise ContractError("send both dates or neither")
    if start and end and start > end:
        raise ContractError("period_start is after period_end")


def check_answer_label(body: object, document_ids: set[str]) -> None:
    body = _exact_keys(body, {"document_id", "verdict", "note"})
    if body["verdict"] not in REQUEST_VERDICTS:
        raise ContractError(f"verdict must be one of {sorted(REQUEST_VERDICTS)}")
    if body["document_id"] is not None and body["document_id"] not in document_ids:
        raise ContractError("document_id is not a document of this answer")
    _note(body)


def _load(name: str):
    return json.loads((HERE / name).read_text(encoding="utf-8"))


def _many_files(answer: dict) -> dict:
    """The same answer with 1,200 more dropped Drive rows and 150 more left-out documents."""
    rows = answer["drive_api"]["rows"]
    rows += [
        dict(
            rows[0],
            file_name=f"example-extra-{n:04d}.pdf",
            kept=False,
            drop_stage="kind",
            drop_reason="not_a_statement",
        )
        for n in range(1200)
    ]
    template = next(
        doc for doc in answer["documents"] if doc.get("document_id") and not doc["selected"]
    )
    answer["documents"] += [
        dict(
            template, document_id=f"doc-synthetic-x{n:04d}", file_name=f"example-extra-{n:04d}.pdf"
        )
        for n in range(150)
    ]
    return answer


def _document_ids(answer: dict) -> set[str]:
    documents = answer.get("documents")
    if not isinstance(documents, list):
        return set()
    return {
        doc["document_id"] for doc in documents if isinstance(doc, dict) and doc.get("document_id")
    }


class PreviewServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port: int = 0, *, engine_match: bool = True) -> None:
        super().__init__(("127.0.0.1", port), _Handler)
        self.fixtures = {path: _load(name) for path, name in GET_FIXTURES.items()}
        if not engine_match:
            engine = self.fixtures["/api/engine"]
            engine.update({"engine_sha": "ffffffffff" + engine["engine_sha"][10:], "match": False})
        self.packet_details = _load("packet_details.json")
        self.request_details = _load("request_details.json")
        self.ask_clean = _load("ask_response.json")
        self.ask_regression = _load("ask_response_regression.json")
        self.lock = threading.Lock()
        self.requests: list[tuple[str, str, object, int]] = []
        self.asks: dict[str, set[str]] = {}


class _Handler(BaseHTTPRequestHandler):
    server: PreviewServer

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - stdlib signature
        return

    def _send(self, status: int, payload: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def _json(
        self, status: int, value: object, method: str, path: str, body: object = None
    ) -> None:
        with self.server.lock:
            self.server.requests.append((method, path, body, status))
        self._send(status, json.dumps(value).encode("utf-8"), "application/json")

    def do_GET(self) -> None:  # noqa: N802 - stdlib name
        path = urlsplit(self.path).path
        name = (
            "index.html"
            if path == "/"
            else path.removeprefix("/static/")
            if path.startswith("/static/")
            else None
        )
        if name in STATIC_TYPES:
            self._send(200, (STATIC / name).read_bytes(), STATIC_TYPES[name])
            return
        if path in self.server.fixtures:
            self._json(200, self.server.fixtures[path], "GET", path)
            return
        for pattern, details in (
            (r"/api/packets/([^/]+)", self.server.packet_details),
            (r"/api/requests/([^/]+)", self.server.request_details),
        ):
            match = re.fullmatch(pattern, path)
            if match and unquote(match.group(1)) in details:
                self._json(200, details[unquote(match.group(1))], "GET", path)
                return
        self._json(404, {"detail": "Not found"}, "GET", path)

    def do_POST(self) -> None:  # noqa: N802 - stdlib name
        path = urlsplit(self.path).path
        try:
            body = json.loads(
                self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"null"
            )
        except ValueError:
            self._json(400, {"detail": "body is not JSON"}, "POST", path)
            return
        try:
            self._route_post(path, body)
        except ContractError as err:
            self._json(422, {"detail": str(err)}, "POST", path, body)

    def _route_post(self, path: str, body: object) -> None:
        if path == "/api/ask":
            check_ask(body)
            if "engine failure" in body["prompt"]:
                self._json(500, {"detail": "Synthetic engine failure"}, "POST", path, body)
                return
            answer = (
                self.server.ask_regression
                if "regression" in body["prompt"]
                else self.server.ask_clean
            )
            answer = copy.deepcopy(answer)
            if "many files" in body["prompt"]:
                answer = _many_files(answer)
            with self.server.lock:
                ask_id = f"ask-preview-{len(self.server.asks) + 1}"
                self.server.asks[ask_id] = _document_ids(answer)
            answer["ask_id"] = ask_id
            self._json(200, answer, "POST", path, body)
            return
        for pattern, known in (
            (r"/api/packets/([^/]+)/label", None),
            (r"/api/requests/([^/]+)/label", self.server.request_details),
            (r"/api/ask/([^/]+)/label", None),
        ):
            match = re.fullmatch(pattern, path)
            if not match:
                continue
            key = unquote(match.group(1))
            if pattern.startswith("/api/packets"):
                if key not in self.server.packet_details:
                    break
                check_packet_label(body)
            elif pattern.startswith("/api/requests"):
                if key not in known:
                    break
                check_answer_label(body, _document_ids(known[key]))
            else:
                with self.server.lock:
                    documents = self.server.asks.get(key)
                if documents is None:
                    break
                check_answer_label(body, documents)
            self._json(200, {"saved": True}, "POST", path, body)
            return
        self._json(404, {"detail": "Not found"}, "POST", path, body)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument(
        "--engine-mismatch", action="store_true", help="serve an engine that differs from UAT"
    )
    args = parser.parse_args(argv)
    server = PreviewServer(args.port, engine_match=not args.engine_mismatch)
    print(f"Synthetic preview on http://127.0.0.1:{server.server_address[1]}/ (Ctrl-C stops it)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
