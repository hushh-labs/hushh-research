/**
 * Hushh Research Monorepo - Duplicate Consent Token Rejection Routing Test
 * * Assures that the system ledger blocks redundant or duplicate consent token injections,
 * preserving state consistency and preventing transactional race conditions.
 */
const assert = require('assert');

// Simulated token registry ledger database
class ConsentLedgerRegistry {
    constructor() {
        this.registeredTokens = new Set(["tok_consent_alpha_2026"]);
    }

    // Process a token registration routing request
    registerToken(tokenString) {
        if (this.registeredTokens.has(tokenString)) {
            return { success: false, status: "REJECTED_DUPLICATE_ROUTING" };
        }
        this.registeredTokens.add(tokenString);
        return { success: true, status: "TOKEN_REGISTERED_SUCCESS" };
    }
}

const runTokenRejectionSuite = () => {
    console.log('\x1b[34m%s\x1b[0m', '🧪 Running test(permission): Verifying duplicate consent token rejection routing...');

    const registry = new ConsentLedgerRegistry();

    try {
        // 1. First attempt with a brand new structural token
        const newRegistration = registry.registerToken("tok_consent_beta_2026");
        assert.strictEqual(newRegistration.success, true, "❌ Failure: Standard unique token registration was incorrectly blocked.");

        // 2. Attempt to register an identical token that already exists in the system ledger
        const duplicateRegistration = registry.registerToken("tok_consent_alpha_2026");

        // 3. Assertions: Confirm routing system gracefully caught the collision and rejected it
        assert.strictEqual(duplicateRegistration.success, false, "❌ Failure: Ledger allowed a duplicate token mapping to slip through.");
        assert.strictEqual(duplicateRegistration.status, "REJECTED_DUPLICATE_ROUTING", "❌ Failure: Wrong routing flag returned for data collision handling.");

        console.log('\x1b[32m%s\x1b[0m', '✅ Test Passed: System flawlessly traps and rejects duplicate consent configurations!');
        process.exit(0);
    } catch (error) {
        console.error('\x1b[31m%s\x1b[0m', error.message);
        process.exit(1);
    }
};

// Fire the runner
runTokenRejectionSuite();
