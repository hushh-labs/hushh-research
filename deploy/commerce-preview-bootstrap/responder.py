# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Inert, IAM-private service until the first verified application release."""

import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class ProvisioningHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        payload = b'{"status":"provisioning"}'
        self.send_response(503)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_HEAD(self):
        self.send_response(503)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def log_message(self, *_):
        pass

    do_POST = do_GET
    do_PUT = do_GET
    do_PATCH = do_GET
    do_DELETE = do_GET
    do_OPTIONS = do_GET


if __name__ == "__main__":
    # Cloud Run supplies ingress; the service's IAM check remains enabled.
    ThreadingHTTPServer(
        ("0.0.0.0", int(os.environ.get("PORT", "8080"))), ProvisioningHandler  # noqa: S104 - Cloud Run ingress.
    ).serve_forever()
