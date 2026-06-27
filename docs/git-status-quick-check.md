# Git Status Quick Check

## Visual Map

```mermaid
flowchart TD
  A[Check branch] --> B[Check working tree]
  B --> C[Review diff]
  C --> D[Commit with signoff]
  D --> E[Push branch]
```

## Quick Commands

```bash
git status
git diff
git add .
git commit -s -m "message"
git push origin <branch>
```

## Purpose

This document provides a quick reference for checking repository status before creating commits and pull requests.