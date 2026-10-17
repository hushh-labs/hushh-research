"""Pair in-Azure runs with the 2026-10-03 laptop runs that share model + effort.

usage: python compare_laptop.py <azure summary.json> <laptop summary.json>
"""

import json
import sys

azure = json.load(open(sys.argv[1]))
laptop = json.load(open(sys.argv[2]))

# laptop label -> (model, effort as sent on Chat Completions)
FT = {
    "ft-gpt-5-mini": ("gpt-5-mini", "default"),
    "ft-gpt-5-mini-effort-low": ("gpt-5-mini", "low"),
    "ft-gpt-6-luna-effort-none": ("gpt-6-luna", "none"),
    "ft-gpt-5.6-luna": ("gpt-5.6-luna", "default"),
}
NAV = {
    "nav-gpt-5-mini": ("gpt-5-mini", "default"),
    "nav-gpt-5-mini-low": ("gpt-5-mini", "low"),
    "nav-gpt-6-luna-none": ("gpt-6-luna", "none"),
    "nav-gpt-5.6-luna": ("gpt-5.6-luna", "default"),
}


def find(kind, model, effort):
    for r in azure[kind]:
        if (
            r["model"] == model
            and r["reasoning"] == effort
            and r.get("pod_mode_env", "0") in ("0", None)
        ):
            return r
    return None


print(
    "| run | laptop cases right | Azure cases right | laptop wall p50/p95 | Azure wall p50/p95 |"
    " Azure model call p50 | laptop $/1k | Azure $/1k |"
)
print("|---|---|---|---|---|---|---|---|")
for old in laptop["first_tool"]:
    if old["label"] not in FT:
        continue
    model, effort = FT[old["label"]]
    new = find("first_tool", model, effort)
    if new is None:
        continue
    print(
        f"| {model} {effort} | {old['case_hits']}/{old['cases']}"
        f"{'' if old['complete'] else ' (incomplete)'} | {new['case_hits']}/{new['cases']} |"
        f" {old['p50_ms']}/{old['p95_ms']} | {new['wall_ms_p50']}/{new['wall_ms_p95']} |"
        f" {new['call_ms_p50']} | {old['usd_per_1000_calls_measured']} |"
        f" {new['usd_per_1000_calls']} |"
    )
print()
print(
    "| run | laptop first tool / goal | Azure first tool / goal | laptop turn p50/p95 |"
    " Azure turn p50/p95 | laptop $/1k turns | Azure $/1k turns |"
)
print("|---|---|---|---|---|---|---|")
for old in laptop["nav"]:
    if old["label"] not in NAV:
        continue
    model, effort = NAV[old["label"]]
    new = find("nav", model, effort)
    if new is None:
        continue
    print(
        f"| {model} {effort} | {old['first_tool_rate']:.0%} / {old['shape_rate']:.0%} |"
        f" {new['first_tool_rate']:.0%} / {new['goal_completion_rate']:.0%} |"
        f" {round(old['p50_ms'])}/{round(old['p95_ms'])} |"
        f" {round(new['turn_ms_p50'])}/{round(new['turn_ms_p95'])} |"
        f" {old['usd_per_1000_turns']} | {new['usd_per_1000_turns']} |"
    )
