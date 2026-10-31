"""Direct Gmail delivery resource inventory and authenticated push configuration.

Gmail's owner-specific topic belongs to the OAuth developer project. The owner
notification project's subscription, retry/DLQ policy and exact pod OIDC target
are explicit. Azure uses a Google notification adapter and its own pod HTTPS
origin. No credential or notification passes through a hub callback.

Resource inventory describes prerequisites; provisioning must establish the
cross-project topic attachment, publisher, token minting, invoker and DLQ IAM.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from typing import Any
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

PUSH_PATH = "/api/one/pod/gmail/push"
GMAIL_PUBLISHER = "serviceAccount:gmail-api-push@system.gserviceaccount.com"
_PUBSUB = "https://pubsub.googleapis.com/v1"


def notification_config_generation(config: dict[str, str]) -> str:
    """Revision of the four explicit, non-secret delivery authority terms."""
    terms = {
        key: config.get(key, "")
        for key in (
            "POD_GMAIL_TOPIC",
            "POD_GMAIL_PUSH_SUBSCRIPTION",
            "POD_GMAIL_PUSH_SERVICE_ACCOUNT",
            "POD_GMAIL_PUSH_AUDIENCE",
        )
    }
    return hashlib.sha256(
        json.dumps(terms, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def canonical_pod_origin(service_url: str) -> str:
    """Validate the provisioned HTTPS origin; never infer authority from Host."""
    base = str(service_url or "").rstrip("/")
    parsed = urlsplit(base)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.path
        or parsed.query
        or parsed.fragment
        or parsed.netloc != parsed.hostname
        or any(c.isspace() for c in base)
    ):
        raise ValueError("a push target needs the pod's exact HTTPS origin")
    return base


def subscription_path(project: str, hushh_id: str) -> str:
    from hushh_mcp.services.user_gcp_backend import _slug  # noqa: PLC0415

    return f"projects/{project}/subscriptions/one-mail-{_slug(hushh_id)}-direct-sub"


def push_config(
    *, project: str, hushh_id: str, service_url: str, push_service_account: str | None = None
) -> dict[str, Any]:
    """The ``modifyPushConfig`` body: push to the agent's own URL, as the agent itself."""
    from hushh_mcp.services.user_gcp_backend import pod_service_account_id  # noqa: PLC0415

    base = canonical_pod_origin(service_url)
    if not project or not hushh_id:
        raise ValueError("a push target needs the agent's https URL, project and HusshID")
    identity = (
        push_service_account
        or f"{pod_service_account_id(hushh_id)}@{project}.iam.gserviceaccount.com"
    )
    if not re.fullmatch(r"[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com", identity):
        raise ValueError("a direct Gmail push needs an exact Google service account")
    if not identity.endswith(f"@{project}.iam.gserviceaccount.com"):
        raise ValueError("the push service account must belong to the subscription project")
    return {
        "pushConfig": {
            "pushEndpoint": base + PUSH_PATH,
            "oidcToken": {
                "serviceAccountEmail": identity,
                "audience": base,
            },
        }
    }


