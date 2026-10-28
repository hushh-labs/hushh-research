"""Reconcile an uncertain managed create without replacement or a second POST."""

from __future__ import annotations

import asyncio
from typing import Any

from hushh_mcp.services.compute_backend import PodSpec
from hushh_mcp.services.gcp_run_client import GcpRunClient
from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired


async def reconcile_existing_creation(backend: Any, spec: PodSpec, existing: dict) -> None:
    deployment = spec.private_gcp_deployment
    if deployment is None:
        raise ProvisionReconciliationRequired(
            "provision requires reconciliation of existing service"
        )
    try:
        deployment.verify_observation(existing)
        metadata = existing["metadata"]
        uid = GcpRunClient.service_uid(existing)
        if (
            not uid
            or metadata["labels"].get("hussh-provision-attempt") != spec.provision_attempt_id
            or spec.on_provision_ack is None
        ):
            raise ValueError("creation correlation unavailable")
        receipt = {
            "service": metadata["name"],
            "serviceUid": uid,
            "backend": backend.backend_id,
            "project": deployment.project,
            "region": deployment.region,
            **GcpRunClient.creation_runtime_evidence(existing, requested_image=deployment.image),
        }
        if "initialImage" not in receipt:
            raise ValueError("creation image evidence unavailable")
        await asyncio.to_thread(spec.on_provision_ack, receipt)
    except ProvisionReconciliationRequired:
        raise
    except Exception:
        raise ProvisionReconciliationRequired(
            "Managed creation requires exact provider reconciliation"
        ) from None


async def prepare_live_host(backend: Any, spec: PodSpec) -> tuple[Any, dict, str, str, str]:
    from hushh_mcp.services.user_gcp_backend import _create_once_iam_settles, _digest_from_service

    name = backend._private_service_name(spec)
    client = await asyncio.to_thread(backend._client)

    # Fetch the existing service FIRST: it is both the create-vs-replace signal and,
    # if present, the record of the digest already deployed. A heal converges to that
    # digest; only a first provision (no service yet) resolves the source tag. Then
    # copy the image into the user's OWN registry and render the pod to pull THAT
    # digest -- create and replace both consume this one rendered config.
    existing = await asyncio.to_thread(client.get_service, name)
    resumed = False
    if spec.provision_attempt_id and existing is not None:
        from hushh_mcp.services.hosted_provision_recovery import reconcile_existing_creation

        await reconcile_existing_creation(backend, spec, existing)
        resumed = True
    image_digest = await asyncio.to_thread(
        backend._ensure_pod_image, spec, _digest_from_service(existing)
    )
    config = backend.render_deploy_config(spec, image_digest=image_digest)
    if existing is not None:
        from hushh_mcp.services.pod_files.provisioning import preserve_existing_configuration

        preserve_existing_configuration(existing, config)
    if existing is None:
        admitted = await _create_once_iam_settles(
            lambda: (
                asyncio.to_thread(client.create_service, config, adopt_existing=False)
                if spec.provision_attempt_id
                else asyncio.to_thread(client.create_service, config)
            )
        )
        service_uid = GcpRunClient.service_uid(admitted)
        if spec.provision_attempt_id:
            if (
                not service_uid
                or (admitted.get("metadata") or {}).get("name") != name
                or spec.on_provision_ack is None
            ):
                raise RuntimeError("provision acknowledgement unavailable")
            await asyncio.to_thread(
                spec.on_provision_ack,
                {
                    "service": name,
                    "serviceUid": service_uid,
                    "backend": backend.backend_id,
                    "project": backend._user_project,
                    "region": backend._user_region,
                    **GcpRunClient.creation_runtime_evidence(
                        admitted,
                        requested_image=config["spec"]["template"]["spec"]["containers"][0][
                            "image"
                        ],
                    ),
                },
            )
    else:
        service_uid = GcpRunClient.service_uid(existing)
        if not resumed:
            await asyncio.to_thread(
                client.replace_service,
                name,
                client.merge_for_replace(existing, config),
                expected_uid=service_uid,
            )
    return client, config, name, service_uid, image_digest
