"""Generate the guard regression fixtures (synthetic; no private content).

Each fixture is one adversarial model output for a runtime validator. Cases
with ``known_gap`` describe a real failure class the runtime does not guard yet;
the suite keeps them as strict expected failures until the runtime closes them.

Run: python tests/fixtures/drive_packet_eval/generate_adversarial.py
"""

from __future__ import annotations

import json
from pathlib import Path

OUT = Path(__file__).with_name("adversarial")
SHA_A = "a" * 64
SHA_B = "b" * 64


def cite(quote, page=1):
    return [{"page": page, "unit_kind": "page", "quote": quote}]


def fact(value, quote=None, page=1):
    return {"value": value, "citations": cite(quote or value, page)}


def unknown_status():
    return {
        "status": "unknown",
        "evidence_basis": "unknown",
        "explanation": "Record status was not assessed.",
        "citations": [],
    }


def statement(document_id, *, month="09", last=30, account="1122", sha=SHA_A, modified=None):
    names = {"09": "September", "10": "October"}
    period_line = f"Statement period {names[month]} 1, 2026 to {names[month]} {last}, 2026"
    text = (
        "Example Bank\nMonthly statement\n"
        f"Account ending {account}\n{period_line}\nEnding balance $1,000.00\n"
    )
    return {
        "document_id": document_id,
        "source_version": "7",
        "complete": True,
        "content_sha256": sha,
        "metadata": {"modifiedTime": modified or "2025-01-15T10:00:00Z"},
        "pages": {"1": text},
        "facts": {
            "document_type": fact("Monthly statement"),
            "issuer": fact("Example Bank"),
            "subject": None,
            "account": fact(f"Account ending {account}"),
            "record_status": unknown_status(),
            "periods": [
                {
                    "start": f"2026-{month}-01",
                    "end": f"2026-{month}-{last}",
                    "citations": cite(period_line),
                }
            ],
            "date_evidence": [],
            "topics": [],
            "facts": [fact("Ending balance $1,000.00")],
            "missing_information": [],
            "ambiguous": False,
        },
    }


def wire_request(document_id, *, status="requested"):
    text = "Wire transfer request form\nRequested date 2026-09-14\nAmount $2,500.00\n"
    basis = "completion_evidence" if status == "completed" else "documentary_form"
    return {
        "document_id": document_id,
        "source_version": "3",
        "complete": True,
        "content_sha256": SHA_B if status == "completed" else SHA_A,
        "metadata": {"modifiedTime": "2026-09-14T12:00:00Z"},
        "pages": {"1": text},
        "facts": {
            "document_type": fact("Wire transfer request form"),
            "issuer": None,
            "subject": None,
            "account": None,
            "record_status": {
                "status": status,
                "evidence_basis": basis,
                "explanation": "The form requests a transfer.",
                "citations": cite("Wire transfer request form"),
            },
            "periods": [],
            "date_evidence": [
                {
                    "role": "planned_action",
                    "start": "2026-09-14",
                    "end": "2026-09-14",
                    "meaning": "Requested transfer date",
                    "citations": cite("Requested date 2026-09-14"),
                }
            ],
            "topics": [],
            "facts": [fact("Amount $2,500.00")],
            "missing_information": [],
            "ambiguous": False,
        },
    }


def pricing(coverage="complete", quality="verified", scope="period", cents=500):
    return {
        "rubric_version": "drive-packet-price-v1",
        "useful_scope": scope,
        "coverage": coverage,
        "quality": quality,
        "rationale": "One verified statement period.",
        "suggested_price_cents": cents,
    }


def proposal(selected, *, periods, state="ready", scope="document_period", **overrides):
    value = {
        "title": "Example Bank statements",
        "description": "Monthly statements for one account.",
        "state": state,
        "selected_document_ids": selected,
        "excluded_documents": [],
        "coverage_summary": "September 2026.",
        "periods": periods,
        "temporal_scope": scope,
        "gaps": [],
        "assessment_score": 90,
        "importance": 50,
        "pricing": pricing(),
        "standalone_value": "supported",
        "utility_rationale": "A complete monthly statement.",
    }
    value.update(overrides)
    return value


def verdict(state="ready"):
    return {
        "state": state,
        "correct_subject_and_account": True,
        "correct_issuer_and_type": True,
        "correct_coverage": True,
        "correct_record_status": True,
        "correct_standalone_value": True,
        "no_unrelated_inclusions": True,
        "no_unexplained_omissions": True,
        "issues": [],
    }


def september(document):
    return [dict(document["facts"]["periods"][0])]


def case(case_id, description, documents, answer, *, known_gap=None, stage="construct", **extra):
    value = {
        "schema_version": "dpe.guard.v1",
        "id": case_id,
        "description": description,
        "stage": stage,
        "documents": documents,
        "proposal": answer,
        "verdict": verdict(),
        "known_gap": known_gap,
    }
    value.update(extra)
    return value


