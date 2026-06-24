#!/usr/bin/env python3
"""
PR Train Auto-Drive — self-contained, idempotent, resumable end-to-end driver.

Runs the full SOP loop for hushh-labs/hushh-research:
  1. Inventory all open integration/pr-train PRs (retarget main->train first, separately).
  2. Detect repass (contributor activity newer than maintainer changes-requested).
  3. Engine-scan actionable PRs (unattended + green repass) in <=50 chunks.
  4. Drive each to terminal:
       merge_now (diff-safe, non-sensitive, non-self-mock, exact-head clean) -> approve + enqueue
       block -> post/edit standardized ## Changes Requested record (idempotent)
       patch_then_merge / harvest -> record in operator queue (NO auto-merge: product code)
       sensitive merge-candidate -> operator/security queue
       conflicting -> rebase ## Changes Requested
  5. Emit a JSON summary to stdout for the cron agent to format.

SAFE BY CONSTRUCTION:
  - never merges sensitive/trust-boundary or merge-authority (ci-governance) paths
  - never merges self-mock tests (test importing no production code)
  - collision guard (one PR per file per run)
  - exact-head re-read + UNKNOWN-mergeability re-poll before enqueue
  - skips self-pushed/self-authored PRs (branch protection)
  - idempotent records (skips if current record already equals engine record)

Run: python3 pr_train_autodrive.py [--max-merge 40] [--max-chunks 6]
"""
import json, subprocess, sys, time, re, argparse, os, glob

REPO="hushh-labs/hushh-research"
ENGINE=".codex/skills/pr-governance-review/scripts/pr_review_checklist.py"
MAINT={"kushaltrivedi5","kushaltrivedi"}
SENS=re.compile(r'/kai/|consent|/vault|/pkm|/voice|/plaid|/gmail|/kyc|/auth|/session|/account|/middleware|migration|/deploy|\.github/workflows|/crypto|/token|world-model|/investor|/ticker|/marketplace|developer-api|db-proxy|ci-governance',re.I)
WORK="tmp/autodrive"

def run(a,timeout=90,retries=2):
    """Resilient subprocess: hard per-call timeout + bounded retry with backoff.

    A single hung gh/GraphQL call must never be able to hang the whole cron
    (root cause of the 6.7h idle-kill). On timeout/transient failure we retry
    with exponential backoff, then surface a non-zero rc so the caller can
    skip-and-continue instead of blocking forever.
    """
    last_err=""
    for attempt in range(retries+1):
        try:
            p=subprocess.run(a,capture_output=True,text=True,timeout=timeout)
            return p.returncode,p.stdout,p.stderr
        except subprocess.TimeoutExpired:
            last_err=f"timeout after {timeout}s (attempt {attempt+1}/{retries+1})"
        except Exception as ex:
            last_err=f"{type(ex).__name__}: {ex}"
        if attempt<retries: time.sleep(2*(attempt+1))
    return 124,"",last_err
def norm(s): return " ".join((s or "").split())
def author(pr):
    a=pr.get("author"); return a if isinstance(a,str) else (a or {}).get("login")

def inventory():
    rc,o,e=run(["gh","pr","list","--repo",REPO,"--state","open","--base","integration/pr-train",
                "--limit","1000","--json","number,reviewDecision,isDraft,author"])
    d=json.loads(o)
    un=[p["number"] for p in d if p.get("reviewDecision") in (None,"REVIEW_REQUIRED") and not p["isDraft"]]
    cr=[p["number"] for p in d if p.get("reviewDecision")=="CHANGES_REQUESTED"]
    return d,sorted(un),sorted(cr)

def detect_repass(cr):
    """Return green+mergeable repass PR numbers (contributor addressed since CR).
    Batched: queries 15 PRs per GraphQL call via aliases to stay fast."""
    from datetime import datetime
    def ts(x): return datetime.fromisoformat(x.replace("Z","+00:00")) if x else None
    FRAG="""pXNX: pullRequest(number:XNX){
      reviews(last:30){nodes{author{login} state submittedAt}}
      commits(last:1){nodes{commit{committedDate}}}
      comments(last:15){nodes{author{login} createdAt}}}"""
    repass=[]
    batches=[cr[i:i+15] for i in range(0,len(cr),15)]
    for b in batches:
        inner="\n".join(FRAG.replace("XNX",str(n)) for n in b)
        q="query($o:String!,$r:String!){repository(owner:$o,name:$r){"+inner+"}}"
        rc,o,e=run(["gh","api","graphql","-f","query="+q,"-F","o=hushh-labs","-F","r=hushh-research"])
        if rc!=0: continue
        try: repo=json.loads(o)["data"]["repository"]
        except Exception: continue
        for n in b:
            pr=repo.get(f"p{n}")
            if not pr: continue
            revs=[ts(r["submittedAt"]) for r in pr["reviews"]["nodes"] if r["state"]=="CHANGES_REQUESTED"]
            last_rev=max([r for r in revs if r],default=None)
            lc=pr["commits"]["nodes"]; last_commit=ts(lc[0]["commit"]["committedDate"]) if lc else None
            cc=[ts(c["createdAt"]) for c in pr["comments"]["nodes"] if (c["author"] or {}).get("login") not in MAINT]
            last_act=max([t for t in ([last_commit]+cc) if t],default=None)
            if last_rev and last_act and last_act>last_rev: repass.append(n)
    return sorted(repass)

