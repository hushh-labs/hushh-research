# Security Policy

## Supported Versions

We release patches for security vulnerabilities in the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

The Hushh team takes security seriously. We appreciate your efforts to
responsibly disclose your findings and will make every effort to acknowledge
your contributions.

### How to Report

**DO NOT** create a public GitHub issue for security vulnerabilities.

Instead, please report security vulnerabilities through one of these channels:

1. **Email**: eng@hush1one.com
2. **GitHub Security Advisories**: [Create a private advisory](https://github.com/hushh-labs/hushh-research/security/advisories/new)

### What to Include

Please include as much of the following information as possible:

- Type of issue (e.g., buffer overflow, SQL injection, cross-site scripting)
- Full paths of source file(s) related to the issue
- Location of the affected source code (tag/branch/commit or direct URL)
- Any special configuration required to reproduce the issue
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact of the issue, including how an attacker might exploit it

### Response Timeline

- **Initial Response**: Within 48 hours
- **Status Update**: Within 7 days
- **Resolution Target**: Within 90 days (depending on complexity)

### What to Expect

1. **Acknowledgment**: We will acknowledge receipt of your report within 48 hours.

2. **Assessment**: Our security team will assess the vulnerability and determine
   its severity and impact.

3. **Communication**: We will keep you informed about our progress toward
   resolving the vulnerability.

4. **Fix**: Once confirmed, we will work on a fix and coordinate the release
   timeline with you.

5. **Credit**: We will publicly acknowledge your contribution (unless you prefer
   to remain anonymous) in our release notes or security advisory.

## Security Best Practices for Contributors

When contributing to Hushh, please follow these security guidelines:

### BYOK (Bring Your Own Key) Compliance

- **NEVER** store encryption keys on the server
- Encryption keys must remain in client memory only
- Use `VaultContext` for key management, not localStorage/sessionStorage
- All vault data stored on backend must be ciphertext only

### Consent-First Architecture

- All data access must require valid consent tokens
- Tokens must be validated on every request
- Check token expiration and revocation status
- Never bypass consent validation, even for "convenience"

### Code Security

- Never commit secrets, API keys, or credentials
- Use environment variables for sensitive configuration
- Review dependencies for known vulnerabilities
- Follow the principle of least privilege

### Testing Security

- Use dynamically generated test keys, not production keys
- Never include real user data in tests
- Test fixtures should use mock data only
- Clean up sensitive test data after tests complete

## Security-Related Configuration

### Environment Variables

These environment variables should be kept secret:

- `APP_SIGNING_KEY` - Used for signing consent tokens and state payloads
- `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT`, `DB_NAME` - Database (Supabase session pooler)
- `FIREBASE_*` - Firebase configuration
- `GOOGLE_*` - Google Cloud credentials

### Network Security

- All API endpoints use HTTPS in production
- CORS is configured to allow only trusted origins
- Rate limiting is enabled on sensitive endpoints

## Known Security Considerations

### Client-Side Encryption

User data is encrypted client-side before transmission. The server never has
access to the encryption keys. This means:

- If a user loses their vault key, their data cannot be recovered
- The server cannot decrypt user data, even for support purposes
- This is by design to protect user privacy

### Consent Tokens

Consent tokens are cryptographically signed and include:

- User ID
- Agent ID
- Scope (what data can be accessed)
- Expiration time
- Signature (HMAC-SHA256)

Tokens can be revoked at any time through the consent management interface.

## Security Updates

Security updates are released as soon as possible after a vulnerability is
confirmed. We recommend:

1. Watch this repository for releases
2. Enable Dependabot alerts
3. Subscribe to security advisories
4. Keep all dependencies up to date

## Contact

For security-related questions that are not vulnerability reports:

- Email: eng@hush1one.com
- Discord: #security channel (for general discussions only)

Thank you for helping keep Hushh and our users safe!
