# Contributing to Hushh Research

Thank you for your interest in contributing to Hushh! We are building the future of **Consent-First Personal Data Agents** at [hushh.ai](https://hushh.ai), and we need your help to make it robust, secure, and user-centric.

## 🛑 Critical Architecture Rules

Before you write a single line of code, understand our three non-negotiable rules. Violating these will result in your PR being rejected.

### 1. The Tri-Flow Rule (Web + iOS + Android)

Hushh is a cross-platform application. **Every feature** that touches backend data or device capabilities must be implemented in three layers:

1.  **Web**: Next.js proxy route (`app/api/...`)
2.  **iOS**: Swift Capacitor Plugin (`ios/App/App/Plugins/...`)
3.  **Android**: Kotlin Capacitor Plugin (`android/app/.../plugins/...`)

**Why?** The native apps do _not_ run the Next.js server locally. They need native plugins to talk to the Python backend. If you only implement the Web flow, the feature will break on mobile.

### 2. Consent-First

- **No Implicit Access**: Even the vault owner needs a token (`VAULT_OWNER` scope).
- **No Backdoors**: Never bypass token validation "just for testing".
- **Validate Early**: Check consent tokens at the API entry point.

### 3. Zero-Knowledge (BYOK)

- **Client-Side Keys**: The vault key never leaves the user's device.
- **Ciphertext Only**: The server only stores encrypted data.
- **Memory-Only**: In the web app, keys live in React Context, not `localStorage`.

---

## 🚀 Getting Started

**New to contributing?** Start with our [Getting Started Guide](getting_started.md) for a step-by-step environment setup, then come back here for workflow guidelines.

**Quick setup:**
```bash
git clone https://github.com/hushh-labs/hushh-research.git
cd hushh-research
make setup        # installs git hooks + adds consent-upstream remote
make verify-setup # confirm everything is configured
```
- You will need:
  - Node.js v20+
  - Python 3.13+
  - PostgreSQL
  - Xcode (for iOS)
  - Android Studio (for Android)

---

## 🔄 Subtree Workflow (consent-protocol)

The `consent-protocol/` directory is a **git subtree** linked to a standalone upstream repo. Changes made here must eventually be synced back. Git hooks enforce this automatically — here's the workflow:

### Day-to-day Development
1. **Sync before starting work** on `consent-protocol/`:
   ```bash
   make sync-protocol   # pull latest from upstream
   ```
2. **Make your changes** and commit normally — the pre-commit hook runs lint checks automatically.
3. **Push your branch** — the pre-push hook verifies upstream is in sync and blocks if not.
4. **After your PR is merged to main**, sync back to the standalone repo:
   ```bash
   make push-protocol   # push changes to upstream (checks sync first)
   ```

### What the Hooks Enforce
| Hook | Trigger | What it does |
|------|---------|-------------|
| **pre-commit** | `git commit` with consent-protocol files | Runs ruff lint + format check |
| **pre-push** | `git push` with consent-protocol files | Blocks if upstream has unpulled commits |

### Available Commands
```bash
make sync-protocol        # Pull upstream → monorepo
make push-protocol        # Push monorepo → upstream (checks sync first)
make push-protocol-force  # Push without sync check (escape hatch)
make check-protocol-sync  # Check sync status without pushing
make verify-setup         # Verify hooks and remotes are configured
```

---

## 🛠 How to Contribute

1.  **Find an Issue**: Look for issues tagged `good-first-issue` or `help-wanted`.
2.  **Fork the Repo**: Create your own fork on GitHub.
3.  **Create a Branch**: Use format `/[username]/[type]/[type-name]`:
    - `YOUR_USERNAME/feat/add-movie-agent`
    - `YOUR_USERNAME/fix/vault-unlock-race-condition`
    - `YOUR_USERNAME/docs/update-readme`
4.  **Implement the Tri-Flow**: Ensure your change works on Web, iOS, and Android.
5.  **Test CI Locally**: **Always run local CI checks before committing**:
    ```bash
    ./scripts/test-ci-local.sh
    ```
    This ensures your changes will pass GitHub Actions CI. See [CI Configuration Reference](docs/reference/operations/ci.md) for details.
6.  **Test Locally**: Verify the change on all supported platforms (simulators/emulators).
7.  **Submit a Pull Request**: targeted at the `main` branch.
    - `main` is protected: PRs require approval and CI checks.
    - `deploy-production` is protected: Only deployed via authorized workflows. Deployment runs from the **`deploy`** branch (not `main`) and requires the **`GCP_SA_KEY`** GitHub secret; see [deploy/README.md](deploy/README.md).

---

## ✅ Pull Request Guidelines

When you open a PR, please use this template:

### Description

Briefly explain what you changed and why.

### Tri-Flow Checklist

- [ ] Web Implementation (Next.js route)
- [ ] iOS Implementation (Swift Plugin)
- [ ] Android Implementation (Kotlin Plugin)
- [ ] Service Layer (Platform detection logic)
- [ ] TypeScript Interface (`lib/capacitor/index.ts`)

### Testing

- [ ] Tested on Web (Chrome/Safari)
- [ ] Tested on iOS Simulator
- [ ] Tested on Android Emulator

### Screenshots/Video

Attach a screen recording or screenshot of the feature in action.

---

## 🧩 Directory Structure

- `consent-protocol/`: Python Backend & MCP Server
- `hushh-webapp/`: Next.js Frontend
- `hushh-webapp/ios/`: Native iOS Code
- `hushh-webapp/android/`: Native Android Code
- `docs/`: Documentation (Single Source of Truth)
- `scripts/`: Utility scripts (including `test-ci-local.sh`)
- `data/`: Large data files (gitignored, regenerable)
- `config/`: Configuration files

## 📚 Documentation

- **[Getting Started Guide](getting_started.md)**: Environment setup
- **[Contributing Guide](contributing.md)**: Workflow and guidelines (this file)
- **[Project Context Map](docs/project_context_map.md)**: Understanding the codebase
- **[New Feature Checklist](docs/guides/new-feature.md)**: Building new features
- **[Route Contracts](docs/reference/architecture/route-contracts.md)**: API and shell contract documentation

---

## 🤝 Community

- **Discord**: [Join our Discord](https://discord.gg/fd38enfsH5)

## 📄 License

By contributing to Hushh, you agree that your contributions will be licensed under the MIT License.

---

Thank you for building with us!
