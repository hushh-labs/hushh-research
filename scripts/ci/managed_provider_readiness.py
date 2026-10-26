#!/usr/bin/env python3
"""Collect candidate-bound provider evidence and enforce UAT's any-provider rule.

Decides readiness, never invocation, information or action authority; retains no provider bodies, credentials or customer information.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import time
from functools import cache
from pathlib import Path
from uuid import UUID, uuid5

ROOT = Path(__file__).resolve().parents[2]
SCOPES = {"one_text_chat", "drive_document_requests"}
PROVIDERS = {"azure_openai", "vertex"}
PROVIDER_SCOPES = {"azure_openai": SCOPES, "vertex": {"drive_document_requests"}}


@cache
def _capability_proof():
    path = Path(__file__).with_name("managed_capability_proof.py")
    spec = importlib.util.spec_from_file_location("managed_capability_proof", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fingerprint(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def context(env):
    keys = (
        "BUILD_ID",
        "SOURCE_SHA",
        "IMAGE",
        "RUNTIME_ACCOUNT",
        "PROJECT",
        "REGION",
        "GITHUB_RUN",
        "ENVIRONMENT",
    )
    result = {key.lower(): env.get("READINESS_" + key, "") for key in keys}
    if (
        not re.fullmatch(r"[0-9a-f]{40}", result["source_sha"])
        or not re.fullmatch(
            r"gcr.io/[a-z0-9-]+/consent-protocol@sha256:[0-9a-f]{64}", result["image"]
        )
        or not re.fullmatch(r"[0-9a-f-]{36}", result["build_id"])
        or not result["runtime_account"]
        or not result["github_run"].isdigit()
    ):
        raise ValueError("Candidate readiness context is invalid")
    document = json.loads(
        (ROOT / "consent-protocol/config/managed-ai-runtime.json").read_text()
    )
    result["config_fingerprint"] = fingerprint(document)
    result["legacy_exception"] = (
        env.get("READINESS_LEGACY_EXCEPTION", "false") == "true"
    )
    return result


def run_json(args):
    result = subprocess.run(
        [shutil.which("gcloud") or "gcloud", *args, "--format=json"],
        capture_output=True,
        text=True,
        timeout=300 if args[:3] == ["run", "services", "update"] else 60,
        check=False,
    )
    if result.returncode:
        raise ValueError("Provider execution evidence is unavailable")
    return json.loads(result.stdout)


def payload(entry):
    value = entry.get("jsonPayload")
    if isinstance(value, dict):
        return value
    text = entry.get("textPayload", "")
    marker = "managed_vertex_probe_result "
    if marker in text:
        text = text.split(marker, 1)[1]
    try:
        value = json.loads(text)
    except (ValueError, TypeError):
        return {}
    return value if isinstance(value, dict) else {}


def valid_core(core, provider, expected, document):
    if isinstance(core, dict) and core.get("schema") == "azure_managed_text_legacy.v1":
        return (
            expected.get("legacy_exception") is True
            and provider == "azure_openai"
            and core.get("scopes") == 2
            and core.get("http_status") == 200
            and core.get("deployment")
            == document["pwm_research_uat"]["azure"]["primary_deployment"]
        )
    if not isinstance(core, dict) or core.get("schema") != "managed_text_probe.v1":
        return False
    policy = document["private_drive_text_uat"]
    generation = str(
        uuid5(
            UUID(policy["policy_id"]),
            policy["version"] + (":vertex" if provider == "vertex" else ""),
        )
    )
    scopes = core.get("scopes")
    if (
        core.get("provider") != provider
        or core.get("ready") is not True
        or core.get("policy_generation") != generation
        or core.get("config_fingerprint") != expected["config_fingerprint"]
        or not isinstance(scopes, dict)
        or set(scopes) != PROVIDER_SCOPES[provider]
    ):
        return False
    model = (
        document["pwm_research_uat"]["azure"]["primary_deployment"]
        if provider == "azure_openai"
        else document["environments"]["uat"]["text_model"]
    )
    location = (
        ""
        if provider == "azure_openai"
        else document["environments"]["uat"]["text_locations"][0]
    )
    root = document["managed_runtime_uat"]["azure"].get("one_text_root")
    return all(
        isinstance(value, dict)
        and value.get("ready") is True
        and value.get("provider") == provider
        and value.get("model")
        == (
            root["deployment"]
            if provider == "azure_openai"
            and scope == "one_text_chat"
            and root is not None
            else model
        )
        and value.get("location") == location
        for scope, value in scopes.items()
    )


def valid_pwm_proof(proof, document):
    counts = ("production_contracts", "attribution_cases", "confirmed_guidance")
    return (
        isinstance(proof, dict)
        and [proof.get("azure_pwm_" + key) for key in counts] == [4, 8, 2]
        and proof.get("deployment")
        == document["pwm_research_uat"]["azure"]["primary_deployment"]
        and bool(re.fullmatch(r"[0-9a-f]{64}", str(proof.get("policy_sha256", ""))))
    )


def valid_capabilities(proof, provider, expected, document):
    policy = document["managed_runtime_uat"]
    digest = fingerprint(
        {"policy": policy, "azure": document["pwm_research_uat"]["azure"]}
    )
    generation = str(
        uuid5(UUID(policy["policy_id"]), policy["version"] + digest + provider)
    )
    return _capability_proof().valid_capabilities(
        proof, provider, expected, document, generation=generation
    )


def collect(provider, expected, step_exit, job):
    result = {
        "schema": "managed_provider_execution.v1",
        "provider": provider,
        "context": expected,
        "step_exit": step_exit,
        "verified": False,
        "core_ready": False,
        "capabilities": {},
        "reason": "not_dispatched",
    }
    if not job:
        return result
    prefix = "azure-pwm-" if provider == "azure_openai" else "genai-ready-"
    if job != prefix + expected["build_id"]:
        raise ValueError("Provider job does not match this build")
    common = ["--project=" + expected["project"], "--region=" + expected["region"]]
    executions = run_json(
        ["run", "jobs", "executions", "list", "--job=" + job, "--limit=2", *common]
    )
    if not isinstance(executions, list) or len(executions) != 1:
        result["reason"] = "execution_missing_or_ambiguous"
        return result
    execution = executions[0]["metadata"]["name"].rsplit("/", 1)[-1]
    observed = run_json(["run", "jobs", "executions", "describe", execution, *common])
    template = observed.get("spec", {}).get("template", {}).get("spec", {})
    containers = template.get("containers", [])
    owners = observed.get("metadata", {}).get("ownerReferences", [])
    terminal = [
        c
        for c in observed.get("status", {}).get("conditions", [])
        if c.get("type") == "Completed"
    ]
    environment = (
        {item.get("name"): item.get("value") for item in containers[0].get("env", [])}
        if len(containers) == 1
        else {}
    )
    if (
        len(containers) != 1
        or containers[0].get("image") != expected["image"]
        or containers[0].get("command") != ["python3"]
        or containers[0].get("args")
        != [
            "scripts/verify_azure_pwm_runtime.py"
            if provider == "azure_openai"
            else "scripts/verify_managed_vertex_runtime.py"
        ]
        or template.get("serviceAccountName") != expected["runtime_account"]
        or len(owners) != 1
        or owners[0].get("name") != job
        or environment.get("ENVIRONMENT") != "uat"
        or len(terminal) != 1
        or terminal[0].get("status") not in {"True", "False"}
    ):
        result["reason"] = "execution_identity_or_terminal_mismatch"
        return result
    document = json.loads(
        (ROOT / "consent-protocol/config/managed-ai-runtime.json").read_text()
    )
    if provider == "vertex" and (
        environment.get("GENAI_GOOGLE_CLOUD_PROJECT")
        != document["environments"]["uat"]["project"]
        or environment.get("HUSHH_GENAI_AUTH_MODE") != "vertex_adc"
    ):
        result["reason"] = "provider_project_mismatch"
        return result
    if any(
        environment.get(key) != provider
        for key in ("HUSHH_UAT_MANAGED_AI_PROVIDER", "HUSHH_UAT_MANAGED_TEXT_PROVIDER")
    ):
        result["reason"] = "provider_selection_mismatch"
        return result
    values = []
    query = (
        'resource.type=cloud_run_job AND labels."run.googleapis.com/execution_name"="'
        + execution
        + '" AND (textPayload:managed_vertex_probe_result OR '
        "textPayload:managed_text_provider_probe OR jsonPayload.managed_text_provider_probe:* "
        "OR jsonPayload.azure_pwm_runtime_probe_result:* OR textPayload:azure_pwm_ "
        "OR jsonPayload.azure_pwm_production_contracts:* OR jsonPayload.azure_pwm_probe_failure:* "
        "OR jsonPayload.azure_managed_text_contract:* OR jsonPayload.azure_pwm_runtime_probe_stage:* "
        "OR jsonPayload.managed_capabilities_probe:* OR textPayload:managed_capabilities_probe)"
    )
    for attempt in range(6):
        entries = run_json(
            [
                "logging",
                "read",
                query,
                "--project=" + expected["project"],
                "--freshness=1h",
                "--limit=30",
            ]
        )
        values = [payload(entry) for entry in entries]
        complete = (
            any(value.get("check") == "managed_vertex_runtime" for value in values)
            if provider == "vertex"
            else any(
                value.get("azure_pwm_runtime_probe_result") == "ok" for value in values
            )
            and any("azure_pwm_production_contracts" in value for value in values)
            and (
                any("managed_text_provider_probe" in value for value in values)
                or expected.get("legacy_exception") is True
            )
        )
        terminal_failed = any(
            value.get("azure_pwm_runtime_probe_result") == "failed"
            or value.get("check") == "managed_vertex_runtime"
            and value.get("ok") is False
            for value in values
        )
        complete = (
            terminal_failed
            or complete
            and any("managed_capabilities_probe" in value for value in values)
        )
        if complete:
            break
        if attempt < 5:
            time.sleep(5)
    cores = [
        value["managed_text_provider_probe"]
        for value in values
        if isinstance(value.get("managed_text_provider_probe"), dict)
    ]
    document = json.loads(
        (ROOT / "consent-protocol/config/managed-ai-runtime.json").read_text()
    )
    if (
        not cores
        and provider == "azure_openai"
        and expected.get("legacy_exception") is True
    ):
        old = [
            v
            for v in values
            if v.get("azure_managed_text_contract") == "ok" and v.get("scopes") == 2
        ]
        primary = [
            v
            for v in values
            if v.get("azure_pwm_runtime_probe_stage") == "primary_http"
            and v.get("result") == "ok"
            and v.get("http_status") == 200
        ]
        if len(old) == len(primary) == 1:
            cores = [
                {
                    "schema": "azure_managed_text_legacy.v1",
                    "scopes": 2,
                    "http_status": 200,
                    "deployment": primary[0].get("deployment"),
                }
            ]
    result.update(
        verified=True,
        execution=execution,
        job=job,
        execution_image=containers[0]["image"],
        runtime_account=template["serviceAccountName"],
        execution_terminal=terminal[0]["status"],
        reason="core_not_proven",
    )
    capability_proofs = [
        value["managed_capabilities_probe"]
        for value in values
        if isinstance(value.get("managed_capabilities_probe"), dict)
    ]
    if len(capability_proofs) == 1 and valid_capabilities(
        capability_proofs[0], provider, expected, document
    ):
        result["capability_proof"] = capability_proofs[0]
    # A matching execution can fail optional modalities while its core text proof succeeds.
    if len(cores) == 1 and valid_core(cores[0], provider, expected, document):
        result.update(core_ready=True, core=cores[0], reason="core_ready")
    result.update(_capability_proof().execution_diagnostics(provider, values))
    if provider == "azure_openai":
        terminals = [
            v.get("azure_pwm_runtime_probe_result")
            for v in values
            if "azure_pwm_runtime_probe_result" in v
        ]
        result["capabilities"] = {
            "pwm_model_contract": terminals == ["ok"] and step_exit == 0
        }
        proofs = [v for v in values if "azure_pwm_production_contracts" in v]
        explicit_failure = any("azure_pwm_probe_failure" in v for v in values) or any(
            v.get("azure_pwm_runtime_probe_result") == "failed"
            and (
                v.get("pwm_trust_failure") is True
                or v.get("error_type")
                in {"ValueError", "ValidationError", "TypeError", "AzurePwmTrustError"}
            )
            for v in values
        )
        proven = (
            terminals == ["ok"]
            and step_exit == 0
            and len(proofs) == 1
            and valid_pwm_proof(proofs[0], document)
        )
        if proven:
            result["pwm_proof"] = proofs[0]
        result["pwm_trust"] = (
            "failed" if explicit_failure else "passed" if proven else "unverified"
        )
        result["capabilities"]["pwm_model_contract"] = proven and not explicit_failure
        # A successful ping cannot erase a later attribution/schema failure.
        result["core_ready"] = result["core_ready"] and proven and not explicit_failure
    return result


def evaluate(envelopes, expected):
    document = json.loads(
        (ROOT / "consent-protocol/config/managed-ai-runtime.json").read_text()
    )
    accepted = {}
    diagnostics = {}
    trust_failed = False
    alternate_diagnostics = []
    for provider in sorted(PROVIDERS):
        value = envelopes.get(provider)
        valid = (
            isinstance(value, dict)
            and value.get("schema") == "managed_provider_execution.v1"
            and value.get("provider") == provider
            and value.get("context") == expected
        )
        prefix = "azure-pwm-" if provider == "azure_openai" else "genai-ready-"
        if (
            valid
            and value.get("verified") is True
            and value.get("pwm_trust") == "failed"
        ):
            trust_failed = True
        if valid and value.get("verified") is True:
            alternate_diagnostics.extend(
                name
                for name, classification in value.get(
                    "capability_classifications", {}
                ).items()
                if not name.startswith("one_chat:")
                and classification in {"candidate_misconfigured", "application_broken"}
            )
        accepted[provider] = bool(
            valid
            and value.get("verified") is True
            and value.get("core_ready") is True
            and value.get("execution_image") == expected["image"]
            and value.get("runtime_account") == expected["runtime_account"]
            and value.get("job") == prefix + expected["build_id"]
            and str(value.get("execution", "")).startswith(
                prefix + expected["build_id"] + "-"
            )
            and value.get("execution_terminal") in {"True", "False"}
            and valid_core(value.get("core"), provider, expected, document)
            and (
                provider == "vertex"
                or valid_capabilities(
                    value.get("capability_proof"), provider, expected, document
                )
            )
            and (
                provider != "azure_openai"
                or (
                    value.get("pwm_trust") == "passed"
                    and valid_pwm_proof(value.get("pwm_proof"), document)
                )
            )
        )
        diagnostics[provider] = _capability_proof().readiness_diagnostics(
            value, provider=provider, valid=valid, ready=accepted[provider]
        )
    selected = "azure_openai" if accepted["azure_openai"] else None
    return {
        "schema": "managed_provider_readiness.v1",
        "ready": selected is not None and not trust_failed,
        "alternate_failures": sorted(alternate_diagnostics),
        "selected_provider": selected,
        "pwm_trust": (
            "failed"
            if trust_failed
            else "passed"
            if diagnostics["azure_openai"]["capabilities"].get("pwm_model_contract")
            is True
            else "unverified"
        ),
        "required_scopes": sorted(SCOPES),
        "required_capabilities": sorted(
            document["managed_runtime_uat"]["required_capabilities"]
        ),
        "context": expected,
        "providers": diagnostics,
    }


def worker_provider(sha, image, run_id, account):
    """Inherit the promoted API's binding; never choose a second worker policy."""
    common = ["--project=hushh-pda-uat", "--region=us-central1"]
    service = run_json(["run", "services", "describe", "consent-protocol", *common])
    traffic = [
        v
        for v in service.get("status", {}).get("traffic", [])
        if v.get("percent", 0) > 0
    ]
    if len(traffic) != 1 or traffic[0].get("percent") != 100:
        raise ValueError("Managed worker binding requires one promoted API revision")
    revision = traffic[0].get("revisionName", "")
    if not re.fullmatch(r"consent-protocol-[a-z0-9-]+", revision):
        raise ValueError("Managed worker API revision is invalid")
    observed = run_json(["run", "revisions", "describe", revision, *common])
    spec = observed.get("spec", {})
    containers = spec.get("containers", [])
    env = (
        {v.get("name"): v.get("value") for v in containers[0].get("env", [])}
        if len(containers) == 1
        else {}
    )
    provider = env.get("HUSHH_UAT_MANAGED_TEXT_PROVIDER")
    if (
        observed.get("metadata", {}).get("name") != revision
        or len(containers) != 1
        or containers[0].get("image") != image
        or spec.get("serviceAccountName") != account
        or env.get("HUSHH_DEPLOY_SHA") != sha
        or env.get("HUSHH_DEPLOY_RUN_ID") != run_id
        or env.get("HUSHH_DEPLOY_ENV") != "uat"
        or provider not in PROVIDERS
        or env.get("HUSHH_UAT_MANAGED_AI_PROVIDER") != provider
        or not any(
            v.get("type") == "Ready" and v.get("status") == "True"
            for v in observed.get("status", {}).get("conditions", [])
        )
    ):
        raise ValueError("Managed worker binding does not match the promoted release")
    return provider


