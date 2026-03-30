import { dirname } from "path";
import { fileURLToPath } from "url";
import nextConfig from "eslint-config-next/core-web-vitals";
import tseslint from "typescript-eslint";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default [
  {
    ignores: [
      ".next/**",
      ".next/**/*",
      ".next-prod/**",
      ".next-prod/**/*",
      "out/**",
      "node_modules/**",
      "dist/**",
      "build/**",
      "android/**",
      "ios/**",
      "*.config.js",
      "*.config.mjs",
      "**/*.config.js",
      "**/*.config.mjs",
      "scripts/**/*.cjs",
      "**/*.cjs",
    ],
  },
  ...nextConfig,
  // TypeScript rules -- must reference the plugin from the same object
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/ban-ts-comment": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/triple-slash-reference": "off", // Next.js uses triple-slash references
    },
  },
  // General rules
  {
    rules: {
      "react/no-unescaped-entities": "off",
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/purity": "off",
      "react-hooks/incompatible-library": "off",
      // BYOK rules + storage ban
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='fetch']",
          message:
            "Direct fetch() is banned in components. Use ApiService or VaultService instead. Native platforms (iOS/Android) have no Next.js server.",
        },
        {
          selector:
            "CallExpression[callee.object.name='localStorage'][callee.property.name='getItem'][arguments.0.value='vault_key']",
          message:
            "BYOK VIOLATION: Reading vault_key from localStorage is insecure. Use useVault().getVaultKey() instead.",
        },
        {
          selector:
            "CallExpression[callee.object.name='sessionStorage'][callee.property.name='getItem'][arguments.0.value='vault_key']",
          message:
            "BYOK VIOLATION: Reading vault_key from sessionStorage is insecure. Use useVault().getVaultKey() instead.",
        },
        {
          selector:
            "CallExpression[callee.object.name='localStorage'][callee.property.name='setItem'][arguments.0.value='vault_key']",
          message:
            "BYOK VIOLATION: Storing vault_key in localStorage is insecure. Use VaultContext.unlockVault() instead.",
        },
        {
          selector:
            "CallExpression[callee.object.name='sessionStorage'][callee.property.name='setItem'][arguments.0.value='vault_key']",
          message:
            "BYOK VIOLATION: Storing vault_key in sessionStorage is insecure. Use VaultContext.unlockVault() instead.",
        },
      ],
      // Ban all sessionStorage/localStorage usage for security
      "no-restricted-globals": [
        "error",
        {
          name: "sessionStorage",
          message:
            "sessionStorage is banned. Use React state/context or Zustand store. No browser storage for sensitive data.",
        },
        {
          name: "localStorage",
          message:
            "localStorage is banned. Use React state/context or Zustand store. No browser storage for sensitive data.",
        },
      ],
    },
  },
  // Override for config files
  {
    files: ["*.config.ts", "*.config.js", "*.config.mjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  // Override: registry-owned vendor files (keep parity-safe without local lint edits)
  {
    files: ["components/ui/**/*.tsx"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  // Override for API routes, services, and plugins (fetch allowed, storage allowed)
  {
    files: [
      "app/api/**/*.ts",
      "**/*.test.ts",
      "**/*.spec.ts",
      "lib/capacitor/plugins/**/*",
      "lib/services/**/*",
      "lib/api/**/*",
      "lib/auth/**/*",
      // SSE streaming components use fetch() for EventSource polyfill
      "components/kai/debate-stream-view.tsx",
    ],
    rules: {
      "no-restricted-syntax": "off",
      "no-restricted-globals": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
    },
  },
  // Override: auth/vault contexts + logout/exit (limited fetch ban, storage allowed for cleanup)
  {
    files: [
      "lib/firebase/auth-context.tsx",
      "lib/vault/vault-context.tsx",
      "app/logout/**/*",
      "components/exit-dialog.tsx",
    ],
    rules: {
      "no-restricted-globals": "off", // These files handle defensive storage cleanup on logout/exit
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='fetch']",
          message:
            "Direct fetch() is banned in components. Use ApiService or VaultService instead.",
        },
      ],
    },
  },
  // Override: Capacitor web plugins need storage access for platform abstraction
  {
    files: ["lib/capacitor/plugins/**/*"],
    rules: {
      "no-restricted-globals": "off",
    },
  },
  // Override: session-storage utility (will be deleted in zero-storage phase)
  {
    files: ["lib/utils/session-storage.ts"],
    rules: {
      "no-restricted-globals": "off",
    },
  },
];
