# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Bounded non-database classification of the reviewed Production health job.

Build 0f80cc7e-2265-4639-9a1a-199359b20600 produced the pinned image below.
Its generation-bound source archive SHA256 is
a19fcdb0dc591c5138f6b831668ca64d0b2e87d0f791ea8ac05e4fa8c922d07f.
All five image inputs were checked against reviewed repository source. The fixed
entrypoint reads protected lists/readiness and writes only its lease and health
log. This is an immutable source/spec exception, never a job-name exemption.
An image, configuration, UID or historical mutation requires renewed review; the
reviewed image replacements (generations 2 through 6) are recorded below.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime

NAME = "protected-configuration-health"
PROJECT = "hushh-pda"
NUMBER = "1006304528804"
UID = "2fe6b836-fc5a-4186-b8b3-19611ffb3dff"
CREATED = "2026-10-29T16:21:33.378523Z"
SOURCE = "05ea774ef2eba09f0dfb3a1737c966e74b6da4a8"
SPEC = "ff36ba631204673e5ac4f408b00cb4d6aa5012527631d3972b5ea1e44e3bdb6a"
TASK = "94af68e20eca9ae843e70debdd59ccdef242c3f3d655cdbfd2be7e74bcd26735"
BIRTH = (
    "5d56e9698a513fb9709c97eff23840ee793a956465cda545fbf5f3c391fd474c",
    "7eb903e88d1a06eab9236c91a619500928a45d2e98140f6f28fa139b2c890391",
)
# Reviewed replacements, in order. Each changed only the image and its client nonce;
# the same single docker step built it from Main, and each generation-bound archive
# holds Main's reviewed Dockerfile and job bodies. Generation 2: Cloud Build
# 0ba45608-a030-4202-90b0-71062604cb15, archive SHA256
# aa6647278d80462321cea9a1c2bf2ffc7c21e644c8c13ac483ae1bfd6a508e93 (bodies equal
# generation 1). Generation 3: Cloud Build e0b7d6c3-bf93-40e3-8615-dd1745489bdb,
# archive SHA256 f433beeada303cb26b6de1bfc636c82d2ed961e7f392c1d75d992fa396a4d3aa;
# its job and process-group bodies add only bounded, redacted failure diagnostics
# around the same lease and protected-list commands. History must contain each exact
# request/result pair once, in order; executions keep the task of their generation.
REPLACEMENTS = (
    {
        "generation": 2,
        "source": "1af940245ad6dd8205a84035e3bfb0495932d596",
        "spec": "fb2fb8874035600033362d07f9e79645c602032d3e35d650ec5e52008be7b814",
        "task": "8b3ad84b0934de42b7daa200bfa3a885a0bef00ed0bd2ceba8e1c0c93ae35125",
        "events": (
            "3ba3ba1cb710794ccb3a9da3d776e4d7916e5fd1ceadaa71897fe61724578ede",
            "50098f2d491bdf55f5982847891a432de011d641a6d642c67e208b5192a3207d",
        ),
        "requested": "2026-10-29T22:48:18.040662Z",
        "replaced": "2026-10-29T22:48:18.517583Z",
    },
    {
        "generation": 3,
        "source": "bb9f6e8a98d6f32260bcfa8e9efcef04b8d1ce2a",
        "spec": "24d9daefe141c6514708cfe050666654ea5e75a662be72d179a112f9db9b7276",
        "task": "2c2e9337ecdd2e87756417d69d75f3b29c2110a022e38bae93a62ac24e82f4ff",
        "events": (
            "b1338ea6fb0f064d46c4cb9d165d1a1a45dd8f9723769dbf5dd6e37dfd2eaf8a",
            "ed2709f4249409af31ba9de99569cd20ad41e18ab974ec5466b69b0816ceecb5",
        ),
        "requested": "2026-10-29T23:55:16.363536Z",
        "replaced": "2026-10-29T23:55:16.820202Z",
    },
    # Cloud Build 5017e752-b237-4b65-b514-f77ba08ef7f9; immutable source archive SHA256
    # 2f8129493c5b360efa3f147813b38a421ae974c78479fe51398e7a8a46bbc8d2. All inputs match reviewed Main.
    {
        "generation": 4,
        "source": "9276f3edc62e0e3a6f55de04ef2d8b6db0649205",
        "spec": "b4e52c1654794680b6e45d8d5b7c9407d6ba89ca8e21ddc7ef9eb60b3eb3f814",
        "task": "fb27cc66f67893ad97d72a959e31b64fe4cc593b6f88692dc57840827ecdda68",
        "events": (
            "ef152ff798071bc1f49c1c7f15bad090e6240969316b9c11689aa366a91524d4",
            "86f28527bb1c51226de4ac0183d92f96501ea0301f47b1abfaf8e3bfa88ea539",
        ),
        "requested": "2026-10-30T02:18:02.827059Z",
        "replaced": "2026-10-30T02:18:03.403903Z",
    },
    # Cloud Build c49b9d09-ce92-47bf-9f35-9ecfb5beac31; immutable source archive SHA256
    # fffc32beb2e651312800eae39ca027058d68c8ae63cb89774685932f4a3ab2ee. All inputs match reviewed Main.
    {
        "generation": 5,
        "source": "8717d9f6a661f4c55e22497c239d06d5662e6a9c",
        "spec": "c91f54faa62deb742f85e20dbcd5ec3b80ad2123e9bcc2e9d63860d6f8b57465",
        "task": "df5f7baa4fb5ee29e3caf3cd0cd60c7b8ba95d03a2a194fd7cd014104d590528",
        "events": (
            "ec804b9789ea690194d4714f5a0e4ac013022664b7382cafdf86845547ff3206",
            "6b8789d7a1c1cfbfccf1805b2cd2bb71ba912fa5e1d2fd266afa2b3ac66b1291",
        ),
        "requested": "2026-10-30T16:40:21.066055Z",
        "replaced": "2026-10-30T16:40:21.713684Z",
    },
    # Cloud Build 4a57447d-0786-49b9-8925-19c1076a950e; immutable source archive SHA256
    # d5f4b8a61dbe3ec60f587bd6c537d564f227c7774eb67053ec4fb11d24943267. All inputs match reviewed Main.
    {
        "generation": 6,
        "source": "177fceb038f4700d7d4c28e583491f9ffbac15c1",
        "spec": "f76df188752d5ebd4298273ff6f023f2f2ea11343ac3d931b63a2476744b85c4",
        "task": "26b3d54e749797b58d2987870872fabe6d47a4f0d6bf0534cd7d4d7a665c7396",
        "events": (
            "05d420fbdde5b9785fe79ac11229982f4470504564c6a9055653890ef6a9b898",
            "446e8401fbb5c59b09af95034cffe07afbeb66f0da01067086ca6b94f3028037",
        ),
        "requested": "2026-10-30T18:24:19.616718Z",
        "replaced": "2026-10-30T18:24:20.191591Z",
    },
)


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def require(value):
    if not value:
        raise ValueError("auth_health_inventory_unqualified")


