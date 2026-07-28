#!/usr/bin/env python3
"""Regression test for route.py --hook mode (UserPromptSubmit contract).

Run:
    python3 .claude/skills/codex-bridge/scripts/test_route_hook.py

The hook contract:
  - Never block the turn: exit code must be 0 on every path, including malformed stdin.
  - Silent on weak matches: empty stdout for chitchat, short prompts, missing fields.
  - Confidence tiers: full briefing only on a strong, unambiguous match; a compact
    pointer between the gates; silence below them.
  - Reply rules load only for the community lane, never for engineering questions.
  - Env kill-switch: CODEX_BRIDGE_DISABLE=1 forces silence.

It also runs the routing-accuracy fixtures in `../fixtures/routing_cases.json`,
which pin the lane each representative prompt must reach and cap the total
injected size so a token regression fails CI.

Exits non-zero if any assertion fails so CI can depend on it.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).parent / "route.py"
FIXTURES = Path(__file__).parents[1] / "fixtures" / "routing_cases.json"


def run_hook(payload: str, env: dict | None = None) -> tuple[str, int]:
    proc = subprocess.run(
        ["python3", str(SCRIPT), "--hook"],
        input=payload,
        capture_output=True,
        text=True,
        env={**os.environ, **(env or {})},
        timeout=20,
    )
    return proc.stdout, proc.returncode


def payload(prompt: str) -> str:
    return json.dumps({
        "session_id": "test",
        "cwd": str(Path.cwd()),
        "hook_event_name": "UserPromptSubmit",
        "prompt": prompt,
    })


FAILED: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  pass  {name}")
    else:
        print(f"  FAIL  {name}  {detail}")
        FAILED.append(name)


FULL_MARKER = "matched **"
COMPACT_MARKER = "possible match for **"
REPLY_RULES_MARKER = "Response format (codex Q&A rules)"


def classify(out: str) -> tuple[str, str, str]:
    """Return (tier, kind, id) for a hook response: tier is full|compact|silent."""
    for line in out.splitlines():
        for marker, tier in ((FULL_MARKER, "full"), (COMPACT_MARKER, "compact")):
            if marker in line:
                label = line.split(marker, 1)[1].split("**", 1)[0]
                kind, _, ident = label.partition(" ")
                return tier, kind.strip(), ident.strip().strip("`")
    return "silent", "", ""


def run_composition_checks() -> None:
    """Assertions the prompt fixtures structurally cannot make.

    A fixture can only see what the hook emits for one prompt. These check
    invariants across the whole corpus and across entry points.
    """
    print("\n=== composition and parity invariants ===")
    sys.path.insert(0, str(Path(__file__).parent))
    import route  # noqa: PLC0415

    repo_root = route.find_repo_root(Path(__file__).parent)
    skills, workflows, agents = route.discover(repo_root)
    by_id = {s.name: s for s in skills}

    # Every declared Read First entry must survive into the briefing. The body's
    # own Read First section is stripped during composition, so anything the
    # recomposition drops is gone from the briefing entirely.
    lost: list[str] = []
    for skill in skills:
        briefing = route.compose_skill_briefing(skill, workflows, by_id)
        for read in skill.manifest.get("required_reads") or []:
            if str(read) not in briefing:
                lost.append(f"{skill.name}:{read}")
    check(
        "no skill briefing drops a required_read",
        not lost,
        f"{len(lost)} lost, e.g. {lost[:4]}",
    )

    # A name must resolve to the same lane through the hook and through the CLI:
    # the compact briefing footer tells the user to run `/codex-bridge <name>`.
    ordered = [(workflows, "workflow"), (skills, "skill"), (agents, "agent")]
    mismatched: list[str] = []
    for name in ("reviewer", "morphy-ax", "hushh-consent-mcp", "governor", "repo-operations"):
        resolved = route.named_match(name, ordered)
        if not resolved:
            mismatched.append(f"{name}: unresolved")
            continue
        entry, kind = resolved
        out, _ = run_hook(payload(name))
        if f"{kind} `{entry.name}`" not in out:
            mismatched.append(f"{name}: hook disagrees with named_match -> {kind} {entry.name}")
    check("hook and CLI resolve a typed name to the same lane", not mismatched, str(mismatched))

    # The Discord tone contract is ~3.3k tokens. It must not ride along on
    # engineering turns, and must not go missing on channel-named turns.
    rules_cases = [
        ("should I respond to this review comment on the PR?", False),
        ("can you review and respond to the failing check?", False),
        ("why is the consent export failing for this user?", False),
        ("draft a reply for the discord thread about BYOK", True),
        ("write the discord announcement for the new release", True),
    ]
    wrong: list[str] = []
    for prompt, want_rules in rules_cases:
        out, _ = run_hook(payload(prompt))
        if (REPLY_RULES_MARKER in out) != want_rules:
            wrong.append(f"{prompt!r} expected rules={want_rules}")
    check("reply rules load only for community-channel turns", not wrong, str(wrong))


def run_routing_fixtures() -> None:
    print("\n=== routing accuracy fixtures ===")
    spec = json.loads(FIXTURES.read_text())
    budget = int(spec.get("total_char_budget") or 0)
    spent = 0
    for case in spec["cases"]:
        prompt = case["prompt"]
        out, code = run_hook(payload(prompt))
        spent += len(out)
        tier, kind, ident = classify(out)
        label = f"{prompt[:46]!r} -> {tier}:{ident or '-'}"
        if code != 0:
            check(label, False, f"non-zero exit {code}")
            continue
        if case.get("expect_silent"):
            check(label, tier == "silent", f"expected silence, got {tier}:{ident}")
            continue
        ok, detail = True, ""
        if case.get("expect_id") and ident != case["expect_id"]:
            ok, detail = False, f"expected id {case['expect_id']}, got {ident or 'silence'}"
        if ok and case.get("expect_kind") and kind != case["expect_kind"]:
            ok, detail = False, f"expected kind {case['expect_kind']}, got {kind or 'silence'}"
        if ok and case.get("forbid_id") and ident == case["forbid_id"]:
            ok, detail = False, f"routed to forbidden lane {ident}"
        if ok and case.get("max_tier") == "compact" and tier == "full":
            ok, detail = False, "emitted a full briefing on a low-confidence match"
        if ok and case.get("forbid_reply_rules") and REPLY_RULES_MARKER in out:
            ok, detail = False, "community reply rules leaked into an engineering turn"
        if ok and case.get("expect_reply_rules") and REPLY_RULES_MARKER not in out:
            ok, detail = False, "community lane lost its reply rules"
        check(label, ok, detail)
    if budget:
        check(
            f"total injected size {spent} <= budget {budget}",
            spent <= budget,
            f"over budget by {spent - budget} chars",
        )


def main() -> int:
    print("=== codex-bridge route.py --hook regression ===")

    out, code = run_hook("")
    check("empty stdin is silent and exit 0", out.strip() == "" and code == 0, f"code={code} out={out!r}")

    out, code = run_hook("not json at all")
    check("malformed stdin is silent and exit 0", out.strip() == "" and code == 0, f"code={code} out={out!r}")

    out, code = run_hook(json.dumps(["a", "b"]))
    check("non-dict json stdin is silent", out.strip() == "" and code == 0)

    out, code = run_hook(json.dumps({"session_id": "x"}))
    check("missing prompt field is silent", out.strip() == "" and code == 0)

    out, code = run_hook(payload("hi"))
    check("prompt shorter than floor is silent", out.strip() == "" and code == 0)

    out, code = run_hook(payload("hey how are you doing today friend"))
    check("chitchat is silent", out.strip() == "" and code == 0, f"leaked={out[:160]!r}")

    out, code = run_hook(payload("repo-operations"))
    check(
        "exact skill name emits wrapped briefing",
        code == 0
        and "Auto-routed by codex-bridge" in out
        and "skill `repo-operations`" in out,
        f"head={out[:200]!r}",
    )

    out, code = run_hook(payload("ci-watch-and-heal"))
    check(
        "exact workflow name emits wrapped briefing",
        code == 0
        and "Auto-routed by codex-bridge" in out
        and "workflow `ci-watch-and-heal`" in out,
        f"head={out[:200]!r}",
    )

    out, code = run_hook(payload("repo-operations guidance for branch protection and merge queue state"))
    check(
        "strong free-text match emits wrapped briefing",
        code == 0 and "Auto-routed by codex-bridge" in out,
        f"head={out[:200]!r}",
    )

    out, code = run_hook(payload("how does repo-operations manage branch protection and merge queue settings?"))
    check(
        "engineering Q&A does not pull in the community reply rules",
        code == 0
        and "Response format (codex Q&A rules)" not in out
        and "Auto-routed by codex-bridge" in out,
        f"head={out[:200]!r}",
    )

    out, code = run_hook(payload("draft a reply for the discord community question about BYOK"))
    check(
        "community-reply lane still prepends the reply-rules header",
        code == 0 and "Response format (codex Q&A rules)" in out,
        f"head={out[:200]!r}",
    )

    out, code = run_hook(
        payload("how does repo-operations manage branch protection and merge queue settings?"),
        env={"CODEX_BRIDGE_DISABLE": "1"},
    )
    check(
        "CODEX_BRIDGE_DISABLE=1 forces silence even on strong match",
        out.strip() == "" and code == 0,
        f"code={code} out={out[:120]!r}",
    )

    # Agent-extension regression cases ----------------------------------------

    out, code = run_hook(payload("governor"))
    check(
        "exact agent name (short) emits final-authority agent briefing",
        code == 0
        and "Auto-routed by codex-bridge" in out
        and "agent `governor`" in out
        and "Final merge/deploy/plan recommendations" in out
        and "delegation lane" in out.lower(),
        f"head={out[:240]!r}",
    )

    out, code = run_hook(payload("reviewer"))
    check(
        "exact advisory agent name emits advisory-only authority",
        code == 0
        and "agent `reviewer`" in out
        and "Advisory-only" in out,
        f"head={out[:240]!r}",
    )

    out, code = run_hook(payload("Northstar Summit Keystone evidence synthesis lane"))
    check(
        "agent-primary fallback routes to governor when no skill or workflow clears its gate",
        code == 0 and "agent `governor`" in out,
        f"head={out[:240]!r}",
    )

    out, code = run_hook(payload("vault PKM boundary encrypted storage rules"))
    check(
        "skill briefing for non-Q&A query includes Suggested delegation lanes footer",
        code == 0
        and "skill `vault-pkm-governance`" in out
        and "Suggested delegation lanes" in out
        and "`security_consent_auditor`" in out,
        f"excerpt={out[-600:]!r}",
    )

    out, code = run_hook(payload("how does vault PKM boundary encryption handle storage rules?"))
    check(
        "Q&A plus skill match suppresses agent lanes footer",
        code == 0
        and "skill `vault-pkm-governance`" in out
        and "Suggested delegation lanes" not in out,
        f"excerpt={out[-400:]!r}",
    )

    out, code = run_hook(payload("architecture review across frontend and backend and voice contracts"))
    check(
        "close-scoring multi-agent tie suppresses delegation footer",
        code == 0 and "Suggested delegation lanes" not in out,
        f"excerpt={out[-400:]!r}",
    )

    run_composition_checks()
    run_routing_fixtures()

    if FAILED:
        print(f"\n{len(FAILED)} check(s) failed: {FAILED}")
        return 1
    print("\nall checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
