/**
 * Hushh Research Monorepo - Environment Variable Structure Integrity Validator
 * * Compares local .env schema structures against the upstream .env.example framework
 * to protect developer velocity without tracking or exposing actual secret values.
 */
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '../.env');
const examplePath = path.join(__dirname, '../.env.example');

console.log('\x1b[36m%s\x1b[0m', '🔍 Auditing local environment variable structure consistency...');

if (!fs.existsSync(examplePath)) {
    console.log('\x1b[33m%s\x1b[0m', '⚠️  No .env.example file detected at root layout. Skipping structural validation.');
    process.exit(0);
}

if (!fs.existsSync(envPath)) {
    console.log('\x1b[31m%s\x1b[0m', '❌ Missing local .env configuration file.');
    console.log('💡 Action: Copy .env.example to .env and populate structural keys safely.\n');
    process.exit(0);
}

const parseKeys = (filePath) => {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return content
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#'))
            .map(line => line.split('=')[0].trim())
            .filter(key => key.length > 0);
    } catch (err) {
        return [];
    }
};

const currentKeys = new Set(parseKeys(envPath));
const expectedKeys = parseKeys(examplePath);

const missingKeys = expectedKeys.filter(key => !currentKeys.has(key));

if (missingKeys.length > 0) {
    console.log('\x1b[31m%s\x1b[0m', '⚠️  Environment Configuration Structural Discrepancy Found:');
    console.log('The following schema variables are defined in .env.example but missing locally:');
    missingKeys.forEach(key => console.log(`  - \x1b[33m${key}\x1b[0m`));
    console.log('\x1b[34m%s\x1b[0m', '\n💡 Action: Append missing structure variables to your local .env workspace.\n');
} else {
    console.log('\x1b[32m%s\x1b[0m', '✅ Local workspace configuration schema perfectly aligned with upstream expectations!\n');
}