def candidate(service, expected, tag):
    revision = service.get("status", {}).get("latestCreatedRevisionName")
    spec = service.get("spec", {}).get("template", {}).get("spec", {})
    containers = spec.get("containers", [])
    env = (
        {v.get("name"): v.get("value") for v in containers[0].get("env", [])}
        if len(containers) == 1
        else {}
    )
    traffic = service.get("status", {}).get("traffic", [])
    tagged = [v for v in traffic if v.get("tag") == tag]
    if (
        not revision
        or service.get("status", {}).get("latestReadyRevisionName") != revision
        or len(containers) != 1
        or containers[0].get("image") != expected["image"]
        or spec.get("serviceAccountName") != expected["runtime_account"]
        or env.get("HUSHH_DEPLOY_SHA") != expected["source_sha"]
        or env.get("HUSHH_DEPLOY_RUN_ID") != expected["github_run"]
        or env.get("HUSHH_DEPLOY_ENV") != "uat"
        or len(tagged) != 1
        or tagged[0].get("revisionName", revision) != revision
        or any(
            v.get("percent", 0) > 0
            and (v.get("revisionName") == revision or v.get("latestRevision") is True)
            for v in traffic
        )
    ):
        raise ValueError(
            "Managed provider selection requires the exact no-traffic candidate"
        )
    selected = env.get("HUSHH_UAT_MANAGED_TEXT_PROVIDER")
    if (
        selected not in PROVIDERS
        or env.get("HUSHH_UAT_MANAGED_AI_PROVIDER") != selected
    ):
        raise ValueError("Candidate managed provider flags disagree")
    return revision, selected


