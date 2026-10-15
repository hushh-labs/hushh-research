"""Synthetic stand-ins for the dashboard tests: two synthetic owners, no UAT, no network.

``FakeEngine`` answers the dashboard's registered statements from in-memory rows
and applies the same owner filter the SQL does (the SQL itself is checked
statically in test_dashboard_sql.py). Envelopes are plain dicts under "plain".
"""

from __future__ import annotations

import json
from pathlib import Path

from hushh_eval.drive_packets.contracts import JudgmentRow, PacketRow, QueueRow, append_rows
from hushh_eval.drive_packets.dashboard.queries import STATEMENTS

OWNER = "owner-synthetic-0001"
OTHER = "owner-synthetic-0002"
MY_PACKET = "11111111-1111-4111-8111-111111111111"
THEIR_PACKET = "22222222-2222-4222-8222-222222222222"
MY_REQUEST = "33333333-3333-4333-8333-333333333333"
THEIR_REQUEST = "44444444-4444-4444-8444-444444444444"
REQUESTER_EMAIL = "buyer.synthetic@example.invalid"
NAMES = {" ".join(sql.split()): name for name, sql in STATEMENTS.items()}


class Rows:
    def __init__(self, rows):
        self.rows = rows

    def mappings(self):
        return [dict(row) for row in self.rows]

    def scalar_one(self):
        return self.rows


class FakeConnection:
    def __init__(self, data: dict):
        self.data = data
        self.executed: list[str] = []

    def exec_driver_sql(self, statement):
        self.executed.append(statement)

    def execute(self, statement, params=None):
        sql = " ".join(str(statement).split())
        if "current_setting('transaction_read_only')" in sql:
            return Rows("on")
        name = NAMES[sql]
        self.executed.append(name)
        owner = (params or {})["owner"]
        return Rows(self.data["answer"](name, owner, params or {}))

    def rollback(self):
        return None

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


class FakeEngine:
    def __init__(self, answer):
        self.connection = FakeConnection({"answer": answer})
        self._dashboard_owner = OWNER

    def connect(self):
        return self.connection


class PlainCipher:
    """Opens {"plain": {...}} envelopes; anything else is unreadable."""

    def open(self, envelope, **_kwargs):
        if isinstance(envelope, dict) and isinstance(envelope.get("plain"), dict):
            return envelope["plain"]
        raise ValueError("unreadable")


def owner_rows():
    """Two owners' packets and requests; the answer function filters by owner."""
    packets = {MY_PACKET: OWNER, THEIR_PACKET: OTHER}
    requests = {
        MY_REQUEST: {
            "request_id": MY_REQUEST,
            "user_id": OWNER,
            "status": "completed",
            "revision": 1,
            "created_at": "2026-10-12T23:00:00+00:00",
            "updated_at": "2026-10-12T23:05:00+00:00",
            "expires_at": "2026-11-11T23:00:00+00:00",
            "request_envelope": {
                "plain": {
                    "purpose": {
                        "purpose": "Recent brokerage statements (synthetic)",
                        "periodStart": "2026-09-01",
                        "periodEnd": "2026-10-09",
                    },
                    "recipient": {"email": REQUESTER_EMAIL, "user_id": "buyer-synthetic-9"},
                    "trusted_auto": True,
                    "owner_allowed": {"amount_cents": 100},
                }
            },
            "payment_required": True,
            "quoted_amount_cents": 100,
            "settlement_method": "card",
            "owner_allowed_at": "2026-10-12T23:00:01+00:00",
            "bulk_search_started_at": "2026-10-12T23:00:02+00:00",
            "agent_package_required": False,
            "requester_display_name": "Synthetic Buyer",
        },
        THEIR_REQUEST: {"request_id": THEIR_REQUEST, "user_id": OTHER},
    }

    def answer(name, owner, params):
        if name in {"packet_head", "packet_detail"}:
            packet = params["packet_id"]
            return (
                [{"packet_id": packet, "current_version": 3}]
                if packets.get(packet) == owner
                else []
            )
        if name in {"request_exists", "request_header"}:
            row = requests.get(params["request_id"])
            return [row] if row and row["user_id"] == owner else []
        if name == "request_list":
            return [
                {
                    **row,
                    "order_status": "paid",
                    "order_amount_cents": 100,
                    "shared_files": 1,
                    "newly_shared": 0,
                    "already_had_access": 1,
                    "ops_files": 0,
                    "ops_shared": 0,
                    "ops_already_had_access": 0,
                }
                for row in requests.values()
                if row["user_id"] == owner
            ]
        if name == "request_payment":
            return (
                [
                    {
                        "status": "paid",
                        "amount_cents": 100,
                        "stripe_mode": "live",
                        "paid_at": "2026-10-12T23:01:00+00:00",
                    }
                ]
                if params["request_id"] in requests
                and requests[params["request_id"]]["user_id"] == owner
                else []
            )
        return []

    return answer


