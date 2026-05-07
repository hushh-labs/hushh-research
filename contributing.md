# Contributing Guide

## Prerequisites

Before getting started, ensure the following tools are installed:

- Git
- Node.js
- Visual Studio Code

---

## Clone the Repository

```bash
git clone https://github.com/YOUR-USERNAME/hushh-research.git
cd hushh-research
```

---

## Getting Started Guide

For detailed onboarding instructions, refer to:

```text
docs/guides/getting-started.md
```

---

## Create a New Branch

```bash
git checkout -b feature-name
```

---

## Install Dependencies

Bootstrap the development environment using:

```bash
./bin/hushh bootstrap
```

---

## Contribution Workflow

1. Fork the repository
2. Clone your fork
3. Create a branch
4. Make changes
5. Commit changes
6. Push changes
7. Open a Pull Request

---

## Commit Example

```bash
git commit -s -m "Add contributor onboarding documentation"
```

---

## Repository Structure

```text
hushh-research/
├── hushh-webapp/
├── docs/
├── api/
├── supabase/
├── scripts/
└── tests/
```

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