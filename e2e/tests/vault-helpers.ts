import { expect, type Page } from '@playwright/test'

// All e2e files share ONE server/vault, so every vault-touching test must use the SAME
// master password and be defensive about current state rather than assume fresh setup.
export const E2E_VAULT_PASSWORD = 'e2e-shared-test-master-password'

export function gotoSection(page: Page, name: string) {
  // Exact match avoids substring collisions; the mobile overlay's same-named button is
  // excluded from the accessibility tree via display:none at the desktop test viewport.
  return page.getByRole('button', { name, exact: true }).click()
}

// Closing a tab opens a ConfirmDialog (Close/Cancel), so every caller needs both clicks.
// `first` closes a specific one of two identically-labeled tabs.
export async function closeTab(page: Page, label: string, options?: { first?: boolean }) {
  const closeButton = page.getByRole('button', { name: `Close ${label}` })
  await (options?.first ? closeButton.first() : closeButton).click()
  await page.getByRole('button', { name: 'Close', exact: true }).click()
}

// Deletes a saved host via its card's edit button, confirming through the shared
// ConfirmDialog the same way closeTab does.
export async function deleteHost(page: Page, name: string) {
  await page.getByRole('button', { name: `Edit ${name}` }).click()
  await page.getByRole('button', { name: 'Delete host' }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
}

export async function ensureVaultUnlocked(page: Page) {
  // VaultGate shows "Loading vault..." during its initial fetch; checking isVisible() before
  // that resolves is a false negative that would skip setup/unlock entirely.
  await expect(page.getByText('Loading vault')).not.toBeVisible({ timeout: 10_000 })

  // Scoped to the placeholder: unlocked sections (e.g. Keychain) have their own password
  // fields, so input[type=password] would re-resolve to one of those instead of "gone".
  const passwordInput = page.getByPlaceholder('Master password')
  if (await passwordInput.isVisible().catch(() => false)) {
    await passwordInput.fill(E2E_VAULT_PASSWORD)
    await page.click('button:has-text("Create vault"), button:has-text("Unlock")')
    // Argon2id takes real time (~1.6s) - wait for the password form to actually go away
    // instead of a fixed sleep.
    await expect(passwordInput).not.toBeVisible({ timeout: 10_000 })
  }
}
