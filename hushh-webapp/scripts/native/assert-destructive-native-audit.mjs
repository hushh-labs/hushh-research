#!/usr/bin/env node

import { assertDestructiveNativeAuditAllowed } from "./native-audit-safety.mjs";

assertDestructiveNativeAuditAllowed();
