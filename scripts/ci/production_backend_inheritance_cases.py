"""Frontend receipts inherit one immutable ordinary backend owner, never history."""

import copy
import json
import subprocess
import tempfile
from contextlib import ExitStack, contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import production_backend_inheritance as inheritance
from production_phone_receipt_fixtures import archive, cold_revision
from production_worker_basis_cases import _basis_case, _ordinary, _runtime, _tag


def _frontend_documents(case):
    release = copy.deepcopy(case.release)
    release.update(scope="frontend", sha="e" * 40)
    release.pop("phone_rollback")
    release["final"]["frontend_revision"] = "hushh-webapp-frontend-only"
    release["candidate"]["frontend_revision"] = release["final"]["frontend_revision"]
    release["backend_origin"] = {
        "run_id": "500",
        "source": case.release["sha"],
        "revision": case.release["final"]["backend_revision"],
        "uid": "primary-uid",
        "service_uid": case.origin["candidate"]["service_uid"],
    }
    return {
        "prod-release-status.json": release,
        "prod-protected-document-release.json": {"configured": True, "enabled": False},
    }


@contextmanager
def _inheritance_case(fixture):
    with _basis_case(fixture) as ports, ExitStack() as stack:
        _ordinary(ports)
        case, owner = ports.case, ports.owner
        case.documents[inheritance.activation.pending.ACTIVATION]["run_id"] = "500"
        documents = _frontend_documents(case)
        release = documents["prod-release-status.json"]
        run = {**copy.deepcopy(case.run), "id": 600}
        jobs = copy.deepcopy(case.jobs)
        jobs["jobs"][0].update(run_id=600)
        artifact = copy.deepcopy(case.artifact)
        artifact.update(id=700, name="prod-release-600")
        artifact["workflow_run"]["id"] = 600
        payload = b""
        old_api, old_command, old_download = (
            owner.api,
            owner.command,
            owner.retention.run_command,
        )

        def pack():
            nonlocal payload
            case.pack()
            payload = archive(SimpleNamespace(artifact=artifact), documents)

        def api(repository, endpoint):
            if endpoint == "runs/400":
                return copy.deepcopy(case.original.run)
            if endpoint in {"runs/600", "runs/600?exclude_pull_requests=true"}:
                return copy.deepcopy(run)
            if endpoint == "runs/600/artifacts?per_page=100":
                return {"total_count": 1, "artifacts": [copy.deepcopy(artifact)]}
            if endpoint in {
                "runs/600/attempts/1/jobs?per_page=100",
                "runs/600/jobs?filter=latest&per_page=100",
            }:
                return copy.deepcopy(jobs)
            return old_api(repository, endpoint)

        def download(command, **kwargs):
            if command[-1].endswith("/700/zip"):
                return subprocess.CompletedProcess(command, 0, payload, b"")
            return old_download(command, **kwargs)

        def command(*arguments):
            if arguments[:3] == ("gh", "run", "download") and arguments[3] == "600":
                directory = Path(arguments[arguments.index("--dir") + 1])
                directory.mkdir(parents=True)
                (directory / "prod-release-status.json").write_text(json.dumps(release))
                return ""
            return old_command(*arguments)

        tag = _tag(SimpleNamespace(release=release))
        tag = inheritance.activation.proof.reference.tag_identity(
            tag["tag_object"].replace("/actions/runs/500", "/actions/runs/600")
        )
        ports.tag.clear()
        ports.tag.update(tag)
        ports.runtimes["hushh-webapp"] = _runtime(
            "hushh-webapp",
            release["sha"],
            "600",
            "frontend-only-uid",
            release["final"]["frontend_revision"],
        )
        for target, name, value in (
            (owner, "api", api),
            (owner, "command", command),
            (owner.retention, "run_command", download),
        ):
            stack.enter_context(mock.patch.object(target, name, value))
        ports.fe_run, ports.fe_release = run, release
        ports.fe_documents, ports.fe_jobs, ports.fe_artifact = documents, jobs, artifact
        ports.pack = pack
        pack()
        yield ports


def _find(ports, callback=None):
    with tempfile.TemporaryDirectory() as temporary:
        return ports.owner.find_release(
            "hushh-labs/hushh-research",
            "600",
            Path(temporary),
            require_live=False,
            environment="production",
            on_phone_rollback=callback,
        )


