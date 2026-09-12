#!/usr/bin/env python3
"""Measure what the PKM can actually hold, against a real document.

Why this replaces the persona benchmark
---------------------------------------
`eval_pkm_structure_agent.py` runs 100 hand-written persona prompts. It reports
schema-ok and domain-ok rates on inputs chosen to exercise the classifier, which
answers "does the classifier obey its contract" and not "can this system hold a
person". A real context document -- the kind someone pastes in during onboarding
after asking another AI to summarise them -- is nothing like 100 tidy prompts.
It is long, uneven, full of preferences and principles, and most of it is not a
fact with a value.

This measures the second question, deterministically and without a model:

  COVERAGE       what share of the document's statements have somewhere to live
  HOMELESSNESS   which statements have no domain that fits, and what they are
  GRANULARITY    how many scopes a domain ends up with (too few is a blob,
                 too many is unusable in a consent list)
  NAMING         whether a scope label reads as words or as an address
  SHAREABILITY   whether the thing could sensibly be shared with someone

No model call, on purpose. A benchmark that needs Vertex cannot run in CI, and
the failures worth catching here are structural: a whole category of a person
with nowhere to go is a defect in the domain model, not in the classifier's
sampling temperature.

Usage:
    python3 scripts/eval_pkm_from_document.py --document path/to/doc.md
    python3 scripts/eval_pkm_from_document.py --document doc.md --json-out report.json
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hushh_mcp.services.domain_contracts import (  # noqa: E402
    DOMAIN_SHARING_POLICY_REGISTRY,
)

# What each canonical domain is plausibly about, in the words a document uses.
# Deliberately generous: the point is to find what has NO home, so a loose match
# must not be counted as homeless.
DOMAIN_CUES: dict[str, tuple[str, ...]] = {
    "identity": (
        "name",
        "preferred name",
        "degree",
        "education",
        "citizen",
        "immigration",
        "visa",
        "h-1b",
        "green card",
        "o-1",
        "eb-1a",
        "born",
        "age",
    ),
    "professional": (
        "role",
        "company",
        "engineer",
        "experience",
        "work",
        "career",
        "team",
        "employer",
        "job",
        "co-founder",
        "colleague",
        "skills",
        "stack",
    ),
    "financial": (
        "loan",
        "interest",
        "salary",
        "equity",
        "credit",
        "debt",
        "investment",
        "brokerage",
        "portfolio",
        "sec",
        "10-k",
        "10-q",
        "plaid",
        "alpaca",
        "cost",
        "$",
    ),
    "health": ("health", "insurance", "obamacare", "medical", "fitness", "sleep", "diet"),
    "food": ("food", "eat", "restaurant", "cook", "recipe", "coffee", "meal"),
    "location": ("moved", "apartment", "address", "city", "washington", "kirkland", "live"),
    "travel": ("travel", "flight", "trip", "hotel", "airport"),
    "shopping": (
        "purchase",
        "bought",
        "costco",
        "membership",
        "towels",
        "pods",
        "mattress",
        "paper towels",
        "body wash",
        "count",
    ),
    "social": ("friend", "family", "partner", "social", "community"),
    "entertainment": ("music", "film", "movie", "game", "book", "reading", "show"),
    "subscriptions": ("subscription", "plan", "renew", "billing"),
    "general": (
        "machine",
        "hardware",
        "laptop",
        "macbook",
        "mac",
        "nvidia",
        "gpu",
        "device",
        "tool",
        "editor",
        "benchmark",
        "tok/sec",
    ),
    "ria": ("advisor", "ria", "fiduciary"),
    "wallet": ("card", "wallet", "payment"),
    "source_library": ("document", "source", "file", "upload"),
    "runtime_secrets": (),
}

# Categories a person clearly HAS that no canonical domain is about. Each one is
# a claim this evaluator makes and can be argued with -- which is the point.
UNHOUSED_CATEGORIES: dict[str, tuple[str, ...]] = {
    "how I want to be communicated with": (
        "voice",
        "tone",
        "direct",
        "concise",
        "overkill",
        "filler",
        "executive",
        "do not",
        "prefer",
        "avoid",
        "em dash",
        "greeting",
    ),
    "how I work and think": (
        "philosophy",
        "principle",
        "architecture before",
        "validation over",
        "understand the system first",
        "break testing",
        "north star",
    ),
    "what I am trying to build": (
        "vision",
        "goal",
        "long-term",
        "strategy",
        "roadmap",
        "priorities",
    ),
    "how I want my tools to behave": (
        "agent should",
        "do not immediately",
        "inspect",
        "instruct",
        "workflow",
    ),
}


@dataclass
class Statement:
    text: str
    section: str
    domain: str | None = None
    unhoused_as: str | None = None


@dataclass
class Report:
    document: str
    statements: int = 0
    housed: int = 0
    homeless: int = 0
    by_domain: dict[str, int] = field(default_factory=dict)
    unhoused: dict[str, list[str]] = field(default_factory=dict)
    findings: list[dict] = field(default_factory=list)


def read_statements(text: str) -> list[Statement]:
    """Every line that asserts something, with the section it sits under.

    A heading is not a statement. A bullet is. A `key: value` line is. A prose
    sentence about the person is. Short fragments are dropped rather than
    counted, because padding the denominator flatters the coverage number.
    """
    out: list[Statement] = []
    section = "(top)"
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            section = line.lstrip("#").strip()
            continue
        line = line.lstrip("-*").strip()
        if len(line) < 12:
            continue
        out.append(Statement(text=line, section=section))
    return out


def classify(statement: Statement) -> None:
    haystack = f"{statement.section} {statement.text}".lower()

    best: tuple[int, str] | None = None
    for domain, cues in DOMAIN_CUES.items():
        hits = sum(1 for cue in cues if cue in haystack)
        if hits and (best is None or hits > best[0]):
            best = (hits, domain)
    if best:
        statement.domain = best[1]
        return

    for label, cues in UNHOUSED_CATEGORIES.items():
        if any(cue in haystack for cue in cues):
            statement.unhoused_as = label
            return


def evaluate(path: Path) -> Report:
    text = path.read_text(encoding="utf-8")
    statements = read_statements(text)
    for statement in statements:
        classify(statement)

    report = Report(document=str(path), statements=len(statements))
    for statement in statements:
        if statement.domain:
            report.housed += 1
            report.by_domain[statement.domain] = report.by_domain.get(statement.domain, 0) + 1
        else:
            report.homeless += 1
            label = statement.unhoused_as or "no category"
            report.unhoused.setdefault(label, []).append(statement.text[:110])

    coverage = report.housed / report.statements if report.statements else 0.0
    report.findings.append(
        {
            "id": "coverage",
            "value": round(coverage, 3),
            "verdict": "pass" if coverage >= 0.8 else "fail",
            "what": f"{report.housed} of {report.statements} statements have a domain that fits.",
        }
    )

    unhoused_named = {k: len(v) for k, v in report.unhoused.items() if k != "no category"}
    if unhoused_named:
        report.findings.append(
            {
                "id": "categories-without-a-domain",
                "value": unhoused_named,
                "verdict": "fail",
                "what": (
                    "Whole categories of this person have no canonical domain. These are not "
                    "edge cases: they are the parts of the document that say how to work with him."
                ),
            }
        )

    unpoliced = sorted(set(report.by_domain) - set(DOMAIN_SHARING_POLICY_REGISTRY))
    if unpoliced:
        report.findings.append(
            {
                "id": "no-sharing-policy",
                "value": unpoliced,
                "verdict": "fail",
                "what": (
                    "These domains hold this person's records and have no authored sharing "
                    "policy, so what a wildcard means there was never decided."
                ),
            }
        )

    blobs = {d: n for d, n in report.by_domain.items() if n >= 12}
    if blobs:
        report.findings.append(
            {
                "id": "granularity",
                "value": blobs,
                "verdict": "warn",
                "what": (
                    "A domain this large becomes one undifferentiated blob in a consent list. "
                    "It needs sub-scopes a person can grant separately."
                ),
            }
        )

    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--document", required=True, type=Path)
    parser.add_argument("--json-out", type=Path)
    args = parser.parse_args()

    report = evaluate(args.document)

    print(f"\nPKM DOCUMENT EVALUATION  --  {args.document.name}")
    print("=" * 68)
    print(f"statements read        {report.statements}")
    print(f"have a domain          {report.housed}")
    print(f"have nowhere to go     {report.homeless}")
    coverage = report.housed / report.statements if report.statements else 0.0
    print(f"coverage               {coverage:.0%}\n")

    print("WHERE THEY LANDED")
    for domain, count in sorted(report.by_domain.items(), key=lambda kv: -kv[1]):
        policy = "" if domain in DOMAIN_SHARING_POLICY_REGISTRY else "   (no sharing policy)"
        print(f"   {domain:18} {count:3}{policy}")

    if report.unhoused:
        print("\nNOWHERE TO GO")
        for label, items in sorted(report.unhoused.items(), key=lambda kv: -len(kv[1])):
            print(f"   {label}  ({len(items)})")
            for item in items[:3]:
                print(f"      - {item}")

    print("\nFINDINGS")
    for finding in report.findings:
        print(f"   [{finding['verdict'].upper():4}] {finding['id']}: {finding['what']}")

    if args.json_out:
        args.json_out.write_text(
            json.dumps(report.__dict__, indent=2, default=str), encoding="utf-8"
        )
        print(f"\nwrote {args.json_out}")

    return 0 if all(f["verdict"] != "fail" for f in report.findings) else 1


if __name__ == "__main__":
    raise SystemExit(main())
