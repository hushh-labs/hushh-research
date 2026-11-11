"""Render an owner-run recovery for one existing Dev cleanup authority.

The rendered file uses the owner's gcloud login, never the application database,
Firebase, vault material or an uploaded token. It restores only the original
unconditional bootstrap impersonation binding; it grants no project role.
"""

from __future__ import annotations

import json


def render_owner_authority_template(recovery: dict) -> str:
    from hushh_mcp.services.legacy_cloud_removal import PROTECTED_PROJECTS, _require

    plan = recovery["plan"]
    project = plan["project"]
    entries = [r for r in plan["resources"] if r["type"] == "bootstrap_access"]
    binding = {
        "role": "roles/iam.serviceAccountTokenCreator",
        "member": "serviceAccount:consent-protocol-runtime@hushh-pda-dev.iam.gserviceaccount.com",
    }
    _require(
        plan["controlProject"] == "hushh-pda-dev" and project["projectId"] not in PROTECTED_PROJECTS
    )
    _require(len(entries) == 1 and entries[0]["authority"] == "owner_reviewed")
    _require(entries[0]["identity"]["bindings"] == [binding])
    frozen = {
        "project": project,
        "bootstrap": entries[0],
        "binding": binding,
        "actor": plan["actor"],
        "operation": plan["attemptId"],
        "digest": recovery["planSha256"],
        "resources": [r["id"] for r in plan["resources"]],
    }
    return _TEMPLATE.replace("__FROZEN_JSON__", repr(json.dumps(frozen, separators=(",", ":"))))


_TEMPLATE = '''#!/usr/bin/env python3
"""One reviewed Dev cleanup authority; report-only unless --apply is explicit."""
import argparse, copy, hashlib, json, pathlib, subprocess, urllib.request
FROZEN=json.loads(__FROZEN_JSON__)
p=argparse.ArgumentParser(description=__doc__)
p.add_argument("--gcloud",default="gcloud")
p.add_argument("--apply",action="store_true")
p.add_argument("--operation-digest")
p.add_argument("--template-sha256")
a=p.parse_args()
def require(condition):
    if not condition: raise SystemExit("Cleanup authority refused: identity, review or provider state changed.")
project=FROZEN["project"]["projectId"]
print(json.dumps({"project":FROZEN["project"],"operation":FROZEN["operation"],"operationDigest":FROZEN["digest"],"resources":FROZEN["resources"]},indent=2),flush=True)
if a.apply:
    require(a.operation_digest==FROZEN["digest"] and a.template_sha256==hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest())
# Run gcloud auth login yourself first. No default account or project is used.
r=subprocess.run([a.gcloud,"auth","print-access-token","--account="+FROZEN["actor"],"--project="+project],capture_output=True,text=True,timeout=40)
require(r.returncode==0 and bool(r.stdout.strip()))
token=r.stdout.strip()
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None
opener=urllib.request.build_opener(NoRedirect())
def request(method,url,body=None):
    headers={"Authorization":"Bearer "+token,"Content-Type":"application/json"}
    if url!="https://openidconnect.googleapis.com/v1/userinfo":
        headers["X-Goog-User-Project"]=project
    req=urllib.request.Request(url,data=None if body is None else json.dumps(body).encode(),method=method,
        headers=headers)
    # An uncertain POST is never retried. Re-run report-only to observe it.
    with opener.open(req,timeout=30) as response: return json.load(response)
who=request("GET","https://openidconnect.googleapis.com/v1/userinfo")
require(who.get("email")==FROZEN["actor"] and who.get("email_verified") is True)
actual=request("GET","https://cloudresourcemanager.googleapis.com/v3/projects/"+project)
require(actual.get("projectId")==project and actual.get("name")=="projects/"+FROZEN["project"]["projectNumber"] and actual.get("createTime")==FROZEN["project"]["createTime"] and actual.get("state")=="ACTIVE")
expected=FROZEN["bootstrap"]["identity"]["account"]
base="https://iam.googleapis.com/v1/projects/"+project+"/serviceAccounts/"+expected["uniqueId"]
account=request("GET",base)
require(all(account.get(k)==v for k,v in expected.items()))
policy=request("POST",base+":getIamPolicy",{"options":{"requestedPolicyVersion":3}})
require(bool(policy.get("etag")))
b=FROZEN["binding"]
def present(value):
    return any(x.get("role")==b["role"] and not x.get("condition") and b["member"] in x.get("members",[]) for x in value.get("bindings",[]))
if present(policy):
    print(json.dumps({"authorityPresent":True,"taskAddedBinding":False,"operation":FROZEN["operation"]}));raise SystemExit(0)
if not a.apply:
    print(json.dumps({"authorityPresent":False,"ownerActionRequired":True,"applyRequiresBothReviewedHashes":True}));raise SystemExit(0)
updated=copy.deepcopy(policy)
matching=next((x for x in updated.setdefault("bindings",[]) if x.get("role")==b["role"] and not x.get("condition")),None)
if matching is None:
    matching={"role":b["role"],"members":[]};updated["bindings"].append(matching)
matching.setdefault("members",[]).append(b["member"])
intent={"operation":FROZEN["operation"],"operationDigest":FROZEN["digest"],"stage":"cleanupAuthorityRestoreIntent","binding":b,"etagSha256":hashlib.sha256(policy["etag"].encode()).hexdigest()}
print(json.dumps(intent),flush=True)
try:
    request("POST",base+":setIamPolicy",{"policy":updated})
except Exception:
    print(json.dumps({"outcome":"unknown","nextAction":"Run report-only; do not replay the request without readback."}),flush=True);raise SystemExit(2)
readback=request("POST",base+":getIamPolicy",{"options":{"requestedPolicyVersion":3}})
require(present(readback))
print(json.dumps({"operation":FROZEN["operation"],"operationDigest":FROZEN["digest"],"authorityPresent":True,"taskAddedBinding":True,"releaseThroughOriginalBootstrapCleanup":True}))
'''
