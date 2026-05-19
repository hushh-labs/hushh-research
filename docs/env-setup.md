# Environment Setup Guide

This guide helps contributors configure the local development environment and troubleshoot common setup issues.

## Prerequisites

Ensure the following tools are installed:

- Node.js
- npm or pnpm
- Git

## Initial Setup

Clone the repository:

```bash
git clone https://github.com/hushh-labs/hushh-research.git
```

Install dependencies:

```bash
npm install
```

or

```bash
pnpm install
```

## Environment Variables

Create a local environment file:

```bash
cp .env.example .env.local
```

Update the required values before running the application.

## Running the Project

```bash
npm run dev
```

or

```bash
pnpm dev
```

## Common Issues

### Missing Environment Variables

If the application fails during startup, verify that all required environment variables are configured correctly.

### Dependency Installation Errors

Try clearing existing modules and reinstalling:

```bash
rm -rf node_modules
npm install
```

### Port Already in Use

Change the local development port or stop the conflicting process.

## Additional Notes

Refer to the project README for architecture and contribution guidelines.