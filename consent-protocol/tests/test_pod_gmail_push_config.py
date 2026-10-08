"""Direct owner subscription, OAuth-project topic and exact pod OIDC contracts."""

from __future__ import annotations

import inspect
import json
from types import SimpleNamespace

import pytest

from hushh_mcp.services import user_gcp_backend
from hushh_mcp.services.pod_gmail_push_config import (
    arm_gmail_push,
    gmail_notification_resources,
    push_config,
)
from hushh_mcp.services.user_gcp_backend import pod_service_account_id

HUSSH = "ha1_pushowner"
URL = "https://one-pod-ha1-pushowner-42.us-central1.run.app"


class _Client:
    def _headers(self) -> dict:
        return {"Authorization": "Bearer bootstrap-15-minute-token"}


class _Session:
    def __init__(self, status: int = 200) -> None:
        self.status = status
        self.posts: list[tuple[str, dict, dict]] = []

    def post(
        self, url: str, *, headers: dict, data: str, timeout: int, allow_redirects: bool
    ) -> SimpleNamespace:
        assert allow_redirects is False
        self.posts.append((url, headers, json.loads(data)))
        return SimpleNamespace(status_code=self.status)


def test_the_push_target_is_the_agents_own_url_signed_as_the_agent():
    body = push_config(project="owner-project", hushh_id=HUSSH, service_url=URL + "/")
    assert body == {
        "pushConfig": {
            "pushEndpoint": URL + "/api/one/pod/gmail/push",
            "oidcToken": {
                "serviceAccountEmail": (
                    f"{pod_service_account_id(HUSSH)}@owner-project.iam.gserviceaccount.com"
                ),
                "audience": URL,
            },
        }
    }
    with pytest.raises(ValueError):
        push_config(project="owner-project", hushh_id=HUSSH, service_url="http://plain")
    for invalid in (
        URL + "/path",
        URL + "?x=y",
        "https://user:pass@pod.example",
        URL + "#fragment",
    ):
        with pytest.raises(ValueError):
            push_config(project="owner-project", hushh_id=HUSSH, service_url=invalid)


def test_cross_project_topic_inventory_and_azure_direct_target():
    inventory = gmail_notification_resources(
        owner_project="owner-project",
        hushh_id=HUSSH,
        oauth_project="oauth-project",
        service_url="https://owner.azurecontainerapps.io",
        push_service_account="owner-push@owner-project.iam.gserviceaccount.com",
    )
    assert inventory["topic"] == "projects/oauth-project/topics/one-mail-ha1-pushowner"
    assert inventory["subscription"].startswith("projects/owner-project/")
    assert (
        inventory["runtimeEnv"]["POD_GMAIL_PUSH_AUDIENCE"] == "https://owner.azurecontainerapps.io"
    )
    assert inventory["subscriptionConfig"]["deadLetterPolicy"]["maxDeliveryAttempts"] == 10
    assert "dead_letter_retained_subscription" in inventory["prerequisites"]
    with pytest.raises(ValueError, match="subscription project"):
        push_config(
            project="owner-project",
            hushh_id=HUSSH,
            service_url=URL,
            push_service_account="push@different-project.iam.gserviceaccount.com",
        )


async def test_arming_modifies_the_persons_own_subscription_with_the_bootstrap_token():
    session = _Session()
    armed = await arm_gmail_push(
        _Client(), SimpleNamespace(hushh_id=HUSSH), "owner-project", URL, session=session
    )
    assert armed is True
    ((url, headers, body),) = session.posts
    assert url == (
        "https://pubsub.googleapis.com/v1/projects/owner-project/subscriptions/"
        "one-mail-ha1-pushowner-direct-sub:modifyPushConfig"
    )
    assert headers["Authorization"] == "Bearer bootstrap-15-minute-token"
    assert body["pushConfig"]["pushEndpoint"].startswith(URL)


async def test_a_refusal_or_a_missing_url_never_fails_provisioning():
    refused = await arm_gmail_push(
        _Client(), SimpleNamespace(hushh_id=HUSSH), "owner-project", URL, session=_Session(403)
    )
    missing = await arm_gmail_push(
        _Client(), SimpleNamespace(hushh_id=HUSSH), "owner-project", None, session=_Session()
    )
    assert (refused, missing) == (False, False)


def test_provision_and_upgrade_arm_the_doorbell_once_the_url_is_known():
    for method in (
        user_gcp_backend.UserGcpBackend._execute_live,
        user_gcp_backend.UserGcpBackend.upgrade,
    ):
        source = inspect.getsource(method)
        url_at = source.index("url = client.service_url(svc)")
        arm_at = source.index("await self._configure_gmail_delivery")
        assert arm_at > url_at, f"{method.__name__} arms before the URL exists"
