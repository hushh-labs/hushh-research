# Contributing to Hushh Research

## Prerequisites

Before getting started, ensure the following tools are installed:

- Git
- Node.js
- Visual Studio Code (Recommended)

---

## Clone the Repository

```bash
git clone https://github.com/YOUR-USERNAME/hushh-research.git
cd hushh-research
```

---

## Create a New Branch

```bash
git checkout -b feature-name
```

---

## Install Dependencies

Locate the appropriate project directory containing package.json before running npm install.

Example:

```bash
cd webapp
npm install
```

---

## Contribution Workflow

1. Fork the repository
2. Clone your fork
3. Create a new branch
4. Make changes
5. Commit your changes
6. Push changes
7. Open a Pull Request

---

## Commit Message Example

```bash
git commit -m "Add contributor onboarding documentation"
```

---

## Pull Request Guidelines

- Keep pull requests focused
- Avoid unrelated file changes
- Write meaningful commit messages
- Test changes before submitting

---

## Architecture Overview

```text
Frontend (Next.js / Capacitor)
        ↓
Consent Protocol Backend (FastAPI)
        ↓
Kai Agent Layer
        ↓
User Data / AI Services
```
## Repository Structure

This repository contains multiple components and services.

Example structure:

```text
hushh-research/
├── hushh-webapp/
├── docs/
├── api/
├── supabase/
├── scripts/
└── tests/
```

Different components may contain their own package.json files and dependency requirements.

## Troubleshooting

### npm install fails with package.json error

If you encounter:

```text
ENOENT: no such file or directory, open 'package.json'
```

this means you are running npm commands outside a valid Node.js project directory.

Use the following command to locate package.json files:

```bash
Get-ChildItem -Recurse -Filter package.json
```

Then navigate into the appropriate component directory before running npm install.

## Recommended Development Workflow

1. Fork the repository
2. Clone your fork locally
3. Create a dedicated branch
4. Make focused changes
5. Commit with meaningful messages
6. Push changes to GitHub
7. Open a Pull Request

## Architecture Overview

```text
Frontend (Next.js / Capacitor)
        ↓
Consent Protocol Backend (FastAPI)
        ↓
Kai Agent Layer
        ↓
User Data / AI Services
```