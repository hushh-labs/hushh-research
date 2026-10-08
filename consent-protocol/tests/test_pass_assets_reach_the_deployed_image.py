"""Guard: runtime assets must survive the Cloud Build upload filter.

This exists because they did not. The pass icon lived in
`hushh_mcp/services/assets/`, which is committed to git and copied by the
Dockerfile's `COPY . .` — so every local check passed. The repo-root
`.gcloudignore` excludes `assets/` for the frontend's large media, and
gitignore semantics match a bare directory name at **any depth**, so the file
was stripped from the build context before the image was built.

The failure was invisible in the worst way: the signing service substitutes its
own placeholder image, so passes kept returning 200 and only looked wrong on a
device. A `FileNotFoundError` in a log line was the only signal.

A negation cannot fix that class of bug — gitignore will not re-include a file
inside an excluded directory — so the contract is that no runtime asset path may
contain a segment matching an ignored directory.
"""

from __future__ import annotations

from pathlib import Path

import pathspec
import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = Path(__file__).resolve().parents[1]

# Every non-Python file the backend reads at runtime. Add to this list whenever
# a service starts depending on a shipped asset.
RUNTIME_ASSETS = (BACKEND_ROOT / "hushh_mcp" / "services" / "pass_assets" / "hushh_pass_icon.png",)

IGNORE_FILES = (
    REPO_ROOT / ".gcloudignore",
    BACKEND_ROOT / ".gcloudignore",
    BACKEND_ROOT / ".dockerignore",
)


@pytest.mark.parametrize("ignore_file", IGNORE_FILES, ids=lambda p: str(p.relative_to(REPO_ROOT)))
def test_manifest_prompts_survive_each_build_context_filter(ignore_file: Path) -> None:
    """The October 7 image failed because upload stripped prompts before Docker."""
    patterns = ignore_file.read_text(encoding="utf-8").splitlines()
    spec = pathspec.GitIgnoreSpec.from_lines(patterns)
    agents = BACKEND_ROOT / "hushh_mcp" / "agents"
    prompts = set()
    for manifest in agents.rglob("agent.yaml"):
        reference = yaml.safe_load(manifest.read_text(encoding="utf-8")).get("prompt_reference")
        if reference:
            prompt = (manifest.parent / reference).resolve()
            assert prompt.is_relative_to(agents)
            assert prompt.is_file()
            prompts.add(prompt)
    assert prompts, "The fixture must exercise actual authored prompt references"
    for prompt in prompts:
        relative = prompt.relative_to(ignore_file.parent).as_posix()
        assert not spec.match_file(relative), f"{ignore_file} removes runtime prompt {relative}"
    # Negative control: the historical broad exclusion removes those same files.
    broken = pathspec.GitIgnoreSpec.from_lines(["*.md"])
    assert all(broken.match_file(p.relative_to(ignore_file.parent).as_posix()) for p in prompts)


def _ignored_directory_names(ignore_file: Path) -> set[str]:
    """Bare directory patterns, which gitignore matches at any depth."""
    if not ignore_file.exists():
        return set()
    names: set[str] = set()
    for raw in ignore_file.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("!"):
            continue
        if not line.endswith("/"):
            continue
        candidate = line.rstrip("/")
        # Anchored or nested patterns only match where they are written.
        if "/" in candidate or candidate.startswith("*"):
            continue
        names.add(candidate)
    return names


@pytest.mark.parametrize("asset", RUNTIME_ASSETS, ids=lambda p: p.name)
def test_the_asset_exists_in_the_repository(asset: Path) -> None:
    assert asset.is_file(), f"{asset} is missing from the repository"
    assert asset.stat().st_size > 0


@pytest.mark.parametrize("asset", RUNTIME_ASSETS, ids=lambda p: p.name)
@pytest.mark.parametrize("ignore_file", IGNORE_FILES, ids=lambda p: p.name)
def test_no_ignored_directory_name_appears_in_a_runtime_asset_path(
    asset: Path, ignore_file: Path
) -> None:
    """The exact bug: a path segment matching a bare `dir/` pattern."""
    ignored = _ignored_directory_names(ignore_file)
    if not ignored:
        pytest.skip(f"{ignore_file.name} declares no bare directory patterns")

    segments = set(asset.relative_to(REPO_ROOT).parts[:-1])
    collisions = segments & ignored
    assert not collisions, (
        f"{asset.relative_to(REPO_ROOT)} sits under {sorted(collisions)}, which "
        f"{ignore_file.name} excludes at any depth. The file would be stripped "
        f"from the build context and the service would fall back to a "
        f"placeholder at runtime. Rename the directory — a '!' negation cannot "
        f"re-include a file inside an excluded directory."
    )


def test_the_icon_loader_points_at_a_real_file() -> None:
    """The loader swallows a missing asset by design; assert it is not missing."""
    from hushh_mcp.services import hushh_wallet_api_client as client

    assert client._ICON_SOURCE.is_file(), (
        f"{client._ICON_SOURCE} does not exist; every pass would ship the "
        f"signing service's placeholder image"
    )


def test_every_apple_image_slot_is_produced_from_the_real_asset() -> None:
    from hushh_mcp.services import hushh_wallet_api_client as client

    client._icon_images.cache_clear()
    images = client._icon_images()

    assert images, "no images produced — the pass would use placeholders"
    assert set(images) == {
        "icon.png",
        "icon@2x.png",
        "icon@3x.png",
        "logo.png",
        "logo@2x.png",
        "logo@3x.png",
    }
