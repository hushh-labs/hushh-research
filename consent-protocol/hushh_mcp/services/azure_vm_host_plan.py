"""Owner-approved VM host resources, using the existing deterministic ARM plan.

No provisioning entrypoint is enabled here. This is the exact, reviewable resource
delta for a whole-pod host offer; existing Container Apps and custody stay intact
until the admitted handoff proves recovery and conditionally publishes the VM.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from hushh_mcp.services.azure_setup_plan import ArmStep, PlanInputs, Scopes, resource_names, tags
from hushh_mcp.services.pod_azure_vm_identity import AzureVmInstallation

OS_IMAGE = {
    "publisher": "Canonical",
    "offer": "ubuntu-24_04-lts",
    "sku": "server",
    "version": "24.04.202610160",
}
VM_SIZE = "Standard_B2als_v2"
# VM start/deallocate is scoped to the exact VM. Compute status reads need a
# separately qualified scope: provider guides differ for split custom roles.
# URI shape alone proves no permission. Never substitute Contributor.
VM_POWER_ACTIONS = (
    "Microsoft.Compute/virtualMachines/read",
    "Microsoft.Compute/virtualMachines/instanceView/read",
    "Microsoft.Compute/virtualMachines/start/action",
    "Microsoft.Compute/virtualMachines/deallocate/action",
)
VM_POLL_ACTIONS = ("Microsoft.Compute/locations/operations/read",)


@dataclass(frozen=True)
class VmHostPlan:
    steps: tuple[ArmStep, ...]
    vm_id: str
    os_disk_id: str
    cleanup_ids: tuple[str, ...]


def _resource(located: dict, path: str, api: str, properties: dict, **extra: Any) -> ArmStep:
    return ArmStep(
        "creating_environment",
        "resource",
        "PUT",
        path,
        api,
        {**located, **extra, "properties": properties},
        create_only=True,
    )


def _inbound_rules() -> list[dict]:
    rules = []
    for priority, label, port in (
        (100, "agent-https", "443"),
        (110, "certificate-validation", "80"),
    ):
        rules.append(
            {
                "name": label,
                "properties": {
                    "priority": priority,
                    "direction": "Inbound",
                    "access": "Allow",
                    "protocol": "Tcp",
                    "sourcePortRange": "*",
                    "destinationPortRange": port,
                    "sourceAddressPrefix": "Internet",
                    "destinationAddressPrefix": "*",
                },
            }
        )
    rules.append(
        {
            "name": "deny-other-inbound",
            "properties": {
                "priority": 200,
                "direction": "Inbound",
                "access": "Deny",
                "protocol": "*",
                "sourcePortRange": "*",
                "destinationPortRange": "*",
                "sourceAddressPrefix": "*",
                "destinationAddressPrefix": "*",
            },
        }
    )
    return rules


def _network_steps(located: dict, nsg: str, vnet: str, ip: str, nic: str) -> tuple[ArmStep, ...]:
    def step(path: str, api: str, properties: dict, **extra: Any) -> ArmStep:
        return _resource(located, path, api, properties, **extra)

    rules = _inbound_rules()
    return (
        step(nsg, "network", {"securityRules": rules}),
        step(
            vnet,
            "network",
            {
                "addressSpace": {"addressPrefixes": ["10.219.0.0/24"]},
                "subnets": [
                    {
                        "name": "agent",
                        "properties": {
                            "addressPrefix": "10.219.0.0/24",
                            "defaultOutboundAccess": False,
                            "networkSecurityGroup": {"id": nsg},
                        },
                    }
                ],
            },
        ),
        step(
            ip,
            "network",
            {"publicIPAllocationMethod": "Static", "publicIPAddressVersion": "IPv4"},
            sku={"name": "Standard"},
        ),
        step(
            nic,
            "network",
            {
                "networkSecurityGroup": {"id": nsg},
                "ipConfigurations": [
                    {
                        "name": "agent",
                        "properties": {
                            "subnet": {"id": vnet + "/subnets/agent"},
                            "privateIPAllocationMethod": "Dynamic",
                            "publicIPAddress": {"id": ip},
                        },
                    }
                ],
            },
        ),
    )


def _vm_step(
    located: dict, vm: str, name: str, identity: str, nic: str, ssh_public_key: str
) -> ArmStep:
    return _resource(
        located,
        vm,
        "virtual_machines",
        {
            "hardwareProfile": {"vmSize": VM_SIZE},
            "storageProfile": {
                "imageReference": dict(OS_IMAGE),
                "osDisk": {
                    "name": name,
                    "createOption": "FromImage",
                    "deleteOption": "Delete",
                    "managedDisk": {"storageAccountType": "StandardSSD_LRS"},
                },
            },
            "osProfile": {
                "computerName": name,
                "adminUsername": "husshhost",
                "linuxConfiguration": {
                    "disablePasswordAuthentication": True,
                    "ssh": {
                        "publicKeys": [
                            {
                                "path": "/home/husshhost/.ssh/authorized_keys",
                                "keyData": ssh_public_key,
                            }
                        ]
                    },
                },
            },
            "networkProfile": {
                "networkInterfaces": [{"id": nic, "properties": {"deleteOption": "Delete"}}]
            },
        },
        identity={"type": "UserAssigned", "userAssignedIdentities": {identity: {}}},
    )


def build_vm_host_plan(
    inputs: PlanInputs, *, generation: str, image_digest: str, ssh_public_key: str
) -> VmHostPlan:
    """Destination only. Never replace the existing owner's compute or custody."""
    import re

    if not re.fullmatch(r"vm_[a-f0-9]{32}", generation) or not re.fullmatch(
        r"sha256:[a-f0-9]{64}", image_digest
    ):
        raise ValueError("VM host installation binding required")
    if not re.fullmatch(
        r"ssh-rsa [A-Za-z0-9+/=]{256,2048}(?: [A-Za-z0-9_.@-]{1,128})?", ssh_public_key
    ):
        raise ValueError("VM host SSH public key invalid")
    scope = Scopes(inputs, resource_names(inputs))
    name = "one-" + generation[3:19]
    compute = scope.group + "/providers/Microsoft.Compute/"
    network = scope.group + "/providers/Microsoft.Network/"
    vm, disk = compute + "virtualMachines/" + name, compute + "disks/" + name
    nsg, vnet, ip, nic = (
        network + kind + "/" + name
        for kind in (
            "networkSecurityGroups",
            "virtualNetworks",
            "publicIPAddresses",
            "networkInterfaces",
        )
    )
    located = {
        "location": inputs.location,
        "tags": {
            **tags(inputs),
            "husshPod": inputs.hushh_id,
            "husshPodGeneration": generation,
            "husshPodImage": image_digest,
        },
    }

    network_steps = _network_steps(located, nsg, vnet, ip, nic)
    steps = (*network_steps, _vm_step(located, vm, name, scope.identity, nic, ssh_public_key))
    # Explicit derived OS disk is retained in inventory even though deleting the
    # VM requests its removal. A provider-side delete option is not an absence receipt.
    return VmHostPlan(steps, vm, disk, (vm, disk, nic, ip, vnet, nsg))


def host_configuration(
    *,
    installation: AzureVmInstallation,
    tenant_id: str,
    image: str,
    hostname: str,
    signing_secret: str,
    environment: dict[str, str],
    browser_qualification: dict | None = None,
) -> dict:
    """Non-secret installation payload; no API key or signing value is serialized."""
    from browser_runtime.azure_host.config import validate
    from hushh_mcp.services.pod_release import browser_qualification_environment

    observed = browser_qualification_environment(
        browser_qualification, target_image=image, host_kind="azure_vm"
    )

    return validate(
        {
            "version": 1,
            "installation": installation.model_dump(),
            "tenant_id": tenant_id,
            "image": image,
            "hostname": hostname,
            "signing_secret": signing_secret,
            "environment": {**environment, **observed},
        }
    )
