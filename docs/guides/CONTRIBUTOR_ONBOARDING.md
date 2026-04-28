# Contributor Onboarding Guide

## Visual Context

> This guide explains the contributor workflow for the hushh-research repository, including setup, making changes, and submitting pull requests.

See: ../../vision/project_context_map.md

Welcome to Hushh Labs! This guide walks you through everything you need to make your first contribution — from forking the repo to getting your Pull Request merged.

## Table of Contents

* [Prerequisites](#prerequisites)
* [Step 1 — Fork the Repository](#step-1--fork-the-repository)
* [Step 2 — Clone Your Fork](#step-2--clone-your-fork)
* [Step 3 — Set Up Upstream Remote](#step-3--set-up-upstream-remote)
* [Step 4 — Sync With Latest Code](#step-4--sync-with-latest-code)
* [Step 5 — Create a Branch](#step-5--create-a-branch)
* [Step 6 — Make Your Changes](#step-6--make-your-changes)
* [Step 7 — Commit Your Changes](#step-7--commit-your-changes)
* [Step 8 — Push to Your Fork](#step-8--push-to-your-fork)
* [Step 9 — Open a Pull Request](#step-9--open-a-pull-request)
* [Step 10 — Address Review Feedback](#step-10--address-review-feedback)
* [Commit Message Conventions](#commit-message-conventions)
* [Where to Contribute](#where-to-contribute)
* [Key Terms Glossary](#key-terms-glossary)
* [Best Practices](#best-practices)

## Prerequisites

Before you start, make sure you have:

* A [GitHub account](https://github.com) (free)
* [Git](https://git-scm.com/downloads) installed on your computer
* [Node.js](https://nodejs.org/) v18+ (for frontend changes)
* [Python 3.10+](https://www.python.org/) (for backend changes)
* A code editor such as [VS Code](https://code.visualstudio.com/)

Verify Git is installed:

```bash
git --version
```

## Step 1 — Fork the Repository

A **fork** is your personal copy of the Hushh repo under your GitHub account.

1. Go to https://github.com/hushh-labs/hushh-research
2. Click the **Fork** button
3. Select your account

## Step 2 — Clone Your Fork

```bash
git clone https://github.com/YOUR_USERNAME/hushh-research.git
cd hushh-research
```

## Step 3 — Set Up Upstream Remote

```bash
git remote add upstream https://github.com/hushh-labs/hushh-research.git
git remote -v
```

## Step 4 — Sync With Latest Code

```bash
git fetch upstream
git rebase upstream/main
```

## Step 5 — Create a Branch

```bash
git checkout -b docs/contributor-onboarding-guide
```

## Step 6 — Make Your Changes

```bash
code .
```

## Step 7 — Commit Your Changes

```bash
git add .
git commit -m "docs: update contributor onboarding guide" --signoff
```

## Step 8 — Push to Your Fork

```bash
git push origin docs/contributor-onboarding-guide
```

## Step 9 — Open a Pull Request

* Go to your fork on GitHub
* Click **Compare & pull request**
* Submit PR

## Step 10 — Address Review Feedback

```bash
git add .
git commit -m "docs: address review feedback" --signoff
git push
```

## Commit Message Conventions

Format:

```
<type>: <description>
```

Examples:

```
docs: add contributor onboarding guide
fix: correct API endpoint
feat: add new feature
```

## Where to Contribute

* docs/
* hushh-webapp/
* consent-protocol/

## Key Terms Glossary

| Term   | Meaning        |
| ------ | -------------- |
| Fork   | Copy of repo   |
| Clone  | Download repo  |
| Branch | Work area      |
| Commit | Save changes   |
| Push   | Upload changes |
| PR     | Request merge  |

## Best Practices

* Keep PR small
* Write clear messages
* Test before pushing
* Follow project structure
