# Getting Started with Hushh Research

> **Quick start guide for developers** - Updated January 2026 with VAULT_OWNER token architecture

---

## 🎯 What You're Building

Hushh is a **consent-first personal data agent system** with:

- **Zero-knowledge vault** encrypted on-device
- **VAULT_OWNER tokens** for secure vault access (stateless, self-contained)
- **Modular agents** (Food, Professional, Kai) with uniform consent validation
- **Multi-platform** support: Web, iOS, Android

---

## Prerequisites

### Required

- **Node.js**: v20+ (for Next.js 16)
- **Python**: 3.13 (for FastAPI backend; grpcio 1.76+ wheels)
- **PostgreSQL**: Cloud SQL or local instance
- **Firebase Project**: For authentication

### Platform-Specific

- **iOS**: Xcode 15+, CocoaPods
- **Android**: Android Studio, SDK 34+
- **macOS**: Required for iOS development

---

## 1. Clone & Install

```bash
# Clone repository
git clone https://github.com/hushh-labs/hushh-research.git
cd hushh-research

# First-time setup: installs git hooks + adds consent-upstream remote
make setup

# Install frontend dependencies (also auto-installs hooks via "prepare")
cd hushh-webapp
npm install

# Install backend dependencies
cd ../consent-protocol
python3 -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

> **Important:** `make setup` installs pre-commit and pre-push hooks that enforce
> linting and subtree sync checks for `consent-protocol/`. These hooks run
> automatically — you don't need to think about them after the initial setup.
> Run `make verify-setup` at any time to confirm everything is configured.

Use **.venv** only. If you have both `venv` and `.venv`, remove `venv` and use `.venv` to avoid two environments.

---

## 2. Environment Configuration

### Backend (consent-protocol/.env)

```bash
# Database Connection (Session Pooler - REQUIRED)
DB_USER=postgres.your-project-ref
DB_PASSWORD=your-password
DB_HOST=aws-1-us-east-1.pooler.supabase.com
DB_PORT=5432
DB_NAME=postgres

# Secret Key (for HMAC token signing)
SECRET_KEY=your-secret-key-here

# Firebase Admin SDK
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json

# Google AI / Gemini (for Kai portfolio parsing)
# Use ONE of these - API key OR Vertex AI project
GOOGLE_API_KEY=AIza...  # Google AI Studio API key
# OR for Vertex AI:
# GOOGLE_CLOUD_PROJECT=your-project-id
# GOOGLE_CLOUD_LOCATION=us-central1

# Port (default: 8000)
PORT=8000
```

### Frontend (hushh-webapp/.env.local)

```bash
# Backend URL (used by web + native routing)
NEXT_PUBLIC_BACKEND_URL=http://localhost:8000

# Next.js API proxy target (server-side)
# If not set, proxies default to http://localhost:8000 in development.
PYTHON_API_URL=http://localhost:8000

# Firebase Config
NEXT_PUBLIC_FIREBASE_API_KEY=your-api-key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your-app.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your-project-id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your-app.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=123456789
NEXT_PUBLIC_FIREBASE_APP_ID=1:123456789:web:abc123

# Backend uses DB_* above; no DATABASE_URL. See consent-protocol/.env.example.
```

---

## 3. Database Setup

### Supabase Setup (Recommended)

Hushh uses **SQLAlchemy with Supabase's Session Pooler** for direct PostgreSQL connections through a service layer architecture.

1. **Create Supabase Project**:
   - Go to https://supabase.com
   - Create a new project
   - Go to Project Settings → Database → Connection Pooling
   - Copy the Session Pooler credentials

2. **Configure Environment**:
   - Set `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT`, `DB_NAME` in `consent-protocol/.env`
   - See `.env` example above

3. **Initialize Schema**:
   ```bash
   cd consent-protocol
   python -c "
   from db.db_client import get_db_connection
   from sqlalchemy import text

   with get_db_connection() as conn:
       with open('db/migrations/COMBINED_MIGRATION.sql', 'r') as f:
           conn.execute(text(f.read()))
       conn.commit()
       print('Migration complete!')
   "
   ```

**Architecture:**
- All database access goes through service layer (`VaultDBService`, `ConsentDBService`, `WorldModelService`)
- Service layer validates consent tokens before database operations
- No direct database access from API routes

See `docs/reference/architecture/README.md` for the current architecture and data-layer references.

### Option B: Local PostgreSQL

```bash
# Create database
createdb hushh_vault

# Set environment variables
export DB_USER=postgres
export DB_PASSWORD=your-password
export DB_HOST=localhost
export DB_PORT=5432
export DB_NAME=hushh_vault

# Run migrations
cd consent-protocol
python -c "
from db.db_client import get_db_connection
from sqlalchemy import text

with get_db_connection() as conn:
    with open('db/migrations/COMBINED_MIGRATION.sql', 'r') as f:
        conn.execute(text(f.read()))
    conn.commit()
"
```

---

## 4. Start Development Servers

**⚠️ Important: Backend MUST run first!**

The FastAPI backend is the core of Hushh - it handles:
- Consent Protocol (VAULT_OWNER tokens)
- Modular Agents (Food, Professional, Kai)
- MCP Server (AI agent integration)

**Always start with `.venv` - never use global Python.**

### Terminal 1: Backend (FastAPI)

```bash
cd consent-protocol

# Step 1: Activate virtual environment (NEVER skip this step)
source .venv/bin/activate

# Step 2: Start the backend server
python -m uvicorn server:app --reload --port 8000

