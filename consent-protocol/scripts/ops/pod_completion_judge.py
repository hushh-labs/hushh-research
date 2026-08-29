#!/usr/bin/env python3
"""The judge: evaluate the pod-completion ledger and say what is still unfinished.

WHY THIS EXISTS
---------------
This programme's recurring defect is not missing code. It is code that exists, is
correct, is tested, and is reached by nothing -- and plans have the same failure
mode. A plan nobody re-evaluates is indistinguishable from a plan nobody wrote,
and the only difference is that the first one feels like progress.

So completion is not a status field anyone edits. Every item in the ledger carries
a CHECK, and its status is whatever running that check says today. Nobody can mark
an item done; they can only make its check pass.

THE INVARIANT THAT MATTERS MOST
-------------------------------
**An item that cannot be evaluated reports UNKNOWN, never PASS.** A judge that
answers "green" when it could not look is worse than no judge, because it is
believed. Every check that needs credentials, a cloud, or a database it does not
have degrades to UNKNOWN and is reported as such, loudly and separately.

The second invariant: **an assertion that cannot fail is not evidence.** Each item
declares `falsifiable`, and an item that is not falsifiable is reported as a defect
in the ledger itself rather than counted as passing.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_LEDGER = REPO_ROOT / "config" / "pod-completion-ledger.yaml"

PASS, FAIL, UNKNOWN = "pass", "fail", "unknown"


@dataclass
class Verdict:
    id: str
    requirement: str
    statement: str
    status: str
    detail: str = ""
    falsifiable: bool = True
    blocked_by: str = ""
    owner_action: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class JudgeReport:
    verdicts: list[Verdict] = field(default_factory=list)

    @property
    def passing(self) -> list[Verdict]:
        return [v for v in self.verdicts if v.status == PASS]

    @property
    def failing(self) -> list[Verdict]:
        return [v for v in self.verdicts if v.status == FAIL]

    @property
    def unknown(self) -> list[Verdict]:
        return [v for v in self.verdicts if v.status == UNKNOWN]

    @property
    def unfalsifiable(self) -> list[Verdict]:
        # Counted separately from failures: the thing being judged may be fine,
        # while the check that claims to judge it proves nothing.
        return [v for v in self.verdicts if not v.falsifiable]

    @property
    def finished(self) -> bool:
        """Finished means every item passes AND every check could actually run
        AND every check could have failed. Two of those three are the ways a
        completion report has lied to us before."""
        return (
            bool(self.verdicts) and not self.failing and not self.unknown and not self.unfalsifiable
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "finished": self.finished,
            "counts": {
                "total": len(self.verdicts),
                "pass": len(self.passing),
                "fail": len(self.failing),
                "unknown": len(self.unknown),
                "unfalsifiable": len(self.unfalsifiable),
            },
            "verdicts": [v.to_dict() for v in self.verdicts],
        }


# --------------------------------------------------------------------------- #
# Check runners. Each returns (status, detail). None of them may return PASS
# when they could not actually look.
# --------------------------------------------------------------------------- #


def _run(cmd: list[str], cwd: Path, timeout: int) -> tuple[int, str]:
    try:
        p = subprocess.run(  # noqa: S603
            cmd, cwd=str(cwd), capture_output=True, text=True, timeout=timeout
        )
    except FileNotFoundError as exc:
        return 127, f"missing executable: {exc}"
    except subprocess.TimeoutExpired:
        return 124, f"timed out after {timeout}s"
    out = (p.stdout or "") + (p.stderr or "")
    return p.returncode, out.strip()[-600:]


def check_pytest(item: dict[str, Any], timeout: int) -> tuple[str, str]:
    """A named test is the strongest cheap check: it runs in CI already."""
    target = str(item.get("target") or "").strip()
    if not target:
        return UNKNOWN, "no target given"
    protocol = REPO_ROOT / "consent-protocol"
    python = protocol / ".venv" / "bin" / "python"
    cmd = (
        [str(python), "-m", "pytest", target, "-q"]
        if python.exists()
        else ["uv", "run", "pytest", target, "-q"]
    )
    if not python.exists() and not shutil.which("uv"):
        return UNKNOWN, "neither .venv nor uv is available to run pytest"
    code, out = _run(cmd, protocol, timeout)
    if code == 0:
        return PASS, out.splitlines()[-1] if out else "ok"
    if code in (124, 127):
        return UNKNOWN, out
    return FAIL, out


def check_command(item: dict[str, Any], timeout: int) -> tuple[str, str]:
    """An arbitrary command. Exit 0 is pass; a missing tool is UNKNOWN, not fail,
    because 'we could not look' and 'it is broken' are different sentences."""
    cmd = item.get("command")
    if not cmd:
        return UNKNOWN, "no command given"
    requires = item.get("requires") or []
    for tool in requires:
        if not shutil.which(tool):
            return UNKNOWN, f"requires {tool!r}, which is not on PATH here"
    code, out = _run(["bash", "-lc", str(cmd)], REPO_ROOT, timeout)
    if code == 0:
        return PASS, out
    if code in (124, 127):
        return UNKNOWN, out
    return FAIL, out


def check_grep(item: dict[str, Any], _timeout: int) -> tuple[str, str]:
    """Assert a file does or does not contain a pattern. Cheap, hermetic, and
    honest about a missing file (UNKNOWN, because the claim is unevaluable)."""
    path = REPO_ROOT / str(item.get("path") or "")
    pattern = str(item.get("pattern") or "")
    if not pattern:
        return UNKNOWN, "no pattern given"
    if not path.exists():
        return UNKNOWN, f"{path} does not exist"
    text = path.read_text(encoding="utf-8", errors="replace")
    present = pattern in text
    want = bool(item.get("expect_present", True))
    if present is want:
        return PASS, f"pattern {'present' if present else 'absent'} as expected"
    return FAIL, f"pattern {'present' if present else 'absent'}, expected the opposite"


def check_manual(item: dict[str, Any], _timeout: int) -> tuple[str, str]:
    """Something only a human or a live environment can settle. It is never PASS
    from here -- recording it as UNKNOWN is the honest answer and keeps it visible
    instead of letting it drift into the passing column.

    Use this sparingly. An item that is permanently `manual` is permanently
    UNKNOWN, and a judge that can never reach YES is red on every run forever,
    which is how a nag becomes furniture. Prefer `receipt` for anything a live run
    can settle, so the item can pass while it is fresh and go red when it is not.
    """
    return UNKNOWN, str(item.get("note") or "needs a human or a live environment")


def check_receipt(item: dict[str, Any], _timeout: int) -> tuple[str, str]:
    """A dated proof from a live run, which EXPIRES.

    This is the answer to the worst failure mode available to this file: a
    human-typed verdict that is true on the day it is written and re-printed
    forever afterwards. That is the `currently` field this ledger exists to
    abolish, wearing a different name.

    A receipt passes only while it is fresh AND its reproduction path still
    exists in the tree. It does not decay into UNKNOWN, it FAILS, because a stale
    proof is actionable ("run it again") in a way that "we could not look" is not.
    An untracked reproduction path fails too: a proof nobody else can re-run is a
    claim, not evidence.
    """
    from datetime import date, timedelta  # noqa: PLC0415

    raw = str(item.get("verified_on") or "").strip()
    if not raw:
        # No passing run has ever been recorded. That is a FAIL, not an UNKNOWN:
        # the run is available to anyone who wants it, so the honest reading is
        # "nobody has made this true yet", which is work, not a blind spot.
        pending = str(item.get("pending") or "").strip()
        return FAIL, f"no passing receipt yet{': ' + pending if pending else ''}"
    try:
        verified = date.fromisoformat(raw)
    except ValueError:
        return FAIL, f"verified_on {raw!r} is not an ISO date"

    reproduce = str(item.get("reproduce") or "").strip()
    if not reproduce:
        return FAIL, "receipt names no reproduction path"
    if not (REPO_ROOT / reproduce).exists():
        return (
            FAIL,
            f"reproduction path {reproduce} is not in the tree, so nobody else can re-run it",
        )

    window = int(item.get("expires_after_days") or 30)
    expires = verified + timedelta(days=window)
    today = date.today()
    if today > expires:
        age = (today - verified).days
        return FAIL, f"receipt is {age}d old (window {window}d); re-run {reproduce}"
    return PASS, f"verified {raw}, fresh until {expires.isoformat()}"


CHECKS = {
    "pytest": check_pytest,
    "command": check_command,
    "grep": check_grep,
    "manual": check_manual,
    "receipt": check_receipt,
}


# --------------------------------------------------------------------------- #
# The judge
# --------------------------------------------------------------------------- #


def load_ledger(path: Path) -> list[dict[str, Any]]:
    import yaml  # noqa: PLC0415

    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    items = data.get("assertions") or []
    if not isinstance(items, list):
        raise ValueError("ledger 'assertions' must be a list")
    return items


class VoidRun(RuntimeError):
    """The judge's own controls failed, so it publishes no verdict at all.

    Borrowed verbatim in spirit from the house judging contract
    (`.codex/skills/puppy-one-harness/references/judging-contract.md`): a void run
    publishes NO result, "not a number with a caveat, because a number with a
    caveat gets quoted without the caveat". The same two controls apply here:
    a negative control that passes means the judge is not reading, and a positive
    control that fails means it over-flags, and its complaints are noise nobody
    can act on.
    """


def run_controls(timeout: int = 30) -> None:
    """Two synthetic items the judge must get right before it may grade anything.

    Cheap enough to run on every invocation, which is the point: the controls are
    worthless if they are a separate step someone can skip.
    """
    positive = {
        "id": "__control_pass__",
        "statement": "a check that must pass",
        "falsifiable": True,
        "check": {"kind": "command", "command": "true"},
    }
    negative = {
        "id": "__control_fail__",
        "statement": "a check that must fail",
        "falsifiable": True,
        "check": {"kind": "command", "command": "false"},
    }
    probe = judge([positive, negative], timeout=timeout, _controlled=False)
    got = {v.id: v.status for v in probe.verdicts}
    if got.get("__control_pass__") != PASS:
        raise VoidRun(
            "positive control did not pass: the judge over-flags, so its failures are noise"
        )
    if got.get("__control_fail__") != FAIL:
        raise VoidRun(
            "negative control did not fail: the judge is not reading, so nothing it says is worth having"
        )


def judge(
    items: list[dict[str, Any]],
    *,
    only: str = "",
    timeout: int = 300,
    _controlled: bool = True,
) -> JudgeReport:
    # The controls run before any real grading, and raise VoidRun rather than
    # returning a degraded verdict. `_controlled=False` is used only by the
    # controls themselves, so they cannot recurse.
    if _controlled:
        run_controls()
    report = JudgeReport()
    for item in items:
        ident = str(item.get("id") or "?")
        if only and only not in ident:
            continue
        check = item.get("check") or {}
        kind = str(check.get("kind") or "manual")
        runner = CHECKS.get(kind)
        if runner is None:
            status, detail = UNKNOWN, f"unknown check kind {kind!r}"
        elif item.get("blocked_by"):
            # Deliberately not evaluated: something outside our control gates it.
            # A judge that nags about the unfixable trains people to ignore it.
            status, detail = UNKNOWN, f"blocked: {item['blocked_by']}"
        else:
            status, detail = runner(check, timeout)
        report.verdicts.append(
            Verdict(
                id=ident,
                requirement=str(item.get("requirement") or ""),
                statement=str(item.get("statement") or ""),
                status=status,
                detail=detail,
                falsifiable=bool(item.get("falsifiable", False)),
                blocked_by=str(item.get("blocked_by") or ""),
                owner_action=str(item.get("owner_action") or ""),
            )
        )
    return report


def render(report: JudgeReport) -> str:
    c = report.to_dict()["counts"]
    lines = [
        "=" * 72,
        "DID WE FINISH IT?   private pod deployment",
        "=" * 72,
        f"  {c['pass']} passing   {c['fail']} failing   {c['unknown']} unknown"
        f"   {c['unfalsifiable']} not falsifiable   of {c['total']}",
        "",
    ]
    if report.finished:
        lines += ["  YES. Every item passes, every check ran, every check could have failed.", ""]
    else:
        lines += ["  NO. Still unfinished:", ""]

    if report.failing:
        lines.append("  FAILING (this is the work):")
        for v in report.failing:
            lines.append(f"    - [{v.requirement}] {v.statement}")
            if v.owner_action:
                lines.append(f"        next: {v.owner_action}")
            if v.detail:
                lines.append(f"        saw: {v.detail.splitlines()[-1][:120]}")
        lines.append("")
    if report.unknown:
        lines.append("  UNKNOWN (could not be evaluated here, NOT counted as done):")
        for v in report.unknown:
            reason = v.blocked_by or (v.detail.splitlines()[-1][:100] if v.detail else "")
            lines.append(f"    - [{v.requirement}] {v.statement}")
            if reason:
                lines.append(f"        why: {reason}")
        lines.append("")
    if report.unfalsifiable:
        lines.append("  NOT FALSIFIABLE (the check proves nothing, fix the check):")
        for v in report.unfalsifiable:
            lines.append(f"    - {v.id}: {v.statement}")
        lines.append("")
    if report.passing:
        lines.append(f"  PASSING ({len(report.passing)}):")
        for v in report.passing:
            lines.append(f"    - {v.statement}")
    lines.append("=" * 72)
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--ledger", default=str(DEFAULT_LEDGER))
    ap.add_argument("--only", default="", help="evaluate only ids containing this substring")
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--report-path", help="write the verdict JSON here")
    ap.add_argument(
        "--fail-on-unfinished",
        action="store_true",
        help="exit non-zero while anything is unfinished (the nag)",
    )
    args = ap.parse_args()

    ledger_path = Path(args.ledger)
    if not ledger_path.exists():
        print(f"ledger not found: {ledger_path}")
        return 2

    try:
        report = judge(load_ledger(ledger_path), only=args.only, timeout=args.timeout)
    except VoidRun as void:
        # No verdict at all, deliberately. A caveated number gets quoted without
        # the caveat, so the honest output here is the reason and nothing else.
        print("VOID RUN: the judge published no verdict.")
        print(f"  {void}")
        return 2
    print(render(report))
    if args.report_path:
        Path(args.report_path).write_text(json.dumps(report.to_dict(), indent=2))
    if args.fail_on_unfinished and not report.finished:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
