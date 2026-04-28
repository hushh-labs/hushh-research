# Contributor Onboarding Guide

> **Welcome to Hushh Labs!** This guide walks you through everything you need to make your first contribution — from forking the repo to getting your Pull Request merged. No prior open-source experience required.

---

## Table of Contents

1. [What Is This Repo?](#what-is-this-repo)
2. [Prerequisites](#prerequisites)
3. [Step 1 — Fork the Repository](#step-1--fork-the-repository)
4. [Step 2 — Clone Your Fork](#step-2--clone-your-fork)
5. [Step 3 — Set Up Upstream Remote](#step-3--set-up-upstream-remote)
6. [Step 4 — Sync With Latest Code](#step-4--sync-with-latest-code)
7. [Step 5 — Create a Branch](#step-5--create-a-branch)
8. [Step 6 — Make Your Changes](#step-6--make-your-changes)
9. [Step 7 — Commit Your Changes](#step-7--commit-your-changes)
10. [Step 8 — Push to Your Fork](#step-8--push-to-your-fork)
11. [Step 9 — Open a Pull Request](#step-9--open-a-pull-request)
12. [Step 10 — Address Review Feedback](#step-10--address-review-feedback)
13. [Commit Message Conventions](#commit-message-conventions)
14. [Where to Contribute](#where-to-contribute)
15. [Key Terms Glossary](#key-terms-glossary)
16. [Common Mistakes to Avoid](#common-mistakes-to-avoid)
17. [Tips for Getting Your PR Merged Fast](#tips-for-getting-your-pr-merged-fast)

---

## What Is This Repo?

`hushh-research` is the research and product workspace for Hushh — a consent-first personal AI platform. It contains:

| Folder | What It Is |
|---|---|
| `hushh-webapp/` | Next.js frontend (TypeScript, React) |
| `consent-protocol/` | Python backend (FastAPI, consent tokens) |
| `docs/` | Cross-cutting documentation |

Contributors help by fixing bugs, improving docs, writing tests, or building new features.

---

## Prerequisites

Before you start, make sure you have:

- [ ] A [GitHub account](https://github.com) (free)
- [ ] [Git](https://git-scm.com/downloads) installed on your computer
- [ ] [Node.js](https://nodejs.org/) (for frontend changes)
- [ ] [Python 3.10+](https://python.org) (for backend changes)
- [ ] A code editor like [VS Code](https://code.visualstudio.com/)

Verify Git is installed:

```bash
git --version
# Expected: git version 2.x.x
```

---

## Step 1 — Fork the Repository

**What is a fork?** A fork is your own personal copy of the Hushh repo under your GitHub account. You make changes in your fork without affecting the original.

1. Go to: [https://github.com/hushh-labs/hushh-research](https://github.com/hushh-labs/hushh-research)
2. Click the **Fork** button in the top-right corner
3. Select your GitHub account as the destination
4. After forking, you will have: `https://github.com/YOUR_USERNAME/hushh-research`

---

## Step 2 — Clone Your Fork

**What is cloning?** Cloning downloads the repository from GitHub to your computer so you can edit files locally.

Open PowerShell (Windows) or Terminal (Mac/Linux) and run:

```bash
git clone https://github.com/YOUR_USERNAME/hushh-research.git
cd hushh-research
```

> 🔁 Replace `YOUR_USERNAME` with your actual GitHub username.

---

## Step 3 — Set Up Upstream Remote

**What is upstream?** The "upstream" remote points to the official Hushh repo. This lets you pull the latest changes from Hushh even after you've forked.

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
|---|---|
| `origin` | Your fork — where YOU push changes |
| `upstream` | The official Hushh repo — where you pull updates |

---

## Step 4 — Sync With Latest Code

Before creating a branch, always pull the latest changes so you're not working on outdated code:

```bash
git fetch upstream
git rebase upstream/main
```

> ⚡ Do this every time before you start a new piece of work.

---

## Step 5 — Create a Branch

**What is a branch?** A branch is an isolated workspace. You make changes in a branch without touching `main`. This allows multiple pieces of work to happen in parallel.

**Never work directly on `main`.** Always create a branch:

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

---

## Step 6 — Make Your Changes

Now open VS Code and make your changes:

```bash
# Open VS Code in the current folder
code .
```

Depending on what you're contributing:

- **Bug fix in web UI** → Edit files in `hushh-webapp/`
- **Backend / protocol fix** → Edit files in `consent-protocol/`
- **Documentation** → Edit or create files in `docs/`

### Running the Frontend Locally

```bash
cd hushh-webapp
npm install
npm run dev
# Opens at http://localhost:3000
```

### Running the Backend Locally

```bash
cd consent-protocol
pip install -r requirements.txt
uvicorn main:app --reload
# Opens at http://localhost:8000
```

---

## Step 7 — Commit Your Changes

**What is a commit?** A commit is a saved snapshot of your changes with a message explaining what you did.

After editing files:

```bash
# Stage all changed files
git add .

# Commit with a clear message
git commit -m "fix: resolve vault unlock passphrase validation bug"
```

See [Commit Message Conventions](#commit-message-conventions) below for proper formatting.

---

## Step 8 — Push to Your Fork

**What is pushing?** Pushing uploads your local commits to your GitHub fork.

```bash
git push origin YOUR_BRANCH_NAME
```

Example:

```bash
git push origin docs/contributor-onboarding-guide
```

---

## Step 9 — Open a Pull Request

**What is a Pull Request (PR)?** A PR is your formal request asking Hushh to merge your changes into their main repo. The team reviews your work and either merges it or asks for improvements.

1. Go to your fork on GitHub: `https://github.com/YOUR_USERNAME/hushh-research`
2. You will see a green **"Compare & pull request"** button — click it
3. Fill in the PR form:

**Title** (be specific):
```
docs: add step-by-step contributor onboarding guide
```

**Description template:**
```markdown
## What does this PR do?
[Describe what you changed in 1–3 sentences]

## Why?
[Explain the problem this solves or the value it adds]

## How did you test it?
[Describe what you checked to make sure it works]

## Related Issues
Closes #[issue number, if applicable]
```

4. Click **"Create pull request"**

> ✅ Your PR is now submitted! The Hushh team will review it within the week.

---

## Step 10 — Address Review Feedback

The Hushh team may leave comments asking you to change something. Here's how to respond:

1. Read their feedback carefully in the PR comments
2. Make the requested changes in your local branch
3. Commit and push again:

```bash
git add .
git commit -m "fix: address review feedback"
git push origin YOUR_BRANCH_NAME
```

> 🔁 The PR updates automatically — you do **not** need to open a new PR.

Repeat until the team is happy and merges your PR. 🎉

---

## Commit Message Conventions

Hushh follows the [Conventional Commits](https://www.conventionalcommits.org/) standard.

Format:
```
<type>: <short description>
```

| Type | When to Use |
|---|---|
| `feat` | Adding a new feature |
| `fix` | Fixing a bug |
| `docs` | Documentation only changes |
| `style` | Code formatting, no logic changes |
| `refactor` | Restructuring code without changing behavior |
| `test` | Adding or fixing tests |
| `chore` | Maintenance, dependency updates |

**Good examples:**
```bash
git commit -m "fix: resolve vault unlock passphrase validation bug"
git commit -m "feat: add VAULT_OWNER token expiry check"
git commit -m "docs: add contributor onboarding guide"
git commit -m "test: add unit tests for consent token generation"
```

**Bad examples:**
```bash
git commit -m "fix"          # Too vague
git commit -m "changes"      # Meaningless
git commit -m "asdf"         # Never do this
```

---

## Where to Contribute

Not sure where to start? Here are the best entry points:

### 1. Browse Open Issues
Visit: [https://github.com/hushh-labs/hushh-research/issues](https://github.com/hushh-labs/hushh-research/issues)

Look for labels like:
- `good first issue` — Beginner-friendly
- `documentation` — No code required
- `bug` — Isolated, testable fixes
- `help wanted` — Team actively needs contributors

### 2. Contribution Types by Difficulty

| Type | Difficulty | Where |
|---|---|---|
| Fix a typo or grammar in docs | ⭐ Very Easy | `docs/` |
| Improve existing documentation | ⭐⭐ Easy | `docs/` |
| Fix a small UI bug | ⭐⭐ Easy | `hushh-webapp/` |
| Add a new UI component | ⭐⭐⭐ Medium | `hushh-webapp/` |
| Fix a backend API bug | ⭐⭐⭐ Medium | `consent-protocol/` |
| Add a new consent flow feature | ⭐⭐⭐⭐ Hard | Full stack |

---

## Key Terms Glossary

| Term | Plain English Meaning |
|---|---|
| **Fork** | Your personal copy of the Hushh repo on GitHub |
| **Clone** | Download the repo to your computer |
| **Branch** | An isolated workspace for your changes |
| **Commit** | Save a snapshot of your changes with a message |
| **Push** | Upload your commits to GitHub |
| **Pull Request (PR)** | Ask Hushh to merge your changes into their repo |
| **Upstream** | The official Hushh repo (`hushh-labs/hushh-research`) |
| **Origin** | Your fork (`YOUR_USERNAME/hushh-research`) |
| **Merge** | When your PR is approved and added to the main codebase |
| **Rebase** | Update your branch with the latest changes from upstream |
| **Review** | The Hushh team reading your code and giving feedback |

---

## Common Mistakes to Avoid

| ❌ Mistake | ✅ What To Do Instead |
|---|---|
| Working directly on `main` | Always create a new branch |
| Not syncing before starting | Run `git fetch upstream && git rebase upstream/main` first |
| Vague commit messages | Use `type: short description` format |
| Opening a new PR after feedback | Just push to the same branch — PR updates automatically |
| Huge PRs with many unrelated changes | Keep PRs small and focused on one thing |
| Not filling in the PR description | Always describe what, why, and how you tested |

---

## Tips for Getting Your PR Merged Fast

1. **Start small** — A focused, small PR is much easier to review than a massive one
2. **Write a good PR description** — Explain what you did and why clearly
3. **Reference an issue** — If your PR fixes a GitHub issue, write `Closes #42` in the description
4. **Respond quickly** — When the team leaves feedback, reply within 24–48 hours
5. **Keep your branch up to date** — If `main` moves forward, rebase your branch
6. **Test your changes** — Make sure things actually work before submitting
7. **Be respectful** — The team is reviewing many PRs; be patient and collaborative

---

## Quick Reference Cheatsheet

```bash
# ONE-TIME SETUP
git clone https://github.com/YOUR_USERNAME/hushh-research.git
cd hushh-research
git remote add upstream https://github.com/hushh-labs/hushh-research.git

# EVERY TIME YOU START NEW WORK
git fetch upstream
git rebase upstream/main
git checkout -b fix/your-branch-name

# AFTER MAKING CHANGES
git add .
git commit -m "fix: clear description of what you did"
git push origin fix/your-branch-name

# THEN: Go to GitHub → Click "Compare & pull request" → Fill in form → Submit

# IF THE TEAM ASKS FOR CHANGES
git add .
git commit -m "fix: address review feedback"
git push origin fix/your-branch-name
# PR updates automatically — no new PR needed!
```

---

> **You've got this!** Every expert contributor started exactly where you are now. Make your first PR, learn from the feedback, and build from there. The Hushh team is here to help. 🚀
>
> Questions? Open a GitHub Discussion or check the existing docs in `docs/guides/`.
