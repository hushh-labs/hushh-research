"""A real request as the deployed backend stored it, shaped for the founder.

Synthetic rows reproduce the 13 October shape: a Trusted auto-approved request,
a Drive search whose filename rule dropped most rows, one kept file with no
content dates, paid, and delivered as "already had access". The page must show
each of those facts plainly. Also: the packets-overlap helper for the request
engine. Synthetic values only.
"""

from hushh_eval.drive_packets.dashboard.queries import DashboardData, OwnerScopedReader
from hushh_eval.drive_packets.dashboard.real_requests import RealRequests

from ._dashboard_fakes import OWNER, FakeEngine, PlainCipher

REQUEST = "55555555-5555-4555-8555-555555555555"
JOB = "66666666-6666-4666-8666-666666666666"
SHARE = "77777777-7777-4777-8777-777777777777"


def answer(name, owner, params):
    assert owner == OWNER
    header = {
        "request_id": REQUEST,
        "user_id": OWNER,
        "status": "completed",
        "revision": 2,
        "created_at": "2026-10-12T23:00:00+00:00",
        "updated_at": "2026-10-12T23:10:00+00:00",
        "request_envelope": {
            "plain": {
                "purpose": {
                    "purpose": "all brokerage statements from Examplebank in 2026",
                    "periodStart": "2026-09-01",
                    "periodEnd": "2026-10-09",
                },
                "recipient": {"email": "buyer@example.invalid"},
                "trusted_auto": True,
                "owner_allowed": {"amount_cents": 100},
            }
        },
        "quoted_amount_cents": 100,
        "settlement_method": "card",
        "owner_allowed_at": "2026-10-12T23:00:01+00:00",
        "agent_package_required": False,
        "requester_display_name": "Synthetic Buyer",
    }
    if name == "request_header":
        return [header]
    if name == "request_search_jobs":
        return [
            {
                "job_id": JOB,
                "user_id": OWNER,
                "status": "completed",
                "matched": 1,
                "pages_scanned": 25,
                "incomplete_search": False,
                "error_code": None,
                "created_at": "2026-10-12T23:00:02+00:00",
                "updated_at": "2026-10-12T23:01:00+00:00",
                "evaluation_status": "pending",
                "evaluation_error_code": None,
                "checkpoint_envelope": {
                    "plain": {
                        "arguments": {
                            "query": "fullText contains 'examplebank'",
                            "orderBy": "modifiedTime desc",
                        },
                        "request": {"query": "Examplebank brokerage statements", "timezone": "UTC"},
                        "request_file_kind": "any",
                        "request_subject_terms": ["examplebank", "brokerage"],
                        "request_explicit_dates": True,
                        "requested_period": {
                            "start": "2026-09-01",
                            "end": "2026-10-09",
                            "timezone": "UTC",
                        },
                        "coverage_manifest": {
                            "dateBasis": "modifiedTime",
                            "contentPeriodVerified": False,
                        },
                        "coverage_counts": {
                            "providerRowsScanned": 1500,
                            "providerFilePages": 25,
                            "excludedByNoteTypeCount": 1499,
                        },
                        "drive_tokens": ["secret-cursor"],
                        "drives": ["drive-id-1"],
                        "phase": "done",
                    }
                },
            }
        ]
    if name == "request_search_results":
        return [
            {
                "job_id": JOB,
                "user_id": OWNER,
                "position": 1,
                "evaluation_envelope": None,
                "metadata_envelope": {
                    "plain": {
                        "name": "Examplebank history 2014-2016.pdf",
                        "mimeType": "application/pdf",
                        "modifiedTime": "2026-10-02T10:00:00Z",
                        "createdTime": "2016-12-31T10:00:00Z",
                        "id": "drive-file-id",
                        "resourceKey": "rk-secret",
                        "openUrl": "https://drive.example/x",
                    }
                },
            }
        ]
    if name == "request_shares":
        return [
            {
                "share_id": SHARE,
                "user_id": OWNER,
                "status": "completed",
                "file_count": 1,
                "approval_source": "trusted_auto",
                "created_at": "2026-10-12T23:01:30+00:00",
            }
        ]
    if name == "request_share_files":
        return [
            {
                "share_id": SHARE,
                "user_id": OWNER,
                "position": 1,
                "source_job_id": JOB,
                "source_position": 1,
                "metadata_envelope": {"plain": {"name": "Examplebank history 2014-2016.pdf"}},
                "state": "preexisting",
                "safe_error_code": None,
            }
        ]
    if name == "request_payment":
        return [
            {
                "status": "paid",
                "amount_cents": 100,
                "stripe_mode": "live",
                "paid_at": "2026-10-12T23:02:00+00:00",
                "created_at": "2026-10-12T23:01:40+00:00",
            }
        ]
    if name == "request_payout":
        return [
            {
                "status": "credited",
                "expected_files": 1,
                "confirmed_files": 1,
                "owner_earning_cents": 70,
            }
        ]
    return []


