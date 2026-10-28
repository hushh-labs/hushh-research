"""Read-only native evidence before retiring an unhosted preparation attempt."""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Callable
from urllib.parse import quote

from hushh_mcp.services.hosted_native_inventory import NativeProjectInventory
from hushh_mcp.services.hosted_native_memory_inventory import observe_memory_absence
from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired

InventoryObserver = Callable[[NativeProjectInventory, dict, str], dict]
CORE_FIELDS = (
    "cloud_run_services",
    "cloud_run_jobs",
    "buckets",
    "soft_deleted_buckets",
    "kms_keys",
    "secrets",
)


def native_preparation_inventory(
    reader: NativeProjectInventory,
    creation: dict,
    region: str,
    *,
    managed_context: dict | None = None,
) -> dict:
    return {
        "resourceInventory": reader.core(),
        "noMemory": observe_memory_absence(
            reader, assigned_region=region, creation=creation, managed_context=managed_context
        ),
    }


class ReadOnlyPreparationSession:
    """Inventory callbacks cannot mutate through their supplied transport."""

    def __init__(self, session: Any) -> None:
        self._session = session

    def request(self, method: str, url: str, **options: Any) -> Any:
        if method.upper() not in {"GET", "HEAD"} and not (
            method.upper() == "POST" and url.endswith(":getIamPolicy")
        ):
            raise ProvisionReconciliationRequired("Preparation inspection cannot mutate")
        return self._session.request(method, url, **options)

    def get(self, url: str, **options: Any) -> Any:
        return self.request("GET", url, **options)

    def post(self, url: str, **options: Any) -> Any:
        return self.request("POST", url, **options)


def _inspect(
    session: Any,
    token: str,
    coordinates: dict,
    contract: dict,
    region: str,
    inventory: InventoryObserver,
) -> dict:
    project, number = coordinates["project"], coordinates["projectNumber"]
    bootstrap = coordinates["bootstrap"]
    headers = {"Authorization": "Bearer " + token}
    reader = NativeProjectInventory(project=project, number=number, token=token, session=session)
    creation = coordinates["projectIdentity"]
    reader.project_identity(creation)
    observed_billing = _inspect_authority(session, headers, coordinates, contract)
    observed = inventory(reader, creation, region)
    if not isinstance(observed, dict) or observed.get("resourceInventory") != {
        key: [] for key in CORE_FIELDS
    }:
        raise ProvisionReconciliationRequired(
            "Preparation resources remain or inventory is incomplete"
        )
    memory = observed.get("noMemory")
    if (
        not isinstance(memory, dict)
        or memory.get("engines") != []
        or memory.get("complete") is not True
        or memory.get("projectNumber") != number
        or memory.get("status") != "observed_absent"
    ):
        raise ProvisionReconciliationRequired("Preparation Memory inventory is incomplete")
    reader.project_identity(creation)
    return {
        "failedPreparation": deepcopy(coordinates.get("failedPreparation", {})),
        "billingObservation": observed_billing,
        "bootstrapIdentity": {
            "name": f"projects/{project}/serviceAccounts/{bootstrap}",
            "projectNumber": number,
            "httpStatus": 404,
            "status": "observed_absent",
        },
        "projectIam": {
            "project": project,
            "projectNumber": number,
            "httpStatus": 200,
            "member": "serviceAccount:" + bootstrap,
            "bindings": [],
            "complete": True,
        },
        "resourceInventory": observed["resourceInventory"],
        "noMemory": memory,
    }


def _inspect_authority(session: Any, headers: dict, coordinates: dict, contract: dict) -> dict:
    project, bootstrap = coordinates["project"], coordinates["bootstrap"]
    response = session.get(
        f"https://iam.googleapis.com/v1/projects/{project}/serviceAccounts/{quote(bootstrap, safe='')}",
        headers=headers,
        timeout=20,
        allow_redirects=False,
    )
    if response.status_code != 404:
        raise ProvisionReconciliationRequired(
            "Preparation bootstrap effects require reconciliation"
        )
    response = session.post(
        f"https://cloudresourcemanager.googleapis.com/v1/projects/{project}:getIamPolicy",
        headers=headers,
        json={"options": {"requestedPolicyVersion": 3}},
        timeout=20,
        allow_redirects=False,
    )
    policy = _body(response)
    bindings = policy.get("bindings", [])
    if not isinstance(bindings, list) or not policy.get("etag"):
        raise ProvisionReconciliationRequired("Preparation IAM inventory is incomplete")
    for binding in bindings:
        if not isinstance(binding, dict) or not isinstance(binding.get("members"), list):
            raise ProvisionReconciliationRequired("Preparation IAM binding is malformed")
        for member in binding["members"]:
            if (
                not isinstance(member, str)
                or member == "serviceAccount:" + bootstrap
                or member.startswith("deleted:serviceAccount:" + bootstrap + "?uid=")
            ):
                raise ProvisionReconciliationRequired("Preparation IAM effects remain")
    billing = _body(
        session.get(
            f"https://cloudbilling.googleapis.com/v1/projects/{project}/billingInfo",
            headers=headers,
            timeout=20,
            allow_redirects=False,
        )
    )
    observed_billing = {
        key: billing.get(key) for key in ("projectId", "billingAccountName", "billingEnabled")
    }
    if observed_billing not in (
        {"projectId": project, "billingAccountName": "", "billingEnabled": False},
        {
            "projectId": project,
            "billingAccountName": contract["billingAccount"],
            "billingEnabled": True,
        },
    ):
        raise ProvisionReconciliationRequired("Preparation billing authority changed")
    return observed_billing


def _body(response: Any) -> dict:
    if response.status_code != 200:
        raise ProvisionReconciliationRequired("Preparation native read is unverified")
    value = response.json()
    if not isinstance(value, dict) or value.get("error") or value.get("unreachable"):
        raise ProvisionReconciliationRequired("Preparation native read is incomplete")
    return value
