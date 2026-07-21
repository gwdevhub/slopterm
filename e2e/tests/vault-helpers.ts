import { expect, type Page } from '@playwright/test'

// All e2e test files share ONE server/vault for the whole suite run (global-setup.ts
// starts a single dotnet process, not one per file) - so every vault-touching test must
// use the SAME master password (whichever test creates the vault first "wins" it) and
// must be defensive about current state (setup vs. already-unlocked-by-another-test-file)
// rather than assuming it's always the fresh setup flow.
export const E2E_VAULT_PASSWORD = 'e2e-shared-test-master-password'

export function gotoSection(page: Page, name: string) {
  // Exact match matters for labels that are a substring of another (e.g. "Hosts" vs.
  // "Known Hosts", "Connect" vs. "Quick Connect") - a has-text()/text= selector would
  // ambiguously match both.
  return page.getByRole('button', { name, exact: true }).click()
}

export async function ensureVaultUnlocked(page: Page) {
  // VaultGate shows "Loading vault..." while its initial status fetch is in flight -
  // checking isVisible() before that resolves gives a false negative (nothing has
  // rendered yet, not "already unlocked"), which would skip setup/unlock entirely.
  await expect(page.getByText('Loading vault')).not.toBeVisible({ timeout: 10_000 })

  const passwordInput = page.locator('input[type=password]').first()
  if (await passwordInput.isVisible().catch(() => false)) {
    await passwordInput.fill(E2E_VAULT_PASSWORD)
    await page.click('button:has-text("Create vault"), button:has-text("Unlock")')
    // Argon2id takes real time (~1.6s) - wait for the password form to actually go away
    // instead of a fixed sleep.
    await expect(passwordInput).not.toBeVisible({ timeout: 10_000 })
  }
}
