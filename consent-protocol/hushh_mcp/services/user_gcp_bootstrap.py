"""Apply ``UserGcpBackend.render_bootstrap_plan`` into the USER'S own GCP project.

The plan has existed as a declarative artifact for a while and nothing consumed it.
This is the consumer: it turns those seven resources and their IAM into real API calls
against a project hushh does not own.

THE CREDENTIAL MODEL, AND A CORRECTION TO THE PLAN'S OWN LANGUAGE
-----------------------------------------------------------------
``render_bootstrap_plan`` describes federation as a **Workload Identity Federation**
pool and provider. For a hushh control plane that runs *outside* Google -- the Anypoint
/ CloudHub deployment is a real part of this architecture -- that is exactly right: WIF
is how a non-Google workload obtains Google credentials without an exported key.

For the GCP-hosted hub it is the wrong primitive, and using it would add a pool and a
provider that buy nothing. Hushh's consent plane is *already* a Google identity
(``consent-protocol-runtime@…``, via the metadata server). A Google identity reaching
another project does not federate; it is granted. So the keyless mechanism here is
**short-lived service-account impersonation**:

* The user creates one least-privilege bootstrap service account in their project and
  grants hushh's consent-plane identity ``roles/iam.serviceAccountTokenCreator`` **on
  that one account** -- not on the project.
* Hushh calls ``iamcredentials.generateAccessToken`` per session, receives a token that
  expires in minutes, applies the plan, and holds nothing afterwards.

Both models are keyless in the sense that matters: no service-account key is ever
created or exported. What neither model removes is *standing authorization* -- the
binding persists until revoked, under WIF exactly as much as under impersonation. The
plan's phrase "no standing credential" is true and worth keeping; "no standing
authority" would not be, and is not claimed. Revocation is one binding removal, which
is the property to hold on to.

INERT BY DEFAULT
----------------
``plan_calls()`` renders the exact requests this would issue and touches nothing, so the
whole applier is reviewable -- and testable -- without a user project in existence.
``apply()`` is the only method that writes, and it needs a token it cannot mint itself.
"""

from __future__ import annotations

import base64
import json
import logging
import time
from typing import Any, Optional

logger = logging.getLogger(__name__)

_BOOTSTRAP_LIFETIME = "900s"  # 15 minutes: long enough to build, short enough to not matter.

#: How long to wait for a long-running operation before giving up on it. Enabling eight
#: APIs in a fresh project took well under a minute in the observed run; five minutes is
#: slack, not an expectation. The deadline exists so a stuck operation surfaces as a
#: failed step rather than a hung bootstrap.
_OPERATION_DEADLINE_SECONDS = 300.0
_OPERATION_POLL_SECONDS = 2.0

#: Roles the user's one-time authorization grants the bootstrap SA, and why each is
#: needed. Listed here so the ask made of a user is legible in one place rather than
#: inferred from the calls below.
BOOTSTRAP_ROLES: tuple[tuple[str, str], ...] = (
    (
        "roles/serviceusage.serviceUsageAdmin",
        "turn on the Google APIs the pod needs, so nobody has to do it by hand",
    ),
    ("roles/cloudkms.admin", "create the per-user CMEK key that seals their history"),
    ("roles/storage.admin", "create the CMEK-encrypted bucket the pod writes to"),
    ("roles/iam.serviceAccountAdmin", "create the pod's own least-privilege identity"),
    ("roles/run.admin", "create the pod service"),
    ("roles/pubsub.admin", "create the mail doorbell topic and subscription"),
    ("roles/cloudscheduler.admin", "re-arm the Gmail watch before its 7-day expiry"),
    ("roles/resourcemanager.projectIamAdmin", "bind the pod SA to exactly those resources"),
    (
        "roles/secretmanager.admin",
        "create the pod's own signing key INSIDE your project, so it is yours and not hushh's",
    ),
)

#: The APIs a pod's resources need. Enabled BY the bootstrap rather than asked of the
#: person: enabling an API is idempotent and happens inside the project they already
#: authorized, so it belongs here by the same logic as everything else this creates.
#: Measured against a real empty project (hushh-byoc-test, 2026-08-08), seven of these
#: eight were off -- which made API enablement the actual blocker, not project creation.
REQUIRED_SERVICES: tuple[str, ...] = (
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "run.googleapis.com",
    "cloudkms.googleapis.com",
    "storage.googleapis.com",
    "pubsub.googleapis.com",
    "cloudscheduler.googleapis.com",
    "aiplatform.googleapis.com",
    # The bootstrap's OWN last step needs this one, and it was missing: the project-level
    # Vertex binding goes through cloudresourcemanager, which failed with "API has not
    # been used in project 642919918840" on the first run that got that far. An applier
    # that enables every API except the one it itself depends on is a subtle kind of
    # incomplete, and only a live run finds it.
    "cloudresourcemanager.googleapis.com",
    # The pod refuses to import without APP_SIGNING_KEY, and Cloud Run resolves a
    # secretKeyRef against the project the service runs in -- so a BYOC pod's key must
    # live in the USER's Secret Manager. Found the only way it could be: the pod booted,
    # crash-looped on "APP_SIGNING_KEY must be set", and said so in its own logs.
    "secretmanager.googleapis.com",
)


