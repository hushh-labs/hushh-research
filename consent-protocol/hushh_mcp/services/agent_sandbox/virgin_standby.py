# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Non-root virgin warm-pool standby HTTP readiness daemon (#9744)."""

from __future__ import annotations

import json
import os
import signal
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


def build_readiness_payload(*, uid: int | None = None) -> dict[str, Any]:
    """Return virgin warm-pool readiness telemetry after verifying non-root UID."""
    effective_uid = os.getuid() if uid is None else int(uid)
    effective_euid = os.geteuid() if uid is None else int(uid)
    if effective_uid == 0 or effective_euid == 0:
        raise PermissionError("VIRGIN_STANDBY_ROOT_FORBIDDEN: sandbox process cannot run as root")
    return {
        "status": "virgin_ready",
        "uid": effective_uid,
        "profile": str(os.environ.get("HUSSH_SANDBOX_PROFILE") or "virgin_pool_v1"),
    }


class _StandbyHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path not in {"/healthz", "/readyz", "/"}:
            self.send_response(404)
            self.end_headers()
            return
        body = json.dumps(build_readiness_payload(), separators=(",", ":")).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        # Suppress default stderr access logging to avoid noisy idle warm-pool logs.
        return None


def main() -> int:
    payload = build_readiness_payload()
    raw_port = int(os.environ.get("PORT", "8080"))
    if not 1 <= raw_port <= 65535:
        raise ValueError("PORT must be between 1 and 65535")
    bind_host = str(os.environ.get("VIRGIN_STANDBY_BIND_HOST") or "")
    server = ThreadingHTTPServer((bind_host, raw_port), _StandbyHandler)

    def _handle_signal(_signum: int, _frame: Any) -> None:
        server.shutdown()

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)
    sys.stdout.write(json.dumps({"event": "virgin_standby_started", **payload}) + "\n")
    sys.stdout.flush()
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
