#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Explicitly authorized local deployment to Akshat's existing sandbox only."""

import argparse
import datetime
import fcntl
import gzip
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

from google.oauth2.credentials import Credentials
import yaml

ROOT = Path(__file__).resolve().parents[1]
PROJECT = "hushh-pda-uat"
REGION = "us-central1"
SERVICE = "backend-dev-akshat"
BRANCH = "Akshat_Working_branch"
ACCOUNT = "i-akshat@hush1one.com"
AUTH = "hushh-akshat-sandbox-auth"
BUCKET = f"{PROJECT}-{SERVICE}-builds"
IMAGE = f"{REGION}-docker.pkg.dev/{PROJECT}/{SERVICE}/{SERVICE}"
RUNTIME = f"{SERVICE}@{PROJECT}.iam.gserviceaccount.com"
BUILDER = f"{SERVICE}-build@{PROJECT}.iam.gserviceaccount.com"
AZURE = "afd2feb2-fd0f-422c-bdfe-0b7c7e14b5ed"
RESOURCE = f"projects/{PROJECT}/locations/{REGION}/services/{SERVICE}"
STATE = Path(
    subprocess.check_output(
        [
            "git",
            "-C",
            str(ROOT),
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "hushh-sandbox-akshat",
        ],
        text=True,
    ).strip()
)


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def git(*args):
    return subprocess.check_output(["git", "-C", str(ROOT), *args], text=True).strip()


class Response:
    headers = {}

    def __init__(self, status, data):
        self.status, self.data = status, data


class Cloud:
    """Use the owner's ADC; credentials stay in memory and off command lines."""

    def __init__(self):
        self.credentials = Credentials.from_authorized_user_file(
            str(Path.home() / ".config/gcloud/application_default_credentials.json")
        )
        self.credentials.refresh(self.transport)
        identity = self.request("https://www.googleapis.com/oauth2/v2/userinfo")
        require(identity.get("email") == ACCOUNT, "Authenticate ADC as " + ACCOUNT)

    @staticmethod
    def transport(url, method="GET", body=None, headers=None, timeout=None, upload=None, **kwargs):
        budget = 60 if upload else min(float(timeout or 20), 60)
        config = ["url = " + json.dumps(url), "request = " + json.dumps(method)]
        for key, value in (headers or {}).items():
            if isinstance(value, bytes):
                value = value.decode()
            config.append("header = " + json.dumps(key + ": " + value))
        if body is not None:
            config.append("data = " + json.dumps(body.decode() if isinstance(body, bytes) else body))
        command = [
            "curl",
            "--silent",
            "--show-error",
            "--connect-timeout",
            "5",
            "--max-time",
            str(budget),
            "--write-out",
            "\n%{http_code}",
            "--config",
            "-",
        ]
        if upload:
            command += ["--upload-file", str(upload)]
        result = subprocess.run(
            command,
            input="\n".join(config),
            capture_output=True,
            text=True,
            timeout=budget + 10,
        )
        require(
            result.returncode == 0,
            f"Cloud transport failed (curl {result.returncode}); reconcile any pending operation before retrying.",
        )
        data, status = result.stdout.rsplit("\n", 1)
        return Response(int(status), data.encode())

    def request(self, url, body=None, method=None, upload=None):
        if not self.credentials.valid:
            self.credentials.refresh(self.transport)
        response = self.transport(
            url,
            method=method or ("POST" if body is not None or upload else "GET"),
            body=json.dumps(body) if body is not None else None,
            headers={
                "Authorization": "Bearer " + self.credentials.token,
                "Content-Type": "application/gzip" if upload else "application/json",
            },
            upload=upload,
        )
        data = json.loads(response.data)
        require(
            response.status < 300,
            f"Cloud API HTTP {response.status}: {data.get('error', {}).get('status', 'request failed')}: {data.get('error', {}).get('message', '')}",
        )
        return data