class BootstrapError(RuntimeError):
    """A bootstrap step failed. Never partially reported as success."""


def mint_bootstrap_token(
    *,
    bootstrap_sa: str,
    session: Any = None,
    source_token: Optional[str] = None,
    lifetime: str = _BOOTSTRAP_LIFETIME,
) -> str:
    """Impersonate the user's bootstrap SA and return a short-lived access token.

    This is the whole keyless story in one call. It fails loudly rather than falling
    back to hushh's own identity: a silent fallback would let the applier keep working
    after the user revoked their grant, which is precisely the control being tested.
    """
    if session is None:
        import requests as session  # noqa: PLC0415

    if source_token is None:
        from google.auth.transport.requests import Request  # noqa: PLC0415

        from hushh_mcp.services.gcp_run_client import load_operator_credentials  # noqa: PLC0415

        creds = load_operator_credentials()
        creds.refresh(Request())
        source_token = creds.token

    # A caller with no token of its own is a HUSHH-side fault, and it must not be
    # reported as the customer's. Without this check the request goes out with an empty
    # bearer, IAM answers 401, and the handler below blames "the user's grant" -- which
    # sends an operator into someone else's project looking for a binding that is
    # present and fine. Observed live on 2026-08-16: an impersonation that failed on
    # hushh's side produced a message naming the customer.
    if not str(source_token or "").strip():
        raise BootstrapError(
            "cannot impersonate: hushh has no caller credential to present. This is a "
            "hushh-side failure, NOT a missing grant in the user's project -- check the "
            "consent plane's own identity before touching anything in their cloud."
        )

    response = session.post(
        f"https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/{bootstrap_sa}"
        ":generateAccessToken",
        headers={"Authorization": f"Bearer {source_token}", "Content-Type": "application/json"},
        json={
            "scope": ["https://www.googleapis.com/auth/cloud-platform"],
            "lifetime": lifetime,
        },
        timeout=60,
    )
    status = getattr(response, "status_code", 0)
    if status != 200:
        # 403 is the customer's binding; 401 is ours. Naming the wrong one costs an
        # operator a trip into a project they cannot see, looking for a grant that is
        # already there.
        blame = (
            "The user's grant of roles/iam.serviceAccountTokenCreator is missing or revoked"
            if status == 403
            else "hushh's own caller credential was rejected, so this is a hushh-side "
            "failure rather than a missing grant in the user's project"
            if status == 401
            else "IAM refused the impersonation"
        )
        raise BootstrapError(
            f"could not impersonate {bootstrap_sa} ({status or '?'}). "
            f"{blame}: {getattr(response, 'text', '')[:200]}"
        )
    return str(response.json()["accessToken"])


