"""Summarise the in-Azure runs from the files the jobs wrote to blob. Numbers only.

usage: python analyze.py <downloaded-results-root> [<laptop-summary.json>]

Per run it reports what the repo harness graded (cases right, Nav goal completion), the
argument validity of every function call, latency split three ways (harness wall time,
model-only time of the successful HTTP attempt, time to response headers), tokens per
call from the transport's own usage, cost at list price, every HTTP attempt the SDK made
(so a silent 429 retry is counted), the serving region Azure reports, whether ADK usage
metadata equals the wire usage, and failure classes with one example each.

Negative controls, which must score low for the grading to mean anything:
  regraded     the run re-scored by the harness's own grader (must equal the report)
  always_fail  the same answers against an impossible expectation (must be 0)
  permuted     each case's answers against another case's expectation (near chance)
  null_model   never calling a tool / a canned non-answer (the floor to clear)
"""

from __future__ import annotations

import json
import statistics
import sys
from collections import Counter
from pathlib import Path

PRICES = {
    "gpt-5-mini": {"in": 0.25, "cached": 0.025, "out": 2.00},
    "gpt-6-luna": {"in": 0.10, "cached": 0.01, "out": 0.50},
    "gpt-5.6-luna": {"in": 0.20, "cached": 0.02, "out": 1.20},
}


def _harness():
    """The repo's own graders, so the controls exercise the real scoring code."""
    root = str(Path(__file__).resolve().parents[2])
    if root not in sys.path:
        sys.path.insert(0, root)
    from scripts import eval_one_first_tool as ft
    from scripts import eval_specialist_turns as es

    return ft, es


def _ft_controls(cases) -> dict:
    ft, _ = _harness()

    def graded(expected_for, got_for=None):
        total = 0
        for i, c in enumerate(cases):
            if c.get("status") != "completed":
                continue
            result = ft.CaseResult(
                c["id"],
                c["family"],
                c["prompt"],
                tuple(expected_for(i, c)),
                got_by_rep=list(got_for(c) if got_for else c["got_by_rep"]),
            )
            total += result.hit
        return total

    shift = len(cases) // 2 + 1
    return {
        "regraded_case_hits": graded(lambda i, c: c["expected"]),
        "always_fail_case_hits": graded(lambda i, c: ("__never__",)),
        "permuted_case_hits": graded(lambda i, c: cases[(i + shift) % len(cases)]["expected"]),
        "null_model_case_hits": graded(
            lambda i, c: c["expected"], lambda c: [None] * len(c["got_by_rep"])
        ),
    }


def _nav_controls(rows) -> dict:
    _, es = _harness()
    by_id = {case["id"]: case for case in es.load_cases()}
    regraded = always_fail = canned = 0
    for x in rows:
        case = by_id[x["id"]]
        ok = x["failure"] is None and not es.shape_errors(case, x["text"], x["directive"])
        regraded += ok and x["first_tool_hit"]
        impossible = {**case, "contains": [*case.get("contains", []), "__never_in_fixture__"]}
        always_fail += x["failure"] is None and not es.shape_errors(
            impossible, x["text"], x["directive"]
        )
        canned += not es.shape_errors(case, "I could not retrieve that right now.", None)
    return {
        "regraded_attempt_goal_hits": regraded,
        "always_fail_attempt_goal_hits": always_fail,
        "canned_non_answer_attempt_goal_hits": canned,
        "attempts": len(rows),
    }


def pct(values, q):
    values = [v for v in values if v is not None]
    if not values:
        return None
    s = sorted(values)
    pos = (len(s) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(s) - 1)
    return round(s[lo] + (s[hi] - s[lo]) * (pos - lo), 1)


def cost(model, inp, cached, out):
    p = PRICES[model]
    return ((inp - cached) * p["in"] + cached * p["cached"] + out * p["out"]) / 1e6


def mean(values):
    values = [v for v in values if v is not None]
    return round(statistics.mean(values), 1) if values else None


