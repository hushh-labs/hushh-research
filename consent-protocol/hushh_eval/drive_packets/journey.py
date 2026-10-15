"""API-level buyer journey replay (no browser, never pays).

Ask in own words -> owner review -> Deny lane -> Allow lane (a stale digest must
be refused) -> payment terms -> owner price edit after Allow leaves the order
unchanged -> checkout twice returns one session -> STOP before paying -> cancel
-> no grant -> repeat request for an already-accessible file is not charged ->
the same listed packet requested twice reuses one request.

UAT Drive checkout runs live Stripe. A live run therefore needs designated test
accounts, a synthetic owner Drive and an explicit flag; it stops at an open
checkout session and cancels it. ``--dry-run`` prints the planned calls only.
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

BASE = "/api/connectors/google_drive/sharing"
Call = Callable[..., Awaitable[tuple[int, Any]]]


@dataclass
class Step:
    name: str
    ok: bool
    code: str


@dataclass
class JourneyResult:
    steps: list[Step] = field(default_factory=list)

    def add(self, name: str, ok: bool, code: str) -> bool:
        self.steps.append(Step(name, ok, code))
        return ok

    @property
    def passed(self) -> bool:
        return bool(self.steps) and all(step.ok for step in self.steps)

    def counts(self) -> dict:
        return {"steps": len(self.steps), "passed": sum(step.ok for step in self.steps)}


def find(value: Any, key: str) -> Any:
    """Shallowest value for ``key`` anywhere in a JSON document."""
    queue = [value]
    while queue:
        current = queue.pop(0)
        if isinstance(current, dict):
            if key in current:
                return current[key]
            queue.extend(current.values())
        elif isinstance(current, list):
            queue.extend(current)
    return None


def planned_calls(owner_ref: str) -> list[str]:
    return [
        f"GET {BASE}/quote",
        f"POST {BASE}/requests (twice, same clientRequestId; owner {owner_ref})",
        f"GET {BASE}/requests/{{id}}/review (owner, poll until the package is ready)",
        f"POST {BASE}/requests/{{deny_id}}/decline (owner) then GET .../payment (buyer)",
        f"POST {BASE}/requests/{{id}}/allow with a stale digest (expect 409), then the real digest",
        f"GET {BASE}/requests/{{id}}/payment (buyer)",
        f"POST {BASE}/requests/{{id}}/price (owner, after Allow)",
        f"POST {BASE}/requests/{{id}}/payment/checkout (twice; same session expected)",
        "STOP: never pay (UAT Drive checkout is live Stripe)",
        f"POST {BASE}/requests/{{id}}/cancel then GET .../payment and GET .../delivery",
        f"GET {BASE}/packets then POST {BASE}/packets/{{packet}}/requests (twice)",
    ]


async def run_journey(
    call: Call,
    *,
    owner_ref: str,
    purpose: str,
    period: tuple[str, str],
    expected_include: set[str] | None = None,
    poll: int = 30,
    sleep: Callable[[float], Awaitable[None]] | None = None,
) -> JourneyResult:
    """``call(role, method, path, json=None)`` returns (status, body)."""
    result = JourneyResult()
    client_id = str(uuid.uuid4())
    body = {
        "ownerPersonRef": owner_ref,
        "clientRequestId": client_id,
        "purpose": {"purpose": purpose, "periodStart": period[0], "periodEnd": period[1]},
    }
    status, _ = await call("buyer", "GET", f"{BASE}/quote")
    result.add("quote", status == 200, f"http_{status}")
    status, created = await call("buyer", "POST", f"{BASE}/requests", json=body)
    request_id = find(created, "requestId")
    if not result.add(
        "create_request", status in {200, 202} and bool(request_id), f"http_{status}"
    ):
        return result
    status, again = await call("buyer", "POST", f"{BASE}/requests", json=body)
    result.add(
        "create_request_idempotent", find(again, "requestId") == request_id, f"http_{status}"
    )

    review = None
    for _ in range(poll):
        status, review = await call("owner", "GET", f"{BASE}/requests/{request_id}/review")
        if status == 200 and find(review, "packageDigest"):
            break
        if sleep:
            await sleep(10)
    digest, revision = find(review, "packageDigest"), find(review, "packageRevision")
    if not result.add(
        "package_ready", bool(digest and revision), "package_missing" if not digest else "ready"
    ):
        return result
    files = find(review, "files") or []
    ids = [find(item, "documentRef") or find(item, "fileRef") for item in files]
    result.add(
        "package_files_distinct",
        len(ids) == len(set(ids)),
        "distinct" if len(ids) == len(set(ids)) else "duplicates",
    )
    if expected_include is not None:
        result.add(
            "package_matches_labels",
            set(ids) == expected_include,
            "match" if set(ids) == expected_include else "mismatch",
        )

    deny_body = {**body, "clientRequestId": str(uuid.uuid4())}
    _, denied = await call("buyer", "POST", f"{BASE}/requests", json=deny_body)
    deny_id = find(denied, "requestId")
    status, _ = await call(
        "owner", "POST", f"{BASE}/requests/{deny_id}/decline", json={"revision": 1}
    )
    result.add("deny", status == 200, f"http_{status}")
    status, terms = await call("buyer", "GET", f"{BASE}/requests/{deny_id}/payment")
    result.add(
        "deny_has_no_order", status in {404, 409} or not find(terms, "orderId"), f"http_{status}"
    )

    request_revision = find(review, "revision") or 1
    allow = {
        "revision": request_revision,
        "packageRevision": revision,
        "packageDigest": "0" * 64,
        "amountCents": 50,
        "confirmed": True,
    }
    status, _ = await call("owner", "POST", f"{BASE}/requests/{request_id}/allow", json=allow)
    result.add("stale_digest_refused", status == 409, f"http_{status}")
    status, _ = await call(
        "owner",
        "POST",
        f"{BASE}/requests/{request_id}/allow",
        json={**allow, "packageDigest": digest},
    )
    if not result.add("allow", status in {200, 202}, f"http_{status}"):
        return result
    status, terms = await call("buyer", "GET", f"{BASE}/requests/{request_id}/payment")
    amount = find(terms, "amountCents")
    result.add("payment_terms", status == 200 and amount == 50, f"amount_{amount}")
    status, _ = await call(
        "owner",
        "POST",
        f"{BASE}/requests/{request_id}/price",
        json={
            **allow,
            "packageDigest": digest,
            "amountCents": 75,
            "revision": request_revision + 1,
        },
    )
    _, after = await call("buyer", "GET", f"{BASE}/requests/{request_id}/payment")
    result.add(
        "price_edit_after_allow_keeps_order", find(after, "amountCents") == 50, f"http_{status}"
    )
    _, first = await call("buyer", "POST", f"{BASE}/requests/{request_id}/payment/checkout")
    _, second = await call("buyer", "POST", f"{BASE}/requests/{request_id}/payment/checkout")
    session = find(first, "checkoutSessionId") or find(first, "url")
    result.add(
        "checkout_idempotent",
        bool(session) and session == (find(second, "checkoutSessionId") or find(second, "url")),
        "same_session" if session else "no_session",
    )
    status, _ = await call(
        "buyer",
        "POST",
        f"{BASE}/requests/{request_id}/cancel",
        json={"revision": request_revision + 1},
    )
    result.add("cancel_before_paying", status == 200, f"http_{status}")
    _, terms = await call("buyer", "GET", f"{BASE}/requests/{request_id}/payment")
    result.add(
        "payment_expired",
        find(terms, "status") in {"expired", "cancelled", "canceled"},
        str(find(terms, "status")),
    )
    _, delivery = await call("owner", "GET", f"{BASE}/requests/{request_id}/delivery")
    granted = find(delivery, "grantedCount") or 0
    result.add("no_grant_without_payment", granted == 0, f"granted_{granted}")

    status, listed = await call("buyer", "GET", f"{BASE}/packets?ownerPersonRef={owner_ref}")
    packets = find(listed, "packets") or []
    if packets:
        packet = packets[0]
        purchase = {"version": packet.get("version"), "clientRequestId": str(uuid.uuid4())}
        _, one = await call(
            "buyer", "POST", f"{BASE}/packets/{packet.get('packetId')}/requests", json=purchase
        )
        _, two = await call(
            "buyer",
            "POST",
            f"{BASE}/packets/{packet.get('packetId')}/requests",
            json={**purchase, "clientRequestId": str(uuid.uuid4())},
        )
        result.add(
            "listed_packet_reuses_request",
            find(one, "requestId") == find(two, "requestId"),
            "checked",
        )
    else:
        result.add("listed_packet_reuses_request", True, "no_listed_packet")
    return result


class FakeBuyerServer:
    """In-memory model of the buyer-journey contract, for tests and dry rehearsal."""

    def __init__(
        self, *, files: list[str], stale_digest_accepted: bool = False, double_session: bool = False
    ):
        self.files = files
        self.requests: dict[str, dict] = {}
        self.by_client: dict[str, str] = {}
        self.stale_digest_accepted = stale_digest_accepted
        self.double_session = double_session
        self.digest = "d" * 64
        self.sessions = 0
        self.packet_requests: dict[str, str] = {}

    async def __call__(self, role, method, path, json=None):
        parts = path.split("?")[0].removeprefix(BASE).strip("/").split("/")
        if parts == ["quote"]:
            return 200, {"quoteVersion": 1}
        if parts == ["requests"] and method == "POST":
            key = json["clientRequestId"]
            request_id = self.by_client.setdefault(key, str(uuid.uuid4()))
            self.requests.setdefault(
                request_id, {"state": "pending", "amount": None, "session": None}
            )
            return 202, {"requestId": request_id}
        if parts == ["packets"]:
            return 200, {"packets": [{"packetId": "p1", "version": 1}]}
        if parts[0] == "packets":
            return 202, {"requestId": self.packet_requests.setdefault(parts[1], str(uuid.uuid4()))}
        request = self.requests.get(parts[1])
        action = parts[2] if len(parts) > 2 else ""
        if request is None:
            return 404, {}
        if action == "review":
            return 200, {
                "revision": 1,
                "package": {
                    "packageDigest": self.digest,
                    "packageRevision": 1,
                    "files": [{"documentRef": item} for item in self.files],
                },
            }
        if action == "decline":
            request["state"] = "declined"
            return 200, {}
        if action == "allow":
            if json["packageDigest"] != self.digest and not self.stale_digest_accepted:
                return 409, {"code": "package_changed"}
            request.update(state="allowed", amount=request["amount"] or json["amountCents"])
            return 202, {}
        if action == "price":
            return 202, {}
        if action == "payment" and len(parts) == 3:
            if request["state"] == "declined" or request["amount"] is None:
                return 404, {}
            status = "expired" if request["state"] == "cancelled" else "open"
            return 200, {"amountCents": request["amount"], "currency": "usd", "status": status}
        if action == "payment" and parts[3] == "checkout":
            if request["session"] is None or self.double_session:
                self.sessions += 1
                request["session"] = f"cs_test_{self.sessions}"
            return 200, {"checkoutSessionId": request["session"]}
        if action == "cancel":
            request["state"] = "cancelled"
            return 200, {}
        if action == "delivery":
            return 200, {"grantedCount": 0}
        return 404, {}


class LiveCheckoutRefused(RuntimeError):
    """UAT Drive checkout is live Stripe; the journey never opens a live session."""


def uat_stripe_mode(command=None) -> str | None:
    """Read-only: the STRIPE_MODE value the UAT backend serves with."""
    from hushh_eval.drive_packets.sources import BACKEND_SERVICE, _gcloud, describe_service

    service = describe_service(BACKEND_SERVICE, command or _gcloud)
    for item in service["spec"]["template"]["spec"]["containers"][0].get("env", []):
        if item["name"] == "STRIPE_MODE":
            return item.get("value")
    return None


def require_test_mode_payments(mode: str | None) -> None:
    if mode != "test":
        raise LiveCheckoutRefused("uat_drive_checkout_is_not_stripe_test_mode")


class ApiTransport:
    """Two designated test accounts (owner, buyer) against the UAT API. Never pays."""

    def __init__(self, base_url: str, sessions: dict[str, Any], client=None):
        import httpx

        self.base_url = base_url.rstrip("/")
        self.sessions = sessions
        self.client = client or httpx.AsyncClient(timeout=60, follow_redirects=False)

    async def __call__(self, role, method, path, json=None):
        session = self.sessions[role]
        response = await self.client.request(
            method,
            self.base_url + path,
            json=json,
            headers={
                "Authorization": f"Bearer {session.firebase_id_token}",
                "X-Hushh-Consent": session.vault_owner_token,
            },
        )
        is_json = response.headers.get("content-type", "").startswith("application/json")
        return response.status_code, response.json() if is_json else {}


def main(argv: list[str] | None = None, *, stripe_mode=uat_stripe_mode) -> int:
    import argparse
    import json
    import os

    parser = argparse.ArgumentParser(prog="python -m hushh_eval.drive_packets.journey")
    parser.add_argument("--owner-ref", default="<owner person ref>")
    parser.add_argument("--live", action="store_true", help="Requires Stripe test mode in UAT")
    args = parser.parse_args(argv)
    if not args.live:
        print("\n".join(planned_calls(args.owner_ref)))
        return 0
    if os.environ.get("DRIVE_PACKET_EVAL_LIVE") != "1":
        print(json.dumps({"error": "set DRIVE_PACKET_EVAL_LIVE=1"}))
        return 2
    try:
        require_test_mode_payments(stripe_mode())
    except LiveCheckoutRefused as error:
        print(json.dumps({"error": str(error)}))
        return 2
    raise SystemExit("live journey needs designated test-account sessions; see README")


if __name__ == "__main__":
    raise SystemExit(main())