class UserGcpBootstrap:
    """Turns a rendered bootstrap plan into resources in the user's project."""

    def __init__(
        self,
        *,
        project: str,
        region: str = "us-central1",
        token: Optional[str] = None,
        session: Any = None,
        sleep: Any = None,
        clock: Any = None,
        bootstrap_sa: str = "",
    ) -> None:
        if not project:
            raise BootstrapError("a target project is required; BYOC never guesses one")
        self._project = project
        self._region = region
        self._token = token
        # Which account this applier is borrowing. Only used to grant that one account
        # `actAs` on the pod identity it creates, and never inferred: an applier that
        # guessed its own identity could bind a grant to the wrong principal, so an
        # unknown bootstrap SA simply omits the step and lets Cloud Run refuse loudly.
        self._bootstrap_sa = bootstrap_sa
        if session is None:
            import requests as session  # noqa: PLC0415
        self._session = session
        # Injected so a test can prove the wait happens without spending the wait.
        self._sleep = sleep or time.sleep
        self._clock = clock or time.monotonic

    # -- rendering (writes nothing) ------------------------------------------------

    def plan_calls(self, plan: dict[str, Any]) -> list[dict[str, Any]]:
        """Every request ``apply`` would make, in order, as inspectable data.

        Kept separate from execution so the blast radius of a bootstrap can be read
        and diffed before anyone points it at a real person's cloud.
        """
        project, region = self._project, self._region
        by_type = {r["type"]: r for r in plan.get("resources", [])}
        keyring = "hushh-one"
        kms_key = by_type.get("kms_key", {}).get("id", "")
        bucket = by_type.get("gcs_bucket", {}).get("id", "")
        pod_sa = by_type.get("service_account", {}).get("id", "")
        pod_sa_id = pod_sa.split("@")[0] if pod_sa else ""
        topic = by_type.get("pubsub_topic", {}).get("id", "")
        sub = by_type.get("pubsub_subscription", {}).get("id", "")
        job = by_type.get("cloud_scheduler_job", {}).get("id", "")
        key_path = f"projects/{project}/locations/{region}/keyRings/{keyring}/cryptoKeys/{kms_key}"

        calls: list[dict[str, Any]] = [
            {
                # First, because every step below fails without it. Seven of the eight
                # were off in a real empty project, which made THIS the blocker people
                # kept mistaking for "you need to create a project".
                "step": "enable_services",
                "method": "POST",
                "url": (
                    f"https://serviceusage.googleapis.com/v1/projects/{project}"
                    "/services:batchEnable"
                ),
                "body": {"serviceIds": list(REQUIRED_SERVICES)},
                "tolerate": [],
                # batchEnable returns a LONG-RUNNING OPERATION, and every step below
                # fails with "API has not been used in this project" until it finishes.
                # The first live run against a real project did exactly that: the enable
                # succeeded, the bootstrap raced past it, and six steps failed on APIs
                # that were on less than a minute later. Waiting is not politeness here,
                # it is the difference between a bootstrap that works and one that
                # reports six spurious failures.
                "await_operation": True,
                "operation_url": "https://serviceusage.googleapis.com/v1/",
                # And if the wait does not end well, stop. Running the rest against APIs
                # that are demonstrably off produces seven failures that all describe the
                # same one cause, which is how the real defect stayed hidden for a minute
                # longer than it needed to.
                "gates_rest": True,
            },
            {
                "step": "kms_keyring",
                "method": "POST",
                "url": f"https://cloudkms.googleapis.com/v1/projects/{project}/locations/{region}/keyRings",
                "params": {"keyRingId": keyring},
                "body": {},
                "tolerate": [409],
            },
            {
                "step": "kms_key",
                "method": "POST",
                "url": (
                    f"https://cloudkms.googleapis.com/v1/projects/{project}/locations/"
                    f"{region}/keyRings/{keyring}/cryptoKeys"
                ),
                "params": {"cryptoKeyId": kms_key},
                "body": {"purpose": "ENCRYPT_DECRYPT"},
                "tolerate": [409],
            },
            {
                "step": "pod_service_account",
                "method": "POST",
                "url": f"https://iam.googleapis.com/v1/projects/{project}/serviceAccounts",
                "body": {
                    "accountId": pod_sa_id,
                    "serviceAccount": {
                        "displayName": "hussh Agent One pod",
                        "description": "Least-privilege runtime identity for this person's pod.",
                    },
                },
                "tolerate": [409],
            },
            *(
                [
                    {
                        # Creating a Cloud Run service that RUNS AS the pod account needs
                        # `iam.serviceAccounts.actAs` on that account, which
                        # `roles/iam.serviceAccountAdmin` does not carry. The first live
                        # run reached Cloud Run and was refused in exactly those words:
                        # "Permission 'iam.serviceaccounts.actAs' denied on service
                        # account one-pod-...". A control create without a runAs identity
                        # was refused too, naming the default compute account -- so this
                        # is about acting as anything, not about this one account.
                        #
                        # The fix deliberately does NOT add roles/iam.serviceAccountUser
                        # to the project ask. At project level that would let the
                        # bootstrap act as EVERY service account the person owns. Bound to
                        # the single account this bootstrap just created, it grants
                        # precisely the ability being used, and the user's one-time
                        # authorization is unchanged.
                        "step": "iam_bootstrap_can_run_as_pod",
                        "kind": "merge_binding",
                        "read_method": "POST",
                        "read_url": (
                            f"https://iam.googleapis.com/v1/projects/{project}"
                            f"/serviceAccounts/{pod_sa}:getIamPolicy"
                        ),
                        "write_url": (
                            f"https://iam.googleapis.com/v1/projects/{project}"
                            f"/serviceAccounts/{pod_sa}:setIamPolicy"
                        ),
                        "policy_envelope": "policy",
                        "read_body": {},
                        "bindings": [
                            {
                                "role": "roles/iam.serviceAccountUser",
                                "members": [f"serviceAccount:{self._bootstrap_sa}"],
                            }
                        ],
                        "tolerate": [],
                    }
                ]
                if self._bootstrap_sa
                else []
            ),
            {
                # Cloud Storage does not encrypt with the user's key as itself -- it uses
                # a per-project SERVICE AGENT, and that agent must hold
                # cryptoKeyEncrypterDecrypter on the key before a CMEK bucket can be
                # created. Granting the pod encrypt/decrypt is not a substitute, and the
                # first live run said so in as many words: "Permission denied on Cloud KMS
                # key. Please ensure that your Cloud Storage service account has been
                # authorized to use this key."
                #
                # The agent's address is not knowable when the plan is rendered -- it
                # embeds the project NUMBER -- so it is looked up at apply time. The GET
                # that reads it also creates the agent if the project has never had one,
                # which is why it is a lookup rather than a computed string.
                "step": "iam_gcs_agent_on_key",
                "kind": "merge_binding",
                "read_url": f"https://cloudkms.googleapis.com/v1/{key_path}:getIamPolicy",
                "read_method": "GET",
                "write_url": f"https://cloudkms.googleapis.com/v1/{key_path}:setIamPolicy",
                "policy_envelope": "policy",
                "member_lookup": {
                    "url": (
                        "https://storage.googleapis.com/storage/v1/projects/"
                        f"{project}/serviceAccount"
                    ),
                    "field": "email_address",
                    "prefix": "serviceAccount:",
                },
                "bindings": [{"role": "roles/cloudkms.cryptoKeyEncrypterDecrypter", "members": []}],
                "tolerate": [],
            },
            {
                # The bucket is created AFTER the key, and names it: a bucket made first
                # would be unencrypted at rest under the user's own key, and switching
                # default encryption later does not re-encrypt what is already written.
                "step": "cmek_bucket",
                # Narrower than gating the whole run: mail and scheduling do not care
                # about the bucket, so they still get their turn.
                "depends_on": "iam_gcs_agent_on_key",
                "method": "POST",
                "url": "https://storage.googleapis.com/storage/v1/b",
                "params": {"project": project},
                "body": {
                    "name": bucket,
                    "location": region.upper(),
                    "encryption": {"defaultKmsKeyName": key_path},
                    "iamConfiguration": {"uniformBucketLevelAccess": {"enabled": True}},
                },
                "tolerate": [409],
            },
            {
                "step": "pod_signing_secret",
                "method": "POST",
                "url": f"https://secretmanager.googleapis.com/v1/projects/{project}/secrets",
                "params": {"secretId": f"{pod_sa_id}-signing-key"},
                "body": {"replication": {"automatic": {}}},
                "tolerate": [409],
            },
            {
                # The material is generated HERE, at apply time, and deliberately never
                # appears in the rendered plan: `apply(dry_run=True)` returns every step
                # verbatim for review, so a key in the plan would be a key in whatever
                # printed it.
                #
                # Idempotent by inspection, not by tolerating an error: a re-run must not
                # rotate this key. APP_SIGNING_KEY is the HMAC key behind consent tokens,
                # grants, receipts and the audit chain, so rotating it silently would
                # invalidate every receipt the pod had already written.
                "step": "pod_signing_secret_version",
                "kind": "generate_secret_version",
                "secret": f"projects/{project}/secrets/{pod_sa_id}-signing-key",
                "depends_on": "pod_signing_secret",
                "tolerate": [],
            },
            {
                "step": "mail_topic",
                "method": "PUT",
                "url": f"https://pubsub.googleapis.com/v1/projects/{project}/topics/{topic}",
                "body": {},
                "tolerate": [409],
            },
            {
                "step": "mail_subscription",
                "method": "PUT",
                "url": f"https://pubsub.googleapis.com/v1/projects/{project}/subscriptions/{sub}",
                "body": {"topic": f"projects/{project}/topics/{topic}"},
                "tolerate": [409],
            },
            {
                "step": "watch_renew_job",
                "method": "POST",
                "url": (
                    f"https://cloudscheduler.googleapis.com/v1/projects/{project}/locations/"
                    f"{region}/jobs"
                ),
                "body": {
                    "name": f"projects/{project}/locations/{region}/jobs/{job}",
                    "schedule": "0 4 * * *",
                    "timeZone": "Etc/UTC",
                    "pubsubTarget": {
                        "topicName": f"projects/{project}/topics/{topic}",
                        "data": "cmVuZXctd2F0Y2g=",  # "renew-watch"
                    },
                },
                "tolerate": [409],
            },
        ]

        # IAM last, and per-resource rather than project-wide. Each binding names one
        # role on one resource; none of them is a project-level grant, which is the
        # difference between "the pod may read its own bucket" and "the pod may read
        # the user's cloud".
        #
        # MERGE, never overwrite. An earlier version wrote these policies whole, on the
        # reasoning that a freshly created key has no bindings to lose. That holds
        # exactly once: this bootstrap is deliberately re-runnable (every resource step
        # tolerates 409), and it is meant to run against a project the person already
        # owns. On a second apply, or against a pre-existing bucket, a whole-policy
        # write drops whatever was there. `safe-changes` R3 says the same thing in one
        # line: add a binding, never set a policy.
        calls.append(
            {
                "step": "iam_pod_sa_on_key",
                "kind": "merge_binding",
                "read_url": f"https://cloudkms.googleapis.com/v1/{key_path}:getIamPolicy",
                "read_method": "GET",
                "write_url": f"https://cloudkms.googleapis.com/v1/{key_path}:setIamPolicy",
                "policy_envelope": "policy",
                "bindings": [
                    {
                        "role": "roles/cloudkms.cryptoKeyDecrypter",
                        "members": [f"serviceAccount:{pod_sa}"],
                    },
                    {
                        "role": "roles/cloudkms.cryptoKeyEncrypter",
                        "members": [f"serviceAccount:{pod_sa}"],
                    },
                ],
                "tolerate": [],
            }
        )
        calls.append(
            {
                "step": "iam_pod_sa_on_signing_secret",
                "kind": "merge_binding",
                "depends_on": "pod_signing_secret",
                "read_method": "GET",
                "read_url": (
                    f"https://secretmanager.googleapis.com/v1/projects/{project}"
                    f"/secrets/{pod_sa_id}-signing-key:getIamPolicy"
                ),
                "write_url": (
                    f"https://secretmanager.googleapis.com/v1/projects/{project}"
                    f"/secrets/{pod_sa_id}-signing-key:setIamPolicy"
                ),
                "policy_envelope": "policy",
                "bindings": [
                    {
                        "role": "roles/secretmanager.secretAccessor",
                        "members": [f"serviceAccount:{pod_sa}"],
                    }
                ],
                "tolerate": [],
            }
        )
        calls.append(
            {
                "step": "iam_pod_sa_on_bucket",
                "kind": "merge_binding",
                "depends_on": "cmek_bucket",
                "read_url": f"https://storage.googleapis.com/storage/v1/b/{bucket}/iam",
                "read_method": "GET",
                "write_url": f"https://storage.googleapis.com/storage/v1/b/{bucket}/iam",
                "write_method": "PUT",
                "policy_envelope": "",
                "bindings": [
                    {
                        "role": "roles/storage.objectAdmin",
                        "members": [f"serviceAccount:{pod_sa}"],
                    }
                ],
                "tolerate": [],
            }
        )
        # Vertex has no per-resource binding, so model access for the pod is granted at
        # PROJECT level. This is the one place BYOC grants project-wide, and it is
        # called out rather than buried: `roles/aiplatform.user` lets the pod call
        # Vertex as itself, on the person's own quota and bill, and nothing else.
        calls.append(
            {
                "step": "iam_pod_sa_vertex",
                "kind": "merge_binding",
                "read_url": (
                    "https://cloudresourcemanager.googleapis.com/v1/projects/"
                    f"{project}:getIamPolicy"
                ),
                "read_method": "POST",
                "write_url": (
                    "https://cloudresourcemanager.googleapis.com/v1/projects/"
                    f"{project}:setIamPolicy"
                ),
                "policy_envelope": "policy",
                "bindings": [
                    {
                        "role": "roles/aiplatform.user",
                        "members": [f"serviceAccount:{pod_sa}"],
                    }
                ],
                "tolerate": [],
                "project_level": True,
            }
        )
        return calls

    # -- execution -----------------------------------------------------------------

    def apply(self, plan: dict[str, Any], *, dry_run: bool = True) -> dict[str, Any]:
        """Create the plan's resources. ``dry_run`` is the default on purpose.

        Returns a per-step result rather than raising on the first problem, because a
        half-built project is a real state a caller has to reason about and an
        exception loses which half.
        """
        calls = self.plan_calls(plan)
        if dry_run:
            return {"dryRun": True, "project": self._project, "steps": calls}
        if not self._token:
            raise BootstrapError(
                "apply(dry_run=False) needs an impersonated bootstrap token; see "
                "mint_bootstrap_token. It will not fall back to hushh's own identity."
            )

        results: list[dict[str, Any]] = []
        headers = {"Authorization": f"Bearer {self._token}", "Content-Type": "application/json"}
        unmet: set[str] = set()
        for index, call in enumerate(calls):
            # A step whose prerequisite failed has nothing to say about itself. Running it
            # anyway produces a second error message for a cause already reported once --
            # which is how the first live run turned one missing IAM binding into three
            # failures that read like three problems.
            required = call.get("depends_on")
            if required and required in unmet:
                results.append(
                    {
                        "step": call["step"],
                        "status": 0,
                        "ok": False,
                        "skipped": True,
                        "detail": f"not attempted: {required} did not succeed",
                    }
                )
                unmet.add(call["step"])
                continue

            if call.get("kind") == "merge_binding":
                merged = self._merge_binding(call, headers)
                results.append(merged)
                if not merged["ok"]:
                    unmet.add(call["step"])
                continue

            if call.get("kind") == "generate_secret_version":
                seeded = self._seed_secret_version(call, headers)
                results.append(seeded)
                if not seeded["ok"]:
                    unmet.add(call["step"])
                continue

            response = self._session.request(
                call["method"],
                call["url"],
                headers=headers,
                params=call.get("params"),
                data=json.dumps(call.get("body") or {}),
                timeout=120,
            )
            code = getattr(response, "status_code", 0)
            ok = code in (200, 201) or code in call.get("tolerate", [])

            # A 409 on the bucket is NOT success. GCS bucket names are globally unique,
            # so "already exists" can mean the name belongs to a completely different
            # owner's project. Tolerating it blindly would point this person's pod at
            # storage it cannot write, and the failure would surface far from the cause.
            if ok and code == 409 and call["step"] == "cmek_bucket":
                owned = self._bucket_is_ours(call, headers)
                if not owned:
                    ok = False
                    results.append(
                        {
                            "step": call["step"],
                            "status": code,
                            "ok": False,
                            "detail": (
                                "that bucket name is taken by a project this bootstrap does "
                                "not own -- GCS names are globally unique. Choose another."
                            ),
                        }
                    )
                    logger.warning("byoc_bootstrap.bucket_name_collision step=%s", call["step"])
                    unmet.add(call["step"])
                    continue

            detail = "" if ok else getattr(response, "text", "")[:300]

            # A 200 here means "the operation started", not "the work is done". Every
            # step after this one depends on the work, so the wait belongs inside the
            # step rather than in the caller's discipline.
            if ok and call.get("await_operation"):
                waited = self._await_operation(call, headers, response)
                ok = waited["ok"]
                detail = waited["detail"]

            results.append(
                {
                    "step": call["step"],
                    "status": code,
                    "ok": ok,
                    "detail": detail,
                }
            )
            logger.info("byoc_bootstrap.step step=%s status=%s ok=%s", call["step"], code, ok)
            if not ok:
                unmet.add(call["step"])

            if not ok and call.get("gates_rest"):
                # Reported as skipped, not failed. They were never attempted, and calling
                # them failures would attribute one cause to eight places.
                results.extend(
                    {
                        "step": later["step"],
                        "status": 0,
                        "ok": False,
                        "skipped": True,
                        "detail": f"not attempted: {call['step']} did not complete",
                    }
                    for later in calls[index + 1 :]
                )
                logger.warning(
                    "byoc_bootstrap.gated_stop step=%s skipped=%s",
                    call["step"],
                    len(calls) - index - 1,
                )
                break

        failed = [r for r in results if not r["ok"] and not r.get("skipped")]
        skipped = [r for r in results if r.get("skipped")]
        return {
            "dryRun": False,
            "project": self._project,
            "steps": results,
            "ok": not failed and not skipped,
            "failed": [r["step"] for r in failed],
            "skipped": [r["step"] for r in skipped],
        }

    def _await_operation(
        self, call: dict[str, Any], headers: dict[str, str], response: Any
    ) -> dict[str, Any]:
        """Block until a long-running operation finishes, or report why it did not.

        Learned from a live run against a real empty project: ``services:batchEnable``
        returned 200 immediately, the applier moved on, and six of the next seven steps
        failed with "API has not been used in this project". Checked a minute later,
        every API was on. Nothing had gone wrong except the assumption that a 200 meant
        the work was done.

        An operation that finishes with an ``error`` is a failure, not a completion --
        the difference matters because ``done: true`` is set in both cases and reading
        only that field would turn a failed enable into a green step.
        """
        body = _json_or_empty(response)
        name = str(body.get("name") or "")
        if body.get("done") or not name:
            # Some calls answer inline. No name to poll means there is nothing to wait
            # for, which is a legitimate (and fast) outcome rather than an error.
            return _operation_verdict(body, polls=0)

        base = str(call.get("operation_url") or "")
        deadline = self._clock() + _OPERATION_DEADLINE_SECONDS
        polls = 0
        while self._clock() < deadline:
            self._sleep(_OPERATION_POLL_SECONDS)
            polls += 1
            poll = self._session.request(
                "GET", f"{base}{name}", headers=headers, params=None, data=None, timeout=60
            )
            if getattr(poll, "status_code", 0) != 200:
                return {
                    "ok": False,
                    "detail": (
                        f"could not read operation {name} "
                        f"({getattr(poll, 'status_code', '?')}): "
                        f"{getattr(poll, 'text', '')[:200]}"
                    ),
                }
            state = _json_or_empty(poll)
            if state.get("done"):
                logger.info("byoc_bootstrap.operation_done step=%s polls=%s", call["step"], polls)
                return _operation_verdict(state, polls=polls)

        return {
            "ok": False,
            "detail": (
                f"operation {name} did not finish within "
                f"{int(_OPERATION_DEADLINE_SECONDS)}s. The steps that depend on it were "
                "not attempted, because they would fail on APIs that are still turning on."
            ),
        }

    def _seed_secret_version(self, call: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
        """Put one random secret into the USER's Secret Manager, once and only once.

        This is the pod's ``APP_SIGNING_KEY``. It cannot follow the log key's pattern of
        being minted by the pod itself, because the application refuses to *import*
        without it -- there is no moment when pod code is running and the key is absent.
        So the bootstrap generates it, and the honest statement of the trade is: hushh's
        process holds these bytes for the length of one HTTPS request and writes them
        only into the user's own project. Nothing here persists them anywhere else, and
        the rendered plan never contains them.

        A re-run must NOT rotate it. This key signs consent tokens, grants, receipts and
        the audit chain, so a silent second version would invalidate every receipt the
        pod had already written. Existing versions are therefore checked first, and a
        secret that already has one is a no-op rather than a fresh write.
        """
        import secrets  # noqa: PLC0415

        listing = self._session.request(
            "GET",
            f"https://secretmanager.googleapis.com/v1/{call['secret']}/versions",
            headers=headers,
            params={"filter": "state:ENABLED"},
            data=None,
            timeout=60,
        )
        if getattr(listing, "status_code", 0) != 200:
            return {
                "step": call["step"],
                "status": getattr(listing, "status_code", 0),
                "ok": False,
                "detail": (
                    "could not check for an existing signing key. Refusing to add one: "
                    "a second version would invalidate every receipt already written."
                ),
            }
        if _json_or_empty(listing).get("versions"):
            return {
                "step": call["step"],
                "status": 200,
                "ok": True,
                "detail": "signing key already present -- not rotated",
            }

        added = self._session.request(
            "POST",
            f"https://secretmanager.googleapis.com/v1/{call['secret']}:addVersion",
            headers=headers,
            params=None,
            # A secret mounted as an env var must be UTF-8 TEXT. Secret Manager's
            # `payload.data` is base64 only for transport, so sending
            # b64(random_bytes) stores raw bytes as the value -- and Cloud Run refused
            # the pod with "Secret ... contains non-UTF8 data. Instance startup will
            # now abort." Generating printable material and transport-encoding THAT is
            # the difference. 48 url-safe bytes render as 64 characters, comfortably
            # past the 32 the app requires.
            data=json.dumps(
                {
                    "payload": {
                        "data": base64.b64encode(secrets.token_urlsafe(48).encode("ascii")).decode(
                            "ascii"
                        )
                    }
                }
            ),
            timeout=60,
        )
        code = getattr(added, "status_code", 0)
        ok = code in (200, 201)
        # Never echo the response body: on this one call it describes the secret.
        return {
            "step": call["step"],
            "status": code,
            "ok": ok,
            "detail": "" if ok else "could not add the signing key version",
        }

    def _lookup_member(self, lookup: dict[str, Any], headers: dict[str, str]) -> str:
        """Read a principal's address from the API that owns it, rather than build one.

        Google's per-project service agents embed the project NUMBER, not its id, so the
        address cannot be rendered at plan time from the id alone. Asking the service for
        it is also what provisions the agent on a project that has never had one.
        """
        response = self._session.request(
            "GET", lookup["url"], headers=headers, params=None, data=None, timeout=60
        )
        if getattr(response, "status_code", 0) != 200:
            logger.warning(
                "byoc_bootstrap.member_lookup_failed status=%s",
                getattr(response, "status_code", 0),
            )
            return ""
        value = str(_json_or_empty(response).get(lookup["field"]) or "")
        return f"{lookup.get('prefix', '')}{value}" if value else ""

    def _bucket_is_ours(self, call: dict[str, Any], headers: dict[str, str]) -> bool:
        """After a 409, does that bucket actually live in THIS project?

        Read rather than assumed, because the alternative is silently adopting a
        stranger's bucket name and discovering it at the pod's first write.
        """
        name = str((call.get("body") or {}).get("name") or "")
        if not name:
            return False
        # Ask which buckets THIS project has and look for the name, rather than reading
        # the bucket and trying to infer ownership from its fields. A bucket GET returns
        # a project NUMBER, not an id, so inferring would mean a second lookup and a
        # comparison that is easy to get subtly wrong; listing answers the actual
        # question directly. Conservative by construction: anything we cannot see in
        # this project's own listing is treated as somebody else's.
        listing = self._session.request(
            "GET",
            "https://storage.googleapis.com/storage/v1/b",
            headers=headers,
            params={"project": self._project, "prefix": name},
            data=None,
            timeout=60,
        )
        if getattr(listing, "status_code", 0) != 200:
            return False
        return any(str(item.get("name")) == name for item in (listing.json().get("items") or []))

    def _merge_binding(self, call: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
        """Read the policy, add our binding, write it back. Never overwrite.

        `safe-changes` R3: add a binding, never set a policy. The etag is carried through
        so a concurrent edit fails the write instead of silently winning.
        """
        bindings = call["bindings"]
        if call.get("member_lookup"):
            resolved = self._lookup_member(call["member_lookup"], headers)
            if not resolved:
                return {
                    "step": call["step"],
                    "status": 0,
                    "ok": False,
                    "detail": (
                        "could not resolve the principal to bind. Refusing rather than "
                        "guessing an address: a binding written to the wrong member is "
                        "an access grant nobody asked for."
                    ),
                }
            bindings = [{**b, "members": [*b["members"], resolved]} for b in bindings]

        read = self._session.request(
            call.get("read_method", "GET"),
            call["read_url"],
            headers=headers,
            params=None,
            data=json.dumps(
                call["read_body"]
                if "read_body" in call
                else {"options": {"requestedPolicyVersion": 3}}
            )
            if call.get("read_method") == "POST"
            else None,
            timeout=60,
        )
        if getattr(read, "status_code", 0) != 200:
            return {
                "step": call["step"],
                "status": getattr(read, "status_code", 0),
                "ok": False,
                "detail": f"could not read the policy to merge into: {getattr(read, 'text', '')[:200]}",
            }

        policy = dict(read.json() or {})
        existing = list(policy.get("bindings") or [])
        if _bindings_equal(existing, bindings):
            # Already granted. Reporting this as a no-op keeps a re-run honest rather
            # than writing an identical policy and calling it a change.
            return {"step": call["step"], "status": 200, "ok": True, "detail": "already bound"}

        merged = [dict(b) for b in existing]
        for wanted in bindings:
            match = next((b for b in merged if b.get("role") == wanted["role"]), None)
            if match is None:
                merged.append({"role": wanted["role"], "members": list(wanted["members"])})
                continue
            members = list(match.get("members") or [])
            for member in wanted["members"]:
                if member not in members:
                    members.append(member)
            match["members"] = members

        policy["bindings"] = merged
        envelope = call.get("policy_envelope") or ""
        body = {envelope: policy} if envelope else policy
        write = self._session.request(
            call.get("write_method", "POST"),
            call["write_url"],
            headers=headers,
            params=None,
            data=json.dumps(body),
            timeout=120,
        )
        code = getattr(write, "status_code", 0)
        ok = code in (200, 201)
        logger.info(
            "byoc_bootstrap.merge_binding step=%s status=%s ok=%s existing=%d",
            call["step"],
            code,
            ok,
            len(existing),
        )
        return {
            "step": call["step"],
            "status": code,
            "ok": ok,
            "detail": "" if ok else getattr(write, "text", "")[:300],
            "preserved_bindings": len(existing),
        }


def _json_or_empty(response: Any) -> dict[str, Any]:
    """A body we could not parse is not a completed operation. Treat it as empty."""
    try:
        parsed = response.json()
    except Exception:  # noqa: BLE001 -- any parse failure means "no usable body"
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _operation_verdict(state: dict[str, Any], *, polls: int) -> dict[str, Any]:
    """``done: true`` alone is not success -- a failed operation is also done."""
    error = state.get("error") or {}
    if error:
        return {
            "ok": False,
            "detail": f"operation finished with an error: {json.dumps(error)[:250]}",
        }
    return {"ok": True, "detail": f"operation completed after {polls} poll(s)"}


def _bindings_equal(existing: list, wanted: list) -> bool:
    """Does the policy already carry every wanted (role, member)? Then nothing to write."""
    have = {(b.get("role"), m) for b in existing for m in (b.get("members") or [])}
    want = {(b["role"], m) for b in wanted for m in b["members"]}
    return want.issubset(have)


def authorization_request(
    *, project: str, bootstrap_sa: str, consent_plane_sa: str
) -> dict[str, Any]:
    """Exactly what to ask a user to run once, stated so they can audit it.

    Deliberately a data structure rather than a prose paragraph: a person handing a
    cloud project to a vendor deserves to see the complete list of what that vendor
    will be able to do, not a summary of it.
    """
    return {
        "project": project,
        "creates": {
            "service_account": bootstrap_sa,
            "purpose": "a bootstrap identity hushh may briefly borrow — never hushh's own",
        },
        "grants_to_bootstrap_sa": [
            {"role": role, "why": why, "scope": f"project {project}"}
            for role, why in BOOTSTRAP_ROLES
        ],
        "grants_to_hushh": [
            {
                "member": f"serviceAccount:{consent_plane_sa}",
                "role": "roles/iam.serviceAccountTokenCreator",
                "on": bootstrap_sa,
                "why": (
                    "lets hushh mint a 15-minute token for THAT ONE account. Not a project "
                    "role, not a key, and revocable by deleting this single binding."
                ),
            }
        ],
        "hushh_never_receives": [
            "a service-account key file",
            "a project-level role",
            "the KMS key material, or the data key it wraps",
            "read access to the pod's bucket contents",
        ],
        "revocation": (
            f"Remove the serviceAccountTokenCreator binding on {bootstrap_sa}, or delete that "
            "service account. hushh loses the ability to change anything in this project "
            "immediately; the pod keeps running on its own identity until you delete it."
        ),
    }


__all__ = [
    "BOOTSTRAP_ROLES",
    "BootstrapError",
    "UserGcpBootstrap",
    "authorization_request",
    "mint_bootstrap_token",
]
