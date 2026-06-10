#!/usr/bin/env python3
"""Detect repass candidates: CHANGES_REQUESTED PRs where contributor activity
(latest commit OR latest non-maintainer comment) is NEWER than the latest
maintainer CHANGES_REQUESTED review. GitHub UI cannot show this."""
import json, subprocess, sys
from datetime import datetime

MAINTAINERS = {"kushaltrivedi5", "kushaltrivedi"}  # maintainer logins authoring review records

def gh_graphql(query, variables):
    p = subprocess.run(["gh","api","graphql","-f","query="+query]+
                       [f"-F={k}={v}" for k,v in variables.items()],
                       capture_output=True, text=True)
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
      reviews(last:30){nodes{author{login} state submittedAt}}
      commits(last:1){nodes{commit{committedDate}}}
      comments(last:15){nodes{author{login} createdAt}}
    }
  }
}"""

def parse(ts):
    return datetime.fromisoformat(ts.replace("Z","+00:00")) if ts else None

repass=[]; still_blocked=[]; errors=[]
for n in cr:
    data,err = gh_graphql(Q, {"owner":"hushh-labs","repo":"hushh-research","num":n})
    if err:
        errors.append((n,err)); continue
    pr = data["data"]["repository"]["pullRequest"]
    # latest maintainer CHANGES_REQUESTED review time
    mreviews=[r for r in pr["reviews"]["nodes"]
              if r["state"]=="CHANGES_REQUESTED" and (r["author"] or {}).get("login") in MAINTAINERS]
    last_review = max([parse(r["submittedAt"]) for r in mreviews], default=None)
    if last_review is None:
        # changes-requested by a non-configured maintainer; use any CHANGES_REQUESTED review
        anyrev=[parse(r["submittedAt"]) for r in pr["reviews"]["nodes"] if r["state"]=="CHANGES_REQUESTED"]
        last_review = max(anyrev, default=None)
    # latest contributor activity
    last_commit = parse(pr["commits"]["nodes"][0]["commit"]["committedDate"]) if pr["commits"]["nodes"] else None
    contrib_comments=[parse(c["createdAt"]) for c in pr["comments"]["nodes"]
                      if (c["author"] or {}).get("login") not in MAINTAINERS]
    last_comment = max(contrib_comments, default=None)
    last_activity = max([t for t in (last_commit,last_comment) if t], default=None)
    rec={"pr":n,"review":last_review.isoformat() if last_review else None,
         "commit":last_commit.isoformat() if last_commit else None,
         "activity":last_activity.isoformat() if last_activity else None}
    if last_review and last_activity and last_activity > last_review:
        # contributor responded AFTER changes requested -> repass
        rec["new_commit_after_review"] = bool(last_commit and last_commit > last_review)
        repass.append(rec)
    else:
        still_blocked.append(n)

print("=== REPASS CANDIDATES (addressed since changes-requested):", len(repass))
for r in sorted(repass,key=lambda x:x["pr"]):
    tag = "commit" if r.get("new_commit_after_review") else "comment-only"
    print(f"  #{r['pr']}  activity={r['activity']}  review={r['review']}  via={tag}")
print("=== STILL BLOCKED (no new activity since changes-requested):", len(still_blocked))
print("  ", sorted(still_blocked))
print("=== ERRORS:", len(errors))
for n,e in errors[:10]: print(f"  #{n}: {e[:80]}")

json.dump({"repass":repass,"still_blocked":still_blocked,"errors":[n for n,_ in errors]},
          open("tmp/repass-result.json","w"), indent=0)
