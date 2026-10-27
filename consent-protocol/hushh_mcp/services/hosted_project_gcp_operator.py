"""Operator-owned preparation using the common GCP primitives, never pod credentials.

The caller verifies its ADC principal and supplies a fresh mutation guard for the
retained preparation step. This is not a hub provisioning or model identity.
"""

from __future__ import annotations

import time
from typing import Any, Callable

from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired


class GuardedOperatorSession:
    def __init__(self, session: Any, guard: Callable[[], None]) -> None:
        self._session, self._guard = session, guard

    def request(self, method: str, url: str, **kwargs: Any) -> Any:
        if method.upper() not in {"GET", "HEAD"} and not url.endswith(":getIamPolicy"):
            self._guard()
        kwargs.setdefault("allow_redirects", False)
        return self._session.request(method, url, **kwargs)

    def get(self, url: str, **kwargs: Any) -> Any:
        return self.request("GET", url, **kwargs)

    def post(self, url: str, **kwargs: Any) -> Any:
        return self.request("POST", url, **kwargs)

    def put(self, url: str, **kwargs: Any) -> Any:
        return self.request("PUT", url, **kwargs)


class GcpPreparationOperator:
    def __init__(
        self,
        reservation: dict,
        *,
        actor: str,
        step: str,
        token: str,
        session: Any,
        guard: Callable[[], None],
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        from hushh_mcp.services.hosted_project_preparation import _require_preparation_contract

        _require_preparation_contract(reservation)
        assignment = reservation["hostedAdmission"]["assignment"]
        self._contract = assignment["preparationContract"]
        if step not in self._contract["steps"]:
            raise ValueError("Unknown preparation operation")
        self._step = step
        if actor != self._contract["operatorPrincipal"] or not token:
            raise ValueError("Preparation operator differs from its retained authority")
        self._reservation, self._assignment = reservation, assignment
        self._project, self._token = assignment["project"], token
        self._session, self._sleep = GuardedOperatorSession(session, guard), sleep
        self._headers = {"Authorization": f"Bearer {token}"}

    def create(self) -> dict:
        self._require_step("create_project")
        from hushh_mcp.services.user_gcp_project import create_project

        result = create_project(
            project_id=self._project,
            display_name="Hussh hosted dev pilot",
            parent_type=self._contract["parentType"],
            parent_id=self._contract["parentId"],
            token=self._token,
            session=self._session,
            tenancy="hussh-hosted",
            provision_attempt_id=self._reservation["attemptId"],
            environment="dev",
        )
        if result.get("ok") is not True:
            raise ProvisionReconciliationRequired("Project creation requires provider observation")
        return self.observe_project()

    def observe_project(self) -> dict:
        self._require_step("create_project")
        from hushh_mcp.services.byoc_oauth_authorizer import _check

        url = f"https://cloudresourcemanager.googleapis.com/v1/projects/{self._project}"
        for _ in range(30):
            response = self._session.get(url, headers=self._headers, timeout=20)
            if response.status_code == 404:
                self._sleep(2)
                continue
            value = _check(response, "observe the assigned pilot project")
            identity = {
                key: value.get(key)
                for key in ("projectId", "projectNumber", "lifecycleState", "parent", "labels")
            }
            if identity["lifecycleState"] != "ACTIVE":
                raise ProvisionReconciliationRequired("Assigned project is not active")
            from hushh_mcp.services.user_gcp_project import _project_labels

            if (
                identity["projectId"] != self._project
                or identity["parent"]
                != {"type": self._contract["parentType"], "id": self._contract["parentId"]}
                or identity["labels"]
                != _project_labels("hussh-hosted", self._reservation["attemptId"], "dev")
                or not isinstance(identity["projectNumber"], str)
                or (
                    self._assignment["projectNumber"] is not None
                    and self._assignment["projectNumber"] != identity["projectNumber"]
                )
            ):
                raise ProvisionReconciliationRequired(
                    "Assigned project identity differs from creation authority"
                )
            return {
                "step": "create_project",
                "status": 200,
                "ok": True,
                "resourceObservation": {
                    "type": "gcp_project",
                    "id": self._project,
                    "disposition": "created",
                    "identity": identity,
                },
            }
        raise ProvisionReconciliationRequired("Assigned project creation observation is pending")

    def link_billing(self) -> dict:
        self._require_step("link_billing")
        from hushh_mcp.services.gcp_project_billing import ensure_explicit_billing

        result = ensure_explicit_billing(
            project_id=self._project,
            expected_account=self._contract["billingAccount"],
            token=self._token,
            session=self._session,
        )
        return {
            "step": "link_billing",
            "status": 200,
            "ok": True,
            "billingObservation": result["observation"],
        }

    def observe_billing(self) -> dict:
        self._require_step("link_billing")
        from hushh_mcp.services.byoc_oauth_authorizer import _check

        value = _check(
            self._session.get(
                f"https://cloudbilling.googleapis.com/v1/projects/{self._project}/billingInfo",
                headers=self._headers,
                timeout=20,
            ),
            "observe assigned project funding",
        )
        if (
            value.get("billingAccountName") != self._contract["billingAccount"]
            or value.get("billingEnabled") is not True
        ):
            raise ProvisionReconciliationRequired("Assigned project funding is not confirmed")
        return {
            "step": "link_billing",
            "status": 200,
            "ok": True,
            "billingObservation": {
                "projectId": self._project,
                "billingAccountName": value["billingAccountName"],
                "billingEnabled": True,
            },
        }

    def authorize(self) -> dict:
        self._require_step("authorize_project")
        from hushh_mcp.services.byoc_oauth_authorizer import apply_authorization

        identity = self._assignment["bootstrapContract"]["plan"]["federation"]["impersonation"]
        bootstrap_id = identity["bootstrap_service_account"].split("@", 1)[0]
        result = apply_authorization(
            project=self._project,
            token=self._token,
            caller_sa=identity["granted_to"],
            bootstrap_account_id=bootstrap_id,
            session=self._session,
        )
        # The full primitive includes its final no-exportable-keys assertion.
        return {
            "step": "authorize_project",
            "status": 200,
            "ok": True,
            "authorizationReceipt": result["authorizationReceipt"],
        }

    def grant_model(self, step: str) -> dict:
        self._require_step(step)
        from hushh_mcp.services.user_gcp_bootstrap import UserGcpBootstrap

        if step not in {"inference_vertex", "inference_quota"}:
            raise ValueError("Unsupported pilot inference grant")
        checkpoint = self._reservation["evidence"]["reserved"]["hostedCheckpoint"]
        observations = [
            result["resourceObservation"]
            for result in checkpoint["completed"]
            if result.get("step") == "pod_service_account" and result.get("ok") is True
        ]
        if checkpoint.get("phase") != "observed" or len(observations) != 1:
            raise ProvisionReconciliationRequired("Pod workload identity is not retained")
        observation = observations[0]
        self._require_runtime_identity(observation)
        project = self._reservation["hostedAdmission"]["modelBinding"]["project"]
        role = (
            "roles/aiplatform.user"
            if step == "inference_vertex"
            else "roles/serviceusage.serviceUsageConsumer"
        )
        url = f"https://cloudresourcemanager.googleapis.com/v1/projects/{project}"
        bootstrap = UserGcpBootstrap(
            project=self._project, region=self._assignment["region"], session=self._session
        )
        result = bootstrap._merge_binding(
            {
                "step": step,
                "read_url": url + ":getIamPolicy",
                "read_method": "POST",
                "read_body": {"options": {"requestedPolicyVersion": 3}},
                "write_url": url + ":setIamPolicy",
                "policy_envelope": "policy",
                "bindings": [{"role": role, "members": ["serviceAccount:" + observation["id"]]}],
            },
            self._headers,
        )
        if result.get("ok") is not True or len(result.get("bindingObservations", [])) != 1:
            raise ProvisionReconciliationRequired("Pilot inference permission is not verified")
        return {key: result[key] for key in ("step", "status", "ok", "bindingObservations")} | {
            "resourceObservation": observation
        }

    def _require_runtime_identity(self, observation: dict) -> None:
        from hushh_mcp.services.byoc_oauth_authorizer import _check
        from hushh_mcp.services.byoc_substrate import _service_account_creation_identity

        email, retained = observation["id"], observation["identity"]
        response = _check(
            self._session.get(
                f"https://iam.googleapis.com/v1/projects/{self._project}/serviceAccounts/{email}",
                headers=self._headers,
                timeout=20,
            ),
            "verify the retained pod workload identity",
        )
        if (
            response.get("disabled") is True
            or _service_account_creation_identity(response, email) != retained
            or retained.get("projectId") != self._project
        ):
            raise ProvisionReconciliationRequired(
                "Pod workload identity changed before model authorization"
            )

    def _require_step(self, step: str) -> None:
        if step != self._step:
            raise ProvisionReconciliationRequired(
                "Provider operation differs from its retained preparation step"
            )
