# Description

Briefly explain what you changed and why.

## 📌 Impact Map (Required)

- Routes touched:
  - [ ] None
  - [ ] Listed below:

- API / schema / type changes:
  - [ ] None
  - [ ] Listed below:

- Cache keys touched:
  - [ ] None
  - [ ] Listed below:

- World-model domain summary effects:
  - [ ] None
  - [ ] Listed below:

- Mobile parity impacts:
  - [ ] None
  - [ ] Listed below:

- Docs updated (exact files):
  - [ ] None
  - [ ] Listed below:

- Verification commands executed:
  - [ ] `cd hushh-webapp && npm run typecheck`
  - [ ] `cd hushh-webapp && npm test`
  - [ ] `cd hushh-webapp && npm run build`
  - [ ] `cd hushh-webapp && npm run ios:test`
  - [ ] `python scripts/ops/kai-system-audit.py --api-base http://localhost:8000 --web-base http://localhost:3000`

## 🛑 Tri-Flow Architecture Check

_Every feature must be implemented across all three layers or explicitly marked as not applicable._

- [ ] **Web**: Next.js implementation (`app/api/...`)
- [ ] **iOS**: Swift Capacitor Plugin (`ios/App/App/Plugins/...`)
- [ ] **Android**: Kotlin Capacitor Plugin (`android/app/.../plugins/...`)

## 🧪 Testing

- [ ] Tested on Web (Chrome/Safari)
- [ ] Tested on iOS Simulator/Device
- [ ] Tested on Android Emulator/Device

## 📸 Screenshots / Video

_Attach proof of work here._

## 🛡️ Privacy & Consent

- [ ] Does this change access user data?
- [ ] If yes, have you implemented `checkConsentToken()`?
