---
title: Contributor Onboarding Guide
description: Step-by-step guide for new contributors to Hushh Labs
---

## Visual Context

This guide is for **new contributors** to the Hushh Labs `hushh-research` repository. It provides complete, step-by-step instructions for:
- Setting up Git and GitHub
- Forking and cloning the repository
- Creating branches and commits
- Submitting and responding to Pull Requests

**Target Audience:** First-time open source contributors, developers new to Git workflow

**Visual Owner:** @hushh-labs/documentation-team

---

# Contributor Onboarding Guide

Welcome to **Hushh Labs**! 🤫 This guide walks you through everything you need to make your first contribution to `hushh-research` — from forking the repository to getting your Pull Request merged.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Understanding the Workflow](#understanding-the-workflow)
- [Step 1: Fork the Repository](#step-1-fork-the-repository)
- [Step 2: Clone Your Fork](#step-2-clone-your-fork)
- [Step 3: Add Upstream Remote](#step-3-add-upstream-remote)
- [Step 4: Sync With Latest Code](#step-4-sync-with-latest-code)
- [Step 5: Create a Feature Branch](#step-5-create-a-feature-branch)
- [Step 6: Make Your Changes](#step-6-make-your-changes)
- [Step 7: Commit Your Changes](#step-7-commit-your-changes)
- [Step 8: Push to Your Fork](#step-8-push-to-your-fork)
- [Step 9: Open a Pull Request](#step-9-open-a-pull-request)
- [Step 10: Address Review Feedback](#step-10-address-review-feedback)
- [Commit Message Conventions](#commit-message-conventions)
- [Where to Contribute](#where-to-contribute)
- [Key Terms Glossary](#key-terms-glossary)
- [Quick Reference](#quick-reference)
- [Best Practices](#best-practices)

---

## Prerequisites

Before you start, ensure you have:

- **GitHub Account** — [Sign up free](https://github.com/signup)
- **Git installed** — [Download here](https://git-scm.com/downloads)
- **Node.js v18+** (for frontend/webapp changes) — [Download here](https://nodejs.org/)
- **Python 3.10+** (for backend/consent-protocol changes) — [Download here](https://www.python.org/)
- **VS Code** (recommended) — [Download here](https://code.visualstudio.com/)

**Verify Git is installed:**

```bash
git --version
```

You should see output like: `git version 2.40.0`

---

## Understanding the Workflow

Here's what you're about to do:

```
┌──────────────┐
│ 1. FORK      │  Create a personal copy on GitHub
└──────┬───────┘
       │
┌──────▼───────┐
│ 2. CLONE     │  Download to your computer
└──────┬───────┘
       │
┌──────▼───────┐
│ 3. SYNC      │  Pull latest changes from Hushh's repo
└──────┬───────┘
       │
┌──────▼───────┐
│ 4. BRANCH    │  Create isolated workspace for your changes
└──────┬───────┘
       │
┌──────▼───────┐
│ 5. EDIT      │  Make changes to files
└──────┬───────┘
       │
┌──────▼───────┐
│ 6. COMMIT    │  Save snapshot with clear message
└──────┬───────┘
       │
┌──────▼───────┐
│ 7. PUSH      │  Upload to your GitHub fork
└──────┬───────┘
       │
┌──────▼───────┐
│ 8. PR        │  Ask Hushh to merge your changes
└──────────────┘
```

---

## Step 1: Fork the Repository

**What is a fork?**

A fork is a complete copy of the Hushh repository under your GitHub account. You make changes here without affecting the original.

**How to fork:**

1. Go to [hushh-labs/hushh-research](https://github.com/hushh-labs/hushh-research)
2. Click the **Fork** button in the top-right corner
3. GitHub will create a copy at `https://github.com/YOUR_USERNAME/hushh-research`

Wait for the fork to complete (usually takes a few seconds).

---

## Step 2: Clone Your Fork

**What is a clone?**

A clone downloads your forked repository to your computer so you can edit files locally.

**How to clone:**

Open PowerShell (Windows) or Terminal (macOS/Linux):

```bash
git clone https://github.com/YOUR_USERNAME/hushh-research.git
cd hushh-research
```

Replace `YOUR_USERNAME` with your actual GitHub username (e.g., `mohammedsahith450-cpu`).

**Verify it worked:**

```bash
git status
```

You should see: `On branch main` and `Your branch is up to date`

---

## Step 3: Add Upstream Remote

**What is upstream?**

Upstream is the official Hushh repository. You use it to stay synced with the latest changes while you work.

**How to add it:**

```bash
git remote add upstream https://github.com/hushh-labs/hushh-research.git
```

**Verify both remotes exist:**

```bash
git remote -v
```

You should see:
```
origin    https://github.com/YOUR_USERNAME/hushh-research.git (fetch)
origin    https://github.com/YOUR_USERNAME/hushh-research.git (push)
upstream  https://github.com/hushh-labs/hushh-research.git (fetch)
upstream  https://github.com/hushh-labs/hushh-research.git (push)
```

- `origin` = your fork (where you push)
- `upstream` = official repo (where you pull updates)

---

## Step 4: Sync With Latest Code

Before starting work, pull the latest changes:

```bash
git fetch upstream
git rebase upstream/main
```

This ensures you're working with the newest code and avoids merge conflicts.

---

## Step 5: Create a Feature Branch

**What is a branch?**

A branch is an isolated workspace. You make changes here without affecting the main code.

**Naming convention:**

- Documentation: `docs/description-of-change`
- Bug fix: `fix/description-of-bug`
- Feature: `feature/description-of-feature`
- Refactor: `refactor/description-of-refactor`

**Create your branch:**

```bash
git checkout -b docs/contributor-onboarding-guide
```

**Examples:**

```bash
git checkout -b docs/add-api-documentation
git checkout -b fix/vault-unlock-passphrase-bug
git checkout -b feature/add-consent-token-validation
```

**Verify you're on the new branch:**

```bash
git branch
```

You should see a `*` next to your new branch name.

---

## Step 6: Make Your Changes

Open your code editor and edit files:

```bash
code .
```

This opens VS Code in your repository.

### For Documentation Changes:

- Write clear, concise explanations
- Use **markdown** formatting (`.md` files)
- Include code examples where helpful
- Link to related documentation
- Check spelling and grammar

### For Code Changes:

- Follow the project's existing code style
- Add comments for complex logic
- Test your changes locally
- Don't include large unrelated changes

---

## Step 7: Commit Your Changes

After editing files, save your work with a commit:

```bash
git add .
git commit -m "docs: add contributor onboarding guide"
```

**Commit message format:**

```
<type>: <short description>
```

**Types:**
- `docs:` — Documentation changes
- `fix:` — Bug fixes
- `feat:` — New features
- `refactor:` — Code cleanup (no functionality change)
- `test:` — Test additions or fixes
- `chore:` — Build, dependencies, etc.

**Good commit messages:**

```bash
git commit -m "docs: add contributor onboarding guide"
git commit -m "fix: resolve vault unlock passphrase validation"
git commit -m "feat: implement VAULT_OWNER token expiry check"
```

**Bad commit messages:**

```bash
git commit -m "update"
git commit -m "fix"
git commit -m "asdf"
git commit -m "random changes"
```

---

## Step 8: Push to Your Fork

Upload your branch to your GitHub account:

```bash
git push origin docs/contributor-onboarding-guide
```

Use the branch name you created in Step 5.

**Verify it worked:**

Go to `https://github.com/YOUR_USERNAME/hushh-research`

You should see a green notification: **"Your branch was pushed X minutes ago"**

---

## Step 9: Open a Pull Request

**What is a PR?**

A Pull Request asks the Hushh team to review and merge your changes into their official repository.

**How to open a PR:**

1. Go to your fork: `https://github.com/YOUR_USERNAME/hushh-research`
2. GitHub will show a green **"Compare & pull request"** button
3. Click it

**Fill in the PR form:**

**Title:** Be specific and clear

```
docs: add contributor onboarding guide
fix: resolve vault passphrase validation bug
feat: implement token expiry validation
```

**Description:** Explain WHAT you changed and WHY

```markdown
## What does this PR do?
Adds a comprehensive contributor onboarding guide for new developers.

## Why?
New contributors found the existing documentation unclear and needed a beginner-friendly, step-by-step guide.

## How did you test it?
Read through the guide and verified all Git commands work as written.

## Related Issues
Closes #42 (if applicable)
```

Click **"Create pull request"**

---

## Step 10: Address Review Feedback

The Hushh team will review your PR. They might ask for changes.

**If they request changes:**

1. Make edits in your local files
2. Commit again:
   ```bash
   git add .
   git commit -m "docs: address review feedback"
   ```
3. Push again:
   ```bash
   git push origin docs/contributor-onboarding-guide
   ```

**The PR updates automatically** — you don't need to create a new PR. Your new commits appear in the same PR.

**If they ask questions:**

Reply in the PR comments. Be respectful and responsive.

---

## Commit Message Conventions

Hushh follows the **Conventional Commits** format:

```
<type>: <description>

<body (optional)>

<footer (optional)>
```

### Types

| Type | Usage | Example |
|------|-------|---------|
| `docs` | Documentation | `docs: add setup guide` |
| `fix` | Bug fix | `fix: resolve login error` |
| `feat` | New feature | `feat: add token validation` |
| `refactor` | Code cleanup | `refactor: simplify API response` |
| `test` | Tests | `test: add unit tests for auth` |
| `chore` | Build, deps | `chore: update dependencies` |
| `ci` | CI/CD changes | `ci: add GitHub Actions workflow` |
| `perf` | Performance | `perf: optimize database query` |

### Examples

```bash
# Simple
git commit -m "docs: add contributor guide"

# With body
git commit -m "fix: resolve vault unlock issue

The unlock passphrase was not handling special characters.
Added proper escaping in validation logic."

# With footer
git commit -m "feat: add token expiry check

Closes #123"
```

---

## Where to Contribute

The `hushh-research` repository is organized as a **monorepo** with multiple modules:

### Documentation (`docs/`)
- Add guides and tutorials
- Improve existing docs
- Add examples
- No complex setup needed — great for first PRs!

### Frontend (`hushh-webapp/`)
- React components
- TypeScript
- UI improvements
- Requires Node.js v18+

### Backend (`consent-protocol/`)
- Python FastAPI code
- Smart contracts (if applicable)
- Server logic
- Requires Python 3.10+

### Other Contributions
- Bug fixes across any module
- Tests
- CI/CD improvements
- Configuration

---

## Key Terms Glossary

| Term | Definition |
|------|-----------|
| **Fork** | Your personal copy of the repository on GitHub |
| **Clone** | Download a repository to your computer |
| **Branch** | An isolated line of work within a repository |
| **Commit** | A saved snapshot of changes with a message |
| **Push** | Upload commits from your computer to GitHub |
| **Pull Request (PR)** | A request to merge your changes into the main repository |
| **Upstream** | The official repository you're contributing to |
| **Origin** | Your personal fork on GitHub |
| **Main/Master** | The primary branch containing stable code |
| **Merge** | Combining two branches into one |

---

## Quick Reference

### Common Commands

```bash
# Setup (first time only)
git clone https://github.com/YOUR_USERNAME/hushh-research.git
cd hushh-research
git remote add upstream https://github.com/hushh-labs/hushh-research.git

# Before starting work
git fetch upstream
git rebase upstream/main

# Create and switch to new branch
git checkout -b docs/my-changes

# Make changes in your editor...

# Save changes
git add .
git commit -m "docs: clear message"

# Upload to your fork
git push origin docs/my-changes

# Then create PR on GitHub
```

### Checking Status

```bash
# See which branch you're on
git branch

# See what changed
git status

# See recent commits
git log --oneline -5

# See difference
git diff
```

---

## Best Practices

1. **Start small** — Your first PR should be focused and manageable
2. **Write for clarity** — Assume the reader is new to the project
3. **Follow conventions** — Match the existing code style and documentation format
4. **Test before pushing** — Verify your changes work locally
5. **Keep PRs focused** — One feature/fix per PR, not multiple unrelated changes
6. **Be responsive** — Reply to review comments promptly
7. **Link related issues** — Reference GitHub issues in your PR description
8. **Proofread** — Check spelling and grammar before submitting
9. **Be humble** — Accept feedback gracefully and ask questions if unclear
10. **Have fun** — You're contributing to open source! 🎉

---

## Common Mistakes to Avoid

| ❌ Mistake | ✅ Correct Approach |
|-----------|-------------------|
| Working directly on `main` branch | Create a feature branch first |
| Committing without a message | Always write clear, descriptive messages |
| Pushing to `main` | Push to your feature branch |
| Large, unfocused PRs | Keep changes small and related |
| No PR description | Explain WHAT and WHY |
| Force pushing to shared branches | Only force push to your own feature branches |
| Not syncing with upstream | Run `git fetch upstream && git rebase upstream/main` regularly |
| Ignoring review feedback | Respond to comments and make requested changes |

---

## Need Help?

- **Git confused?** Run `git status` to see where you are
- **Command error?** Copy the error and search on [Stack Overflow](https://stackoverflow.com)
- **Hushh question?** Ask in the [Hushh Discord community](https://discord.gg/hushh)
- **GitHub question?** Check [GitHub Docs](https://docs.github.com)

---

## What's Next After Your First PR?

✅ **PR Merged!** You're now a Hushh contributor. You'll appear on:
- The repository's contributors page
- Hushh's community dashboard
- Your GitHub profile

🎯 **Continue Contributing:**
1. Look for issues labeled `good first issue` or `help wanted`
2. Fix small bugs
3. Improve documentation
4. Build more complex features

---

## Additional Resources

- [GitHub's Git Handbook](https://guides.github.com/introduction/git-handbook/)
- [Conventional Commits](https://www.conventionalcommits.org/)
- [Pro Git Book](https://git-scm.com/book/en/v2)
- [Hushh Labs GitHub](https://github.com/hushh-labs)
- [Hushh Documentation](https://docs.hushh.ai)

---

**Welcome to the Hushh community! 🤫**

Your data. Your vault. Your agents.

---

*Last updated: April 2026*