def _instant(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _incarnation(job):
    """Return the count of reviewed replacements behind the live generation."""
    generation = job.get("metadata", {}).get("generation")
    spec = fingerprint(job.get("spec"))
    if generation == 1 and spec == SPEC:
        return 0, SOURCE, SPEC
    for count, row in enumerate(REPLACEMENTS, start=1):
        if generation == row["generation"] and spec == row["spec"]:
            return count, row["source"], row["spec"]
    raise ValueError("auth_health_inventory_unqualified")


def _task_matches(task, created):
    tasks = (TASK, *(row["task"] for row in REPLACEMENTS))
    for index, expected in enumerate(tasks):
        after = index == 0 or created > _instant(REPLACEMENTS[index - 1]["replaced"])
        before = index == len(REPLACEMENTS) or created < _instant(
            REPLACEMENTS[index]["requested"]
        )
        if task == expected and after and before:
            return True
    return False


def qualify_job(job):
    metadata = job.get("metadata", {})
    require(
        metadata.get("name") == NAME
        and metadata.get("namespace") == NUMBER
        and metadata.get("uid") == UID
        and metadata.get("creationTimestamp") == CREATED
    )
    _count, source, spec = _incarnation(job)
    return {
        "name": NAME,
        "uid": UID,
        "source": source,
        "spec": spec,
        "capacity_classification": "reviewed-auth-health-observer",
        "connections": 0,
    }


def qualify_execution(execution):
    metadata = execution.get("metadata", {})
    name = metadata.get("name", "")
    require(
        execution.get("kind") == "Execution"
        and metadata.get("namespace") == NUMBER
        and isinstance(name, str)
        and name.startswith(NAME + "-")
        and metadata.get("uid")
        and _instant(metadata["creationTimestamp"]) >= _instant(CREATED)
        and metadata.get("ownerReferences")
        == [
            {
                "kind": "Job",
                "name": NAME,
                "uid": UID,
                "apiVersion": "serving.knative.dev/v1",
                "controller": True,
                "blockOwnerDeletion": True,
            }
        ]
    )
    task = fingerprint(execution.get("spec"))
    require(_task_matches(task, _instant(metadata["creationTimestamp"])))
    return {"name": name, "uid": metadata["uid"], "spec": task}


def collect(job, read, opts):
    row = qualify_job(job)
    executions = read("run", "jobs", "executions", "list", "--job=" + NAME, *opts)
    require(isinstance(executions, list) and len(executions) < 10_000)
    seen, active = set(), []
    for execution in executions:
        metadata = execution.get("metadata", {})
        name = metadata.get("name")
        require(
            isinstance(name, str) and name.startswith(NAME + "-") and name not in seen
        )
        seen.add(name)
        if execution.get("status", {}).get("completionTime"):
            continue
        observed = read("run", "jobs", "executions", "describe", name, *opts)
        require(observed.get("metadata", {}).get("name") == name)
        active.append(qualify_execution(observed))
    return {
        **row,
        "checked_active_executions": sorted(active, key=lambda item: item["name"]),
    }


def review_history(events, job):
    """Close the exact birth, reviewed replacements and every completed execution."""
    current = qualify_job(job)
    expected = _incarnation(job)[0]
    require(
        len(events) >= 2 and tuple(fingerprint(event) for event in events[:2]) == BIRTH
    )
    starts = {row["events"][0]: position for position, row in enumerate(REPLACEMENTS)}
    executions, seen, applied, index = [], set(), 0, 2
    while index < len(events):
        event = events[index]
        position = starts.get(fingerprint(event))
        if position is not None:
            pair = tuple(fingerprint(row) for row in events[index : index + 2])
            require(position == applied and pair == REPLACEMENTS[position]["events"])
            applied, index = applied + 1, index + 2
            continue
        index += 1
        payload = event.get("protoPayload", {})
        require(
            event.get("logName")
            == f"projects/{PROJECT}/logs/cloudaudit.googleapis.com%2Fsystem_event"
            and payload.get("methodName") == "/Jobs.RunJob"
            and not payload.get("request")
        )
        execution = payload.get("response", {})
        row = qualify_execution(execution)
        require(
            payload.get("resourceName")
            == f"namespaces/{PROJECT}/executions/{row['name']}"
            and row["uid"] not in seen
            and not any(previous["name"] == row["name"] for previous in executions)
        )
        completed = [
            condition
            for condition in execution.get("status", {}).get("conditions", [])
            if condition.get("type") == "Completed"
        ]
        require(len(completed) == 1 and completed[0].get("status") in {"True", "False"})
        seen.add(row["uid"])
        executions.append(row)
    require(applied == expected)
    return {
        "source": current["source"],
        "uid": UID,
        "birth": list(BIRTH),
        **(
            {"replacements": [list(row["events"]) for row in REPLACEMENTS[:applied]]}
            if applied
            else {}
        ),
        "executions": executions,
    }