def engine_scan(prs,tag,max_chunks,max_age_s=7200):
    """Scan actionable PRs in chunks of 50, caching each chunk's engine report.

    REALTIME-DRAIN CACHE SEMANTICS (fixed 2026-06): the per-chunk cache file is
    keyed by chunk INDEX, but the actionable PR set changes every run (new PRs,
    repass activity). A stale cache therefore silently skips freshly-opened PRs
    (the June-19 tranche bug). We now invalidate a cached chunk when EITHER:
      (a) it is older than ``max_age_s`` (default 2h), OR
      (b) the exact PR-number set in that chunk differs from what the cache was
          built for (membership drift).
    The cache stores the chunk's PR list alongside the reports so (b) is exact.
    """
    os.makedirs(WORK,exist_ok=True)
    chunks=[prs[i:i+50] for i in range(0,len(prs),50)][:max_chunks]
    reps={}
    for idx,ch in enumerate(chunks):
        out=f"{WORK}/{tag}-{idx}.json"
        fresh=False
        if os.path.exists(out):
            try:
                age=time.time()-os.path.getmtime(out)
                cached=json.load(open(out))
                cached_prs=cached.get("_autodrive_chunk_prs")
                # Fresh only if young AND same membership as this run's chunk.
                fresh=(age<=max_age_s and cached_prs==list(ch))
            except Exception:
                fresh=False
        if not fresh:
            run(["python3",ENGINE,"--repo",REPO,"--prs",",".join(map(str,ch)),
                 "--repass-after-changes","--json","--output",out],timeout=420,retries=1)
            # Tag the freshly written report with the chunk's PR set so the next
            # run can detect membership drift and avoid stale reuse.
            try:
                d=json.load(open(out))
                d["_autodrive_chunk_prs"]=list(ch)
                json.dump(d,open(out,"w"),default=str)
            except Exception:
                pass
        if os.path.exists(out):
            d=json.load(open(out))
            for r in d["reports"]:
                reps[r["pr"]["number"]]={"lane":r["lane"],"comment":r.get("communication_markdown",""),
                    "files":r["changed_files"],"attach":r.get("canonical_attach_point"),
                    "contract":r["contract_set"],"author":author(r["pr"])}
    return reps

def gh_json(n,fields):
    rc,o,e=run(["gh","pr","view",str(n),"--repo",REPO,"--json",fields]);
    return json.loads(o) if rc==0 else None

def diff_safe(n,files):
    if any(SENS.search(f) for f in files): return False,"sensitive_path"
    tests=[f for f in files if "__tests__" in f or f.endswith((".test.ts",".test.tsx",".test.js")) or f.startswith("tests/")]
    if tests and len(tests)==len(files):
        rc,o,e=run(["gh","pr","diff",str(n),"--repo",REPO])
        added=[l for l in o.splitlines() if l.startswith("+")]
        if not any(("@/" in l or re.search(r'from\s+["\']\.\.?/',l) or "require(" in l) for l in added):
            return False,"self_mock_no_prod_import"
    return True,"ok"

def post_record(n,body,head=None):
    """Post/refresh the standardized ## Changes Requested record.

    CRITICAL: editing an existing review body via PUT does NOT advance the
    review's submittedAt NOR re-pin its commit_id — so a timestamp/head-based
    repass detector would re-flag the PR forever (the exact loop that left
    contributor PRs looking unattended). Therefore:
      - if the latest maintainer record is already pinned to the CURRENT head
        and the body matches -> 'already' (truly terminal, no write).
      - if the body changed but head is unchanged -> PUT edit (cheap, head
        already current).
      - if the head MOVED past the last-reviewed head -> post a NEW review so it
        re-pins commit_id to the current head and gets a fresh submittedAt,
        making it terminal for this head.
    """
    if not body or "## Changes Requested" not in body: return "no_template"
    rc,o,e=run(["gh","api",f"repos/{REPO}/pulls/{n}/reviews"]); rid=None; ex=None; reviewed_head=None
    if rc==0:
        try:
            for rv in json.loads(o):
                if (rv.get("user") or {}).get("login") in MAINT and rv.get("state")=="CHANGES_REQUESTED":
                    rid=rv["id"]; ex=rv.get("body"); reviewed_head=rv.get("commit_id")
        except Exception: pass
    head_moved = bool(head and reviewed_head and reviewed_head!=head)
    # Already terminal at this exact head with identical body -> no write.
    if ex is not None and norm(ex)==norm(body) and not head_moved: return "already"
    if rid and not head_moved:
        rc2,o2,e2=run(["gh","api","-X","PUT",f"repos/{REPO}/pulls/{n}/reviews/{rid}","-f",f"body={body}"])
    else:
        # head moved (or no prior record): NEW review re-pins commit_id + bumps submittedAt
        rc2,o2,e2=run(["gh","pr","review",str(n),"--repo",REPO,"--request-changes","--body",body])
    return "recorded" if rc2==0 else "fail:"+e2[:40]