def ok_attempt_ms(w):
    good = [a["ms"] for a in w.get("attempts", []) if a.get("status") == 200]
    return good[-1] if good else None


def wire_block(model, wires):
    """Per-call token, latency, retry and effort statistics over raw wire records."""
    done = [w for w in wires if w.get("input_tokens") is not None]
    attempts = [a for w in wires for a in w.get("attempts", [])]
    statuses = Counter(a.get("status") for a in attempts)
    out = {
        "http_calls": len(wires),
        "http_attempts": len(attempts),
        "attempt_statuses": dict(statuses),
        "calls_with_retry": sum(1 for w in wires if len(w.get("attempts", [])) > 1),
        "wire_errors": sorted(
            {
                (w.get("error_status"), (w.get("error_message") or "")[:90])
                for w in wires
                if w.get("error_status") or w.get("error_message")
            }
        ),
        "regions": dict(Counter(a.get("region") for a in attempts if a.get("status") == 200)),
        "credential": sorted({w.get("credential") for w in wires}),
        "store": sorted({str(w.get("store")) for w in wires}),
        "transport_effort": dict(Counter(str(w.get("transport_effort")) for w in wires)),
        "sent_effort": dict(Counter(str(w.get("sent_effort")) for w in wires)),
        "reported_effort": dict(Counter(str(w.get("reported_effort")) for w in wires)),
        "status": dict(Counter(str(w.get("status")) for w in wires)),
        "incomplete": dict(
            Counter(w.get("incomplete_reason") for w in wires if w.get("incomplete_reason"))
        ),
        "call_ms_p50": pct([w.get("elapsed_ms") for w in done], 0.5),
        "call_ms_p95": pct([w.get("elapsed_ms") for w in done], 0.95),
        "headers_ms_p50": pct([ok_attempt_ms(w) for w in done], 0.5),
        "first_output_ms_p50": pct([w.get("first_output_ms") for w in done], 0.5),
    }
    if done:
        inp = [w["input_tokens"] for w in done]
        cached = [w.get("cached_tokens") or 0 for w in done]
        outp = [w["output_tokens"] for w in done]
        reason = [w.get("reasoning_tokens") or 0 for w in done]
        out.update(
            input_mean=mean(inp),
            cached_mean=mean(cached),
            output_mean=mean(outp),
            reasoning_mean=mean(reason),
            reasoning_max=max(reason),
            cached_share=round(sum(cached) / sum(inp), 3) if sum(inp) else None,
            usd_per_1000_calls=round(
                sum(cost(model, a, b, c) for a, b, c in zip(inp, cached, outp, strict=True))
                / len(done)
                * 1000,
                4,
            ),
            usd_per_1000_calls_uncached=round(
                sum(cost(model, a, 0, c) for a, c in zip(inp, outp, strict=True))
                / len(done)
                * 1000,
                4,
            ),
        )
    return out