def gmail_notification_resources(
    *,
    owner_project: str,
    hushh_id: str,
    oauth_project: str,
    service_url: str,
    push_service_account: str | None = None,
) -> dict[str, Any]:
    """Inventory for GCP or Azure's explicit Google notification adapter.

    The owner subscription attaches to an owner-specific topic in the OAuth
    developer project. Azure callers supply a Google notification project and SA;
    Azure credentials alone cannot provision Google's Gmail delivery resources.
    Provisioners must configure the DLQ and retention before declaring readiness.
    """
    from hushh_mcp.services.user_gcp_backend import _slug  # noqa: PLC0415

    if not re.fullmatch(r"[a-z][a-z0-9-]{4,61}[a-z0-9]", oauth_project) or not re.fullmatch(
        r"[a-z][a-z0-9-]{4,61}[a-z0-9]", owner_project
    ):
        raise ValueError("explicit OAuth and owner notification projects are required")
    config = push_config(
        project=owner_project,
        hushh_id=hushh_id,
        service_url=service_url,
        push_service_account=push_service_account,
    )
    topic = f"projects/{oauth_project}/topics/one-mail-{_slug(hushh_id)}"
    subscription = subscription_path(owner_project, hushh_id)
    dead_letter = f"projects/{owner_project}/topics/one-mail-{_slug(hushh_id)}-dead-letter"
    identity = config["pushConfig"]["oidcToken"]["serviceAccountEmail"]
    runtime_env = {
        "POD_GMAIL_TOPIC": topic,
        "POD_GMAIL_PUSH_SUBSCRIPTION": subscription,
        "POD_GMAIL_PUSH_SERVICE_ACCOUNT": identity,
        "POD_GMAIL_PUSH_AUDIENCE": canonical_pod_origin(service_url),
    }
    runtime_env["POD_GMAIL_CONFIG_GENERATION"] = notification_config_generation(runtime_env)
    return {
        "topic": topic,
        "subscription": subscription,
        "deadLetterTopic": dead_letter,
        "subscriptionConfig": {
            "topic": topic,
            **config,
            "ackDeadlineSeconds": 60,
            "retryPolicy": {"minimumBackoff": "10s", "maximumBackoff": "600s"},
            "messageRetentionDuration": "604800s",
            "expirationPolicy": {},
            "deadLetterPolicy": {"deadLetterTopic": dead_letter, "maxDeliveryAttempts": 10},
        },
        "runtimeEnv": runtime_env,
        "prerequisites": [
            "oauth_topic_gmail_publisher",
            "oauth_topic_attach_subscription",
            "push_service_account_act_as",
            "pubsub_oidc_token_creator",
            "direct_endpoint_invoker",
            "dead_letter_publisher_and_source_subscriber",
            "dead_letter_retained_subscription",
        ],
    }


def gmail_doorbell_calls(
    plan: dict[str, Any], *, project: str, oauth_project: str | None = None
) -> list[dict[str, Any]]:
    """The bootstrap's merged binding letting Gmail publish into the person's own topic."""
    topic = next(
        (r.get("id") for r in plan.get("resources", []) if r.get("type") == "pubsub_topic"), ""
    )
    if not topic or not oauth_project:
        return []
    topic_path = f"{_PUBSUB}/projects/{oauth_project}/topics/{topic}"
    return [
        {
            "step": "iam_gmail_publisher_on_topic",
            "kind": "merge_binding",
            "depends_on": "oauth_mail_topic",
            "read_url": f"{topic_path}:getIamPolicy",
            "read_method": "GET",
            "write_url": f"{topic_path}:setIamPolicy",
            "policy_envelope": "policy",
            "bindings": [{"role": "roles/pubsub.publisher", "members": [GMAIL_PUBLISHER]}],
            "tolerate": [],
        }
    ]


def _arm(
    client: Any,
    project: str,
    hushh_id: str,
    url: str,
    session: Any,
    push_service_account: str | None = None,
) -> bool:
    body = push_config(
        project=project,
        hushh_id=hushh_id,
        service_url=url,
        push_service_account=push_service_account,
    )
    if session is None:
        import requests  # type: ignore[import-untyped]  # noqa: PLC0415

        session = requests
    response = session.post(
        f"{_PUBSUB}/{subscription_path(project, hushh_id)}:modifyPushConfig",
        headers={**client._headers(), "Content-Type": "application/json"},
        data=json.dumps(body),
        timeout=30,
        allow_redirects=False,
    )
    return getattr(response, "status_code", 0) == 200


async def arm_gmail_push(
    client: Any,
    spec: Any,
    project: str | None,
    url: str | None,
    *,
    session: Any = None,
    push_service_account: str | None = None,
) -> bool:
    """Point the person's mail subscription at their agent. Never raises."""
    try:
        armed = await asyncio.to_thread(
            _arm,
            client,
            str(project or ""),
            str(spec.hushh_id or ""),
            str(url or ""),
            session,
            push_service_account,
        )
    except Exception as exc:  # noqa: BLE001 - provisioning must not fail on the doorbell
        logger.warning("pod_gmail_push_config.arm_failed reason=%s", type(exc).__name__)
        return False
    if not armed:
        logger.warning("pod_gmail_push_config.arm_refused")
    return armed


__all__ = [
    "GMAIL_PUBLISHER",
    "PUSH_PATH",
    "arm_gmail_push",
    "gmail_doorbell_calls",
    "push_config",
    "canonical_pod_origin",
    "gmail_notification_resources",
    "notification_config_generation",
    "subscription_path",
]
