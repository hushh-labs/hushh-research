"""Guard regression suite: adversarial model outputs fed to the runtime validators.

Each fixture scripts what a misbehaving model returns. The runtime functions
(construct_packet, verify_packet and the finalize state rule) decide the outcome:

- ``rejected``: a runtime validator refused the output;
- ``not_ready``: accepted, but not Ready;
- ``accepted_clean``: Ready, and the eval's deterministic checks find no defect
  (for example a bounded request description accepted by the independent checker);
- ``accepted_with_defect``: Ready although a deterministic check fails. This
  turns CI red, unless the fixture names a ``known_gap`` (tracked runtime work),
  which the test suite marks as a strict expected failure.

Fixtures are synthetic replicas (generated, never copied from private data).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from hushh_eval.drive_packets.deterministic import Finding, check_packet

FIXTURES = (
    Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "drive_packet_eval" / "adversarial"
)
SAFE = {"rejected", "not_ready", "accepted_clean"}


@dataclass
class GuardResult:
    case_id: str
    outcome: str
    stage: str
    findings: list[Finding] = field(default_factory=list)
    known_gap: str | None = None

    @property
    def safe(self) -> bool:
        return self.outcome in SAFE


def _scripted(answer):
    async def interpret(*, prompt, user_id, output_schema):
        del prompt, user_id, output_schema
        return json.loads(json.dumps(answer))

    return interpret


def load_cases(directory: Path = FIXTURES) -> list[dict]:
    cases = []
    for path in sorted(directory.glob("*.json")):
        case = json.loads(path.read_text())
        if case.get("schema_version") != "dpe.guard.v1" or case.get("id") != path.stem:
            raise ValueError(f"invalid_guard_fixture:{path.name}")
        cases.append(case)
    return cases


def _members(case: dict) -> list[dict]:
    return [
        {
            "document_id": item["document_id"],
            "content_sha256": item.get("content_sha256"),
            "facts": item["facts"],
            "pages": {int(k): v for k, v in (item.get("pages") or {}).items()} or None,
            "metadata": item.get("metadata") or {},
            "complete": item.get("complete", True),
        }
        for item in case["documents"]
    ]


async def run_case(case: dict) -> GuardResult:
    from hushh_mcp.services.drive_packet_intelligence import (
        construct_packet,
        extract_page_facts,
        verify_packet,
    )
    from hushh_mcp.services.drive_packet_worker import compact_evidence

    gap = case.get("known_gap")
    if case["stage"] == "page_facts":
        try:
            await extract_page_facts(
                user_id="guard-suite", pages=case["pages"], interpret=_scripted(case["answer"])
            )
        except ValueError:
            return GuardResult(case["id"], "rejected", "page_facts", known_gap=gap)
        return GuardResult(case["id"], "accepted_with_defect", "page_facts", known_gap=gap)
    complete = all(item.get("complete", True) for item in case["documents"])
    documents = [
        {
            "document_id": item["document_id"],
            "source_version": item.get("source_version", "1"),
            "complete": item.get("complete", True),
            "facts": item["facts"],
            **({"content_digest": item["content_sha256"]} if item.get("content_sha256") else {}),
        }
        for item in case["documents"]
    ]
    try:
        packet = await construct_packet(
            user_id="guard-suite",
            key=case.get("key", "guard-key"),
            documents=documents,
            complete=complete,
            interpret=_scripted(case["proposal"]),
        )
    except ValueError:
        return GuardResult(case["id"], "rejected", "construct", known_gap=gap)
    proposal = packet.model_dump(mode="json")
    try:
        checked = await verify_packet(
            user_id="guard-suite",
            packet=proposal,
            documents=[compact_evidence(item) for item in documents],
            complete=complete,
            batch_scope={
                "mode": "complete_compact_summary",
                "member_count": len(documents),
                "batch_checks_passed": True,
                "batch_issues": [],
                "canonical_key": case.get("key", "guard-key"),
            },
            interpret=_scripted(case["verdict"]),
        )
    except ValueError:
        return GuardResult(case["id"], "rejected", "verify", known_gap=gap)
    # Mirrors DrivePacketStore.finalize_packet: Ready needs both answers Ready.
    if not packet.state == checked.state == "ready":
        return GuardResult(case["id"], "not_ready", "finalize", known_gap=gap)
    findings = [
        finding
        for finding in check_packet(
            proposal, _members(case), verification=checked.model_dump(mode="json")
        )
        if finding.check != "price"
    ]
    outcome = "accepted_with_defect" if findings else "accepted_clean"
    return GuardResult(case["id"], outcome, "deterministic", findings, known_gap=gap)


async def run_suite(directory: Path = FIXTURES) -> list[GuardResult]:
    return [await run_case(case) for case in load_cases(directory)]


def suite_status(results: list[GuardResult]) -> dict:
    """Deploy gate input. Unknown-gap defects fail; tracked known gaps are reported."""
    regressions = [item.case_id for item in results if not item.safe and not item.known_gap]
    known = [item.case_id for item in results if not item.safe and item.known_gap]
    closed = [item.case_id for item in results if item.safe and item.known_gap]
    return {
        "cases": len(results),
        "regressions": sorted(regressions),
        "known_gaps_open": sorted(known),
        "known_gaps_closed": sorted(closed),
        "passed": not regressions,
    }
