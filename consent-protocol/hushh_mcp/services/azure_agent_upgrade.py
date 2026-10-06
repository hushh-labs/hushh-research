"""Move an owner Azure agent onto an approved digest, under the person's JIT token.

There is no ARM ETag for a container app (measured), so the write is fenced by what
Hussh recorded instead: the hub's upgrade lease (held by the orchestrator around this
call), the agent's ``hussh-incarnation`` tag, which must equal the recorded
``serviceUid``, and ``systemData.createdAt``, re-read immediately before the PUT. A
replaced or re-created agent changes one of them and the upgrade refuses.

With an owner-approved operation, the running agent is first fenced through the
existing pod upgrade handoff (prepare, idle receipt) and released again if anything
fails before the replacement is submitted, exactly as on Google Cloud.

The new revision's suffix is derived from the attempt id, so the acknowledgement
names exactly the revision this attempt created. The previous revision keeps serving
until the new one is ready (single revision mode activates the new one only then),
and the update answers only on the platform's verdict for that revision.
Files background organization is not available on Azure yet, so a Files plan refuses.
The import reads the source as the configured image reader (``azure_image_source``),
minted inside the fenced section so a refused credential releases the drained agent,
and from the same pod-only release repository setup imports from (``import_source``).
"""

from __future__ import annotations

import copy
import logging
import time
from collections.abc import Callable
from typing import TYPE_CHECKING, Any, Optional

from hushh_mcp.services.azure_agent_setup import binding_is_valid, parse_source_image
from hushh_mcp.services.azure_arm_client import API_VERSIONS, ArmClient, ArmError
from hushh_mcp.services.azure_container_app_renderer import (
    INCARNATION_TAG,
    image_reference,
    refuse_metered_configuration,
)
from hushh_mcp.services.azure_image_source import import_credentials, release_source
from hushh_mcp.services.azure_setup_applier import AzureSetupRefused, resolve
from hushh_mcp.services.azure_setup_plan import (
    CONTAINER_APP_NAME,
    NONCE_TAG,
    Scopes,
    import_image_step,
    resource_names,
)
from hushh_mcp.services.compute_backend import BackendHandle, PodSpec
from hushh_mcp.services.pod_release import is_immutable_image_reference

if TYPE_CHECKING:
    from hushh_mcp.services.azure_agent_observation import AzureAgentObservation
    from hushh_mcp.services.user_azure_backend import UserAzureBackend

logger = logging.getLogger(__name__)

#: How often, and for how long, an update reads its new revision before answering.
#: A cold start measured 30 to 41 s on dev (2026-10-05). Answering at ARM's acceptance
#: instead reported a finished update as failed while the revision came up seconds
#: later; six minutes stays far above the measurement and inside the job's heartbeat.
VERDICT_POLL_SECONDS = 5.0
VERDICT_TIMEOUT_SECONDS = 360.0

#: What a waited update tells the person, typed so each sentence claims only what was
#: observed. Azure decided the new revision failed: single revision mode never moved
#: traffic off the previous one. No decision arrived (timeout, or the reads stopped):
#: the lease stays and read-only recovery settles it, so there is nothing to do yet.
UPGRADE_REVISION_FAILED = "UPGRADE_REVISION_FAILED"
UPGRADE_UNCONFIRMED = "UPGRADE_UNCONFIRMED"
REVISION_FAILED_MESSAGE = (
    "The new version did not start. Your agent keeps running the version it had. "
    "Try the update again."
)
UNCONFIRMED_MESSAGE = (
    "We could not confirm the update yet. It is being checked; you do not need to do anything."
)

#: ARM answers read again until the deadline (Azure busy or erroring); an unreadable
#: agent or any other refusal is no proof either way, so it is unconfirmed at once.
_TRANSIENT_ARM_KINDS = frozenset({"throttled", "server"})

#: Writable fields of a container app; everything else ARM computes.
_WRITABLE = ("location", "tags", "identity")
_WRITABLE_PROPERTIES = ("environmentId", "workloadProfileName", "configuration", "template")


