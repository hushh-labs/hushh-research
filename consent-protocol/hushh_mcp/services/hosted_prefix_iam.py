"""Reverse only retained managed-prefix IAM writes, using current etag CAS."""

from __future__ import annotations

from copy import deepcopy
from urllib.parse import urlsplit

from hushh_mcp.services.byoc_oauth_authorizer import _check
from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired


def remove_prefix_binding(native, binding: dict, *, identity: dict | None = None) -> None:
    url = binding["policyResource"]
    parsed = urlsplit(url)
    if (
        parsed.scheme != "https"
        or parsed.query
        or parsed.fragment
        or parsed.netloc
        not in {
            "iam.googleapis.com",
            "cloudresourcemanager.googleapis.com",
            "artifactregistry.googleapis.com",
            "cloudkms.googleapis.com",
            "secretmanager.googleapis.com",
            "storage.googleapis.com",
        }
        or (not url.endswith(":getIamPolicy") and not url.endswith("/iam"))
    ):
        raise ProvisionReconciliationRequired("Managed prefix policy target is invalid")
    storage = parsed.netloc == "storage.googleapis.com"
    post_read = parsed.netloc in {"iam.googleapis.com", "cloudresourcemanager.googleapis.com"}
    method = "POST" if post_read else "GET"
    options = (
        {"json": {"options": {"requestedPolicyVersion": 3}}}
        if post_read
        else {"params": {"options.requestedPolicyVersion": 3}}
    )

    def observe() -> dict:
        policy = _check(native.request(method, url, **options), "observe prefix IAM policy")
        if not isinstance(policy, dict):
            raise ProvisionReconciliationRequired("Managed prefix IAM response is malformed")
        if not isinstance(policy.get("bindings", []), list) or any(
            not isinstance(item, dict) or not isinstance(item.get("members", []), list)
            for item in policy.get("bindings", [])
        ):
            raise ProvisionReconciliationRequired("Managed prefix IAM policy is malformed")
        return policy

    policy = observe()
    if binding["disposition"] == "already_present":
        return
    if binding["disposition"] != "added":
        raise ProvisionReconciliationRequired("Managed prefix binding provenance unavailable")
    targets = {binding["member"]}
    if identity and binding["member"] == "serviceAccount:" + identity["email"]:
        targets.add(f"deleted:serviceAccount:{identity['email']}?uid={identity['uniqueId']}")
    updated = deepcopy(policy)
    changed = False
    for row in updated.get("bindings", []):
        if row.get("role") != binding["role"] or not targets.intersection(row.get("members", [])):
            continue
        if row.get("condition"):
            raise ProvisionReconciliationRequired("Managed prefix binding acquired a condition")
        prior = row["members"]
        row["members"] = [member for member in prior if member not in targets]
        changed |= prior != row["members"]
    if changed:
        if not policy.get("etag"):
            raise ProvisionReconciliationRequired("Managed prefix policy etag unavailable")
        updated["bindings"] = [row for row in updated["bindings"] if row.get("members")]
        endpoint = url if storage else url.removesuffix(":getIamPolicy") + ":setIamPolicy"
        _check(
            native.request(
                "PUT" if storage else "POST",
                endpoint,
                json=updated if storage else {"policy": updated},
            ),
            "remove retained managed prefix binding",
        )
    if any(
        row.get("role") == binding["role"] and targets.intersection(row.get("members", []))
        for row in observe().get("bindings", [])
    ):
        raise ProvisionReconciliationRequired("Managed prefix IAM removal remains unconfirmed")