class BackendInheritanceCases:
    def test_frontend_retention_protects_original_phone_rollback_and_rejects_tamper(
        self,
    ):
        with _inheritance_case(self) as ports:
            anchors = []
            release = _find(ports, anchors.append)[1]
            anchor = anchors[0]
            cold = cold_revision(ports.case.documents["phone-rollback/qualified.json"])
            cold["metadata"]["uid"] = anchor["uid"]
            with (
                mock.patch.object(
                    ports.owner.retention,
                    "revision_state",
                    return_value=[cold, ports.runtimes["consent-protocol"][1]],
                ) as inventory,
                mock.patch.object(
                    ports.owner,
                    "command",
                    return_value=release["final"]["backend_revision"],
                ),
            ):
                flags = ports.owner.release_protection_flags(
                    "consent-protocol",
                    "backend",
                    release,
                    environment="production",
                    phone_anchor=anchor,
                )
                self.assertEqual(flags[0], release["final"]["backend_revision"])
                self.assertEqual(flags[2], cold["metadata"]["name"])
                self.assertEqual(flags[4], release["final"]["backend_revision"])
                inventory.side_effect = [
                    [cold, ports.runtimes["consent-protocol"][1]],
                    [ports.runtimes["consent-protocol"][1]],
                ]
                with self.assertRaises(ports.owner.retention.UnsafeState):
                    ports.owner.release_protection_flags(
                        "consent-protocol",
                        "backend",
                        release,
                        environment="production",
                        phone_anchor=anchor,
                    )
                with self.assertRaises(ports.owner.retention.UnsafeState):
                    ports.owner.release_protection_flags(
                        "consent-protocol",
                        "backend",
                        release,
                        environment="production",
                        phone_anchor={**anchor, "release_sha": "a" * 40},
                    )

    def test_frontend_inherits_actual_backend_identity_and_phone_anchor(self):
        with _inheritance_case(self) as ports:
            found = _find(ports)
            self.assertEqual(found[0], 600)
            release = found[1]
            self.assertEqual(release["_maintenance_backend_identity"]["run_id"], 500)
            self.assertEqual(
                release["_maintenance_backend_identity"]["uid"], "primary-uid"
            )
            self.assertEqual(
                release["_maintenance_lane_provenance"]["backend"]["sha"], "f" * 40
            )
            self.assertEqual(
                release["_maintenance_lane_provenance"]["frontend"]["sha"], "e" * 40
            )
            self.assertNotIn("phone_rollback", release)
            self.assertTrue(
                ports.owner.live_release_matches(release, environment="production")
            )

    def test_frontend_selector_cannot_forge_or_chain_backend_authority(self):
        for defect in (
            "uid",
            "source",
            "run",
            "service",
            "pending",
            "frontend",
            "activation",
            "continuation",
        ):
            with self.subTest(defect=defect), _inheritance_case(self) as ports:
                pointer = ports.fe_release["backend_origin"]
                if defect in {"uid", "source", "service"}:
                    pointer[
                        {"uid": "uid", "source": "source", "service": "service_uid"}[
                            defect
                        ]
                    ] = "a" * 40
                elif defect == "run":
                    pointer["run_id"] = "400"
                elif defect in {"pending", "frontend"}:
                    ports.case.release["status" if defect == "pending" else "scope"] = (
                        "pending_activation" if defect == "pending" else "frontend"
                    )
                elif defect == "activation":
                    ports.case.documents[inheritance.activation.pending.ACTIVATION][
                        "candidate_uid"
                    ] = "forged"
                else:
                    ports.case.documents[inheritance.activation.ORIGIN] = (
                        ports.case.origin
                    )
                ports.pack()
                with self.assertRaises(ports.owner.retention.UnsafeState):
                    _find(ports)

    def test_frontend_inheritance_keeps_canonical_hygiene_failure_classifier(self):
        from production_worker_basis_cases import _hygiene_failure

        with _inheritance_case(self) as ports:
            ports.case.documents[inheritance.activation.ORIGIN] = ports.case.origin
            _hygiene_failure(ports)
            ports.pack()
            self.assertEqual(
                _find(ports)[1]["_maintenance_backend_identity"]["run_id"], 500
            )
