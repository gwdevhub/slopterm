import { expect, type Page } from '@playwright/test'

// All e2e test files share ONE server/vault for the whole suite run (global-setup.ts
// starts a single dotnet process, not one per file) - so every vault-touching test must
// use the SAME master password (whichever test creates the vault first "wins" it) and
// must be defensive about current state (setup vs. already-unlocked-by-another-test-file)
// rather than assuming it's always the fresh setup flow.
export const E2E_VAULT_PASSWORD = 'e2e-shared-test-master-password'

export function gotoSection(page: Page, name: string) {
  // Exact match matters in case a label is ever a substring of another (a has-text()/
  // text= selector would ambiguously match both). Resolves to the desktop sidebar's
  // button - the mobile menu overlay's equivalent button shares the same accessible
  // name, but it's excluded from the accessibility tree (and so from this lookup) via
  // `display:none` at the default (desktop-sized) test viewport.
  return page.getByRole('button', { name, exact: true }).click()
}

// Closing a tab now opens a ConfirmDialog (Close/Cancel) instead of closing immediately -
// every test that closes a tab needs both clicks, so this is the one place that knows it.
// `first` matches tabs.spec.ts's need to close a specific one of two identically-labeled
// tabs (both sessions to the same host).
export async function closeTab(page: Page, label: string, options?: { first?: boolean }) {
  const closeButton = page.getByRole('button', { name: `Close ${label}` })
  await (options?.first ? closeButton.first() : closeButton).click()
  await page.getByRole('button', { name: 'Close', exact: true }).click()
}

// Deletes a saved host via its card's edit (pencil) button - there's no more side panel
// to select a host into, so this is the only path to Delete now. Confirms through the
// shared ConfirmDialog the same way closeTab does above.
export async function deleteHost(page: Page, name: string) {
  await page.getByRole('button', { name: `Edit ${name}` }).click()
  await page.getByRole('button', { name: 'Delete host' }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
}

export async function ensureVaultUnlocked(page: Page) {
  // VaultGate shows "Loading vault..." while its initial status fetch is in flight -
  // checking isVisible() before that resolves gives a false negative (nothing has
  // rendered yet, not "already unlocked"), which would skip setup/unlock entirely.
  await expect(page.getByText('Loading vault')).not.toBeVisible({ timeout: 10_000 })

  // Scoped to the placeholder, not just input[type=password] - some vault-backed
  // sections (e.g. Keychain) have their own password-type fields once unlocked, and a
  // generic selector would re-resolve to one of those instead of "gone" below.
  const passwordInput = page.getByPlaceholder('Master password')
  if (await passwordInput.isVisible().catch(() => false)) {
    await passwordInput.fill(E2E_VAULT_PASSWORD)
    await page.click('button:has-text("Create vault"), button:has-text("Unlock")')
    // Argon2id takes real time (~1.6s) - wait for the password form to actually go away
    // instead of a fixed sleep.
    await expect(passwordInput).not.toBeVisible({ timeout: 10_000 })
  }
}