def write_batch(root: Path, batch_id: str, verdicts: dict[str, str], *, human: dict | None = None):
    """A synthetic eval batch: one Ready packet per key with a consensus verdict."""
    path = root / "batches" / batch_id
    path.mkdir(parents=True, mode=0o700)
    packets, judgments = [], []
    for key, verdict in verdicts.items():
        packets.append(
            PacketRow(
                batch_id=batch_id,
                packet_key=key,
                mode="replay",
                state="ready",
                member_case_ids=["c1"],
                selected_case_ids=["c1"],
                excluded=[],
                periods=[],
                temporal_scope="content_period",
                gaps_count=0,
                pricing={},
                price_cents=500,
                assessment_score=80,
                importance=10,
                standalone_value="supported",
                visible={},
                record_statuses=[],
                verification=None,
                digest="d" * 64,
            )
        )
        judgments.append(
            JudgmentRow(
                batch_id=batch_id,
                packet_key=key,
                judge_id="consensus",
                model_version=None,
                prompt_sha256=None,
                seed=None,
                variant="consensus",
                verdict=verdict,
                failed_checks=[] if verdict == "pass" else ["coverage"],
                severity=None if verdict == "pass" else "S2",
                citations_valid=True,
            )
        )
    for key, verdict in (human or {}).items():
        judgments.append(
            JudgmentRow(
                batch_id=batch_id,
                packet_key=key,
                judge_id="human",
                model_version="human",
                prompt_sha256=None,
                seed=None,
                variant="primary",
                verdict=verdict,
                failed_checks=[],
                severity=None,
                citations_valid=None,
            )
        )
    append_rows(path / "packets.jsonl", packets)
    append_rows(path / "judgments.jsonl", judgments)
    append_rows(
        path / "queue.jsonl",
        [
            QueueRow(batch_id=batch_id, subject=f"packet:{key}", reason="high_risk_ready")
            for key in verdicts
        ],
    )
    wrong = sum(value == "fail" for value in verdicts.values())
    decided = sum(value in {"pass", "fail"} for value in verdicts.values())
    (path / "scores.json").write_text(
        json.dumps(
            {
                "batch_id": batch_id,
                "code_sha": "abc1234def",
                "mode": "replay",
                "human_confirmed_ready": 0,
                "files": 10,
                "packets": {"states": {"ready": len(verdicts)}, "total": len(verdicts)},
                "scores": [
                    {
                        "metric": "ready_correct_one_per_family",
                        "successes": decided - wrong,
                        "trials": decided,
                        "n_unknown": len(verdicts) - decided,
                    }
                ],
            }
        )
    )
    (path / "report.md").write_text(
        f"Drive packet check {batch_id}: replay.\nReady packets wrong: {wrong} of {decided}.\n"
    )
    (path / "gate-listing.json").write_text(
        json.dumps(
            {"gate": "listing", "status": "fail", "exit_code": 1, "reasons": ["ready_packet_wrong"]}
        )
    )
    return path
