"""Synthetic selected-model observations for Files offer authority regressions."""

import json
from types import SimpleNamespace

from hushh_mcp.services.pod_inference_bridge import BRIDGE_ENV, BRIDGE_PROJECT


def configure_files_offer_bridge(monkeypatch, service, runtime_account, case):
    monkeypatch.setenv("HUSSH_POD_FILES_ENABLED", "true")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat" if case in {"owner", "non_dev"} else "dev")
    container = service["spec"]["template"]["spec"]["containers"][0]
    bridge = {"project": BRIDGE_PROJECT, "serviceAccount": runtime_account}
    if case != "owner":
        selected = "central-model-project" if case == "central" else BRIDGE_PROJECT
        if case == "unapproved_project":
            selected = "unapproved-project"
        container["env"] = [
            entry
            for entry in container["env"]
            if entry["name"] not in {"GENAI_GOOGLE_CLOUD_PROJECT", "HUSHH_DEPLOY_ENV"}
        ]
        container["env"].extend(
            [
                {"name": "GENAI_GOOGLE_CLOUD_PROJECT", "value": selected},
                {"name": "HUSHH_DEPLOY_ENV", "value": "dev"},
            ]
        )
        configured = (
            {**bridge, "serviceAccount": "one-pod-other@owner-project.iam.gserviceaccount.com"}
            if case == "wrong_identity"
            else bridge
        )
        monkeypatch.setenv(BRIDGE_ENV, json.dumps(configured))
    if case == "conflicting_policy":
        container["env"].append(
            {"name": BRIDGE_ENV, "value": json.dumps({**bridge, "project": "unapproved-project"})}
        )
    monkeypatch.setattr(
        "hushh_mcp.runtime_providers.ManagedGeminiRuntimeBinding.from_environment",
        lambda: SimpleNamespace(project="central-model-project"),
    )