def revision_suffix(attempt_id: str) -> str:
    """Lowercase alphanumeric, short, and unique to one upgrade attempt."""
    clean = "".join(ch for ch in str(attempt_id or "").lower() if ch.isalnum())
    if len(clean) < 8:
        raise ValueError("an upgrade needs its attempt id to name the new revision")
    return f"u{clean[:12]}"


#: The economy idle window every scale-to-zero agent runs with (the renderer's value).
IDLE_GRACE_ENV = {"name": "POD_IDLE_GRACE_SECONDS", "value": "600"}


def _carry_idle_window(template: dict[str, Any], container: dict[str, Any]) -> None:
    """Give a scale-to-zero agent set up before the idle window existed that window.

    Azure has one profile (minReplicas 0), so this is part of it, not an opt-in; an
    agent without it never released an idle Puppy socket and stayed warm. A value the
    agent already carries is never changed.
    """
    if ((template.get("scale") or {}).get("minReplicas")) != 0:
        return
    env = container.setdefault("env", [])
    if not any(entry.get("name") == IDLE_GRACE_ENV["name"] for entry in env):
        env.append(dict(IDLE_GRACE_ENV))


def replacement_body(app: dict[str, Any], *, image: str, suffix: str) -> dict[str, Any]:
    """The existing agent with one image and one revision suffix changed."""
    body = {key: copy.deepcopy(app[key]) for key in _WRITABLE if key in app}
    properties = app.get("properties") or {}
    body["properties"] = {
        key: copy.deepcopy(properties[key]) for key in _WRITABLE_PROPERTIES if key in properties
    }
    template = body["properties"].setdefault("template", {})
    template["revisionSuffix"] = suffix
    containers = template.get("containers") or []
    if len(containers) != 1:
        raise ValueError("the agent runs exactly one container")
    containers[0]["image"] = image
    _carry_idle_window(template, containers[0])
    # Secrets are Key Vault references (name, URL, identity), so the GET shape is
    # exactly what a replace must carry; no secret value ever transits Hussh here.
    refuse_metered_configuration(body)
    return body


def _fence(app: dict[str, Any], spec: PodSpec, expected_uid: str) -> tuple[str, str]:
    tags = app.get("tags") or {}
    if not binding_is_valid(tags, spec.hushh_id) or tags.get(INCARNATION_TAG) != expected_uid:
        raise RuntimeError("pod incarnation changed; reconcile before updating")
    created = str((app.get("systemData") or {}).get("createdAt") or "")
    return str(tags.get(NONCE_TAG) or ""), created


def _image(app: dict[str, Any]) -> str:
    containers = ((app.get("properties") or {}).get("template") or {}).get("containers") or [{}]
    return str(containers[0].get("image") or "")


def import_source(approved: str) -> tuple[str, str, str]:
    """(registry, repository, digest) the person's registry imports the approved image from.

    The approval, the acknowledgement and the agent's reported image all stay bound to
    ``approved``; only where those bytes are read from moves, to the pod-only release
    repository the image reader is granted (``release_source``), exactly as setup does.
    Reading the hub's own reference instead would ask the reader for a repository it is
    deliberately not granted. A digest names exact bytes, so a mapping that reads any
    other digest is refused.
    """
    _, _, approved_digest = parse_source_image(approved)
    registry, repository, digest = parse_source_image(release_source(approved))
    if digest != approved_digest:
        raise RuntimeError("the import source must name the approved digest")
    return registry, repository, digest


