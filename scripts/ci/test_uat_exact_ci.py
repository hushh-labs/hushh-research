#!/usr/bin/env python3
"""Fail closed when direct-UAT evidence changes or belongs to another source."""

import copy
import json
import os
import subprocess
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import promotion_approval as promotion
import uat_exact_ci as subject
from uat_exact_ci_fixture import (
    AttemptAPI as _AttemptAPI,
    attempt_jobs as _attempt_jobs,
    attempt_check as _attempt_check,
    attempt_run as _attempt_run,
)






class ExactUatCiTest(unittest.TestCase):
    def test_ordinary_uat_keeps_app_independent_but_pins_privileged_execution(self):
        with tempfile.TemporaryDirectory(prefix="hussh-uat-authority-") as root:
            env = {k: v for k, v in os.environ.items() if not k.startswith(("GIT_", "GITHUB_", "GH_"))}

            def git(*args):
                try:
                    return subprocess.check_output(["git", "-C", root, *args], env=env, stderr=subprocess.DEVNULL)
                except subprocess.CalledProcessError as error:
                    raise subject.Refused("Git authority lookup failed") from error

            def write(path, text):
                target = Path(root, path)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(text)

            def commit():
                git("add", ".")
                git("commit", "-qm", "fixture")
                return git("rev-parse", "HEAD").decode().strip()

            git("init", "-q")
            git("config", "user.name", "CI fixture")
            git("config", "user.email", "ci@example.invalid")
            git("config", "core.hooksPath", "/dev/null")
            for path in subject.MANIFEST_FILES:
                write(path, "[tool.pytest.ini_options]\naddopts = '-q'\n" if path.endswith(".toml")
                      else '{"scripts": {"test": "vitest"}}')
            write(subject.BACKEND_TEST_MANIFEST, "tests/test_main.py\n")
            prose = ".agents/skills/repo-operations/SKILL.md"
            write(prose, "# Original guidance\n")
            guarded = (".agents/config.json", ".agents/workflows/example/workflow.json",
                       ".agents/skills/repo-operations/scripts/operator.py",
                       "scripts/ops/sync_backend_runtime_secrets.py",
                       "scripts/ops/scope_commerce_runtime_policy.py",
                       "consent-protocol/db/migration_authority.py", "deploy/backend.cloudbuild.yaml",
                       "consent-protocol/db/hosted_custody_qualification.py",
                       "consent-protocol/db/firebase_erasure_adoption.py",
                       "deploy/drive/deploy_worker_service.sh",
                       "deploy/drive/setup_work_drain_scheduler.sh",
                       "deploy/drive/verify_worker_revision.py",
                       "deploy/drive/new_privileged_input.py")
            for path in guarded:
                write(path, "original\n")
            authority = commit()
            git("update-ref", "refs/remotes/origin/main", authority)
            write(prose, "# Updated development guidance\n")
            candidate = commit()
            git("checkout", "--detach", authority)
            write("application.txt", "historical serving release from a sibling history\n")
            serving = commit()
            git("checkout", "--detach", candidate)
            with patch.object(subject, "git", side_effect=git):
                # The accepted serving commit is deliberately not an ancestor.
                self.assertEqual(subject.verify_git_authority(candidate, serving, authority, current=False),
                                 git("rev-parse", f"{candidate}^{{tree}}").decode().strip())
                with self.assertRaises(subject.Refused):
                    subject.verify_git_authority(candidate, "0" * 40, authority, current=False)
                self.assertEqual(subject.verify_git_authority(candidate, authority, authority, current=False),
                                 git("rev-parse", f"{candidate}^{{tree}}").decode().strip())
                for path in guarded:
                    write(path, "changed\n")
                    changed = commit()
                    with self.subTest(path=path):
                        if path.startswith(("deploy/", "consent-protocol/db/")):
                            with self.assertRaisesRegex(subject.Refused, "Privileged build or migration"):
                                subject.verify_git_authority(changed, authority, authority, current=False)
                        else:
                            self.assertEqual(subject.verify_git_authority(changed, authority, authority, current=False),
                                             git("rev-parse", f"{changed}^{{tree}}").decode().strip())
                    write(path, "original\n")
                    commit()
                for path in ("deploy/drive/deploy_worker_service_prod.sh",
                             "deploy/drive/setup_work_drain_scheduler_prod.sh"):
                    write(path, "production-only change\n")
                    changed = commit()
                    self.assertEqual(subject.verify_git_authority(changed, authority, authority, current=False),
                                     git("rev-parse", f"{changed}^{{tree}}").decode().strip())
                    git("reset", "--hard", candidate)
                # Each invocation projection and branch-owned manifest may
                # evolve independently of Main, even without Main-only tests.
                for path in (*subject.MANIFEST_FILES, subject.BACKEND_TEST_MANIFEST):
                    original = Path(root, path).read_text()
                    changed_text = ("tests/test_uat_only.py\n" if path == subject.BACKEND_TEST_MANIFEST
                                    else "[tool.pytest.ini_options]\naddopts = '-ra'\n" if path.endswith(".toml")
                                    else '{"scripts": {"test": "vitest run"}}')
                    write(path, changed_text)
                    changed = commit()
                    with self.subTest(path=path):
                        if path in subject.UAT_PRIVILEGED_PATHS:
                            with self.assertRaises(subject.Refused):
                                subject.verify_git_authority(changed, serving, authority, current=False)
                        else:
                            self.assertEqual(subject.verify_git_authority(changed, serving, authority, current=False),
                                             git("rev-parse", f"{changed}^{{tree}}").decode().strip())
                        # Isolated UAT retains its former invocation contract.
                        with self.assertRaises(subject.Refused):
                            subject.verify_invocation_authority(changed, authority)
                    write(path, original)
                    commit()
                # Exercise the real shared verifier through inspection, early
                # deployment admission and the stored under-lock recheck.
                import uat_release_prerequisites as prerequisites

                write("deploy/backend.cloudbuild.yaml", "original\n")
                write("hushh-webapp/package.json", '{"scripts": {"test": "vitest run"}}')
                write(subject.BACKEND_TEST_MANIFEST, "tests/test_uat_only.py\n")
                candidate = commit()
                git("update-ref", "refs/remotes/origin/uat", candidate)
                run = _attempt_run(candidate)
                transport = _AttemptAPI(run, _attempt_jobs(candidate, serving), [run], _attempt_check(candidate))
                protected = {"protected": True, "commit": {"sha": candidate}}
                api = SimpleNamespace(read=lambda path: copy.deepcopy(protected)
                                      if path.endswith("/branches/uat") else transport.read(path))
                live = {name: {"sha": serving, "revision": name + "-00001-abc"}
                        for name in ("backend", "frontend")}
                args = SimpleNamespace(environment="uat", scope="all", sha=candidate,
                    base_sha=serving, authority_sha=authority, ci_run_id=123, ci_attempt=1,
                    backend_base_sha=serving, frontend_base_sha=serving,
                    backend_base_revision=live["backend"]["revision"],
                    frontend_base_revision=live["frontend"]["revision"], predecessor=None)
                # Synthetic Git repo has no remote; refresh is the only Git
                # operation replaced. All content/ancestry reads use real Git.
                with patch.object(subject, "git", side_effect=lambda *a: b"" if a[0] == "fetch" else git(*a)), \
                     patch.object(subject, "GitHub", return_value=api), \
                     patch.object(subject, "live_serving_bases", side_effect=lambda _: copy.deepcopy(live)), \
                     patch.dict(os.environ, {"UAT_EMAIL_AUTH_ENABLED": "false"}):
                    self.assertTrue(prerequisites.inspect(api, authority, read_live=lambda _: copy.deepcopy(live))["ready"])
                    prerequisites.validate_deployment(api, candidate, "123", "1", serving, authority=authority)
                    record = subject.issue_predecessor(args)
                    receipt = Path(root, "admission.json")
                    receipt.write_text(json.dumps(record))
                    options = {"read_live": lambda _: copy.deepcopy(live), "predecessor": receipt}
                    prerequisites.verify_release_scope(api, candidate, serving, "", **options)
                    live["frontend"]["revision"] = "frontend-00002-abc"
                    with self.assertRaisesRegex(subject.Refused, "revisions changed"):
                        prerequisites.verify_release_scope(api, candidate, serving, "", **options)
                    run["conclusion"] = "failure"
                    with self.assertRaises(subject.Refused):
                        prerequisites.validate_deployment(api, candidate, "123", "1", serving, authority=authority)
                    run["conclusion"] = "success"
                    protected["protected"] = False
                    with self.assertRaises(subject.Refused):
                        prerequisites.validate_deployment(api, candidate, "123", "1", serving, authority=authority)

    def test_tooling_independence_preserves_source_and_main_provenance_checks(self):
        candidate, base, authority = (letter * 40 for letter in "abc")
        for refused in (("merge-base", "--is-ancestor", candidate, "origin/uat"),
                        ("merge-base", "--is-ancestor", authority, "origin/main"),
                        *(("cat-file", "-e", f"{sha}^{{commit}}") for sha in (candidate, base, authority))):
            def observed(*args):
                if args == refused:
                    raise subject.Refused("Unprovable source identity")
                return b""
            with self.subTest(refused=refused), patch.object(subject, "git", side_effect=observed), \
                 self.assertRaisesRegex(subject.Refused, "Unprovable source identity"):
                subject.verify_git_authority(candidate, base, authority)
        with patch.object(subject, "git") as git_read:
            for args, options in (((candidate, base, "bad"), {}),
                                  ((candidate, base, authority), {"branch": "main"})):
                with self.subTest(args=args, options=options), self.assertRaises(subject.Refused):
                    subject.verify_git_authority(*args, **options)
            git_read.assert_not_called()

    def test_legacy_isolated_history_retains_its_reviewed_ancestry_boundary(self):
        candidate, base, authority = "a" * 40, "b" * 40, "c" * 40

        def observed(*args):
            if args == ("merge-base", "--is-ancestor", base, candidate):
                raise subject.Refused("Git authority lookup failed")
            return b""

        with patch.object(subject, "git", side_effect=observed), self.assertRaisesRegex(
            subject.Refused, "Isolated UAT serving base.*reviewed source transition"
        ):
            subject.verify_git_authority(candidate, base, authority, current=False, branch="uat-isolated")

    def test_reviewed_product_tests_and_dependencies_do_not_change_execution_authority(self):
        main = {"scripts": {"test": "vitest"}, "dependencies": {"a": "1"}}
        candidate = {**main, "dependencies": {"a": "2"}}
        def observed(*args):
            if args[0] == "ls-tree":
                return f"100644 blob {'d' * 40}\t{subject.BACKEND_TEST_MANIFEST}\n".encode()
            if args[-1].endswith(subject.BACKEND_TEST_MANIFEST):
                return b"tests/test_application.py\n"
            if args[-1].endswith("pyproject.toml"):
                return b"[tool.pytest.ini_options]\naddopts = '-q'\n"
            return json.dumps(candidate if args[-1].startswith("candidate:") else main).encode()
        with patch.object(subject, "git", side_effect=observed):
            subject.verify_invocation_authority("candidate", "main")
            candidate["scripts"] = {"test": "true"}
            with self.assertRaises(subject.Refused):
                subject.verify_invocation_authority("candidate", "main")

    def test_ordinary_uat_manifest_is_branch_owned_but_must_be_well_formed(self):
        candidate, base, authority = "a" * 40, "b" * 40, "c" * 40
        state = {"manifest": b"tests/test_main.py\ntests/services/test_uat_only.py\n",
                 "mode": "100644"}

        def observed(*args):
            if args[0] == "ls-tree":
                self.assertEqual(args, ("ls-tree", candidate, "--", subject.BACKEND_TEST_MANIFEST))
                return f"{state['mode']} blob {'d' * 40}\t{subject.BACKEND_TEST_MANIFEST}\n".encode()
            if args[0] == "show":
                self.assertEqual(args, ("show", f"{candidate}:{subject.BACKEND_TEST_MANIFEST}"))
                return state["manifest"]
            if args[0] == "rev-parse":
                return ("9" * 40).encode()
            return b""

        with patch.object(subject, "git", side_effect=observed):
            self.assertEqual(subject.verify_git_authority(candidate, base, authority, current=False), "9" * 40)
            for invalid in (b"", b"# comments only\n", b"--override-ini=addopts=\n", b"tests/../outside.py\n",
                            b"tests/test_main.py\ntests/test_main.py\n", b"\xff"):
                state["manifest"] = invalid
                with self.subTest(manifest=invalid), self.assertRaisesRegex(subject.Refused, "invalid test identities"):
                    subject.verify_git_authority(candidate, base, authority, current=False)
            state["manifest"] = b"tests/test_other.py\n"
            self.assertEqual(subject.verify_git_authority(candidate, base, authority, current=False), "9" * 40)
            state["manifest"] = b"tests/test_main.py\n"
            state["mode"] = "120000"
            with self.assertRaisesRegex(subject.Refused, "regular tracked file"):
                subject.verify_git_authority(candidate, base, authority, current=False)

    def test_preserved_release_tooling_can_validate_branch_manifest(self):
        import importlib.util
        import sys
        import textwrap

        root = Path(__file__).resolve().parents[2]
        for name in ("deploy-uat-implementation.yml", "deploy-production.yml"):
            with self.subTest(workflow=name), tempfile.TemporaryDirectory() as scratch:
                workflow = (root / ".github/workflows" / name).read_text()
                block = workflow.split("- name: Preserve current release tooling", 1)[1].split("\n      - name:", 1)[0]
                script = textwrap.dedent(block.split("run: |\n", 1)[1]).replace(
                    "${{ inputs.skip_managed_vertex_probe_once }}", "false"
                )
                # This contract tests copied verifier dependencies. Frontend
                # scope copies the profile without the unrelated GNU timeout
                # used by backend capacity admission (covered by capacity tests).
                script = script.replace("${{ needs.wait-capacity.outputs.scope }}", "frontend")
                script = script.replace(
                    "${{ steps.resolve-sha.outputs.sha }}",
                    subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
                )
                env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
                env["RUNNER_TEMP"] = scratch
                subprocess.run(["bash", "-c", script], cwd=root, env=env, check=True, capture_output=True)
                copied = Path(scratch) / "release-tools/uat_exact_ci.py"
                if name == "deploy-production.yml":
                    checkout = workflow.split("- name: Checkout deployment SHA", 1)[1].split("\n      - name:", 1)[0]
                    restore = next(line.strip() for line in checkout.splitlines()
                                   if line.lstrip().startswith('cp "${RUNNER_TEMP}/release-tools/uat_exact_ci.py"'))
                    destination = Path(scratch) / "candidate"
                    (destination / "scripts/ci").mkdir(parents=True)
                    subprocess.run(["bash", "-c", restore], cwd=destination, env=env, check=True, capture_output=True)
                    copied = destination / "scripts/ci/uat_exact_ci.py"
                spec = importlib.util.spec_from_file_location("preserved_uat_exact", copied)
                module = importlib.util.module_from_spec(spec)
                with patch.object(sys, "path", [str(Path(scratch) / "release-tools"), *sys.path]):
                    spec.loader.exec_module(module)
                def observed(*args):
                    if args[0] == "ls-tree":
                        return f"100644 blob {'d' * 40}\t{module.BACKEND_TEST_MANIFEST}\n".encode()
                    if args[-1].endswith(module.BACKEND_TEST_MANIFEST):
                        return b"tests/test_application.py\n"
                    if args[-1].endswith("pyproject.toml"):
                        return b"[tool.pytest.ini_options]\naddopts = '-q'\n"
                    return b'{"scripts": {"test": "vitest"}}'
                with patch.object(module, "git", side_effect=observed):
                    module.verify_invocation_authority("a" * 40, "b" * 40)

    def test_remote_tip_is_refreshed_but_historical_authority_does_not_use_current_tip(self):
        candidate, base, authority = "a" * 40, "b" * 40, "c" * 40
        calls = []
        def observed(*args):
            calls.append(args)
            if args == ("rev-parse", "origin/uat"):
                return ("d" * 40).encode()
            if args[:1] == ("ls-tree",):
                return b"trusted pipeline entries"
            if args[:1] == ("rev-parse",):
                return ("e" * 40).encode()
            return b""
        with patch.object(subject, "git", side_effect=observed), patch.object(subject, "backend_test_inventory"):
            self.assertEqual(subject.verify_git_authority(candidate, base, authority), "e" * 40)
            self.assertEqual(calls[0], ("fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main", "+refs/heads/uat:refs/remotes/origin/uat"))
            self.assertIn(("merge-base", "--is-ancestor", candidate, "origin/uat"), calls)
            with self.assertRaisesRegex(subject.Refused, "tip changed"):
                subject.verify_git_authority(candidate, base, authority, branch="uat-isolated")
            calls.clear()
            self.assertEqual(subject.verify_git_authority(candidate, base, authority, current=False), "e" * 40)
            self.assertNotIn(("rev-parse", "origin/uat"), calls)
            self.assertFalse(any(call[0] == "fetch" for call in calls))

    def test_isolated_uat_still_rejects_changed_release_recipe_or_migration_controller(
        self,
    ):
        candidate, base, authority = "a" * 40, "b" * 40, "c" * 40
        changed_paths = (
            "deploy/backend.cloudbuild.yaml",
            "consent-protocol/db/migrate.py",
            "consent-protocol/db/migration_authority.py",
            "consent-protocol/db/dev_migration_manifest.py",
            "consent-protocol/hushh_mcp/services/hushh_tech_uat_database_attestation.py",
        )
        for changed_path in changed_paths:
            with self.subTest(path=changed_path):
                calls = []

                def observed(*args):
                    calls.append(args)
                    if args[:1] == ("diff",):
                        covers_path = any(
                            changed_path == path
                            or changed_path.startswith(path.rstrip("/") + "/")
                            for path in args[5:]
                        )
                        return (changed_path + "\n").encode() if covers_path else b""
                    if args[:1] == ("rev-parse",):
                        return ("e" * 40).encode()
                    return b""

                with (
                    patch.object(subject, "git", side_effect=observed),
                    patch.object(subject, "verify_invocation_authority"),
                    self.assertRaisesRegex(
                        subject.Refused, "Isolated UAT build or migration authority differs from Main"
                    ),
                ):
                    subject.verify_git_authority(
                        candidate, base, authority, current=False, branch="uat-isolated"
                    )

                tree_reads = [call for call in calls if call[0] == "diff"]
                self.assertEqual(len(tree_reads), 1)
                for call in tree_reads:
                    covered = any(
                        changed_path == path
                        or changed_path.startswith(path.rstrip("/") + "/")
                        for path in call[5:]
                    )
                    self.assertTrue(
                        covered, f"{changed_path} is not in the authority tree"
                    )

    def test_protected_tip_and_serving_revision_cannot_change_after_approval(self):
        candidate, base = "a" * 40, "b" * 40
        api = SimpleNamespace(read=lambda _: {"protected": True, "commit": {"sha": candidate}})
        subject.require_protected_tip(api, candidate)
        for observed in ({"protected": False, "commit": {"sha": candidate}},
                         {"protected": True, "commit": {"sha": base}}):
            with patch.object(subject, "git", side_effect=subject.Refused("Source is not in protected history")), self.assertRaises(subject.Refused):
                subject.require_protected_tip(SimpleNamespace(read=lambda _: observed), candidate)
        args = SimpleNamespace(environment="uat", scope="backend", sha=candidate, base_sha=base,
            backend_base_sha=base, frontend_base_sha="e" * 40, authority_sha="c" * 40,
            backend_base_revision="consent-protocol-old", frontend_base_revision="hushh-webapp-old",
            ci_run_id=42, ci_attempt=1, predecessor=None)
        serving = {"backend": {"sha": base, "revision": "consent-protocol-old"},
                   "frontend": {"sha": "e" * 40, "revision": "hushh-webapp-old"}}
        with tempfile.TemporaryDirectory() as directory, patch.object(subject, "live_serving_bases", return_value=serving), \
             patch.object(subject, "verify_git_authority", return_value="d" * 40), \
             patch.object(subject, "verify_predecessor"):
            record = subject.issue_predecessor(args)
            # Even before the first receipt exists, a same-SHA replacement must
            # not silently change the rollback baseline captured by the caller.
            serving["frontend"]["revision"] = "hushh-webapp-replaced"
            with self.assertRaisesRegex(subject.Refused, "changed before mutation"):
                subject.issue_predecessor(args)
            serving["frontend"]["revision"] = args.frontend_base_revision
            args.predecessor = Path(directory) / "prior.json"
            args.predecessor.write_text(json.dumps(record))
            serving["backend"]["revision"] = "consent-protocol-replaced"
            with self.assertRaisesRegex(subject.Refused, "changed before mutation"):
                subject.issue_predecessor(args)

    def test_frozen_ordinary_source_survives_descendant_tip_but_not_foreign_history(self):
        import sys
        import textwrap

        repo_root = Path(subject.__file__).resolve().parents[2]
        workflow = (repo_root / ".github/workflows/deploy-uat-implementation.yml").read_text()
        promotion = workflow.split("        id: promote-uat-traffic\n", 1)[1]
        promotion = promotion.split("\n      - name:", 1)[0]
        promotion = textwrap.dedent(promotion.split("        run: |\n", 1)[1])
        # Execute the authored source guard, ending before the unchanged cloud
        # serving-revision guards. Git is real; only the GitHub read is synthetic.
        guard = promotion.split('if [[ "$PREPROMOTION_UAT_GATES" == true ]]; then\n', 1)[1]
        guard = guard.split("check_serving() {", 1)[0]
        with tempfile.TemporaryDirectory() as root:
            def git(*args):
                try:
                    return subprocess.check_output(["git", "-C", root, *args], stderr=subprocess.DEVNULL)
                except subprocess.CalledProcessError as error:
                    raise subject.Refused("Source history is unavailable") from error
            git("init", "-q")
            git("config", "user.name", "Synthetic reviewer")
            git("config", "user.email", "reviewer@example.invalid")
            git("config", "core.hooksPath", "/dev/null")
            Path(root, ".git/info/exclude").write_text("runner/\nstubs/\nbranch.json\ntraffic-marker\n")
            path = Path(root, "content")
            def commit(value):
                path.write_text(value)
                git("add", ".")
                git("commit", "-qm", value)
                return git("rev-parse", "HEAD").decode().strip()
            selected = commit("selected")
            tip = commit("newer merged work")
            ref = {"protected": True, "commit": {"sha": selected}}
            tools = Path(root, "runner/release-tools")
            tools.mkdir(parents=True)
            for name in ("uat_exact_ci.py", "process_group.py"):
                (tools / name).write_text((repo_root / "scripts/ci" / name).read_text())
            (tools / "github_security_authority.py").write_text(
                "import json, os\n"
                "class Refused(RuntimeError): pass\n"
                "def verify_source(*args): raise AssertionError('unexpected source lookup')\n"
                "class GitHub:\n"
                " def __init__(self, repository, token):\n"
                "  assert repository == 'hushh-labs/hushh-research' and token == 'synthetic-token'\n"
                " def read(self, path):\n"
                "  assert path == 'repos/hushh-labs/hushh-research/branches/' + os.environ['UAT_SOURCE_BRANCH']\n"
                "  with open(os.environ['BRANCH_RESPONSE']) as handle: return json.load(handle)\n"
            )
            stub = Path(root, "stubs")
            stub.mkdir()
            gh = stub / "gh"
            gh.write_text(f"#!{sys.executable}\nimport os\nprint(open(os.environ['BRANCH_RESPONSE']).read())\n")
            gh.chmod(0o755)
            response, marker = Path(root, "branch.json"), Path(root, "traffic-marker")

            def run_guard(branch, allowed):
                response.write_text(json.dumps(ref))
                marker.unlink(missing_ok=True)
                result = subprocess.run(
                    ["bash", "-c", 'set -euo pipefail\n' + guard + '\nprintf promoted > "$TRAFFIC_MARKER"'],
                    cwd=root, capture_output=True, text=True,
                    env={**os.environ, "PATH": str(stub) + os.pathsep + os.environ["PATH"],
                         "RUNNER_TEMP": str(tools.parent), "GH_TOKEN": "synthetic-token",
                         "GITHUB_REPOSITORY": "hushh-labs/hushh-research",
                         "BRANCH_RESPONSE": str(response), "TRAFFIC_MARKER": str(marker),
                         "APPLICATION_SHA": selected, "UAT_SOURCE_BRANCH": branch},
                )
                self.assertEqual(result.returncode == 0, allowed, result.stderr[-1500:])
                self.assertEqual(marker.exists(), allowed)

            run_guard("uat", True)
            ref["commit"]["sha"] = tip
            run_guard("uat", True)
            run_guard("uat-isolated", False)
            ref["protected"] = False
            run_guard("uat", False)
            ref["protected"] = True
            git("checkout", "--orphan", "foreign")
            ref["commit"]["sha"] = commit("unrelated")
            run_guard("uat", False)
            ref["commit"]["sha"] = "0" * 40
            run_guard("uat", False)

    def test_selected_services_must_match_the_ci_serving_base(self):
        base, other = "a" * 40, "b" * 40
        self.assertEqual(
            subject.verify_serving_bases(base, "all", base, base),
            {"backend": base, "frontend": base},
        )
        self.assertEqual(
            subject.verify_serving_bases(base, "frontend", other, base),
            {"frontend": base},
        )
        for backend, frontend in ((base, other), ("", base), (base, "")):
            with (
                self.subTest(backend=backend, frontend=frontend),
                self.assertRaises(subject.Refused),
            ):
                subject.verify_serving_bases(base, "all", backend, frontend)



