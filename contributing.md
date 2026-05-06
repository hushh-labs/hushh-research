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