#!/usr/bin/env python3
"""Read and verify the UAT Calendar follow-ups gates in deploy/uat-surface-gates.txt.

``read-gates`` is what the UAT deploy and the scheduler script call: it validates the file, and
when follow-ups are on it also refuses unless the existing sealing key is readable, so a revision
is never built that cannot open its own sealed records. Only the three reviewed combinations are
accepted (false/false, true/false, true/true); anything else exits 1 instead of guessing.

``verify`` runs after a healthy UAT release. It compares the gates with the environment of every
Cloud Run revision that serves traffic, so a gate file that says "true" cannot sit beside a
revision that was built without it (or the reverse). It prints sanitized evidence: revision
names, traffic share, image, the two flag values and whether the key is bound by secret
reference. It never reads a secret value.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

FOLLOWUPS_FLAG = "CALENDAR_EMAIL_FOLLOWUPS"
DRAIN_FLAG = "CALENDAR_EMAIL_FOLLOWUP_DRAIN_ENABLED"
KEY_NAME = "CALENDAR_EMAIL_FOLLOWUP_KEY"
VALID_GATES = {
    ("false", "false"),
    ("true", "false"),
    ("true", "true"),
}


def parse_gates(text: str) -> tuple[str, str]:
    """Return (followups, drain) or raise ValueError on anything but the three reviewed pairs."""
    lines = [
        line for line in text.split("\n") if line.strip() and not line.lstrip().startswith("#")
    ]
    keys = ("calendar_email_followups=", "calendar_email_followup_drain=")
    if len(lines) != 2 or not all(
        line.startswith(key) for line, key in zip(lines, keys, strict=True)
    ):
        raise ValueError("gate file must hold the two reviewed lines in order")
    values = (lines[0][len(keys[0]) :], lines[1][len(keys[1]) :])
    if values not in VALID_GATES:
        raise ValueError("gate file holds an unreviewed combination")
    return values


def serving_revisions(service: dict) -> list[tuple[str, int]]:
    ready = (service.get("status") or {}).get("latestReadyRevisionName", "")
    shares: dict[str, int] = {}
    for entry in (service.get("status") or {}).get("traffic") or []:
        name = entry.get("revisionName") or (ready if entry.get("latestRevision") else "")
        if name and int(entry.get("percent") or 0) > 0:
            shares[name] = shares.get(name, 0) + int(entry["percent"])
    return sorted(shares.items())


def revision_facts(revision: dict) -> dict:
    container = ((revision.get("spec") or {}).get("containers") or [{}])[0]
    env = {item.get("name"): item for item in container.get("env") or []}

    def plain(name: str) -> str | None:
        item = env.get(name)
        return None if item is None else str(item.get("value", "")).lower()

    key_ref = ((env.get(KEY_NAME) or {}).get("valueFrom") or {}).get("secretKeyRef") or {}
    return {
        "image": container.get("image", ""),
        "followups": plain(FOLLOWUPS_FLAG),
        "drain": plain(DRAIN_FLAG),
        "key_bound_by_secret_reference": key_ref.get("name") == KEY_NAME,
        "key_set_as_plain_value": KEY_NAME in env and not key_ref,
    }


def problems(gates: tuple[str, str], facts: dict) -> list[str]:
    followups, drain = gates
    found = []
    if facts["followups"] != followups:
        found.append(f"{FOLLOWUPS_FLAG} is {facts['followups']!r}, gate says {followups!r}")
    if facts["drain"] != drain:
        found.append(f"{DRAIN_FLAG} is {facts['drain']!r}, gate says {drain!r}")
    if facts["key_set_as_plain_value"]:
        found.append(f"{KEY_NAME} must be a secret reference, not a plain value")
    if facts["key_bound_by_secret_reference"] != (followups == "true"):
        found.append(f"{KEY_NAME} binding does not match the follow-ups gate")
    return found


def gcloud_json(*args: str) -> dict:
    result = subprocess.run(  # noqa: S603 - fixed gcloud verbs with repository-owned arguments.
        ["gcloud", *args, "--format=json"], capture_output=True, text=True, check=True
    )
    return json.loads(result.stdout)


def key_is_readable(project: str) -> bool:
    result = subprocess.run(  # noqa: S603 - fixed gcloud verb; reads secret metadata only.
        ["gcloud", "secrets", "describe", KEY_NAME, f"--project={project}"],
        capture_output=True,
        text=True,
        check=False,
    )
    return result.returncode == 0


def read_gates(args: argparse.Namespace) -> int:
    try:
        gates = parse_gates(Path(args.file).read_bytes().decode("utf-8"))
    except ValueError:
        print(
            f"{args.file} must hold calendar_email_followups=<true|false> then "
            "calendar_email_followup_drain=<true|false>, and drain may be true only while "
            "follow-ups is.",
            file=sys.stderr,
        )
        return 1
    if args.project and gates[0] == "true" and not key_is_readable(args.project):
        print(
            f"Calendar follow-ups are enabled but {KEY_NAME} is not readable in project "
            f"{args.project}.",
            file=sys.stderr,
        )
        return 1
    print(" ".join(gates))
    return 0


def verify(args: argparse.Namespace) -> int:
    gates_path = Path(args.gates)
    if not gates_path.is_file():
        print("No UAT surface gates in this commit; nothing to verify.")
        return 0
    gates = parse_gates(gates_path.read_bytes().decode("utf-8"))
    base = ["--project", args.project, "--region", args.region]
    service = gcloud_json("run", "services", "describe", args.service, *base)
    revisions = serving_revisions(service)
    if not revisions or sum(share for _, share in revisions) != 100:
        print("Serving traffic does not add up to 100% across named revisions.", file=sys.stderr)
        return 1
    evidence = {"application_sha": args.application_sha, "gates": list(gates), "revisions": []}
    failed = False
    for name, share in revisions:
        facts = revision_facts(gcloud_json("run", "revisions", "describe", name, *base))
        issues = problems(gates, facts)
        failed = failed or bool(issues)
        evidence["revisions"].append(
            {"name": name, "traffic_percent": share, **facts, "issues": issues}
        )
    Path(args.evidence).write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(evidence, indent=2))
    if failed:
        print("Serving revision does not match deploy/uat-surface-gates.txt", file=sys.stderr)
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    read = commands.add_parser("read-gates", help="validate the gate file and print its two values")
    read.add_argument("file")
    read.add_argument("--project", help="also require the sealing key to be readable when on")
    read.set_defaults(handler=read_gates)
    check = commands.add_parser("verify", help="compare the gates with the serving revisions")
    check.add_argument("--project", required=True)
    check.add_argument("--region", required=True)
    check.add_argument("--service", required=True)
    check.add_argument("--application-sha", required=True)
    check.add_argument("--gates", default="deploy/uat-surface-gates.txt")
    check.add_argument("--evidence", required=True)
    check.set_defaults(handler=verify)
    args = parser.parse_args()
    return args.handler(args)


if __name__ == "__main__":
    sys.exit(main())
