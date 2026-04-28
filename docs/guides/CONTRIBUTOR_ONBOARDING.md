# Contributor Onboarding Guide

Welcome to Hushh Labs! This guide walks you through everything you need to make your first contribution — from forking the repo to getting your Pull Request merged.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Step 1 — Fork the Repository](#step-1--fork-the-repository)
- [Step 2 — Clone Your Fork](#step-2--clone-your-fork)
- [Step 3 — Set Up Upstream Remote](#step-3--set-up-upstream-remote)
- [Step 4 — Sync With Latest Code](#step-4--sync-with-latest-code)
- [Step 5 — Create a Branch](#step-5--create-a-branch)
- [Step 6 — Make Your Changes](#step-6--make-your-changes)
- [Step 7 — Commit Your Changes](#step-7--commit-your-changes)
- [Step 8 — Push to Your Fork](#step-8--push-to-your-fork)
- [Step 9 — Open a Pull Request](#step-9--open-a-pull-request)
- [Step 10 — Address Review Feedback](#step-10--address-review-feedback)
- [Commit Message Conventions](#commit-message-conventions)
- [Where to Contribute](#where-to-contribute)
- [Key Terms Glossary](#key-terms-glossary)
- [Best Practices](#best-practices)

## Prerequisites

Before you start, make sure you have:

- A [GitHub account](https://github.com) (free)
- [Git](https://git-scm.com/downloads) installed on your computer
- [Node.js](https://nodejs.org/) v18+ (for frontend changes)
- [Python 3.10+](https://www.python.org/) (for backend changes)
- A code editor such as [VS Code](https://code.visualstudio.com/)

Verify Git is installed:

```bash
git --version
```

## Step 1 — Fork the Repository

A **fork** is your personal copy of the Hushh repo under your GitHub account.

1. Go to <https://github.com/hushh-labs/hushh-research>
2. Click the **Fork** button in the top-right corner
3. Select your GitHub account as the destination

After forking, you will have: `https://github.com/YOUR_USERNAME/hushh-research`

## Step 2 — Clone Your Fork

**Cloning** downloads the repository from GitHub to your computer.

```bash
git clone https://github.com/YOUR_USERNAME/hushh-research.git
cd hushh-research
```

Replace `YOUR_USERNAME` with your actual GitHub username.

## Step 3 — Set Up Upstream Remote

The **upstream** remote points to the official Hushh repo so you can pull the latest changes.

```bash
git remote add upstream https://github.com/hushh-labs/hushh-research.git
```

Verify it worked:

```bash
git remote -v
```

Expected output:

```
origin    https://github.com/YOUR_USERNAME/hushh-research.git (fetch)
origin    https://github.com/YOUR_USERNAME/hushh-research.git (push)
upstream  https://github.com/hushh-labs/hushh-research.git (fetch)
upstream  https://github.com/hushh-labs/hushh-research.git (push)
```

| Remote | Meaning |
| --- | --- |
| `origin` | Your fork — where you push changes |
| `upstream` | The official Hushh repo — where you pull updates |

## Step 4 — Sync With Latest Code

Before creating a branch, always pull the latest changes:

```bash
git fetch upstream
git rebase upstream/main
```

Run this every time before you start new work.

## Step 5 — Create a Branch

A **branch** is an isolated workspace. Never work directly on `main`.

```bash
# For a bug fix:
git checkout -b fix/your-bug-name

# For a new feature:
git checkout -b feature/your-feature-name

# For documentation:
git checkout -b docs/your-doc-name
```

Examples:

```bash
git checkout -b fix/vault-unlock-passphrase-bug
git checkout -b feature/add-consent-token-expiry
git checkout -b docs/contributor-onboarding-guide
```

## Step 6 — Make Your Changes

Open your editor and make your changes:

```bash
code .
```

### Frontend (Next.js)

```bash
cd hushh-webapp
npm install
npm run dev
```

### Backend (FastAPI)

```bash
cd consent-protocol
pip install -r requirements.txt
uvicorn main:app --reload
```

## Step 7 — Commit Your Changes

A **commit** is a saved snapshot of your changes with a descriptive message.

```bash
git add .
git commit -m "fix: resolve vault unlock passphrase validation bug"
```

See [Commit Message Conventions](#commit-message-conventions) for proper formatting.

## Step 8 — Push to Your Fork

**Pushing** uploads your local commits to your GitHub fork.

```bash
git push origin YOUR_BRANCH_NAME
```

## Step 9 — Open a Pull Request

1. Go to your fork: `https://github.com/YOUR_USERNAME/hushh-research`
2. Click the green **"Compare & pull request"** button
3. Fill in the PR title and description using the template provided
4. Click **"Create pull request"**

Your PR is now submitted for review.

## Step 10 — Address Review Feedback

If the Hushh team requests changes:

1. Make the edits in your local branch
2. Commit and push again:

```bash
git add .
git commit -m "fix: address review feedback"
git push origin YOUR_BRANCH_NAME
```

The PR updates automatically — you do not need to open a new PR.

## Commit Message Conventions

Hushh follows the [Conventional Commits](https://www.conventionalcommits.org/) standard.

Format: `<type>: <short description>`

| Type | When to Use |
| --- | --- |
| `feat` | Adding a new feature |
| `fix` | Fixing a bug |
| `docs` | Documentation only changes |
| `style` | Formatting, no logic changes |
| `refactor` | Code restructuring without behavior change |
| `test` | Adding or fixing tests |
| `chore` | Maintenance, dependency updates |

Good examples:

```bash
git commit -m "fix: resolve vault unlock passphrase validation bug"
git commit -m "feat: add VAULT_OWNER token expiry check"
git commit -m "docs: add contributor onboarding guide"
```

## Where to Contribute

Browse open issues: <https://github.com/hushh-labs/hushh-research/issues>

Look for labels such as `good first issue`, `documentation`, `bug`, or `help wanted`.

### Contribution Types by Difficulty

| Type | Difficulty | Location |
| --- | --- | --- |
| Fix a typo or grammar | Easy | `docs/` |
| Improve documentation | Easy | `docs/` |
| Fix a small UI bug | Medium | `hushh-webapp/` |
| Add a new UI component | Medium | `hushh-webapp/` |
| Fix a backend API bug | Medium | `consent-protocol/` |
| Add a new consent flow feature | Hard | Full stack |

## Key Terms Glossary

| Term | Meaning |
| --- | --- |
| Fork | Your personal copy of the repo on GitHub |
| Clone | Download the repo to your computer |
| Branch | An isolated workspace for your changes |
| Commit | Save a snapshot of your changes with a message |
| Push | Upload your commits to GitHub |
| Pull Request | Ask Hushh to merge your changes into their repo |
| Upstream | The official Hushh repo |
| Origin | Your fork |

## Best Practices

- Start with small, focused PRs — easier to review and merge faster
- Write a clear PR description explaining what, why, and how you tested
- Reference issues in your PR description using `Closes #42`
- Respond to review feedback within 24 to 48 hours
- Keep your branch up to date by rebasing regularly
- Test your changes before submitting
- Never force-push to a shared branch

### Quick Reference

```bash
# One-time setup
git clone https://github.com/YOUR_USERNAME/hushh-research.git
cd hushh-research
git remote add upstream https://github.com/hushh-labs/hushh-research.git

# Every time you start new work
git fetch upstream
git rebase upstream/main
git checkout -b fix/your-branch-name

# After making changes
git add .
git commit -m "fix: clear description"
git push origin fix/your-branch-name

# After review feedback
git add .
git commit -m "fix: address review feedback"
git push origin fix/your-branch-name
```
