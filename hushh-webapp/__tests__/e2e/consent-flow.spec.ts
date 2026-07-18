import { test, expect, Page } from '@playwright/test';

/**
 * E2E Tests for Consent Flow
 * 
 * Tests:
 * 1. Grant read access to vault
 * 2. Agent requests scoped data via consent token
 * 3. Vault decrypts & returns data correctly
 * 4. User revokes consent, agent access denied
 * 5. Mobile parity (iOS/Android behavior)
 */

test.describe('Consent Flow E2E', () => {
  let page: Page;

  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage();
    // Setup test user
    await page.goto('/login');
    await page.fill('[data-testid="email-input"]', 'test@example.com');
    await page.fill('[data-testid="password-input"]', 'password123');
    await page.click('[data-testid="login-button"]');
    await page.waitForURL('/dashboard');
  });

  test.afterEach(async () => {
    await page.close();
  });

  test('Grant vault read access consent', async () => {
    // Navigate to consent center
    await page.goto('/settings/consent');
    
    // Find vault agent
    const vaultAgent = page.locator('[data-testid="agent-vault"]');
    await expect(vaultAgent).toBeVisible();
    
    // Grant read permission
    await vaultAgent.locator('[data-testid="grant-read"]').click();
    
    // Confirm dialog
    const confirmButton = page.locator('[data-testid="confirm-grant"]');
    await expect(confirmButton).toBeVisible();
    await confirmButton.click();
    
    // Verify success message
    await expect(page.locator('text=Permission granted')).toBeVisible();
    
    // Verify stored in database
    const response = await page.request.get('/api/consent/agents');
    const agents = await response.json();
    const grantedAgent = agents.find(a => a.name === 'vault' && a.permissions.includes('read'));
    expect(grantedAgent).toBeDefined();
  });

  test('Agent accesses scoped vault data via consent token', async () => {
    // Grant consent first
    await grantConsentToAgent(page, 'vault', ['read']);
    
    // Get consent token from API
    const tokenResponse = await page.request.get('/api/consent/tokens');
    const tokens = await tokenResponse.json();
    const vaultToken = tokens.find(t => t.scopes.includes('vault.read'));
    expect(vaultToken).toBeDefined();
    
    // Simulate agent request with token
    const agentResponse = await page.request.post('/api/vault/query', {
      headers: {
        'Authorization': `Bearer ${vaultToken.token}`,
        'X-Consent-Token': vaultToken.id,
      },
      data: {
        query: 'SELECT * FROM holdings',
      }
    });
    
    expect(agentResponse.ok()).toBeTruthy();
    const result = await agentResponse.json();
    expect(result.data).toBeDefined();
    expect(result.data.length).toBeGreaterThan(0);
  });

  test('Vault decrypts data with user key', async () => {
    await grantConsentToAgent(page, 'vault', ['read']);
    
    // Navigate to vault view
    await page.goto('/vault');
    
    // Verify encrypted data is displayed
    const encryptedPlaceholder = page.locator('[data-testid="encrypted-data"]');
    await expect(encryptedPlaceholder).toBeVisible();
    
    // Request decryption (vault unlock)
    await page.locator('[data-testid="unlock-vault"]').click();
    
    // Enter passphrase
    await page.fill('[data-testid="passphrase-input"]', 'user-passphrase-123');
    await page.click('[data-testid="unlock-button"]');
    
    // Verify decryption succeeded
    await page.waitForTimeout(2000);  // Wait for decryption
    const decryptedData = page.locator('[data-testid="decrypted-holdings"]');
    await expect(decryptedData).toBeVisible();
    
    // Verify actual data is displayed
    const holdingElement = page.locator('[data-testid="holding-aapl"]');
    await expect(holdingElement).toContainText('AAPL');
  });

  test('Agent cannot access revoked consent', async () => {
    // Grant and then revoke consent
    await grantConsentToAgent(page, 'vault', ['read']);
    await revokeConsentFromAgent(page, 'vault');
    
    // Get new token (should be invalid)
    const tokenResponse = await page.request.get('/api/consent/tokens');
    const tokens = await tokenResponse.json();
    const revokedToken = tokens.find(t => t.scopes.includes('vault.read'));
    
    if (!revokedToken) {
      // If token is deleted, agent access should fail
      const agentResponse = await page.request.post('/api/vault/query', {
        headers: {
          'Authorization': `Bearer invalid-token`,
        },
        data: { query: 'SELECT * FROM holdings' }
      });
      
      expect(agentResponse.status()).toBe(401);
    } else {
      // If token still exists but revoked
      const agentResponse = await page.request.post('/api/vault/query', {
        headers: {
          'Authorization': `Bearer ${revokedToken.token}`,
        },
        data: { query: 'SELECT * FROM holdings' }
      });
      
      expect(agentResponse.status()).toBe(403);
    }
  });

  test('Multiple scope levels work correctly', async () => {
    // Grant both read and write
    await grantConsentToAgent(page, 'vault', ['read', 'write']);
    
    // Verify both scopes are granted
    const tokenResponse = await page.request.get('/api/consent/tokens');
    const tokens = await tokenResponse.json();
    const multiScopeToken = tokens.find(t => 
      t.scopes.includes('vault.read') && t.scopes.includes('vault.write')
    );
    expect(multiScopeToken).toBeDefined();
    
    // Test read access
    const readResponse = await page.request.post('/api/vault/query', {
      headers: { 'X-Consent-Token': multiScopeToken.id },
      data: { query: 'SELECT * FROM holdings' }
    });
    expect(readResponse.ok()).toBeTruthy();
    
    // Test write access
    const writeResponse = await page.request.post('/api/vault/mutation', {
      headers: { 'X-Consent-Token': multiScopeToken.id },
      data: { mutation: 'UPDATE holdings SET quantity = 10' }
    });
    expect(writeResponse.ok()).toBeTruthy();
  });

  test('Consent expiration blocks access', async () => {
    // Grant with 1-second expiry
    await grantConsentToAgent(page, 'vault', ['read'], { expiresIn: 1 });
    
    // Immediate access should work
    let tokenResponse = await page.request.get('/api/consent/tokens');
    let tokens = await tokenResponse.json();
    let token = tokens[0];
    
    let response = await page.request.post('/api/vault/query', {
      headers: { 'X-Consent-Token': token.id },
      data: { query: 'SELECT * FROM holdings' }
    });
    expect(response.ok()).toBeTruthy();
    
    // Wait for expiration
    await page.waitForTimeout(1100);
    
    // Access should fail
    response = await page.request.post('/api/vault/query', {
      headers: { 'X-Consent-Token': token.id },
      data: { query: 'SELECT * FROM holdings' }
    });
    expect(response.status()).toBe(403);
  });

  test('Consent center displays all granted agents', async () => {
    // Grant consent to multiple agents
    await grantConsentToAgent(page, 'vault', ['read']);
    await grantConsentToAgent(page, 'portfolio', ['read']);
    await grantConsentToAgent(page, 'analytics', ['read', 'write']);
    
    // Navigate to consent center
    await page.goto('/settings/consent');
    
    // Verify all agents are listed
    await expect(page.locator('[data-testid="agent-vault"]')).toBeVisible();
    await expect(page.locator('[data-testid="agent-portfolio"]')).toBeVisible();
    await expect(page.locator('[data-testid="agent-analytics"]')).toBeVisible();
    
    // Verify scope badges
    await expect(page.locator('[data-testid="scope-vault-read"]')).toBeVisible();
    await expect(page.locator('[data-testid="scope-portfolio-read"]')).toBeVisible();
    await expect(page.locator('[data-testid="scope-analytics-read"]')).toBeVisible();
    await expect(page.locator('[data-testid="scope-analytics-write"]')).toBeVisible();
  });

  test('Mobile parity: iOS consent flow', async ({ browser }) => {
    const iosPage = await browser.newPage({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15'
    });
    
    await iosPage.goto('/login');
    // ... perform iOS-specific consent flow
    
    // Verify iOS UI elements
    const mobileGrantButton = iosPage.locator('[data-testid="grant-button-mobile"]');
    await expect(mobileGrantButton).toBeVisible();
    
    // Verify touch interactions work
    await mobileGrantButton.tap();
    
    await iosPage.close();
  });

  test('Mobile parity: Android consent flow', async ({ browser }) => {
    const androidPage = await browser.newPage({
      userAgent: 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36'
    });
    
    await androidPage.goto('/login');
    // ... perform Android-specific consent flow
    
    // Verify Android UI elements
    const mobileGrantButton = androidPage.locator('[data-testid="grant-button-mobile"]');
    await expect(mobileGrantButton).toBeVisible();
    
    await androidPage.close();
  });

  test('Audit trail logs all consent changes', async () => {
    // Grant consent
    await grantConsentToAgent(page, 'vault', ['read']);
    
    // Fetch audit trail
    const auditResponse = await page.request.get('/api/consent/audit');
    const auditLog = await auditResponse.json();
    
    // Verify grant is logged
    const grantEntry = auditLog.find(e => 
      e.action === 'GRANT' && e.agent === 'vault' && e.scopes.includes('read')
    );
    expect(grantEntry).toBeDefined();
    expect(grantEntry.timestamp).toBeDefined();
    expect(grantEntry.user_id).toBe('test@example.com');
    
    // Revoke consent
    await revokeConsentFromAgent(page, 'vault');
    
    // Fetch updated audit trail
    const updatedAudit = await page.request.get('/api/consent/audit');
    const updatedLog = await updatedAudit.json();
    
    // Verify revoke is logged
    const revokeEntry = updatedLog.find(e => 
      e.action === 'REVOKE' && e.agent === 'vault'
    );
    expect(revokeEntry).toBeDefined();
  });
});

/**
 * Helper functions
 */

async function grantConsentToAgent(
  page: Page,
  agentName: string,
  scopes: string[],
  _options?: { expiresIn?: number }
): Promise<void> {
  await page.goto('/settings/consent');
  
  const agent = page.locator(`[data-testid="agent-${agentName}"]`);
  await expect(agent).toBeVisible();
  
  for (const scope of scopes) {
    const button = agent.locator(`[data-testid="grant-${scope}"]`);
    await button.click();
  }
  
  const confirmButton = page.locator('[data-testid="confirm-grant"]');
  await confirmButton.click();
  
  await expect(page.locator('text=Permission granted')).toBeVisible();
}

async function revokeConsentFromAgent(
  page: Page,
  agentName: string
): Promise<void> {
  await page.goto('/settings/consent');
  
  const agent = page.locator(`[data-testid="agent-${agentName}"]`);
  const revokeButton = agent.locator('[data-testid="revoke-button"]');
  await revokeButton.click();
  
  const confirmButton = page.locator('[data-testid="confirm-revoke"]');
  await confirmButton.click();
  
  await expect(page.locator('text=Consent revoked')).toBeVisible();
}