def upgrade_agent(
    backend: UserAzureBackend,
    spec: PodSpec,
    arm: ArmClient,
    *,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> BackendHandle:
    """Synchronous: import the digest, re-fence, replace, acknowledge, wait for a verdict."""
    if spec.files_upgrade_plan is not None:
        raise ValueError("Files background organization is not available on Azure yet")
    expected = str(spec.expected_service_uid or "").strip()
    if not expected:
        raise RuntimeError("pod incarnation unverified; recovery required before upgrade")
    registry, repository, digest = import_source(str(spec.upgrade_target_image or ""))
    api = API_VERSIONS["container_apps"]
    app = arm.get(backend.app_id, api_version=api, op="upgrade")
    nonce, created = _fence(app, spec, expected)
    names = resource_names(backend.plan_inputs(spec.hushh_id, nonce))
    scopes = Scopes(backend.plan_inputs(spec.hushh_id, nonce), names)
    target = image_reference(f"{names.registry}.azurecr.io", digest)
    previous = _image(app)
    if previous == target:
        running = backend.verified_handle(spec.hushh_id, backend.observe_sync())
        return _with_metadata(running, upgraded=False, source_image=spec.upgrade_target_image)
    handoff = _prepare_handoff(spec, app)
    try:
        step = import_image_step(scopes, registry, repository)
        body = resolve(step.body, {"imageDigest": digest})
        credentials = import_credentials(registry)
        if credentials is not None:
            body["source"]["credentials"] = credentials()
        arm.post(step.path, api_version=API_VERSIONS[step.api], body=body, op="importing_image")
        current = arm.get(backend.app_id, api_version=api, op="upgrade")
        if _fence(current, spec, expected) != (nonce, created):
            raise RuntimeError("the agent changed while its image was imported; nothing replaced")
    except Exception:
        _release_handoff(handoff, spec)
        raise
    return _replace(
        backend,
        spec,
        arm,
        current=current,
        target=target,
        previous=previous,
        clock=clock,
        sleep=sleep,
    )


def _replace(
    backend: UserAzureBackend,
    spec: PodSpec,
    arm: ArmClient,
    *,
    current: dict[str, Any],
    target: str,
    previous: str,
    clock: Callable[[], float],
    sleep: Callable[[float], None],
) -> BackendHandle:
    """Submit the one-image replacement, acknowledge it, and wait for its revision."""
    api = API_VERSIONS["container_apps"]
    expected = str(spec.expected_service_uid or "")
    suffix = revision_suffix(spec.upgrade_attempt_id or spec.upgrade_operation_id or "")
    started = arm.request(
        "PUT",
        backend.app_id,
        api_version=api,
        body=replacement_body(current, image=target, suffix=suffix),
        op="deploying_agent",
    )
    revision = f"{CONTAINER_APP_NAME}--{suffix}"
    if spec.on_upgrade_ack is not None:
        spec.on_upgrade_ack(
            {
                "version": 1,
                "service": backend.app_id,
                "serviceUid": expected,
                "revision": revision,
                "attemptId": spec.upgrade_attempt_id or "",
                "image": target,
            }
        )
    try:  # the replace was sent: the revision verdict below, not this poll, decides
        if arm.needs_poll(started):
            arm.wait(started, "deploying_agent")
    except (ArmError, OSError) as exc:
        logger.warning("user_azure_backend.replace_poll_failed err=%s", type(exc).__name__)
    began = clock()
    observation = _await_verdict(
        backend, spec, arm, revision=revision, target=target, clock=clock, sleep=sleep
    )
    handle = backend.verified_handle(spec.hushh_id, observation)
    logger.info(
        "user_azure_backend.upgraded revision=%s waited_seconds=%.0f", revision, clock() - began
    )
    return _with_metadata(
        handle, upgraded=True, source_image=spec.upgrade_target_image, previous_image=previous
    )


def _prepare_handoff(spec: PodSpec, app: dict[str, Any]) -> Any:
    """Fence the running agent's work before replacement (the GCP handoff, unchanged).

    Single revision mode keeps the old revision serving until the new one is ready,
    so without this two revisions could write one sealed log at once. The client is
    cloud-neutral: a Google ID token for the agent's own address, the same hub-to-pod
    identity Azure keeps. The incarnation is the serving revision, which the agent
    reads as CONTAINER_APP_REVISION.
    """
    if not spec.upgrade_operation_id:
        return None
    from hushh_mcp.services.pod_upgrade_handoff import PodUpgradeHandoffClient  # noqa: PLC0415

    properties = app.get("properties") or {}
    fqdn = str(((properties.get("configuration") or {}).get("ingress") or {}).get("fqdn") or "")
    revision = str(properties.get("latestReadyRevisionName") or "")
    if not fqdn or not revision:
        raise RuntimeError("pod upgrade handoff capability is unavailable")
    client = PodUpgradeHandoffClient(url=f"https://{fqdn}", hushh_id=spec.hushh_id)
    handoff = (client, revision)
    try:
        receipt = client.prepare_and_wait(
            operation_id=spec.upgrade_operation_id, incarnation=revision
        )
        if spec.on_upgrade_idle is not None:
            spec.on_upgrade_idle(receipt)
    except Exception:
        _release_handoff(handoff, spec)
        raise
    return handoff


def _release_handoff(handoff: Any, spec: PodSpec) -> None:
    """Release the fence when no replacement was submitted. Never masks the cause."""
    if handoff is None:
        return
    client, revision = handoff
    try:
        client.release(operation_id=spec.upgrade_operation_id, incarnation=revision)
    except Exception:  # noqa: BLE001 - the original failure is the one to report
        logger.info("user_azure_backend.handoff_release_failed", exc_info=True)


#: App provisioning states after which ARM is no longer applying the replacement.
_SETTLED_APP_STATES = frozenset({"Succeeded", "Failed", "Canceled"})


def upgrade_verdict(
    app: dict[str, Any],
    *,
    revision: str,
    image: str,
    read_revision: Callable[[], Optional[dict[str, Any]]],
) -> Optional[str]:
    """``live``, ``failed``, or None while the platform has not decided.

    Failed only on a definitive platform verdict: the attempt's revision failed to
    provision or to run, or ARM settled without ever creating it. A revision still
    activating keeps the lease (None), because calling it failed would record the old
    image while the new one may yet start serving.
    """
    properties = app.get("properties") or {}
    latest = properties.get("latestRevisionName")
    if (
        latest == revision
        and properties.get("latestReadyRevisionName") == revision
        and properties.get("provisioningState") == "Succeeded"
    ):
        if _image(app) != image:
            raise RuntimeError("the acknowledged replacement changed; reconcile before resolving")
        return "live"
    resource = read_revision()
    if resource is not None:
        state = resource.get("properties") or {}
        return (
            "failed"
            if "Failed" in (state.get("provisioningState"), state.get("runningState"))
            else None
        )
    if latest != revision and properties.get("provisioningState") in _SETTLED_APP_STATES:
        return "failed"
    return None


def _revision_reader(
    client: ArmClient, app_id: str, revision: str, op: str
) -> Callable[[], Optional[dict[str, Any]]]:
    """Read exactly the revision one attempt created; None while ARM has no such revision."""
    return lambda: client.get_or_none(
        f"{app_id}/revisions/{revision}", api_version=API_VERSIONS["container_apps"], op=op
    )


def _unconfirmed(revision: str, reason: str) -> AzureSetupRefused:
    """The typed answer when no verdict was observed; the reason stays in the log."""
    logger.warning("user_azure_backend.upgrade_unconfirmed revision=%s reason=%s", revision, reason)
    return AzureSetupRefused(UNCONFIRMED_MESSAGE, code=UPGRADE_UNCONFIRMED)


def _read_verdict(
    backend: UserAzureBackend,
    spec: PodSpec,
    *,
    revision: str,
    target: str,
    read_revision: Callable[[], Optional[dict[str, Any]]],
) -> tuple[Optional[str], AzureAgentObservation]:
    """One re-fenced read of the agent and the attempt's revision, like recovery's."""
    observation = backend.observe_sync()
    if not observation.present:
        if observation.absence_confirmed:
            raise observation.refusal("observe the update of")
        raise _unconfirmed(revision, observation.gone_reason or "unreadable")
    _fence(observation.app, spec, str(spec.expected_service_uid or ""))
    verdict = upgrade_verdict(
        observation.app, revision=revision, image=target, read_revision=read_revision
    )
    return verdict, observation


def _await_verdict(
    backend: UserAzureBackend,
    spec: PodSpec,
    arm: ArmClient,
    *,
    revision: str,
    target: str,
    clock: Callable[[], float],
    sleep: Callable[[float], None],
) -> AzureAgentObservation:
    """Read the agent until the attempt's revision has a platform verdict.

    ``upgrade_verdict`` stays the one place that decides live and failed, the same rule
    the read-only recovery applies, and every read is re-fenced like recovery's. A busy
    or erroring Azure is read again until the deadline. Every refusal raises after the
    acknowledgement was recorded, so the orchestrator keeps the lease and that recovery
    settles it: success is only recorded once observed.
    """
    read_revision = _revision_reader(arm, backend.app_id, revision, "deploying_agent")
    deadline = clock() + VERDICT_TIMEOUT_SECONDS
    while True:
        verdict: Optional[str] = None
        try:
            verdict, observation = _read_verdict(
                backend, spec, revision=revision, target=target, read_revision=read_revision
            )
        except (ArmError, OSError) as exc:  # requests' transport errors are OSErrors
            kind = exc.kind if isinstance(exc, ArmError) else type(exc).__name__
            if isinstance(exc, ArmError) and kind not in _TRANSIENT_ARM_KINDS:
                raise _unconfirmed(revision, f"arm_{kind}") from exc
            logger.info("user_azure_backend.verdict_read_retry revision=%s err=%s", revision, kind)
        if verdict == "live":
            return observation
        if verdict == "failed":
            logger.warning("user_azure_backend.upgrade_revision_failed revision=%s", revision)
            raise AzureSetupRefused(REVISION_FAILED_MESSAGE, code=UPGRADE_REVISION_FAILED)
        if clock() + VERDICT_POLL_SECONDS > deadline:
            raise _unconfirmed(revision, f"no_verdict_within_{VERDICT_TIMEOUT_SECONDS:.0f}s")
        sleep(VERDICT_POLL_SECONDS)


def observe_upgrade(
    backend: UserAzureBackend,
    spec: PodSpec,
    receipt: dict[str, Any],
    observer: ArmClient,
) -> Optional[BackendHandle]:
    """Resolve a crashed update's lease from the observer's reads alone; writes nothing.

    The revision name derives from the attempt id, so the observer reads exactly the
    revision this attempt created. No person token is needed to read, and nothing
    here can start an update, which still needs the person's sign-in.
    """
    expected, attempt = str(spec.expected_service_uid or ""), str(spec.upgrade_attempt_id or "")
    if not expected or not attempt:
        raise RuntimeError("upgrade recovery authority unavailable")
    revision = f"{CONTAINER_APP_NAME}--{revision_suffix(attempt)}"
    image = str(receipt.get("image") or "")
    if (
        receipt.get("version") != 1
        or receipt.get("service") != backend.app_id
        or receipt.get("serviceUid") != expected
        or receipt.get("attemptId") != attempt
        or receipt.get("revision") != revision
        or not is_immutable_image_reference(image)
    ):
        raise RuntimeError("upgrade recovery receipt binding invalid")
    observation = backend.observe_sync()
    if not observation.present:
        raise observation.refusal("observe the update of")
    _fence(observation.app, spec, expected)
    handle = backend.verified_handle(spec.hushh_id, observation)
    verdict = upgrade_verdict(
        observation.app,
        revision=revision,
        image=image,
        read_revision=_revision_reader(observer, backend.app_id, revision, "observe_upgrade"),
    )
    if verdict == "live":
        return _with_metadata(handle, upgraded=True, source_image=receipt.get("targetImage") or "")
    if verdict is None:
        return None
    return BackendHandle(
        external_agent_id=handle.external_agent_id,
        a2a_route=handle.a2a_route,
        status="failed",
        backend=handle.backend,
        backend_metadata={"image": observation.image, "failedRevision": revision},
    )


def _with_metadata(handle: BackendHandle, **extra: Any) -> BackendHandle:
    return BackendHandle(
        external_agent_id=handle.external_agent_id,
        a2a_route=handle.a2a_route,
        status=handle.status,
        backend=handle.backend,
        backend_metadata={**(handle.backend_metadata or {}), **extra},
    )


__all__ = [
    "REVISION_FAILED_MESSAGE",
    "UNCONFIRMED_MESSAGE",
    "UPGRADE_REVISION_FAILED",
    "UPGRADE_UNCONFIRMED",
    "VERDICT_POLL_SECONDS",
    "VERDICT_TIMEOUT_SECONDS",
    "import_source",
    "observe_upgrade",
    "replacement_body",
    "revision_suffix",
    "upgrade_agent",
    "upgrade_verdict",
]