# Expected output:
# ✅ Added CORS origin from FRONTEND_URL: http://localhost:3000
# 🚀 Hushh Consent Protocol server initialized - KAI V2 + PHASE 2 + WORLD MODEL ENABLED
# INFO: Uvicorn running on http://0.0.0.0:8000
```

**Validation Steps:**
1. Check `.venv` directory exists (don't use `venv`)
2. If both exist, delete `venv` and keep only `.venv`
3. Run commands above - backend must be running before frontend

### Terminal 2: Frontend (Next.js)

```bash
make local-web

# Expected output:
# ▲ Next.js 16.x.x
# - Local: http://localhost:3000
# ✓ Compiled in 2.3s
```

---

## 5. Verify Setup

### Web Application

1. Open http://localhost:3000
2. Click "Sign in with Google"
3. Create vault with passphrase
4. Check browser console for:
   ```
   ✅ VAULT_OWNER token issued
   ✅ Vault unlocked
   ```

### Backend Health Check

```bash
curl http://localhost:8000/health

# Expected response:
{
  "status": "healthy",
  "agents": ["food_dining", "professional_profile"]
}
```

---

## 6. iOS Development (Optional)

### First-Time Setup

```bash
cd hushh-webapp
npm run build:ios  # Builds Next.js + syncs to iOS

cd ios/App
pod install        # Installs iOS dependencies
```

### Launch iOS Simulator

```bash
# Quick launch (recommended)
cd hushh-webapp
npm run cap:ios:run

# OR open in Xcode
npx cap open ios
# Press Cmd+R to build and run
```

### Verify Native Plugins

Check Xcode console for:

```
🔑 [HushhConsent] VAULT_OWNER token issued
🔐 [HushhVault] Native encryption using Keychain
```

---

## 7. Android Development (Optional)

### First-Time Setup

```bash
cd hushh-webapp
npm run build:android  # Builds Next.js + syncs to Android

# Open in Android Studio
npx cap open android
```

### Launch Android Emulator

```bash
# In Android Studio:
# 1. Select emulator
# 2. Click Run button (Ctrl+R / Cmd+R)
```

---

## 8. Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                   HUSHH STACK                        │
├─────────────────────────────────────────────────────┤
│                                                      │
│  Frontend (Next.js 16 + Capacitor)                  │
│  ├─ Web: http://localhost:3000                      │
│  ├─ iOS: Native Swift plugins                       │
│  └─ Android: Native Kotlin plugins                  │
│                                                      │
│  Backend (FastAPI + Python)                         │
│  ├─ Consent Protocol (VAULT_OWNER tokens)           │
│  ├─ Modular Agents (Food, Professional, Kai)        │
│  └─ MCP Server (AI agent integration)               │
│                                                      │
│  Storage (PostgreSQL + Cloud SQL)                   │
│  └─ E2E Encrypted Vault                             │
│                                                      │
└─────────────────────────────────────────────────────┘
```

---

## 9. Key Features to Test

### VAULT_OWNER Token Flow ✨ NEW!

1. **Unlock vault** → Backend issues VAULT_OWNER token
2. **Token stored** in React Context (memory-only)
3. **Access data** → Food/Professional pages validate token
4. **Logout** → Token cleared from memory

### Test Endpoints

```bash
# Issue VAULT_OWNER token (requires Firebase ID token)
curl -X POST http://localhost:8000/api/consent/vault-owner-token \
  -H "Authorization: Bearer $FIREBASE_TOKEN" \
  -d '{"userId": "user123"}'

# Get food preferences (requires VAULT_OWNER token)
curl -X POST http://localhost:8000/api/food/preferences \
  -d '{"userId": "user123", "consentToken": "HCT:..."}'

# Get professional data (requires VAULT_OWNER token)
curl -X POST http://localhost:8000/api/professional/preferences \
  -d '{"userId": "user123", "consentToken": "HCT:..."}'
```

---

## 10. Common Issues

### Backend won't start

```bash
# Check PostgreSQL is running
psql -h localhost -U postgres -l

# Check Python dependencies
pip install -r requirements.txt
```

### Frontend won't compile

```bash
# Clear Next.js cache
rm -rf .next
make local-web
```

### iOS build fails

```bash
# Clean build
cd ios/App
pod deintegrate
pod install

# Re-sync Capacitor
cd ../../
npx cap sync ios
```

### Database connection errors

```bash
# Verify DB_* in consent-protocol/.env (see .env.example)
cd consent-protocol && python -c "
from db.connection import get_database_url
print('DB URL (masked):', get_database_url()[:50] + '...')
"
# Or test with psql using DB_USER, DB_PASSWORD, DB_HOST, DB_PORT, DB_NAME
```

---

## 11. Next Steps

- **Architecture**: Read `docs/reference/architecture/README.md`
- **Consent + IAM**: Read `docs/reference/iam/README.md`
- **Mobile**: Read `docs/reference/mobile/README.md`
- **API Reference**: Read `docs/reference/architecture/api-contracts.md`
- **Kai Agent**: Read `docs/reference/kai/README.md`

---

## 12. VS Code Setup (Recommended)

Install extensions:

- **Python** - Microsoft
- **Pylance** - Microsoft
- **ESLint** - Microsoft
- **Prettier** - Prettier
- **Swift** - Apple (for iOS)

### Debug Configuration

See `.vscode/launch.json` for:

- **Next.js Debugger** (Chrome)
- **FastAPI Debugger** (Python)
- Combined concurrent debugging

---

## 🆘 Get Help

- **Documentation**: `/docs` directory
- **Issues**: GitHub Issues
- **Architecture Questions**: Check `docs/reference/architecture/README.md`

---

_Last Updated: February 2026 | Version: 6.0 | Kai Portfolio UX + World Model Release_