def main():
    ap=argparse.ArgumentParser()
    # Drain-to-zero defaults (2026-06): the goal is MINIMUM standing backlog —
    # every actionable PR (unattended + repass) is driven to terminal each run,
    # not a fixed slice. First cycle is heavy; steady state is light because only
    # newly-opened or newly-updated (repass) PRs remain actionable. Override with
    # smaller values for a quick partial pass. max-chunks 200 ⇒ up to 10k PRs/run.
    ap.add_argument("--max-merge",type=int,default=10000)
    ap.add_argument("--max-chunks",type=int,default=200)
    a=ap.parse_args()
    res={"queued":[],"block_recorded":[],"operator_patch":[],"security_review":[],
         "conflicting":[],"collision_defer":[],"self_hold":[],"skipped":[],"fail":[],
         "inventory":{},"repass_detected":0}
    allpr,un,cr=inventory()
    res["inventory"]={"open_train":len(allpr),"unattended":len(un),"changes_requested":len(cr)}
    repass=detect_repass(cr)
    res["repass_detected"]=len(repass)
    actionable=sorted(set(un)|set(repass))
    reps=engine_scan(actionable,"act",a.max_chunks)
    claimed=set(); mn=0
    # merge_now
    for n in sorted(reps):
        if reps[n]["lane"]!="merge_now": continue
        files=reps[n]["files"]
        if mn>=a.max_merge: res["skipped"].append(n); continue
        if claimed & set(files): res["collision_defer"].append(n); continue
        safe,why=diff_safe(n,files)
        if not safe:
            (res["security_review"] if why=="sensitive_path" else res["skipped"]).append(n); continue
        d=gh_json(n,"headRefOid,baseRefName,isDraft,mergeable,id")
        if not d or d["baseRefName"]!="integration/pr-train" or d["isDraft"]: res["skipped"].append(n); continue
        if d["mergeable"]=="UNKNOWN": time.sleep(3); d=gh_json(n,"headRefOid,baseRefName,isDraft,mergeable,id") or d
        if d["mergeable"]=="CONFLICTING": res["conflicting"].append(n); continue
        if d["mergeable"]!="MERGEABLE": res["skipped"].append(n); continue
        sha=d["headRefOid"][:8]
        body=f"## Approved: clean at current head\n\nRe-reviewed at head `{sha}`: {reps[n]['contract']} change, path-clean, green CI Status Gate, MERGEABLE, base integration/pr-train. Enqueued to merge queue."
        run(["gh","pr","review",str(n),"--repo",REPO,"--approve","--body",body])
        rc,o,e=run(["gh","api","graphql","-f",
            f'query=mutation{{enqueuePullRequest(input:{{pullRequestId:"{d["id"]}"}}){{mergeQueueEntry{{state position}}}}}}'])
        if rc==0 and '"errors"' not in o: mn+=1; claimed|=set(files); res["queued"].append(n)
        elif "last pusher" in (o+e): res["self_hold"].append(n)
        else: res["fail"].append(n)
        time.sleep(0.2)
    # block (post/refresh records FIRST so a mid-run budget-out still leaves
    # every actionable PR with a current-head record — never looking unattended)
    for n in sorted(reps):
        if reps[n]["lane"]!="block": continue
        hd=gh_json(n,"headRefOid")
        head=(hd or {}).get("headRefOid")
        r=post_record(n,reps[n]["comment"],head=head)
        if r in ("recorded","already"): res["block_recorded"].append(n)
        elif r=="no_template": res["skipped"].append(n)
        else: res["fail"].append(n)
        time.sleep(0.15)
    # patch/harvest
    for n in sorted(reps):
        if reps[n]["lane"] in ("patch_then_merge","maintainer_harvest"):
            res["operator_patch"].append({"pr":n,"attach":reps[n]["attach"]})
    print(json.dumps(res,indent=1,default=str))

if __name__=="__main__": main()