def select(result, expected, folder):
    if (
        result.get("ready") is not True
        or result.get("selected_provider") != "azure_openai"
    ):
        raise ValueError("One UAT requires qualified Azure processing")
    service = os.environ["READINESS_SERVICE"]
    tag = os.environ["READINESS_TAG"]
    if (
        expected["project"] != "hushh-pda-uat"
        or expected["region"] != "us-central1"
        or service != "consent-protocol"
        or expected["runtime_account"]
        != "consent-protocol-runtime@hushh-pda-uat.iam.gserviceaccount.com"
        or tag != "account-deletion-" + expected["github_run"]
    ):
        raise ValueError("Managed provider selection is outside UAT authority")
    args = ["--project=" + expected["project"], "--region=" + expected["region"]]
    current = run_json(["run", "services", "describe", service, *args])
    revision, provider = candidate(current, expected, tag)
    selected = result["selected_provider"]
    if provider != selected:
        result["selection"] = {
            "status": "requested",
            "provider": selected,
            "previous_revision": revision,
        }
        write(folder / "result.json", result)
        run_json(
            [
                "run",
                "services",
                "update",
                service,
                *args,
                "--no-traffic",
                "--tag=" + tag,
                "--update-env-vars=HUSHH_UAT_MANAGED_TEXT_PROVIDER="
                + selected
                + ",HUSHH_UAT_MANAGED_AI_PROVIDER="
                + selected,
                "--quiet",
            ]
        )
        current = run_json(["run", "services", "describe", service, *args])
    revision, provider = candidate(current, expected, tag)
    if provider != selected:
        raise ValueError("Candidate did not adopt the verified managed provider")
    result["selection"] = {
        "status": "verified",
        "provider": provider,
        "revision": revision,
        "image": expected["image"],
        "traffic_percent": 0,
    }
    write(folder / "result.json", result)
    print(
        json.dumps(
            {"managed_provider_selection": result["selection"], "context": expected},
            sort_keys=True,
        )
    )


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, sort_keys=True) + "\n")
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "action", choices=("record", "evaluate", "select", "worker-provider")
    )
    parser.add_argument("--provider", choices=sorted(PROVIDERS))
    parser.add_argument("--job", default="")
    parser.add_argument("--sha")
    parser.add_argument("--image")
    parser.add_argument("--run-id")
    parser.add_argument("--account")
    args = parser.parse_args()
    if args.action == "worker-provider":
        print(worker_provider(args.sha, args.image, args.run_id, args.account))
        return 0
    build_id = os.environ["READINESS_BUILD_ID"]
    UUID(build_id)
    folder = Path("/workspace/managed-readiness") / build_id
    if os.environ["READINESS_ENVIRONMENT"] != "uat":
        path = folder / "legacy-vertex.json"
        if args.action == "record":
            if args.provider == "vertex":
                write(
                    path,
                    {
                        "build_id": build_id,
                        "step_exit": int(os.environ["READINESS_STEP_EXIT"]),
                    },
                )
            return 0
        try:
            legacy = json.loads(path.read_text())
        except (OSError, ValueError):
            raise SystemExit(
                "The original Vertex release check is unverified"
            ) from None
        if legacy != {"build_id": build_id, "step_exit": 0}:
            raise SystemExit("The original Vertex release check did not pass")
        return 0
    expected = context(os.environ)
    if args.action == "record":
        code = int(os.environ["READINESS_STEP_EXIT"])
        try:
            value = collect(args.provider, expected, code, args.job)
        except Exception:
            value = {
                "schema": "managed_provider_execution.v1",
                "provider": args.provider,
                "context": expected,
                "step_exit": code,
                "verified": False,
                "core_ready": False,
                "reason": "collection_unavailable",
            }
        write(folder / (args.provider + ".json"), value)
        print(
            json.dumps(
                {
                    "managed_provider_collected": args.provider,
                    "core_ready": value["core_ready"],
                }
            )
        )
        return 0
    envelopes = {}
    for provider in PROVIDERS:
        try:
            envelopes[provider] = json.loads(
                (folder / (provider + ".json")).read_text()
            )
        except (OSError, ValueError):
            pass
    result = evaluate(envelopes, expected)
    write(folder / "result.json", result)
    print(json.dumps({"managed_provider_readiness": result}, sort_keys=True))
    if not result["ready"]:
        raise SystemExit("No usable managed text provider passed readiness")
    if args.action == "select":
        select(result, expected, folder)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