class ApplicationSourceAdmissionTest(unittest.TestCase):
    def test_new_uat_selection_requires_protected_uat_membership(self):
        application = "a" * 40

        def protected_uat_member(*args):
            if args == ("merge-base", application, "origin/uat"):
                return application
            raise AssertionError("UAT selection must use protected UAT history")

        self.assertEqual(
            promotion.uat_source(application, resolve=protected_uat_member),
            ("uat", "CI Status Gate,Queue Validation,Branch Validation Gate"),
        )

    def test_main_alias_passes_only_when_the_sha_is_also_in_uat(self):
        application = "b" * 40

        def shared_main_uat_member(*args):
            if args in {
                ("merge-base", application, "origin/main"),
                ("merge-base", application, "origin/uat"),
            }:
                return application
            raise AssertionError("Selection must bind to protected UAT membership")

        self.assertEqual(
            promotion.uat_source(application, resolve=shared_main_uat_member)[0],
            "uat",
        )

    def test_main_only_or_arbitrary_sha_is_not_a_new_uat_source(self):
        application = "c" * 40

        def main_only(*args):
            if args == ("merge-base", application, "origin/main"):
                return application
            if args == ("merge-base", application, "origin/uat"):
                return "0" * 40
            raise AssertionError("Main membership cannot authorize a UAT dispatch")

        with self.assertRaisesRegex(ValueError, "not in protected UAT history"):
            promotion.uat_source(application, resolve=main_only)

    def test_dev_normal_dispatch_checks_dev_membership_and_preserves_pod_source(self):
        root = Path(__file__).resolve().parents[2]
        caller = (root / ".github/workflows/deploy-dev.yml").read_text()
        workflow = (root / ".github/workflows/deploy-dev-implementation.yml").read_text()
        normal_gate = workflow.split(
            "- name: Validate deployment SHA in protected Dev history", 1
        )[1].split("\n      - name:", 1)[0]
        pod_gate_section = workflow.split(
            "- name: Verify exact pod source CI and ref", 1
        )[1]
        pod_gate = pod_gate_section.split("\n      - name:", 1)[0]

        self.assertIn("REQUIRED_BRANCH: dev", normal_gate)
        self.assertNotIn("steps.resolve-sha.outputs.ref", normal_gate)
        self.assertIn("REQUIRED_BRANCH: ${{ inputs.ref }}", pod_gate)
        self.assertIn("Application lookup ref", workflow)
        self.assertIn(
            "run-name: Dev · ${{ inputs.operation || 'deploy' }} · ${{ inputs.target || 'shared-dev' }} · app ${{ inputs.sha || 'protected Dev tip' }} · source dev",
            caller,
        )
        self.assertIn("Source authority: protected \\`dev\\` history", workflow)

    def test_dev_membership_accepts_a_main_alias_only_for_a_dev_member_sha(self):
        root = Path(__file__).resolve().parents[2]
        helper = root / "scripts/ci/require-deploy-sha-on-main.sh"
        application = "a" * 40
        with tempfile.TemporaryDirectory() as directory:
            fake_bin = Path(directory)
            fake_git = fake_bin / "git"
            fake_git.write_text(
                "#!/bin/sh\n"
                'case "$1" in\n'
                "  fetch|cat-file) exit 0 ;;\n"
                '  merge-base) exit "${DEV_MEMBERSHIP_EXIT:-0}" ;;\n'
                "esac\n"
                "exit 0\n"
            )
            fake_git.chmod(0o755)
            environment = {
                **os.environ,
                "PATH": f"{fake_bin}:{os.environ['PATH']}",
                "REQUIRED_BRANCH": "dev",
                "REQUIRE_CI_SUCCESS": "0",
            }
            member = subprocess.run(
                ["bash", str(helper), application],
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(member.returncode, 0, member.stderr)
            environment["DEV_MEMBERSHIP_EXIT"] = "1"
            outside = subprocess.run(
                ["bash", str(helper), "b" * 40],
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertNotEqual(outside.returncode, 0)

    def test_explicit_uat_sha_is_checked_before_selection_completes(self):
        root = Path(__file__).resolve().parents[2]
        caller = (root / ".github/workflows/deploy-uat.yml").read_text()
        workflow = (root / ".github/workflows/deploy-uat-implementation.yml").read_text()
        selection = workflow.split('if ! [[ "$REQUESTED_SHA"', 1)[1]
        selection = selection.split('echo "sha=$REQUESTED_SHA"', 1)[0]

        checkout = workflow.split("- name: Checkout code", 1)[1].split(
            "\n      - name:", 1
        )[0]
        self.assertIn("fetch-depth: 0", checkout)
        self.assertIn("promotion_approval.py uat", selection)
        self.assertIn(
            "run-name: UAT · source ${{ inputs.source_branch || 'uat' }} · app ${{ inputs.sha || 'unselected' }}",
            caller,
        )
        self.assertIn('--application-sha "$REQUESTED_SHA"', selection)
        self.assertIn(
            "Source authority: \\`${{ steps.application-authority.outputs.branch }}\\`",
            workflow,
        )


class ExactUatAttemptTest(unittest.TestCase):
    def test_unit_coverage_requires_complete_exact_shards_and_keeps_historical_receipts(self):
        candidate, base = "a" * 40, "b" * 40
        run = _attempt_run(candidate)
        original = _attempt_jobs(candidate, base)
        unit = next(job for job in original if job["name"] == "Web Unit Contracts")
        others = [job for job in original if job is not unit]

        def verify(legs, *, current=True, isolated=""):
            jobs = others + legs
            api = _AttemptAPI(run, jobs, [run], _attempt_check(candidate))
            subject._verify_run_jobs(api, run, candidate, base, 123, 1,
                                     current=current, isolated_candidate=isolated)

        def leg(shard):
            result = copy.deepcopy(unit)
            result["name"] = f"Web Unit Contracts ({shard})"
            result["steps"][-1]["name"] = f"Verify unit shard ({shard})"
            return result

        verify([unit])
        verify([leg("1/1")])
        complete = [leg(shard) for shard in ("1/3", "2/3", "3/3")]
        verify(complete)
        old = copy.deepcopy(unit)
        old["steps"] = []
        historical_workflow = ('  web-full-suite-check:\n    name: "Web Unit Contracts"\n'
                               '    steps:\n      - env:\n          WEB_FULL_SUITE_SHARD: ""\n')
        with patch.object(subject, "git", return_value=historical_workflow.encode()) as observed:
            verify([old], current=False)
            observed.assert_called_once_with("show", f"{candidate}:.github/workflows/ci.yml")
        decorated_without_marker = {**old, "name": "Web Unit Contracts (1/1)"}
        with patch.object(subject, "git", return_value=historical_workflow.encode()) as observed:
            with self.assertRaises(subject.Refused):
                verify([decorated_without_marker], current=False)
            observed.assert_not_called()
        with patch.object(subject, "git", return_value=(historical_workflow + "    strategy: {}\n").encode()):
            with self.assertRaises(subject.Refused):
                verify([old], current=False)
        cases = [[], [old], complete[:2], [leg("1/3")] * 3,
                 [leg("1/1"), leg("2/3"), leg("3/3")], [leg("4/4")]]
        mismatched = copy.deepcopy(complete)
        mismatched[0]["name"], mismatched[1]["name"] = mismatched[1]["name"], mismatched[0]["name"]
        cases.extend([mismatched, [unit, *complete], [leg("1/1"), leg("4/4")]])
        for field, value in (("run_id", 999), ("head_sha", "c" * 40),
                             ("status", "in_progress"), ("conclusion", "cancelled")):
            bad = copy.deepcopy(complete)
            bad[1][field] = value
            cases.append(bad)
        for steps in (
            [{"name": "Verify unit shard (1/1)", "conclusion": "success"}],
            [{"name": "Run affected unit contracts", "conclusion": "failure"},
             {"name": "Verify unit shard (1/1)", "conclusion": "success"}],
            unit["steps"] + [unit["steps"][-1]],
        ):
            bad = copy.deepcopy(unit)
            bad["steps"] = steps
            cases.append([bad])
        for legs in cases:
            with self.subTest(legs=legs), self.assertRaises(subject.Refused):
                verify(legs)
        # Each isolated shard must prepare the same exact application, too.
        with self.assertRaises(subject.Refused):
            subject._verify_unit_jobs(complete, candidate, 123, current=True,
                                      isolated_candidate="d" * 40)
        for job in complete:
            job["steps"].insert(0, {"name": "Prepare isolated UAT source", "conclusion": "success"})
        subject._verify_unit_jobs(complete, candidate, 123, current=True,
                                  isolated_candidate="d" * 40)

    def test_exact_attempt_requires_complete_current_run_and_canonical_gates(self):
        candidate, base = "a" * 40, "b" * 40
        run = _attempt_run(candidate)
        jobs = _attempt_jobs(candidate, base)
        exact = next(
            job
            for job in jobs
            if job["name"] in {"Exact UAT Candidate", f"Exact UAT Candidate ({base})"}
        )
        database = next(job for job in jobs if job["name"] == "Protocol Database (1/2)")
        runs = [run]
        check = _attempt_check(candidate)

        api = _AttemptAPI(run, jobs, runs, check)
        self.assertEqual(
            subject.verify_attempt(api, candidate, base, 123, 1)["run_attempt"], 1
        )
        # Full application qualification may intentionally omit unaffected native lanes.
        for name in ("iOS Native (Xcode)", "Android Native (Gradle)"):
            native = next(job for job in jobs if job["name"] == name)
            original = native["conclusion"]
            native["conclusion"] = "skipped"
            subject.verify_attempt(api, candidate, base, 123, 1)
            for failure in ("failure", "cancelled"):
                native["conclusion"] = failure
                with self.assertRaises(subject.Refused):
                    subject.verify_attempt(api, candidate, base, 123, 1)
            native["conclusion"] = original
        self._assert_clock_anomaly_requires_single_run(api, candidate, base, run, runs)
        with self.assertRaises(subject.Refused):
            subject.verify_attempt(api, candidate, "d" * 40, 123, 1)
        exact["conclusion"] = "cancelled"
        with self.assertRaises(subject.Refused):
            subject.verify_attempt(api, candidate, base, 123, 1)
        exact["conclusion"] = "success"
        database["head_sha"] = "c" * 40
        with self.assertRaises(subject.Refused):
            subject.verify_attempt(api, candidate, base, 123, 1)
        database["head_sha"] = candidate
        database["conclusion"] = "skipped"
        with self.assertRaises(subject.Refused):
            subject.verify_attempt(api, candidate, base, 123, 1)
        database["conclusion"] = "success"
        for bad_check in (
            {"id": 15368, "slug": "not-actions"},
            {"id": 1, "slug": "github-actions"},
        ):
            check["app"] = bad_check
            with self.assertRaises(subject.Refused):
                subject.verify_attempt(api, candidate, base, 123, 1)
        check["app"] = {"id": 15368, "slug": "github-actions"}
        check["check_suite"] = {"id": 78}
        with self.assertRaises(subject.Refused):
            subject.verify_attempt(api, candidate, base, 123, 1)
        check["check_suite"] = {"id": 77}
        run["run_attempt"] = 2
        with self.assertRaises(subject.Refused):
            subject.verify_attempt(api, candidate, base, 123, 1)
        run["run_attempt"] = 1
        self._assert_inventory_attempt_advancement_refuses(api, candidate, base, run, runs)
        self._assert_later_failed_runs_refuse(api, candidate, base, run, runs)

    def _assert_inventory_attempt_advancement_refuses(self, api, candidate, base, run, runs):
        runs[:] = [{**run, "run_attempt": 2}]
        read = api.read

        def stale_run_endpoint(path):
            if path.endswith("/actions/runs/123"):
                return dict(run)
            return read(path)

        with patch.object(api, "read", side_effect=stale_run_endpoint):
            for current in (True, False):
                with self.assertRaises(subject.Refused):
                    subject.verify_attempt(api, candidate, base, 123, 1, current=current)
        runs[:] = [run]

    def _assert_clock_anomaly_requires_single_run(self, api, candidate, base, run, runs):
        started, updated = run["run_started_at"], run["updated_at"]
        run.update(run_started_at="2026-11-01T09:36:17Z", updated_at="2026-11-01T09:10:39Z")
        self.assertEqual(subject.verify_attempt(api, candidate, base, 123, 1)["run_attempt"], 1)
        read = api.read

        def incomplete_inventory(path):
            result = read(path)
            if "/workflows/ci.yml/runs?" in path:
                return {**result, "total_count": 2}
            return result

        with patch.object(api, "read", side_effect=incomplete_inventory):
            with self.assertRaisesRegex(subject.Refused, "run inventory is incomplete"):
                subject.verify_attempt(api, candidate, base, 123, 1)
        for inventory in ([], [{**run, "id": 124}]):
            runs[:] = inventory
            with self.assertRaises(subject.Refused):
                subject.verify_attempt(api, candidate, base, 123, 1)
        runs[:] = [run]
        runs.append({**run, "id": 122, "run_started_at": started, "updated_at": updated})
        with self.assertRaisesRegex(subject.Refused, "CI chronology is invalid"):
            subject.verify_attempt(api, candidate, base, 123, 1)
        runs.pop()
        run.update(run_started_at=started, updated_at=updated)

    def _assert_later_failed_runs_refuse(self, api, candidate, base, run, runs):
        for status, conclusion in (("completed", "failure"), ("queued", None)):
            runs.append(
                {
                    **run,
                    "id": 124,
                    "status": status,
                    "conclusion": conclusion,
                    "run_started_at": "2026-10-28T00:01:00Z",
                    "updated_at": "2026-10-28T00:01:10Z",
                }
            )
            with self.subTest(status=status), self.assertRaises(subject.Refused):
                subject.verify_attempt(api, candidate, base, 123, 1)
            runs.pop()
        # A rerun with a smaller ID is still the most recent attempt.
        runs.append(
            {
                **run,
                "id": 122,
                "run_attempt": 2,
                "conclusion": "failure",
                "run_started_at": "2026-10-28T00:02:00Z",
                "updated_at": "2026-10-28T00:02:10Z",
            }
        )
        with self.assertRaises(subject.Refused):
            subject.verify_attempt(api, candidate, base, 123, 1)
        runs.pop()

    def test_historical_predecessor_keeps_pinned_integrity_without_electing_other_runs(self):
        candidate, base, tree = "a" * 40, "b" * 40, "e" * 40
        run = _attempt_run(candidate)
        runs = [run]
        api = _AttemptAPI(run, _attempt_jobs(candidate, base), runs, _attempt_check(candidate))
        prior = {"sha": candidate, "base_sha": base, "authority_sha": "c" * 40,
                 "tree": tree, "run_id": 123, "run_attempt": 1}
        with patch.object(subject, "GitHub", return_value=api), \
             patch.object(subject, "verify_git_authority", return_value=tree):
            for status in ("queued", "failure", "success"):
                runs[:] = [run, {**run, "id": 124, "status": "queued" if status == "queued" else "completed",
                                 "conclusion": None if status == "queued" else status,
                                 "run_started_at": "2026-10-28T00:01:00Z", "updated_at": "2026-10-28T00:01:10Z"}]
                subject.verify_predecessor(prior, current=False)
                with self.assertRaises(subject.Refused):
                    subject.verify_attempt(api, candidate, base, 123, 1)
            runs[:] = [{**run, "run_attempt": 2}]
            with self.assertRaises(subject.Refused):
                subject.verify_predecessor(prior, current=False)
            runs.clear()
            with self.assertRaises(subject.Refused):
                subject.verify_predecessor(prior, current=False)
            runs[:] = [run]
            run["conclusion"] = "failure"
            with self.assertRaises(subject.Refused):
                subject.verify_predecessor(prior, current=False)

    def test_static_name_requires_ordered_base_binding_and_dynamic_alias_is_compatible(self):
        candidate, base = "a" * 40, "b" * 40
        run = _attempt_run(candidate)
        runs = [run]
        check = _attempt_check(candidate)
        for exact_name in ("Exact UAT Candidate", f"Exact UAT Candidate ({base})"):
            jobs = _attempt_jobs(candidate, base, exact_name=exact_name)
            api = _AttemptAPI(run, jobs, runs, check)
            for current in (True, False):
                self.assertEqual(
                    subject.verify_attempt(api, candidate, base, 123, 1, current=current)[
                        "run_attempt"
                    ],
                    1,
                )

        unbound = _attempt_jobs(
            candidate, base, exact_name="Exact UAT Candidate", bind_static_base=False
        )
        api = _AttemptAPI(run, unbound, runs, check)
        for current in (True, False):
            with self.subTest(binding="missing", current=current), self.assertRaises(
                subject.Refused
            ):
                subject.verify_attempt(api, candidate, base, 123, 1, current=current)

        # Retained pre-policy receipts keep their old immutable inventory;
        # that exception cannot authorize a new current qualification.
        legacy_job = next(job for job in unbound if job["name"] == "Exact UAT Candidate")
        self.assertIs(
            subject._exact_candidate_job([legacy_job], base, allow_legacy_static=True),
            legacy_job,
        )

        for mutation in ("wrong_base", "duplicate", "late", "failed"):
            jobs = _attempt_jobs(candidate, base, exact_name="Exact UAT Candidate")
            exact = next(job for job in jobs if job["name"] == "Exact UAT Candidate")
            bound = next(
                step
                for step in exact["steps"]
                if step["name"] == f"Verify exact serving base ({base})"
            )
            if mutation == "wrong_base":
                bound["name"] = f"Verify exact serving base ({'d' * 40})"
            elif mutation == "duplicate":
                exact["steps"].append(dict(bound))
            elif mutation == "late":
                exact["steps"].remove(bound)
                exact["steps"].append(bound)
            else:
                bound["conclusion"] = "failure"
            api = _AttemptAPI(run, jobs, runs, check)
            with self.subTest(binding=mutation), self.assertRaises(subject.Refused):
                subject.verify_attempt(api, candidate, base, 123, 1)

        jobs = _attempt_jobs(candidate, base, exact_name="Exact UAT Candidate")
        historical = next(
            job
            for job in _attempt_jobs(candidate, base)
            if job["name"] == f"Exact UAT Candidate ({base})"
        )
        jobs.append(historical)
        api = _AttemptAPI(run, jobs, runs, check)
        with self.assertRaises(subject.Refused):
            subject.verify_attempt(api, candidate, base, 123, 1)


class ExactUatPartitionTest(unittest.TestCase):
    def test_full_targeted_coverage_preserves_partition(self):
        from web_ci_lane_fixture import ROOT, _run
        TARGETED = ROOT / "scripts/ci/web-targeted-check.sh"
        env = {"WEB_TARGETED_ALL_PACKS": "1", "WEB_TARGETED_FULL_SUITE_OWNED": "1",
               "WEB_TARGETED_CHANGED_FILES": "no/matching/path"}
        observed = {}
        for part, shard in (("all", ""), ("node", ""), *(('browser', f'{i}/4') for i in range(1, 5))):
            code, calls, output = _run(TARGETED, {**env, "WEB_TARGETED_PART": part,
                                                   "PLAYWRIGHT_SHARD": shard}, stub_diagrams=True)
            assert code == 0, output[-2000:]
            observed[(part, shard)] = calls
        all_calls, node = observed[("all", "")], observed[("node", "")]
        first = observed[("browser", "1/4")]
        assert node and first and sorted(node + first) == sorted(all_calls)
        assert not set(node) & set(first)
        for index in (2, 3, 4):
            other = observed[("browser", f"{index}/4")]
            assert sorted(other) == sorted(call for call in first if call not in {
                "scripts/verify-doc-diagrams.cjs", "scripts/render-doc-mermaid.mjs"})
        assert "scripts/observability/verify-android-scope.mjs" in node
        assert "scripts/testing/analytics-smoke-failure.test.mjs" in node
        code, calls, _ = _run(TARGETED, {"WEB_TARGETED_ALL_PACKS": "unexpected"})
        assert code == 2 and not calls


if __name__ == "__main__":
    unittest.main()