def first_tool(run_dir: Path, model: str) -> dict:
    report = json.loads(next(run_dir.glob("one_first_tool_eval_*_production.json")).read_text())
    probe = json.loads((run_dir / "probe_rows.json").read_text())
    cases = report["cases"]
    rows = [r for r in probe["rows"] if "wire" in r]
    wires = [w for r in rows for w in r["wire"]]

    def hit(got, expected):
        return (got is None and "no_tool" in expected) or got in expected

    rep_hits = sum(1 for c in cases for g in c["got_by_rep"] if hit(g, c["expected"]))
    reps = sum(len(c["got_by_rep"]) for c in cases)
    calls = [x for r in rows for x in (r.get("detail") or {}).get("calls", [])]
    checked = [x for x in calls if x["args_valid"] is not None]
    adk_equal = [
        r["detail"]["adk_usage"]["prompt"] == r["wire"][-1]["input_tokens"]
        and r["detail"]["adk_usage"]["candidates"] == r["wire"][-1]["output_tokens"]
        for r in rows
        if (r.get("detail") or {}).get("adk_usage")
        and r["wire"]
        and r["wire"][-1].get("input_tokens") is not None
    ]
    classes: dict[str, dict] = {}
    for c in cases:
        for g in c["got_by_rep"]:
            if hit(g, c["expected"]):
                continue
            if g is None:
                kind = "answered_in_text_instead_of_tool"
            elif "no_tool" in c["expected"]:
                kind = "tool_call_when_none_needed"
            elif str(g).startswith("run_app_action") and any(
                str(e).startswith("run_app_action") for e in c["expected"]
            ):
                kind = "wrong_app_action"
            elif any(str(e).startswith("delegate") or "agent" in str(e) for e in c["expected"]):
                kind = "missed_delegation"
            else:
                kind = "wrong_tool"
            slot = classes.setdefault(kind, {"count": 0, "example": None})
            slot["count"] += 1
            slot["example"] = slot["example"] or {
                "case": c["id"],
                "prompt": c["prompt"][:90],
                "got": g,
                "expected": c["expected"],
            }
    infra = [c["id"] for c in cases if c.get("status") != "completed"]
    roster = set(probe.get("azure_roster", []))
    unreachable = [
        c["id"]
        for c in cases
        if not any(str(e).split(":")[0] in roster | {"no_tool"} for e in c["expected"])
    ]
    reachable_hits = sum(1 for c in cases if c["hit"] and c["id"] not in unreachable)
    return {
        "label": run_dir.name,
        "model": model,
        "reasoning": probe.get("reasoning_setting"),
        "credential": probe.get("credential"),
        "in_azure": probe.get("in_azure"),
        "roster_tools": len(probe.get("azure_roster", [])),
        "cases": report["overall"]["cases"],
        "case_hits": report["overall"]["hits"],
        "rep_hits": rep_hits,
        "reps": reps,
        "complete": report["measurement_complete"],
        "infra_incomplete_cases": infra,
        "pod_mode_env": probe.get("hussh_pod_mode_env"),
        "unreachable_cases": unreachable,
        "reachable_case_hits": f"{reachable_hits}/{len(cases) - len(unreachable)}",
        "families": {k: f"{v['hits']}/{v['cases']}" for k, v in report["families"].items()},
        "wall_ms_p50": report["latency_ms"]["p50"],
        "wall_ms_p95": report["latency_ms"]["p95"],
        "tool_calls": len(calls),
        "args_checked": len(checked),
        "args_invalid": [(x["name"], x["error"]) for x in checked if not x["args_valid"]],
        "parallel_call_answers": sum(
            1 for r in rows if len((r.get("detail") or {}).get("calls", [])) > 1
        ),
        "adk_usage_equals_wire": f"{sum(adk_equal)}/{len(adk_equal)}",
        "failure_classes": classes,
        "controls": _ft_controls(cases),
        **wire_block(model, wires),
    }