def check_permissions(cloud):
    checks = [
        (
            f"https://cloudresourcemanager.googleapis.com/v1/projects/{PROJECT}:testIamPermissions",
            ["cloudbuild.builds.create", "cloudbuild.builds.get"],
        ),
        (
            f"https://run.googleapis.com/v1/{RESOURCE}:testIamPermissions",
            [
                "run.services.get",
                "run.services.update",
                "run.services.getIamPolicy",
                "run.routes.invoke",
            ],
        ),
    ]
    for identity in (RUNTIME, BUILDER):
        checks.append(
            (
                f"https://iam.googleapis.com/v1/projects/{PROJECT}/serviceAccounts/{identity}:testIamPermissions",
                ["iam.serviceAccounts.actAs"],
            )
        )
    missing = []
    for url, expected in checks:
        granted = cloud.request(url, {"permissions": expected}).get("permissions", [])
        missing.extend(permission for permission in expected if permission not in granted)
    bucket = cloud.request(
        f"https://storage.googleapis.com/storage/v1/b/{BUCKET}/iam/testPermissions?permissions=storage.objects.create&permissions=storage.objects.get"
    )
    missing.extend(
        p for p in ["storage.objects.create", "storage.objects.get"] if p not in bucket.get("permissions", [])
    )
    for permission in sorted(set(missing)):
        print("MISSING:", permission, flush=True)
    require(
        not missing,
        "Direct sandbox deployment is blocked by the permissions listed above. No cloud resources were changed.",
    )


def check(cloud, *, deployment=True):
    if deployment:
        check_permissions(cloud)
    service = cloud.request(f"https://run.googleapis.com/v2/{RESOURCE}")
    require(
        not service.get("reconciling", False)
        and service.get("terminalCondition", {}).get("state") == "CONDITION_SUCCEEDED"
        and str(service.get("observedGeneration")) == str(service.get("generation")),
        "Sandbox is not healthy and settled; reconcile it before deployment",
    )
    template = service["template"]
    require(
        service.get("labels", {}).get("sandbox-owner") == "akshat",
        "Sandbox ownership label differs",
    )
    require(
        not service.get("invokerIamDisabled", False),
        "Sandbox must require authenticated invocation",
    )
    require(template.get("serviceAccount") == RUNTIME, "Unexpected runtime identity")
    instances = [
        instance
        for volume in template.get("volumes", [])
        for instance in volume.get("cloudSqlInstance", {}).get("instances", [])
    ]
    require(
        instances == [f"{PROJECT}:{REGION}:{SERVICE}-pg"],
        "Unexpected database instance",
    )
    require(len(template.get("containers", [])) == 1, "Unexpected container topology")
    environment = {entry["name"]: entry for entry in template["containers"][0].get("env", [])}
    require(
        environment.get("DB_NAME", {}).get("value") == "backend_dev_akshat",
        "Unexpected database name",
    )
    require(
        environment.get("DB_UNIX_SOCKET", {}).get("value") == f"/cloudsql/{PROJECT}:{REGION}:{SERVICE}-pg",
        "Unexpected database socket",
    )
    require(
        environment.get("GOOGLE_CLOUD_PROJECT", {}).get("value") == AUTH,
        "Unexpected authentication project",
    )
    for entry in environment.values():
        secret = entry.get("valueSource", {}).get("secretKeyRef")
        if secret:
            allowed = {
                f"BACKEND_DEV_AKSHAT_{suffix}"
                for suffix in (
                    "APP_SIGNING_KEY",
                    "VAULT_DATA_KEY",
                    "DB_USER",
                    "DB_PASSWORD",
                )
            }
            require(
                secret["secret"] in allowed | {f"projects/{PROJECT}/secrets/{name}" for name in allowed},
                "Unexpected secret reference",
            )
    policy = cloud.request(f"https://run.googleapis.com/v2/{RESOURCE}:getIamPolicy")
    require(
        not any(
            member in ("allUsers", "allAuthenticatedUsers")
            for binding in policy.get("bindings", [])
            for member in binding.get("members", [])
        ),
        "Sandbox IAM is public",
    )
    require(
        template.get("scaling", {}).get("maxInstanceCount") == 1,
        "Unexpected sandbox capacity",
    )
    print("Sandbox permissions and isolation: passed", flush=True)
    return service


