# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Fake exact Cloud Run job IAM transport for UAT installer tests."""

import copy


class FakeCloudCLI:
    """Callable gcloud stand-in with explicit one-shot mutation timeouts."""

    def __init__(self, state, calls, resources, **options):
        self.state = state
        self.calls = calls
        self.resources = resources
        self.options = options

    def __call__(self, args, *, optional=False):
        self.calls.append(tuple(args))
        if args[:2] == ["projects", "describe"]:
            return {"projectNumber": "123"}
        if args[:3] == ["iam", "service-accounts", "describe"]:
            email = args[3]
            return {
                "email": email,
                "projectId": self.options["project"],
                "uniqueId": self.options["checker_id"]
                if email == self.options["checker_email"]
                else self.options["clock_id"],
                "description": f"Hussh auth-health operation {self.options['operation']}",
            }
        if args[:3] == ["iam", "roles", "describe"]:
            return {
                "includedPermissions": [
                    "secretmanager.versions.list",
                    "secretmanager.versions.access",
                ]
            }
        if args[:2] == ["projects", "get-iam-policy"]:
            return self.resources["project_policy"]
        if args[:3] == ["storage", "buckets", "get-iam-policy"]:
            return self.resources["role_policy"]
        if args[:2] == ["secrets", "get-iam-policy"]:
            if self.options["denied_secret_binding"]:
                return {"bindings": []}
            return {
                "bindings": [
                    {
                        "role": self.options["role"],
                        "members": [f"serviceAccount:{self.options['checker_email']}"],
                    }
                ]
            }
        if args[:3] == ["run", "services", "get-iam-policy"]:
            return {
                "bindings": [
                    {
                        "role": "roles/run.viewer",
                        "members": [f"serviceAccount:{self.options['checker_email']}"],
                    }
                ]
            }
        if args[:2] == ["builds", "list"]:
            return [self.resources["build"]]
        if args[:2] == ["builds", "describe"]:
            return copy.deepcopy(self.resources["build"])
        if args[:2] == ["run", "jobs"]:
            return self._job(args, optional)
        if args[:3] in (
            ["scheduler", "jobs", "create"],
            ["scheduler", "jobs", "resume"],
        ):
            return self._scheduler(args)
        if args[:2] == ["logging", "read"]:
            return self.resources["events"]
        raise AssertionError(args)

    def _job(self, args, optional):
        if args[:4] == ["run", "jobs", "executions", "describe"]:
            return self.resources["execution"]
        if args[:4] == ["run", "jobs", "describe", self.options["job_name"]]:
            if self.state.pop("job_readback_timeout_once", False):
                raise self.options["timeout_error"]()
            if self.state["job"] is None and optional:
                return None
            return self.state["job"] or self.resources["job"]
        if args[:4] == ["run", "jobs", "create", self.options["job_name"]]:
            deploy_error = self.options["deploy_error"]
            if deploy_error:
                if deploy_error == "timeout-unapplied":
                    raise self.options["timeout_error"]()
                self.state["job"] = self.resources["job"]
                if deploy_error == "timeout-readback":
                    self.state["job_readback_timeout_once"] = True
                if str(deploy_error).startswith("timeout-"):
                    raise self.options["timeout_error"]()
                raise RuntimeError("Cloud operation refused")
            self.state["job"] = self.resources["job"]
            return {}
        raise AssertionError(args)

    def _scheduler(self, args):
        create_error = self.state["create_error"]
        if args[:3] == ["scheduler", "jobs", "create"]:
            if create_error:
                if (
                    create_error in {"lost", "timeout-applied", "timeout-readback"}
                    and self.state["timer"] is None
                ):
                    self.state["timer"] = self.options["scheduler_resource"]("ENABLED")
                if create_error == "timeout-readback":
                    self.state["timer_readback_timeout_once"] = True
                if str(create_error).startswith("timeout-"):
                    raise self.options["timeout_error"]()
                raise RuntimeError("Cloud operation refused")
            self.state["timer"] = self.options["scheduler_resource"]("ENABLED")
            return {}
        resume_error = self.options["resume_error"]
        if resume_error:
            if resume_error in {"timeout-applied", "timeout-readback"}:
                self.state["timer"] = self.options["scheduler_resource"]("ENABLED")
            if resume_error == "timeout-readback":
                self.state["timer_readback_timeout_once"] = True
            if str(resume_error).startswith("timeout-"):
                raise self.options["timeout_error"]()
            raise RuntimeError("Cloud operation refused")
        self.state["timer"] = self.options["scheduler_resource"]("ENABLED")
        return {}


class Response:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return copy.deepcopy(self._payload)


class FakeIAMAPI:
    def __init__(self, state, calls, invoker_error, *, project, region, job):
        self.state = state
        self.calls = calls
        self.invoker_error = invoker_error
        self.project = project
        self.region = region
        self.job = job

    def get(self, url, *, params, timeout, allow_redirects):
        assert url == (
            f"https://run.googleapis.com/v2/projects/{self.project}/locations/"
            f"{self.region}/jobs/{self.job}:getIamPolicy"
        )
        assert params == {"options.requestedPolicyVersion": 3}
        assert timeout == 30 and allow_redirects is False
        self.calls.append(("iam:get", url))
        if self.state["invoker_readback_error"] and self.state["invoker_set_attempted"]:
            raise OSError("private marker")
        return Response(200, self.state["job_policy"])

    def post(self, url, *, json, timeout, allow_redirects):
        assert url == (
            f"https://run.googleapis.com/v2/projects/{self.project}/locations/"
            f"{self.region}/jobs/{self.job}:setIamPolicy"
        )
        assert timeout == 30 and allow_redirects is False
        policy = copy.deepcopy(json["policy"])
        assert policy["etag"] == self.state["job_policy"]["etag"]
        self.calls.append(("iam:set", url, copy.deepcopy(json)))
        self.state["invoker_set_attempted"] = True
        if self.invoker_error == "denied":
            return Response(403, {})
        self.state["job_policy"] = policy
        self.state["job_policy"]["etag"] = "policy-etag-2"
        if self.invoker_error == "lost":
            raise OSError("private marker")
        return Response(200, self.state["job_policy"])

    def close(self):
        return None