def nav(run_dir: Path, model: str) -> dict:
    report = json.loads((run_dir / "nav_report.json").read_text())
    rows = report["results"]
    wires = [w for x in rows for w in x.get("wire", [])]
    per_turn = []
    for x in rows:
        ws = [w for w in x.get("wire", []) if w.get("input_tokens") is not None]
        if ws and len(ws) == len(x.get("wire", [])):
            per_turn.append(
                (
                    sum(w["input_tokens"] for w in ws),
                    sum((w.get("cached_tokens") or 0) for w in ws),
                    sum(w["output_tokens"] for w in ws),
                    sum((w.get("reasoning_tokens") or 0) for w in ws),
                )
            )
    classes: dict[str, dict] = {}
    for x in rows:
        if x["first_tool_hit"] and x["shape_hit"]:
            continue
        if x.get("failure"):
            kind = f"exception:{x['failure']}"
        elif not x["first_tool_hit"]:
            kind = "wrong_first_tool" if x["observed"] != "no_tool" else "no_tool_called"
        else:
            kind = "answer_shape:" + ",".join(sorted({e.split(":")[0] for e in x["shape_errors"]}))
        slot = classes.setdefault(kind, {"count": 0, "example": None})
        slot["count"] += 1
        slot["example"] = slot["example"] or {
            "case": x["id"],
            "observed": x["observed"],
            "shape_errors": x["shape_errors"],
            "failure_chain": x.get("failure_chain"),
            "text": (x.get("text") or "")[:160],
        }
    meta = report.get("run_meta", {})
    return {
        "label": run_dir.name,
        "model": model,
        "reasoning": meta.get("reasoning_setting"),
        "credential": meta.get("credential"),
        "in_azure": meta.get("in_azure"),
        "cases": report["cases"],
        "runs": report["runs"],
        "first_tool_rate": round(report["first_tool_rate"], 3),
        "goal_completion_rate": round(report["shape_rate"], 3),
        "attempts": len(rows),
        "attempt_first_tool_hits": sum(x["first_tool_hit"] for x in rows),
        "attempt_goal_hits": sum(x["shape_hit"] for x in rows),
        "exceptions": sum(1 for x in rows if x.get("failure")),
        "turn_ms_p50": round(report["latency_ms"]["p50"], 1),
        "turn_ms_p95": round(report["latency_ms"]["p95"], 1),
        "model_calls_per_turn": round(report["model_calls"] / len(rows), 2),
        "effective_model": report["effective_model"],
        "gates": report["gates"]["breaches"],
        "failure_classes": classes,
        "tokens_per_turn": {
            "input": mean(t[0] for t in per_turn),
            "cached": mean(t[1] for t in per_turn),
            "output": mean(t[2] for t in per_turn),
            "reasoning": mean(t[3] for t in per_turn),
        }
        if per_turn
        else None,
        "usd_per_1000_turns": round(
            statistics.mean(cost(model, *t[:3]) for t in per_turn) * 1000, 4
        )
        if per_turn
        else None,
        "controls": _nav_controls(rows),
        **wire_block(model, wires),
    }


def structured(run_dir: Path, model: str) -> dict:
    data = json.loads((run_dir / "structured.json").read_text())
    rows = data["rows"]
    wires = [w for r in rows for w in r["wire"]]
    return {
        "label": run_dir.name,
        "model": model,
        "reasoning": data.get("reasoning_setting"),
        "valid": sum(r["valid"] for r in rows),
        "refs_match": sum(bool(r.get("refs_match")) for r in rows),
        "n": len(rows),
        "ms_p50": pct([r["elapsed_ms"] for r in rows], 0.5),
        "ms_p95": pct([r["elapsed_ms"] for r in rows], 0.95),
        "errors": [r.get("error") for r in rows if not r["valid"]],
        **wire_block(model, wires),
    }


def main() -> None:
    root = Path(sys.argv[1])
    out: dict = {"first_tool": [], "nav": [], "structured": [], "preflight": [], "status": []}
    for lane in sorted(p for p in root.iterdir() if p.is_dir()):
        if (lane / "preflight.json").exists():
            out["preflight"].append(json.loads((lane / "preflight.json").read_text()))
        if (lane / "status.json").exists():
            out["status"].append(json.loads((lane / "status.json").read_text()))
        for run_dir in sorted(p for p in lane.iterdir() if p.is_dir()):
            if (run_dir / "probe_rows.json").exists():
                meta = json.loads((run_dir / "probe_rows.json").read_text())
                out["first_tool"].append(first_tool(run_dir, meta["deployment"]))
            elif (run_dir / "nav_report.json").exists():
                meta = json.loads((run_dir / "nav_report.json").read_text())
                out["nav"].append(nav(run_dir, meta["run_meta"]["deployment"]))
            elif (run_dir / "structured.json").exists():
                meta = json.loads((run_dir / "structured.json").read_text())
                out["structured"].append(structured(run_dir, meta["deployment"]))
    if len(sys.argv) > 2:
        out["laptop_baseline"] = json.loads(Path(sys.argv[2]).read_text())
    (root / "summary.json").write_text(json.dumps(out, indent=1, default=str))
    print(json.dumps(out, indent=1, default=str))


if __name__ == "__main__":
    main()