def traffic_allocation(service):
    result = {}
    for entry in service["trafficStatuses"]:
        if entry.get("percent", 0):
            result[entry["revision"]] = result.get(entry["revision"], 0) + entry["percent"]
    require(
        sum(result.values()) == 100,
        "Existing sandbox traffic does not total 100 percent",
    )
    return result


def save(path, data):
    STATE.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, indent=2) + "\n")
    temporary.chmod(0o600)
    temporary.replace(path)


def deploy(cloud, service, started):
    stage_started = time.monotonic()
    require(git("branch", "--show-current") == BRANCH, "Switch to " + BRANCH)
    require(not git("status", "--porcelain"), "Commit working changes before deployment")
    sha = git("rev-parse", "HEAD")
    require(
        git("ls-remote", "origin", "refs/heads/" + BRANCH).split()[0] == sha,
        "Push the exact branch commit first",
    )
    pending = STATE / "direct-pending.json"
    require(
        not pending.exists(),
        "A prior direct attempt needs reconciliation: " + str(pending),
    )
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d%H%M%S")
    tag = f"local-{sha[:12]}-{int(time.time()):08x}"
    require(len(tag) + len(SERVICE) <= 46, "Sandbox tag and service name exceed Cloud Run's URL limit")
    revision = SERVICE + "-" + tag
    object_name = f"personal-backend/{sha}-local-{stamp}.tar.gz"
    intent = {
        "execution": "local-user-adc",
        "actor": ACCOUNT,
        "sha": sha,
        "project": PROJECT,
        "region": REGION,
        "service": SERVICE,
        "tag": tag,
        "revision": revision,
        "stage": "upload",
        "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "timings_seconds": {"authorization_preflight": round(stage_started - started, 3)},
    }
    save(pending, intent)
    with tempfile.TemporaryDirectory(prefix="akshat-sandbox-") as directory:
        archive = Path(directory) / "source.tar.gz"
        with subprocess.Popen(
            ["git", "-C", str(ROOT), "archive", sha, "consent-protocol", "contracts"],
            stdout=subprocess.PIPE,
        ) as source:
            with gzip.open(archive, "wb") as output:
                shutil.copyfileobj(source.stdout, output)
            require(source.wait() == 0, "Git archive failed")
        stored = cloud.request(
            f"https://storage.googleapis.com/upload/storage/v1/b/{BUCKET}/o?uploadType=media&ifGenerationMatch=0&name={object_name}",
            upload=archive,
        )
    intent["timings_seconds"]["source_archive_and_upload"] = round(time.monotonic() - stage_started, 3)
    recipe = yaml.safe_load(git("show", sha + ":deploy/personal-backend-image.cloudbuild.yaml"))
    recipe.update(
        source={
            "storageSource": {
                "bucket": BUCKET,
                "object": object_name,
                "generation": stored["generation"],
            }
        },
        serviceAccount=f"projects/{PROJECT}/serviceAccounts/{BUILDER}",
    )
    recipe["substitutions"] = {
        "_SANDBOX": "akshat",
        "_IMAGE": IMAGE,
        "_SOURCE_SHA": sha,
        "_ATTEMPT": f"{sha}-local-{stamp}",
    }
    intent.update(stage="build-submit", source_generation=stored["generation"])
    save(pending, intent)
    stage_started = time.monotonic()
    operation = cloud.request(f"https://cloudbuild.googleapis.com/v1/projects/{PROJECT}/builds", recipe)
    build_id = operation["metadata"]["build"]["id"]
    intent.update(stage="build", build_id=build_id)
    save(pending, intent)
    deadline = time.monotonic() + 2100
    while time.monotonic() < deadline:
        build = cloud.request(f"https://cloudbuild.googleapis.com/v1/projects/{PROJECT}/builds/{build_id}")
        status = build["status"]
        print("Cloud Build", build_id, status, flush=True)
        if status == "SUCCESS":
            break
        require(
            status in ("STATUS_UNKNOWN", "PENDING", "QUEUED", "WORKING"),
            "Build failed; inspect recorded build ID before retrying",
        )
        time.sleep(15)
    else:
        raise RuntimeError("Build is still unresolved; inspect recorded build ID")
    intent["timings_seconds"]["build_submit_and_wait"] = round(time.monotonic() - stage_started, 3)
    for label, first, last in [
        ("cloud_build_queue", "createTime", "startTime"),
        ("cloud_build_execution", "startTime", "finishTime"),
    ]:
        if build.get(first) and build.get(last):
            intent["timings_seconds"][label] = round(
                (
                    datetime.datetime.fromisoformat(build[last].replace("Z", "+00:00"))
                    - datetime.datetime.fromisoformat(build[first].replace("Z", "+00:00"))
                ).total_seconds(),
                3,
            )
    import base64

    metadata = json.loads(base64.b64decode(build["results"]["buildStepOutputs"][1]))
    digest = metadata["digest"]
    require(
        metadata["image"] == IMAGE + ":" + recipe["substitutions"]["_ATTEMPT"]
        and re.fullmatch(r"sha256:[0-9a-f]{64}", digest),
        "Image provenance differs",
    )
    require(
        build.get("serviceAccount") == recipe["serviceAccount"],
        "Builder identity differs",
    )
    require(
        build.get("sourceProvenance", {}).get("resolvedStorageSource") == recipe["source"]["storageSource"],
        "Build source provenance differs",
    )
    # Re-read ownership/configuration before the sole Cloud Run mutation.
    fresh = check(cloud)
    require(
        fresh.get("etag") == service.get("etag"),
        "Sandbox changed during the build; reconcile before deployment",
    )
    template = service["template"]
    template["revision"] = revision
    container = template["containers"][0]
    container["image"] = IMAGE + "@" + digest
    updates = {
        "ENVIRONMENT": "development",
        "HUSHH_SANDBOX_MANAGED_AI_PROVIDER": "azure_openai",
        "HUSHH_SANDBOX_AZURE_CLIENT_ID": AZURE,
    }
    container["env"] = [entry for entry in container.get("env", []) if entry["name"] not in updates] + [
        {"name": key, "value": value} for key, value in updates.items()
    ]
    # Freeze any existing 'latest' allocation before creating a revision.
    traffic = [
        {
            "type": "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION",
            "revision": entry["revision"],
            **({"percent": entry["percent"]} if "percent" in entry else {}),
            **({"tag": entry["tag"]} if entry.get("tag") else {}),
        }
        for entry in service["trafficStatuses"]
    ]
    traffic.append(
        {
            "type": "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION",
            "revision": revision,
            "tag": tag,
        }
    )
    body = {
        "name": RESOURCE,
        "etag": service["etag"],
        "template": template,
        "traffic": traffic,
        "labels": {
            **service.get("labels", {}),
            "deploy-sha": sha,
            "sandbox-build-id": build_id,
        },
    }
    intent.update(stage="deploy-submit", digest=digest)
    save(pending, intent)
    stage_started = time.monotonic()
    operation = cloud.request(
        f"https://run.googleapis.com/v2/{RESOURCE}?updateMask=template,traffic,labels",
        body,
        method="PATCH",
    )
    intent.update(stage="deploy", operation=operation["name"])
    save(pending, intent)
    deadline = time.monotonic() + 900
    while not operation.get("done") and time.monotonic() < deadline:
        time.sleep(5)
        operation = cloud.request("https://run.googleapis.com/v2/" + operation["name"])
    require(
        operation.get("done") and "error" not in operation,
        "Deployment did not become ready; reconcile the recorded operation",
    )
    observed = check(cloud)
    require(
        traffic_allocation(observed) == traffic_allocation(service),
        "Existing default traffic changed",
    )
    old_tags = {entry["tag"]: entry["revision"] for entry in service["trafficStatuses"] if entry.get("tag")}
    new_tags = {entry["tag"]: entry["revision"] for entry in observed["trafficStatuses"] if entry.get("tag")}
    require(
        all(new_tags.get(name) == value for name, value in old_tags.items()),
        "Existing sandbox tag changed",
    )
    require(
        any(entry.get("tag") == tag and entry.get("revision") == revision for entry in observed["trafficStatuses"]),
        "New revision tag is not ready",
    )
    require(
        observed["template"]["containers"][0]["image"] == IMAGE + "@" + digest,
        "Deployed image differs",
    )
    intent["timings_seconds"]["revision_rollout_and_verification"] = round(time.monotonic() - stage_started, 3)
    intent["timings_seconds"]["total_deployment_command"] = round(time.monotonic() - started, 3)
    intent["ready_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    intent["stage"] = "ready"
    save(STATE / "direct-deployment.json", intent)
    pending.unlink()
    print("Deployment ready:", json.dumps(intent), flush=True)


def deployment_receipt(service):
    receipt = json.loads((STATE / "direct-deployment.json").read_text())
    require(
        receipt.get("stage") == "ready"
        and receipt.get("actor") == ACCOUNT
        and receipt.get("project") == PROJECT
        and receipt.get("service") == SERVICE
        and re.fullmatch(r"[a-f0-9]{40}", receipt.get("sha", "")),
        "Invalid local deployment receipt",
    )
    tag, sha = receipt["tag"], receipt["sha"]
    require(
        re.fullmatch(r"local-" + sha[:12] + r"-[a-f0-9]{8}", tag),
        "Unexpected local revision tag",
    )
    require(
        receipt["revision"] == SERVICE + "-" + tag
        and any(
            item.get("tag") == tag and item.get("revision") == receipt["revision"]
            for item in service["trafficStatuses"]
        ),
        "Recorded sandbox revision is not available",
    )
    require(
        service["template"]["containers"][0]["image"] == IMAGE + "@" + receipt["digest"],
        "Sandbox image differs from the receipt",
    )
    return receipt


def tunnel(cloud, service):
    receipt = deployment_receipt(service)
    destination = next(item["uri"] for item in service["trafficStatuses"] if item.get("tag") == receipt["tag"])
    binary = shutil.which("cloud-run-proxy")
    require(binary, "Install the Google Cloud SDK cloud-run-proxy component")
    require(destination.startswith("https://") and destination.endswith(".run.app"), "Unexpected sandbox tag URL")
    while True:
        cloud.credentials.refresh(cloud.transport)
        token = cloud.credentials.id_token
        require(token, "The verified owner ADC did not return an identity token")
        # Match the SDK's native proxy/55-minute refresh loop. Never log its argv.
        child = subprocess.Popen(
            [binary, "-host", destination, "-token", token, "-bind", "127.0.0.1:8080", "-server-up-time", "55m"]
        )
        try:
            require(child.wait() == 0, "Authenticated native proxy exited")
        finally:
            if child.poll() is None:
                child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


def frontend(cloud, service, started):
    receipt = deployment_receipt(service)
    sha = receipt["sha"]
    for port in (3000, 8080):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", port))
    tree = ROOT.parent / "hushh-research-akshat-sandbox"
    require(tree.is_dir(), "Matching clean sandbox worktree is missing: " + str(tree))
    # Next adds its selected dev output to this isolated worktree's TS includes.
    # Revert only that exact generated change after a prior owned run.
    tsconfig = tree / "hushh-webapp/tsconfig.json"
    original_config = subprocess.check_output(["git", "-C", str(tree), "show", "HEAD:hushh-webapp/tsconfig.json"])
    original_json = json.loads(original_config)
    owned_type_paths = {
        ".next-isolated/types/**/*.ts",
        ".next-isolated/dev/types/**/*.ts",
        ".next-sandbox-prod/types/**/*.ts",
        ".next-sandbox-prod/dev/types/**/*.ts",
    }
    if tsconfig.exists():
        generated_json = json.loads(tsconfig.read_text())
        generated_json["include"] = [
            entry for entry in generated_json.get("include", []) if entry not in owned_type_paths
        ]
        if generated_json == original_json:
            tsconfig.write_bytes(original_config)
    require(
        not subprocess.check_output(["git", "-C", str(tree), "status", "--porcelain"], text=True).strip(),
        "Sandbox frontend worktree has uncommitted changes",
    )
    subprocess.run(["git", "-C", str(tree), "checkout", "--detach", sha], check=True)
    web = tree / "hushh-webapp"
    for filename in (
        ".env",
        ".env.local",
        ".env.development",
        ".env.development.local",
        ".env.production",
        ".env.production.local",
        "firebase-service-account.json",
    ):
        require(not (web / filename).exists(), "Sandbox frontend must not load " + filename)
    private = Path.home() / ".codex/private/akshat-sandbox"
    config = json.loads((private / "firebase-web-config.json").read_text())
    require(
        config.get("projectId") == AUTH and config.get("authDomain") == AUTH + ".firebaseapp.com",
        "Unexpected Firebase web project",
    )
    adc = private / "localhost-auth-adc.json"
    credential = json.loads(adc.read_text())
    require(
        credential.get("type") == "impersonated_service_account"
        and credential.get("service_account_impersonation_url")
        == f"https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/localhost-sandbox-auth@{AUTH}.iam.gserviceaccount.com:generateAccessToken",
        "Unexpected frontend signing identity",
    )
    owner_credential = json.loads((Path.home() / ".config/gcloud/application_default_credentials.json").read_text())
    require(
        owner_credential.get("type") == "authorized_user"
        and owner_credential.get("refresh_token") == cloud.credentials.refresh_token,
        "Owner ADC changed while preparing the frontend",
    )
    if credential.get("source_credentials") != owner_credential:
        credential["source_credentials"] = owner_credential
        save(adc, credential)
    env = dict(os.environ)
    for key in (
        "K_SERVICE",
        "K_REVISION",
        "GOOGLE_CLOUD_PROJECT",
        "NODE_ENV",
        "CAPACITOR_BUILD",
        "HUSHH_DEPLOY_ENV",
        "FIREBASE_AUTH_EMULATOR_HOST",
        "NEXT_PUBLIC_LOCAL_REVIEWER_EMAIL",
        "NEXT_PUBLIC_LOCAL_REVIEWER_PASSWORD",
    ):
        env.pop(key, None)
    env.update(
        GOOGLE_APPLICATION_CREDENTIALS=str(adc),
        FIREBASE_ADMIN_CREDENTIALS_JSON="",
        FIREBASE_SERVICE_ACCOUNT_JSON="",
        NEXT_PUBLIC_FIREBASE_PROJECT_ID=AUTH,
        NEXT_PUBLIC_FIREBASE_PHONE_AUTH_DISABLE_APP_VERIFICATION="false",
        NEXT_PUBLIC_GOOGLE_SIGN_IN_CLIENT_ID="",
        NEXT_PUBLIC_APP_ENV="uat",
        NEXT_PUBLIC_APP_URL="http://localhost:3000",
        NEXT_DIST_DIR=".next-sandbox-prod",
        NODE_ENV="production",
        NEXT_PUBLIC_OBSERVABILITY_ENABLED="false",
        NODE_OPTIONS="--max-old-space-size=4096",
    )
    for field, name in [
        ("apiKey", "API_KEY"),
        ("authDomain", "AUTH_DOMAIN"),
        ("appId", "APP_ID"),
        ("messagingSenderId", "MESSAGING_SENDER_ID"),
    ]:
        env["NEXT_PUBLIC_FIREBASE_" + name] = config[field]
    for field in ("STORAGE_BUCKET", "MEASUREMENT_ID", "VAPID_KEY"):
        env["NEXT_PUBLIC_FIREBASE_" + field] = ""
    for name in (
        "PYTHON_API_URL",
        "BACKEND_URL",
        "DEVELOPER_API_URL",
        "NEXT_PUBLIC_BACKEND_URL",
        "NEXT_PUBLIC_DEVELOPER_API_URL",
    ):
        env[name] = "http://127.0.0.1:8080"
    env["NEXT_PUBLIC_DEVELOPER_MCP_URL"] = "http://127.0.0.1:8080/mcp/"
    # The tunnel verifies the owner's fixed ADC; the web signer uses dedicated ADC.
    tunnel_env = {key: value for key, value in os.environ.items() if key != "GOOGLE_APPLICATION_CREDENTIALS"}
    children = []
    try:
        tunnel_started = time.monotonic()
        children.append(
            subprocess.Popen(
                [sys.executable, str(Path(__file__).resolve()), "tunnel"],
                env=tunnel_env,
                start_new_session=True,
            )
        )
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            require(children[0].poll() is None, "Authenticated tunnel exited")
            response = subprocess.run(
                [
                    "curl",
                    "-fsS",
                    "--max-time",
                    "3",
                    "-o",
                    "/dev/null",
                    "http://127.0.0.1:8080/health",
                ],
                capture_output=True,
            )
            if response.returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError("Authenticated sandbox tunnel did not become healthy")
        tunnel_seconds = round(time.monotonic() - tunnel_started, 3)
        build_started = time.monotonic()
        print("Building production frontend for the deployed application commit...", flush=True)
        children.append(subprocess.Popen(["npm", "run", "build"], cwd=web, env=env, start_new_session=True))
        require(children[-1].wait() == 0, "Production frontend build failed")
        children.pop()
        frontend_build_seconds = round(time.monotonic() - build_started, 3)
        standalone = web / env["NEXT_DIST_DIR"] / "standalone" / web.name
        require((standalone / "server.js").is_file(), "Production standalone server is missing")
        shutil.copytree(
            web / env["NEXT_DIST_DIR"] / "static", standalone / env["NEXT_DIST_DIR"] / "static", dirs_exist_ok=True
        )
        shutil.copytree(web / "public", standalone / "public", dirs_exist_ok=True)
        web_started = time.monotonic()
        children.append(
            subprocess.Popen(
                ["node", str(standalone / "server.js")],
                cwd=standalone,
                env={**env, "HOSTNAME": "127.0.0.1", "PORT": "3000"},
                start_new_session=True,
            )
        )
        deadline = time.monotonic() + 240
        while time.monotonic() < deadline:
            require(all(child.poll() is None for child in children), "A sandbox runtime process exited")
            response = subprocess.run(
                ["curl", "-fsS", "--max-time", "10", "-o", "/dev/null", "http://localhost:3000/login"],
                capture_output=True,
            )
            if response.returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError("Local frontend did not become ready")
        startup = {
            "sha": sha,
            "supervisor_pid": os.getpid(),
            "revision": receipt["revision"],
            "ready_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "timings_seconds": {
                "authenticated_tunnel": tunnel_seconds,
                "frontend_production_build": frontend_build_seconds,
                "frontend_process_to_login": round(time.monotonic() - web_started, 3),
                "total_frontend_command": round(time.monotonic() - started, 3),
            },
            "owned_processes": [child.pid for child in children],
        }
        save(STATE / "direct-frontend.json", startup)
        print("Startup timings:", json.dumps(startup["timings_seconds"]), flush=True)
        print(
            "Frontend: http://localhost:3000 — sandbox revision " + receipt["revision"],
            flush=True,
        )
        while all(child.poll() is None for child in children):
            time.sleep(1)
        raise RuntimeError("A sandbox runtime process exited")
    finally:
        for child in reversed(children):
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()


def main():
    started = time.monotonic()
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["check", "deploy", "frontend", "tunnel"])
    args = parser.parse_args()
    cloud = Cloud()
    if args.operation == "deploy":
        STATE.mkdir(parents=True, exist_ok=True)
        with (STATE / "direct.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            deploy(cloud, check(cloud), started)
    elif args.operation == "frontend":
        frontend(cloud, check(cloud, deployment=False), started)
    elif args.operation == "tunnel":
        tunnel(cloud, check(cloud, deployment=False))
    else:
        check(cloud)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("Sandbox stopped:", error, file=sys.stderr)
        sys.exit(1)
