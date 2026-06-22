#!/usr/bin/env python3
"""Scan ALL unattended train PRs through the engine in <=50-PR chunks,
consolidate per-PR lane/decision/comment/files. Resumable: skips chunks
whose output already exists. Writes tmp/unattended-full-actions.json."""
import json, subprocess, os, math

state=json.load(open("tmp/state.json"))
un=state["unattended"]
CHUNK=50
chunks=[un[i:i+CHUNK] for i in range(0,len(un),CHUNK)]
print(f"unattended={len(un)} chunks={len(chunks)}")

for idx,ch in enumerate(chunks):
    out=f"tmp/un-chunk-{idx}.json"
    if os.path.exists(out):
        print(f"chunk {idx}: exists, skip"); continue
    prs=",".join(str(n) for n in ch)
    try:
        rc=subprocess.run(["python3",".codex/skills/pr-governance-review/scripts/pr_review_checklist.py",
            "--repo","hushh-labs/hushh-research","--prs",prs,"--json","--output",out],
            capture_output=True,text=True,timeout=420)
        print(f"chunk {idx}: rc={rc.returncode} -> {out}")
    except subprocess.TimeoutExpired:
        print(f"chunk {idx}: TIMEOUT after 420s -> skipped (will retry next run)")

# consolidate
def author(pr):
    a=pr.get("author"); return a if isinstance(a,str) else (a or {}).get("login")
allreps={}
for idx in range(len(chunks)):
    out=f"tmp/un-chunk-{idx}.json"
    if not os.path.exists(out): continue
    d=json.load(open(out))
    for r in d["reports"]:
        n=r["pr"]["number"]
        allreps[n]={"lane":r["lane"],"policy":r["public_comment_policy"],
            "comment":r.get("communication_markdown",""),"base":r["pr"]["base_ref"],
            "head":r["pr"]["head_sha"],"author":author(r["pr"]),"title":r["pr"]["title"],
            "files":r["changed_files"],"attach":r.get("canonical_attach_point"),
            "mergeable":r["pr"].get("mergeable"),"contract":r["contract_set"]}
json.dump(allreps,open("tmp/unattended-full-actions.json","w"))
from collections import Counter
print("consolidated:",len(allreps),"lanes:",dict(Counter(r["lane"] for r in allreps.values())))
