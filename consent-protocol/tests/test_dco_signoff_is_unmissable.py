"""The DCO remedy must be wired, not merely present.

`.githooks/prepare-commit-msg` exists, is tracked, and appends a `Signed-off-by`
line when one is missing. Its own comment says it is there "so the PR Validation /
DCO check never fails for a missing signoff again."

`core.hooksPath` was never set, so git never ran it. **78 of the 167 non-merge
commits** on this branch reached the remote with no signoff, the `CI Status Gate`
went red, every test lane was skipped rather than run, and the dev deploy refused
the SHA — all while the fix for it sat in the repository, tracked and correct and
never once invoked.

Four separate remedies for this already existed: `scripts/setup-hooks.sh`,
`consent-protocol/ops/monorepo/setup.sh`, `./bin/hushh protocol setup`, and a
`verify_setup` in `scripts/protocol/subtree.sh` that prints a red cross when the
hooks path is unset. Every one of them was correct. Every one of them required a
person to remember to run it. So a fifth document would have changed nothing, and
the wiring moved into the two places that execute on their own:

* `scripts/ci/orchestrate.sh` activates the tracked hooks — it is the standing
  pre-push gate, so it is the one thing that reliably runs before a push.
* `.githooks/pre-push` refuses to push an unsigned commit, so the CI gate stops
  being the first thing that notices.

That is the same defect this codebase keeps finding in itself: a component that
passes inspection and has never executed. This file checks the WIRING, not the
component, because the component was never the problem.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_HOOKS_DIR = _REPO / ".githooks"
_HOOK = _HOOKS_DIR / "prepare-commit-msg"
_PRE_PUSH = _HOOKS_DIR / "pre-push"
_ORCHESTRATE = _REPO / "scripts" / "ci" / "orchestrate.sh"
_DCO_CHECK = _REPO / "scripts" / "ci" / "check-dco-signoff.sh"


def _git(*args: str, cwd: Path | None = None) -> str:
    return subprocess.run(  # noqa: S603
        ["git", *args], cwd=cwd or _REPO, capture_output=True, text=True, check=False
    ).stdout.strip()


def _throwaway_repo(root: Path) -> None:
    """A real git repo with one real unsigned commit, isolated from this clone."""
    root.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "GIT_CONFIG_GLOBAL": str(root / ".gitconfig"), "HOME": str(root)}
    for args in (
        ["init", "--quiet", "-b", "main"],
        ["config", "user.name", "Probe"],
        ["config", "user.email", "probe@example.invalid"],
        # No commit.gpgsign, and deliberately no core.hooksPath: this stands in
        # for a fresh clone, which is exactly the state that produced the 78.
    ):
        subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, env=env)  # noqa: S603


def test_the_signoff_hook_exists_and_is_tracked() -> None:
    """An untracked hook protects exactly one clone — whoever happened to write it."""
    assert _HOOK.is_file(), "the DCO signoff hook is missing"
    tracked = _git("ls-files", ".githooks/prepare-commit-msg")
    assert tracked, "the hook is untracked, so no other clone can ever get it"


def test_the_hook_actually_appends_a_signoff(tmp_path: Path) -> None:
    """Run it. A hook that exists and does nothing is the worse failure, because it
    looks like protection."""
    message = tmp_path / "COMMIT_EDITMSG"
    message.write_text("feat(x): a change\n")

    subprocess.run(  # noqa: S603
        ["sh", str(_HOOK), str(message)],
        cwd=_REPO,
        check=True,
        capture_output=True,
        env=os.environ.copy(),
    )
    assert "Signed-off-by:" in message.read_text(), (
        "the hook ran and added no signoff — the remedy is inert"
    )


def test_the_hook_does_not_duplicate_this_committer_s_signoff(tmp_path: Path) -> None:
    """`git commit -s` already adds one for THIS identity; the hook must not add a
    second copy of the same line, or every message grows a duplicate.

    Note what this deliberately does NOT assert: that the hook leaves a message alone
    when it carries someone ELSE'S signoff. It appends in that case, and that is
    correct DCO semantics — each contributor attests separately, so a co-developed
    commit legitimately carries two. An earlier version of this test asserted the
    opposite and failed the hook for being right.
    """
    name = _git("config", "user.name")
    email = _git("config", "user.email")
    own = f"Signed-off-by: {name} <{email}>"

    message = tmp_path / "COMMIT_EDITMSG"
    message.write_text(f"feat(x): a change\n\n{own}\n")
    before = message.read_text()

    subprocess.run(  # noqa: S603
        ["sh", str(_HOOK), str(message)], cwd=_REPO, check=True, capture_output=True
    )
    assert message.read_text() == before, "the hook duplicated a signoff it had already added"


def test_the_local_gate_activates_the_tracked_hooks(tmp_path: Path) -> None:
    """The circularity-breaker, proven by running it rather than by reading it.

    A hook cannot install itself and a document cannot install it either, so the
    activation has to live in something that already runs unprompted.
    `scripts/ci/orchestrate.sh` is the standing pre-push gate, which makes it the
    only honest home for this.

    Driven inside a throwaway repo with `core.hooksPath` unset — the state a fresh
    clone is in, and the state that produced the unsigned history.
    """
    root = tmp_path / "clone"
    _throwaway_repo(root)
    (root / ".githooks").mkdir()
    (root / "scripts" / "ci").mkdir(parents=True)
    shutil.copy(_ORCHESTRATE, root / "scripts" / "ci" / "orchestrate.sh")

    assert _git("config", "--get", "core.hooksPath", cwd=root) == "", (
        "the fixture is meant to start with no hooks path"
    )

    # An unknown stage exits non-zero AFTER activation, which is the cheapest way
    # to reach it without running a whole CI lane.
    env = {k: v for k, v in os.environ.items() if k not in ("CI", "GITHUB_ACTIONS")}
    subprocess.run(  # noqa: S603
        ["bash", "scripts/ci/orchestrate.sh", "__probe__"],
        cwd=root,
        check=False,
        capture_output=True,
        env=env,
    )

    assert _git("config", "--get", "core.hooksPath", cwd=root) == ".githooks", (
        "the local gate ran and did not activate the tracked hooks — which is the "
        "whole mechanism, since every other remedy needed a human to remember it"
    )


def test_the_local_gate_leaves_ci_alone(tmp_path: Path) -> None:
    """CI checks out with no local config and legitimately has no hooks path.

    Writing git config on a runner would be pointless, and a gate that fails for a
    reason the runner cannot fix is a gate people learn to route around. So the
    activation must be a no-op there, and that is worth pinning rather than assuming.
    """
    root = tmp_path / "runner"
    _throwaway_repo(root)
    (root / ".githooks").mkdir()
    (root / "scripts" / "ci").mkdir(parents=True)
    shutil.copy(_ORCHESTRATE, root / "scripts" / "ci" / "orchestrate.sh")

    subprocess.run(  # noqa: S603
        ["bash", "scripts/ci/orchestrate.sh", "__probe__"],
        cwd=root,
        check=False,
        capture_output=True,
        env={**os.environ, "CI": "true", "GITHUB_ACTIONS": "true"},
    )

    assert _git("config", "--get", "core.hooksPath", cwd=root) == "", (
        "the gate wrote git config on a CI runner, where it means nothing"
    )


def test_the_dco_check_actually_fails_on_an_unsigned_commit(tmp_path: Path) -> None:
    """The decision function the pre-push hook calls, exercised against a real
    unsigned commit in a real repo — not a string match on its source."""
    root = tmp_path / "unsigned"
    _throwaway_repo(root)
    env = {**os.environ, "GIT_CONFIG_GLOBAL": str(root / ".gitconfig"), "HOME": str(root)}

    (root / "a.txt").write_text("one\n")
    subprocess.run(["git", "add", "."], cwd=root, check=True, capture_output=True, env=env)  # noqa: S603
    subprocess.run(  # noqa: S603
        ["git", "commit", "--quiet", "-m", "base"],
        cwd=root,
        check=True,
        capture_output=True,
        env=env,
    )
    base = subprocess.run(  # noqa: S603
        ["git", "rev-parse", "HEAD"], cwd=root, check=True, capture_output=True, text=True, env=env
    ).stdout.strip()

    (root / "a.txt").write_text("two\n")
    subprocess.run(["git", "add", "."], cwd=root, check=True, capture_output=True, env=env)  # noqa: S603
    subprocess.run(  # noqa: S603
        ["git", "commit", "--quiet", "-m", "no signoff here"],
        cwd=root,
        check=True,
        capture_output=True,
        env=env,
    )

    unsigned = subprocess.run(  # noqa: S603
        ["bash", str(_DCO_CHECK), base, "HEAD"], cwd=root, capture_output=True, text=True, env=env
    )
    assert unsigned.returncode != 0, (
        "the DCO check passed a commit with no signoff — every gate above it is decorative"
    )

    subprocess.run(  # noqa: S603
        ["git", "commit", "--quiet", "--amend", "-s", "--no-edit"],
        cwd=root,
        check=True,
        capture_output=True,
        env=env,
    )
    signed = subprocess.run(  # noqa: S603
        ["bash", str(_DCO_CHECK), base, "HEAD"], cwd=root, capture_output=True, text=True, env=env
    )
    assert signed.returncode == 0, (
        f"the DCO check refused a properly signed commit: {signed.stdout}{signed.stderr}"
    )


def test_pre_push_refuses_unsigned_commits_before_they_reach_the_remote() -> None:
    """Run the hook against this repo's own unsigned history.

    The CI `dco-check` is correct and fires on `pull_request` — after the commits
    are written, when the only remedy left is rewriting published history. This
    moves the same check to the last moment it is still cheap.

    Scoped to commits NEW in the push, deliberately: a check over the whole branch
    would refuse every future push over already-published history that cannot be
    signed without a rewrite, and a gate that can never go green gets disabled.
    """
    base = _git("rev-parse", "origin/main")
    head = _git("rev-parse", "HEAD")
    if not base or not head:
        import pytest  # noqa: PLC0415

        pytest.skip("no origin/main in this checkout")

    unsigned = subprocess.run(  # noqa: S603
        ["bash", str(_DCO_CHECK), base, head], cwd=_REPO, capture_output=True, text=True
    )
    if unsigned.returncode == 0:
        import pytest  # noqa: PLC0415

        # Good news, not a failure: the branch is fully signed. The refusal path is
        # covered against a synthetic repo by the test above regardless.
        pytest.skip("this branch carries no unsigned commits to drive the refusal with")

    refused = subprocess.run(  # noqa: S603
        ["sh", str(_PRE_PUSH), "origin", "git@example.invalid:x/y.git"],
        cwd=_REPO,
        input=f"refs/heads/probe {head} refs/heads/probe {base}\n",
        capture_output=True,
        text=True,
    )
    assert refused.returncode != 0, (
        "pre-push accepted unsigned commits; CI would be the first thing to notice, "
        "by which point the remedy is a history rewrite"
    )
    assert "Refusing to push unsigned commits" in refused.stderr, (
        "pre-push failed without saying why, which teaches people to use the override"
    )

    allowed = subprocess.run(  # noqa: S603
        ["sh", str(_PRE_PUSH), "origin", "git@example.invalid:x/y.git"],
        cwd=_REPO,
        input=f"refs/heads/probe {head} refs/heads/probe {base}\n",
        capture_output=True,
        text=True,
        env={**os.environ, "HUSSH_ALLOW_UNSIGNED_PUSH": "1"},
    )
    assert "Refusing to push unsigned commits" not in allowed.stderr, (
        "the documented override does not work, so the only way past a false "
        "positive is deleting the hook"
    )


def test_the_repo_documents_how_to_activate_the_hooks() -> None:
    """The gap was never the hook. It was that nothing told anyone to point git at it.

    `core.hooksPath` is per-clone local config that git deliberately will not set from
    a checked-in file — so beyond the automatic activation above, the contract a human
    or an agent reads on arrival still has to say it.
    """
    contract = (_REPO / "CLAUDE.md").read_text()
    assert "core.hooksPath" in contract, (
        "nothing in CLAUDE.md tells a new clone to activate .githooks, which is "
        "precisely how 78 commits shipped without a signoff"
    )


def test_this_checkout_has_the_hooks_activated() -> None:
    """Reports on the working clone rather than asserting against it.

    A hard failure here would break CI, which checks out with no local config and
    legitimately has no hooks path — and a gate that fails for a reason the runner
    cannot fix is a gate people learn to ignore. So this asserts nothing about CI and
    surfaces the state for a human clone.
    """
    configured = _git("config", "--get", "core.hooksPath")
    if not configured:
        print(  # noqa: T201 - deliberate operator-facing signal
            "\nNOTE: core.hooksPath is unset in this clone. Run:\n"
            "    bash scripts/ci/orchestrate.sh protocol   # activates it, or\n"
            "    git config core.hooksPath .githooks\n"
            "Without it the DCO signoff hook never runs, which is how this branch "
            "accumulated 78 unsigned commits.",
            file=sys.stderr,
        )
    assert configured in ("", ".githooks"), (
        f"core.hooksPath points somewhere unexpected ({configured!r}); the tracked "
        "hooks in .githooks are not the ones running"
    )
