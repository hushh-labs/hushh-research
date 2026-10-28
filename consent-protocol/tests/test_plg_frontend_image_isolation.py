"""Isolated PLG publication never mutates shared frontend image tags."""

from pathlib import Path

import pytest
import yaml

from tests.helpers.frontend_cloudbuild import _body, _run, _steps, _substitute

ROOT = Path(__file__).resolve().parents[2]
FRONTEND_IMAGE_BUILD = ROOT / "deploy/frontend-image.cloudbuild.yaml"


@pytest.mark.parametrize(
    "mode,environment,project,tag,allowed",
    [
        ("standard", "production", "hushh-pda", "normal-release", True),
        ("plg-w2-isolated", "dev", "hushh-pda-dev", "plg-w2-dev-123-2", True),
        ("plg-w2-isolated", "uat", "hushh-pda-uat", "plg-w2-uat-456-1", True),
        ("plg-w2-isolated", "dev", "hushh-pda-uat", "plg-w2-dev-123-2", False),
        ("plg-w2-isolated", "production", "hushh-pda", "plg-w2-production-123-2", False),
        ("plg-w2-isolated", "uat", "hushh-pda-uat", "latest", False),
        ("plg-w2-isolated", "uat", "hushh-pda-uat", "plg-w2-uat-0-2", False),
        ("plg-w2-isolated", "uat", "hushh-pda-uat", "plg-w2-uat-" + "1" * 20 + "-2", False),
        ("plg-w2-isolated", "uat", "hushh-pda-uat", "$(exit 99)", False),
        ("plg-w2-isolated", "uat", "hushh-pda-uat", "$(touch plg-injection-sentinel)", False),
        ("plg-w2-isolated", "uat", "hushh-pda-uat", "`touch plg-injection-sentinel`", False),
        ("plg-w2-isolated", "uat", "hushh-pda-uat", '"; touch plg-injection-sentinel; #', False),
        ("plg-w2-isolated", "uat", "hushh-pda-uat", "bad\n$(touch plg-injection-sentinel)", False),
        ("$(exit 99)", "uat", "hushh-pda-uat", "plg-w2-uat-1-1", False),
        ("plg-w2-isolated", "$(exit 99)", "hushh-pda-dev", "plg-w2-dev-1-1", False),
        ("plg-w2-isolated", "dev", "hushh-pda-dev", "plg-w2-dev-123-3", False),
        ("unknown", "dev", "hushh-pda-dev", "plg-w2-dev-123-2", False),
    ],
)
def test_frontend_image_publication_isolated_from_shared_tags(
    tmp_path, mode, environment, project, tag, allowed
):
    config = yaml.safe_load(FRONTEND_IMAGE_BUILD.read_text(encoding="utf-8"))
    values = {name: str(value) for name, value in config["substitutions"].items()}
    values.update(
        {
            "_IMAGE_PUBLISH_MODE": mode,
            "_DEPLOY_ENV": environment,
            "_APP_ENV": environment,
            "_IMAGE_TAG": tag,
        }
    )
    if tag == "plg-w2-dev-123-3":
        values["_APP_ENV"] = "production"
    body = _body(_steps(FRONTEND_IMAGE_BUILD)["build-frontend-image"])
    # Execute the real publication and buildx argument block with fake tools.
    segment = body[
        body.index('cache_tag="buildcache"') : body.index(
            "--build-arg NEXT_PUBLIC_FIREBASE_API_KEY"
        )
    ]
    segment = _substitute(segment, values).replace("$$", "$") + "source\n"
    capture = tmp_path / "build-args"
    guards = (
        "gcloud() { return 0; };\n"
        "docker() { "
        f'if [ "$1 $2" = "buildx build" ]; then printf "%s\\n" "$@" > "{capture.as_posix()}"; fi; '
        "return 0; };\n"
    )
    result = _run(
        "set -euo pipefail\n" + guards + segment, env={"PROJECT_ID": project}, cwd=tmp_path
    )
    assert (result.returncode == 0) is allowed, result.stdout + result.stderr
    assert not (tmp_path / "plg-injection-sentinel").exists()
    if not allowed:
        assert result.returncode != 99
        assert not capture.exists()
        return
    args = capture.read_text().splitlines()
    prefix = f"gcr.io/{project}/hushh-webapp:"
    tags = [args[i + 1] for i, arg in enumerate(args[:-1]) if arg == "-t"]
    if mode == "standard":
        assert tags == [prefix + "manual", prefix + "latest", prefix + tag]
        assert f"--cache-from=type=registry,ref={prefix}buildcache" in args
        assert f"--cache-to=type=registry,ref={prefix}buildcache,mode=max" in args
    else:
        assert tags == [prefix + tag]
        assert f"--cache-from=type=registry,ref={prefix}{tag}-cache" in args
        assert f"--cache-to=type=registry,ref={prefix}{tag}-cache,mode=max" in args
        assert "--platform=linux/amd64" in args
        assert "--metadata-file=/workspace/frontend-image-metadata.json" in args
