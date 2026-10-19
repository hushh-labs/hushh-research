"""The retention job must not erase a live verification worktree or its dependencies."""

import os
import shutil
import subprocess
import time
from pathlib import Path


def test_tmp_cleanup_preserves_registered_worktree_and_ignored_files(tmp_path):
    source = Path(__file__).resolve().parents[2] / "scripts/maintenance/clean_tmp.sh"
    repo = tmp_path / "hushh-research"
    scripts = repo / "scripts/maintenance"
    scripts.mkdir(parents=True)
    script = scripts / "clean_tmp.sh"
    shutil.copyfile(source, script)

    def git(*args):
        subprocess.run(  # noqa: S603 - fixed Git commands in the disposable fixture
            ["git", "-C", str(repo), *args], check=True, capture_output=True
        )

    git("init", "-q")
    git("add", "scripts")
    git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "fixture",
    )
    scratch = repo / "tmp"
    scratch.mkdir()
    worktree = scratch / "active verification"
    git("worktree", "add", "--detach", str(worktree), "HEAD")
    dependency = worktree / ".venv/lib/fixture.py"
    dependency.parent.mkdir(parents=True)
    dependency.write_text("preserve\n")
    bytecode = worktree / ".venv/lib/__pycache__/fixture.pyc"
    bytecode.parent.mkdir()
    bytecode.write_bytes(b"preserve")
    empty = worktree / "empty"
    empty.mkdir()
    expired = scratch / "expired.txt"
    expired.write_text("remove\n")
    old = time.time() - 10 * 86400
    for path in [dependency, bytecode, expired, worktree / "scripts/maintenance/clean_tmp.sh"]:
        os.utime(path, (old, old))

    subprocess.run(  # noqa: S603 - repository script copied into the disposable fixture
        ["bash", str(script)], check=True, capture_output=True
    )

    assert dependency.read_text() == "preserve\n"
    assert bytecode.read_bytes() == b"preserve"
    assert empty.is_dir()
    assert (worktree / "scripts/maintenance/clean_tmp.sh").is_file()
    assert not expired.exists()  # Negative control: cleanup itself still runs.
