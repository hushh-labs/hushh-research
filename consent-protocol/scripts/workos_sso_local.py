"""Local helper for a WorkOS enterprise SSO sandbox run.

Sends a correctly signed ``dsync.user.*`` event to a running backend, to exercise
deprovisioning without a real directory. Developer tooling only: it reads
``WORKOS_WEBHOOK_SECRET`` from the environment or ``consent-protocol/.env``, never
prints it, and only talks to the URL you give it.

  python scripts/workos_sso_local.py webhook --org org_01XXXX --email test@example.com

The person must already have signed in through SSO, and ``--org`` must be the
WorkOS organization they signed in through; anyone else is left untouched.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import sys
import time
import uuid
from pathlib import Path

import requests
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

load_dotenv(PROJECT_ROOT / ".env")

DEFAULT_WEBHOOK_URL = "http://127.0.0.1:8000/api/webhooks/workos"


def _webhook_secret() -> str:
    secret = str(os.getenv("WORKOS_WEBHOOK_SECRET") or "").strip()
    if not secret:
        raise SystemExit("error: WORKOS_WEBHOOK_SECRET is not set (env or consent-protocol/.env)")
    return secret


def build_signed_event(
    secret: str, *, event: str, org: str, email: str, state: str, directory_user_id: str
) -> tuple[bytes, str]:
    body = json.dumps(
        {
            "id": f"event_local_{uuid.uuid4().hex[:20]}",
            "event": event,
            "data": {
                "id": directory_user_id,
                "organization_id": org,
                "email": email,
                "state": state,
            },
        },
        separators=(",", ":"),
    ).encode()
    issued = str(int(time.time() * 1000))
    digest = hmac.new(secret.encode(), issued.encode() + b"." + body, hashlib.sha256).hexdigest()
    return body, f"t={issued}, v1={digest}"


def webhook(args: argparse.Namespace) -> int:
    body, signature = build_signed_event(
        _webhook_secret(),
        event=args.event,
        org=args.org,
        email=args.email.strip().lower(),
        state=args.state,
        directory_user_id=args.directory_user_id,
    )
    print(f"POST {args.url} event={args.event} org={args.org} email={args.email}")
    response = requests.post(
        args.url,
        data=body,
        headers={"Content-Type": "application/json", "WorkOS-Signature": signature},
        timeout=30,
    )
    print(f"-> {response.status_code} {response.text[:300]}")
    return 0 if response.ok else 1


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    commands = parser.add_subparsers(dest="command", required=True)

    hook_parser = commands.add_parser("webhook", help="send a signed dsync.user.* event")
    hook_parser.add_argument("--url", default=DEFAULT_WEBHOOK_URL)
    hook_parser.add_argument("--org", required=True, help="WorkOS organization id")
    hook_parser.add_argument("--email", required=True)
    hook_parser.add_argument("--event", default="dsync.user.deleted")
    hook_parser.add_argument("--state", default="inactive")
    hook_parser.add_argument("--directory-user-id", default="directory_user_local")
    hook_parser.set_defaults(run=webhook)

    args = parser.parse_args()
    return args.run(args)


if __name__ == "__main__":
    raise SystemExit(main())
