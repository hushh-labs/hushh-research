"""Complete synthetic creation identities for the frozen core-only pod plan."""

CREATED = "2026-09-08T00:00:00Z"


class HostedErasureFacts:
    def __init__(self, pg, reservation):
        self.pg, self.provision = pg, reservation
        self.owner, self.erase = reservation["ownerId"], "e" * 32
        assignment = reservation["hostedAdmission"]["assignment"]
        self.project, self.region = assignment["project"], assignment["region"]
        self.plan = assignment["bootstrapContract"]["plan"]
        self.resources = {item["type"]: item for item in self.plan["resources"]}
        self.service = self.resources["cloud_run_service"]["id"]
        self.image = (
            f"{self.region}-docker.pkg.dev/{self.project}/one-pod/consent-protocol-pod@"
            + reservation["hostedAdmission"]["imageDigest"]
        )
        self.hub = self.plan["federation"]["impersonation"]["granted_to"]
        bootstrap = self.plan["federation"]["impersonation"]["bootstrap_service_account"]
        self.runtime = self.account(self.resources["service_account"]["id"], "123456789")
        self.bootstrap = self.account(bootstrap, "9876543210")
        self.observations = self.resource_observations(assignment["projectNumber"])
        self.bindings = self.policy_observations()
        self.inventory = {
            "version": "byoc.substrate.receipt.v1",
            "applied": True,
            "plannedResources": [
                {"type": item["type"], "id": item["id"]} for item in self.plan["resources"]
            ],
            "resourceObservations": list(self.observations.values()),
            "bindingObservations": self.bindings,
            "plannedBindings": [
                {
                    "member": self.runtime["email"],
                    "role": "roles/serviceusage.serviceUsageConsumer",
                    "on": "project:" + self.project,
                }
            ],
        }

    def account(self, email, uid):
        return {
            "name": f"projects/{self.project}/serviceAccounts/{email}",
            "email": email,
            "projectId": self.project,
            "uniqueId": uid,
        }

    def resource_observations(self, number):
        identities = {
            "service_account": self.runtime,
            "gcs_bucket": {
                "name": self.resources["gcs_bucket"]["id"],
                "generation": "10",
                "projectNumber": number,
                "timeCreated": CREATED,
            },
            "kms_key": {
                "name": f"projects/{self.project}/locations/{self.region}/keyRings/hushh-one/cryptoKeys/"
                + self.resources["kms_key"]["id"],
                "purpose": "ENCRYPT_DECRYPT",
                "createTime": CREATED,
            },
            "secret": {
                "name": f"projects/{self.project}/secrets/" + self.resources["secret"]["id"],
                "projectId": self.project,
                "createTime": CREATED,
            },
            "artifact_repository": {
                "name": f"projects/{self.project}/locations/{self.region}/repositories/one-pod",
                "format": "DOCKER",
                "createTime": CREATED,
            },
        }
        return {
            kind: {
                "type": kind,
                "id": self.resources[kind]["id"],
                "disposition": "created",
                "identity": identity,
            }
            for kind, identity in identities.items()
        }

    def policy_observations(self):
        def binding(step, role, resource, member):
            return {
                "step": step,
                "policyResource": resource + ":getIamPolicy",
                "role": role,
                "member": "serviceAccount:" + member,
                "disposition": "added",
                "beforeEtag": "before",
                "afterEtag": "after",
            }

        project = f"https://cloudresourcemanager.googleapis.com/v1/projects/{self.project}"
        repository = (
            "https://artifactregistry.googleapis.com/v1/"
            + self.observations["artifact_repository"]["identity"]["name"]
        )
        return [
            binding("iam_pod_sa_vertex", "roles/aiplatform.user", project, self.runtime["email"]),
            binding(
                "iam_pod_sa_quota",
                "roles/serviceusage.serviceUsageConsumer",
                project,
                self.runtime["email"],
            ),
            binding(
                "artifact_repo_grant_copy_writer",
                "roles/artifactregistry.writer",
                repository,
                self.hub,
            ),
        ]
