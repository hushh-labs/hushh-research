#!/usr/bin/env python3
"""Attach the Mail exchange to future UAT sandboxes after signed pod publication."""

import argparse
import base64
import json
import subprocess
import sys
from pathlib import Path

PROJECT = "hushh-pda-uat"
CONTEXT = "gke_hushh-pda-uat_us-central1_hussh-one-sandbox-uat"
NAMESPACE = "hussh-agents"
TEMPLATE = "sandboxtemplate/hussh-one-sandbox-v1"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--image", required=True, help="Approved, deployed UAT pod digest containing the exchange"
    )
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "consent-protocol"))
    from hushh_mcp.operons.agent_sandbox.k8s_manifests import render_sandbox_template

    kubectl = ["kubectl", "--context", CONTEXT, "-n", NAMESPACE]
    template = json.loads(subprocess.check_output([*kubectl, "get", TEMPLATE, "-o", "json"]))
    spec = template["spec"]["podTemplate"]["spec"]
    containers = spec["containers"]
    index = next(i for i, c in enumerate(containers) if c["name"] == "sandbox")
    agent = containers[index]
    if agent["image"] != args.image or spec.get("hostNetwork") or spec.get("shareProcessNamespace"):
        raise SystemExit(
            "Expected the approved UAT image, private network and isolated container processes"
        )
    proxy = next(e["value"] for e in agent["env"] if e["name"] == "HTTPS_PROXY")
    rendered = render_sandbox_template(
        image_ref=args.image, egress_proxy_url=proxy, uat_mail_browser=True
    )
    desired_agent, sidecar = rendered["spec"]["podTemplate"]["spec"]["containers"]
    public_id = next(
        e for e in desired_agent["env"] if e["name"] == "GOOGLE_UAT_MAIL_WEB_CLIENT_ID"
    )
    path = "/spec/podTemplate/spec/containers"
    changes = [
        {
            "op": "test",
            "path": "/metadata/resourceVersion",
            "value": template["metadata"]["resourceVersion"],
        }
    ]
    lookup = {c["name"]: i for i, c in enumerate(containers)}
    if sidecar["name"] in lookup:
        changes.append(
            {"op": "replace", "path": f"{path}/{lookup[sidecar['name']]}", "value": sidecar}
        )
    else:
        changes.append({"op": "add", "path": f"{path}/-", "value": sidecar})
    env = [e for e in agent["env"] if e["name"] != public_id["name"]]
    changes.append({"op": "replace", "path": f"{path}/{index}/env", "value": [*env, public_id]})
    patch = [*kubectl, "patch", TEMPLATE, "--type=json", "-p", json.dumps(changes)]
    subprocess.run([*patch, "--dry-run=server"], check=True)
    if not args.apply:
        return
    data = {}
    for key, name in [
        ("client-id", "GOOGLE_UAT_MAIL_WEB_CLIENT_ID"),
        ("client-secret", "GOOGLE_UAT_MAIL_WEB_CLIENT_SECRET"),
    ]:
        value = subprocess.check_output(
            [
                "gcloud",
                "secrets",
                "versions",
                "access",
                "latest",
                "--project",
                PROJECT,
                "--secret",
                name,
            ]
        )
        data[key] = base64.b64encode(value).decode("ascii")
    manifest = {
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {"name": "uat-private-mail-oauth", "namespace": NAMESPACE},
        "data": data,
    }
    subprocess.run(
        [*kubectl, "apply", "--server-side", "-f", "-"],
        input=json.dumps(manifest).encode(),
        check=True,
    )
    subprocess.run(patch, check=True)


if __name__ == "__main__":
    main()