def requests():
    reader = OwnerScopedReader(FakeEngine(answer), OWNER)
    return RealRequests(reader, cipher=PlainCipher())


def test_the_incident_shape_is_visible_end_to_end():
    detail = requests().detail(REQUEST)
    assert detail["requester_display_name"] == "Synthetic Buyer"
    assert detail["plan"]["drive_query"] == "fullText contains 'examplebank'"
    assert detail["plan"]["date_basis"] == "modifiedTime"
    assert detail["plan"]["content_period_verified"] is False
    assert "drive_tokens" not in detail["plan"]["other_stored_fields"]
    [call] = detail["drive_api"]["calls"]
    assert (call["rows"], call["kept"], call["ms"]) == (1500, 1, "not recorded")
    assert detail["drive_api"]["dropped"] == {"excludedByNoteTypeCount": 1499}
    [row] = detail["drive_api"]["rows"]
    assert row["file_name"] == "Examplebank history 2014-2016.pdf" and row["kept"] is True
    [document] = detail["documents"]
    assert document["document_id"] == "p1" and document["selected"] is True
    assert "selected_without_content_dates" in document["flags"]
    assert (
        document["period_role"] == "not recorded" and document["delivery"] == "already_had_access"
    )
    assert detail["delivery"] == [
        {
            "document_id": "p1",
            "file_name": "Examplebank history 2014-2016.pdf",
            "outcome": "already_had_access",
            "states": ["preexisting"],
            "errors": [],
        }
    ]
    assert detail["paid"] is True and detail["delivered"] == 0 and detail["already_had_access"] == 1
    assert detail["payment"]["stripe_mode"] == "live" and detail["payment"]["refunded"] is False
    assert detail["payment"]["owner_payout"]["confirmed_files"] == 1
    assert detail["owner_review"]["kind"] == "trusted_auto"
    assert detail["logs"] == "not recorded"
    names = [step["name"] for step in detail["steps"]]
    assert names[0] == "request created" and "Drive search" in names and "delivery" in names
    search = next(step for step in detail["steps"] if step["name"] == "Drive search")
    assert (search["in"], search["kept"], search["dropped"]) == (1500, 1, 1499)
    text = repr(detail)
    for secret in (
        "drive-file-id",
        "rk-secret",
        "drive.example",
        "buyer@example.invalid",
        "secret-cursor",
        "drive-id-1",
    ):
        assert secret not in text


def _packet(title, start, end, status="ready", key="brokerage_statement:examplebank"):
    return {
        "packet_id": title,
        "version_id": 1,
        "title": title,
        "status": status,
        "member_count": 2,
        "period_label": f"{start} – {end}",
        "price_cents": 500,
        "listed": False,
        "updated_at": None,
        "ai_verdict": None,
        "human_label": None,
        "available": True,
        "_assessment": {"description": "", "periods": [{"start": start, "end": end}]},
        "_key": {"key": key, "title": title},
    }


def test_matching_packets_needs_kind_and_period_overlap(monkeypatch):
    data = DashboardData(object.__new__(OwnerScopedReader), owner_label="Manish")
    items = [
        _packet("Examplebank brokerage statements", "2026-08-01", "2026-09-30"),
        _packet("Examplebank brokerage statements 2015", "2015-01-01", "2015-12-31"),
        _packet(
            "Samplebank bank statements",
            "2026-09-01",
            "2026-09-30",
            key="bank_statement:samplebank",
        ),
        _packet("Draft Examplebank statements", "2026-09-01", "2026-09-30", status="building"),
    ]
    items[3]["version_id"] = None
    monkeypatch.setattr(data, "_packets", lambda: items)
    found = data.matching_packets(
        kinds=["brokerage statement"],
        period_start="2026-09-01",
        period_end="2026-10-09",
        terms=["Examplebank"],
    )
    assert [item["title"] for item in found] == ["Examplebank brokerage statements"]
    assert (
        "overlaps the ask by 30 days" in found[0]["why_matched"]
        and "Examplebank" in found[0]["why_matched"]
    )
    assert set(found[0]) == {
        "packet_id",
        "title",
        "status",
        "period_label",
        "member_count",
        "listed",
        "price_cents",
        "why_matched",
    }
    everything = data.matching_packets(kinds=["statements"])
    assert {item["title"] for item in everything} == {
        "Examplebank brokerage statements",
        "Examplebank brokerage statements 2015",
        "Samplebank bank statements",
    }