def build():
    sep = statement("doc-sep")
    cases = []
    cases.append(
        case(
            "ready-with-gaps",
            "Ready proposal that admits a coverage gap.",
            [sep],
            proposal(["doc-sep"], periods=september(sep), gaps=["October is missing"]),
        )
    )
    cases.append(
        case(
            "ready-partial-coverage",
            "Ready proposal priced as partial coverage.",
            [sep],
            proposal(["doc-sep"], periods=september(sep), pricing=pricing(coverage="partial")),
        )
    )
    other = statement("doc-other", month="10", last=31)
    cases.append(
        case(
            "ready-hides-unverifiable",
            "Ready proposal that excludes an unreadable member as unverifiable.",
            [sep, other],
            proposal(
                ["doc-sep"],
                periods=september(sep),
                excluded_documents=[
                    {
                        "document_id": "doc-other",
                        "reason": "unverifiable",
                        "explanation": "Pages could not be read.",
                        "duplicate_of_document_id": None,
                    }
                ],
            ),
        )
    )
    cases.append(
        case(
            "invented-member",
            "Proposal selects a document that was never supplied.",
            [sep],
            proposal(["doc-sep", "doc-invented"], periods=september(sep)),
        )
    )
    cases.append(
        case(
            "unaccounted-member",
            "Proposal neither selects nor explains a supplied document.",
            [sep, other],
            proposal(["doc-sep"], periods=september(sep)),
        )
    )
    cases.append(
        case(
            "untraced-period",
            "Packet claims an October period no member evidences.",
            [sep],
            proposal(
                ["doc-sep"],
                periods=[
                    {
                        "start": "2026-10-01",
                        "end": "2026-10-31",
                        "citations": september(sep)[0]["citations"],
                    }
                ],
            ),
        )
    )
    cases.append(
        case(
            "snapshot-without-as-of",
            "Snapshot scope without any as-of date evidence.",
            [sep],
            proposal(
                ["doc-sep"], periods=[], scope="as_of_snapshot", pricing=pricing(scope="single")
            ),
        )
    )
    gap = statement("doc-gap")
    gap["complete"] = False
    cases.append(
        case(
            "ocr-gap-marked-ready",
            "A member with unreadable pages cannot finish as Ready.",
            [gap],
            proposal(["doc-gap"], periods=september(gap)),
        )
    )
    wire = wire_request("doc-wire")
    cases.append(
        case(
            "wire-request-executed-copy",
            "Request-only source; the model claims the transfer was executed. "
            "The runtime must replace the visible copy (fence from c3878efdad).",
            [wire],
            proposal(
                ["doc-wire"],
                periods=[],
                scope="no_period_claim",
                title="Requested wire transfer",
                description="Requested transfer: settlement confirmed by bank",
                coverage_summary="Bank debited the account",
                pricing={**pricing(scope="single"), "rationale": "Payment went through"},
                utility_rationale="Settlement confirmed",
            ),
        )
    )
    cases.append(
        case(
            "wire-request-as-snapshot",
            "Request-only source presented as a dated snapshot.",
            [wire],
            proposal(
                ["doc-wire"],
                periods=[],
                scope="as_of_snapshot",
                title="Wire transfer requests",
                description="Documents requesting a wire transfer; execution is unverified.",
                pricing=pricing(scope="single"),
            ),
        )
    )
    done = wire_request("doc-done", status="completed")
    cases.append(
        case(
            "mixed-requested-evidence",
            "One request and one completed record presented as one Ready packet.",
            [wire, done],
            proposal(
                ["doc-wire", "doc-done"],
                periods=[],
                scope="no_period_claim",
                pricing=pricing(scope="collection"),
            ),
        )
    )
    trap = statement("doc-trap", month="10", last=31, modified="2026-10-13T09:00:00Z")
    trap["facts"]["periods"][0]["citations"] = cite("Monthly statement")
    cases.append(
        case(
            "period-from-modified-date",
            "Statement period equals the file's modified month and no quote states it "
            "(incident class: a recent edit read as a recent statement).",
            [trap],
            proposal(["doc-trap"], periods=[dict(trap["facts"]["periods"][0])]),
        )
    )
    copy_a = statement("doc-copy-a", sha=SHA_A)
    copy_b = statement("doc-copy-b", sha=SHA_A)
    cases.append(
        case(
            "same-pdf-twice",
            "The same original selected twice in one Ready packet (incident class).",
            [copy_a, copy_b],
            proposal(["doc-copy-a", "doc-copy-b"], periods=september(copy_a)),
        )
    )
    wrong = statement("doc-wrong", month="10", last=31, account="9876", sha=SHA_B)
    cases.append(
        case(
            "wrong-account-member",
            "Another account's statement included in a Ready packet.",
            [sep, wrong],
            proposal(
                ["doc-sep", "doc-wrong"],
                periods=september(sep) + [dict(wrong["facts"]["periods"][0])],
                pricing=pricing(scope="multi_period"),
            ),
        )
    )
    cases.append(
        {
            "schema_version": "dpe.guard.v1",
            "id": "fabricated-citation",
            "description": "Page facts cite a text span that does not exist.",
            "stage": "page_facts",
            "documents": [],
            "pages": [
                {"page": 1, "text": "Example Bank\nMonthly statement\n", "unit_kind": "page"}
            ],
            "answer": {
                "pages": [1],
                "document_type": {"value": "Monthly statement", "citation_refs": ["p1s9"]},
                "issuer": None,
                "subject": None,
                "account": None,
                "record_status": {
                    "status": "unknown",
                    "evidence_basis": "unknown",
                    "explanation": "Not assessed.",
                    "citation_refs": [],
                },
                "periods": [],
                "date_evidence": [],
                "topics": [],
                "facts": [],
                "missing_information": [],
                "ambiguous": False,
            },
            "known_gap": None,
        }
    )
    return cases


def main():
    OUT.mkdir(exist_ok=True)
    for path in OUT.glob("*.json"):
        path.unlink()
    for item in build():
        (OUT / f"{item['id']}.json").write_text(json.dumps(item, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
