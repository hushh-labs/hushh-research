#!/usr/bin/env python3
"""Detect repass candidates: CHANGES_REQUESTED PRs where contributor activity
(latest commit OR latest non-maintainer comment) is NEWER than the latest
maintainer CHANGES_REQUESTED review. GitHub UI cannot show this."""
import json, subprocess, sys
from datetime import datetime

MAINTAINERS = {"kushaltrivedi5", "kushaltrivedi"}  # maintainer logins authoring review records

def gh_graphql(query, variables):
    try:
        p = subprocess.run(["gh","api","graphql","-f","query="+query]+
                           [f"-F={k}={v}" for k,v in variables.items()],
                           capture_output=True, text=True, timeout=90)
    except subprocess.TimeoutExpired:
        return None, "timeout after 90s"
    except Exception as ex:
        return None, f"{type(ex).__name__}: {ex}"
    if p.returncode != 0:
        return None, p.stderr.strip()
    return json.loads(p.stdout), None

# load CHANGES_REQUESTED train PRs
train = json.load(open("tmp/train-prs.json"))
cr = [p["number"] for p in train if p.get("reviewDecision")=="CHANGES_REQUESTED"]

Q = """
query($owner:String!,$repo:String!,$num:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$num){
      number
      headRefOid
      reviews(last:30){nodes{author{login} state submittedAt commit{oid}}}
      commits(last:1){nodes{commit{committedDate}}}
      comments(last:15){nodes{author{login} createdAt}}
    }
  }
}"""

def parse(ts):
    return datetime.fromisoformat(ts.replace("Z","+00:00")) if ts else None

repass=[]; still_blocked=[]; already_reviewed_head=[]; errors=[]
for n in cr:
    data,err = gh_graphql(Q, {"owner":"hushh-labs","repo":"hushh-research","num":n})
    if err:
        errors.append((n,err)); continue
    pr = data["data"]["repository"]["pullRequest"]
    head = pr.get("headRefOid")
    # latest maintainer CHANGES_REQUESTED review (time + the head it was pinned to)
    mreviews=[r for r in pr["reviews"]["nodes"]
              if r["state"]=="CHANGES_REQUESTED" and (r["author"] or {}).get("login") in MAINTAINERS]
    last_review = max([parse(r["submittedAt"]) for r in mreviews], default=None)
    # the commit OID the most-recent maintainer review was pinned to
    reviewed_head=None
    if mreviews:
        latest_m=max(mreviews,key=lambda r:parse(r["submittedAt"]) or datetime.min.replace(tzinfo=None))
        reviewed_head=(latest_m.get("commit") or {}).get("oid")
    if last_review is None:
        anyrev=[r for r in pr["reviews"]["nodes"] if r["state"]=="CHANGES_REQUESTED"]
        last_review = max([t for t in (parse(r["submittedAt"]) for r in anyrev) if t], default=None)
        if anyrev and reviewed_head is None:
            latest_any=max(anyrev,key=lambda r:parse(r["submittedAt"]) or datetime.min.replace(tzinfo=None))
            reviewed_head=(latest_any.get("commit") or {}).get("oid")
    # latest contributor activity
    last_commit = parse(pr["commits"]["nodes"][0]["commit"]["committedDate"]) if pr["commits"]["nodes"] else None
    contrib_comments=[parse(c["createdAt"]) for c in pr["comments"]["nodes"]
                      if (c["author"] or {}).get("login") not in MAINTAINERS]
    last_comment = max(contrib_comments, default=None)
    last_activity = max([t for t in (last_commit,last_comment) if t], default=None)
    rec={"pr":n,"head":head,"reviewed_head":reviewed_head,
         "review":last_review.isoformat() if last_review else None,
         "commit":last_commit.isoformat() if last_commit else None,
         "activity":last_activity.isoformat() if last_activity else None}
    # KEY FIX: a review pinned to the CURRENT head is terminal regardless of
    # timestamps. Editing a review body via PUT does NOT advance submittedAt, so
    # timestamp-only comparison re-flags forever. Pin on head instead.
    if reviewed_head and head and reviewed_head == head:
        already_reviewed_head.append(rec)
    elif last_review and last_activity and last_activity > last_review:
        rec["new_commit_after_review"] = bool(last_commit and last_commit > last_review)
        repass.append(rec)
    else:
        still_blocked.append(n)

print("=== REPASS CANDIDATES (new head since last review):", len(repass))
for r in sorted(repass,key=lambda x:x["pr"]):
    tag = "commit" if r.get("new_commit_after_review") else "comment-only"
    print(f"  #{r['pr']}  head={(r['head'] or '')[:8]}  reviewed_head={(r['reviewed_head'] or 'none')[:8]}  via={tag}")
print("=== ALREADY REVIEWED AT CURRENT HEAD (terminal, do not re-flag):", len(already_reviewed_head))
print("  ", sorted(r["pr"] for r in already_reviewed_head))
print("=== STILL BLOCKED (no new activity since changes-requested):", len(still_blocked))
print("  ", sorted(still_blocked))
print("=== ERRORS:", len(errors))
for n,e in errors[:10]: print(f"  #{n}: {e[:80]}")

json.dump({"repass":repass,"already_reviewed_head":already_reviewed_head,
           "still_blocked":still_blocked,"errors":[n for n,_ in errors]},
          open("tmp/repass-result.json","w"), indent=0)
