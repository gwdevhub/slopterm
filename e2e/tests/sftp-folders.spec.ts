import { test, expect, type Page } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureVaultUnlocked, gotoSection } from './vault-helpers'

const HERE = dirname(fileURLToPath(import.meta.url))
const ctx = JSON.parse(readFileSync(resolve(HERE, '../.tmp/context.json'), 'utf-8')) as {
  baseUrl: string
  sshHost: string
  sshPort: number
  sshUsername: string
  sshPassword: string
}
const origin = new URL(ctx.baseUrl).origin

async function openFolderSession(page: Page) {
  const hostName = `folder test ${Date.now()}`
  await page.goto(ctx.baseUrl)
  await gotoSection(page, 'Hosts')
  await ensureVaultUnlocked(page)
  await page.click('button:has-text("New host")')
  await page.fill('#name', hostName)
  await page.fill('#host', ctx.sshHost)
  await page.fill('#port', String(ctx.sshPort))
  await page.fill('#username', ctx.sshUsername)
  await page.fill('#password', ctx.sshPassword)
  await page.click('button:has-text("Save host")')
  const connected = page.waitForResponse((response) => response.url().endsWith('/api/sftp/connect'))
  await page.getByRole('button', { name: `SFTP to ${hostName}` }).click()
  const response = await connected
  expect(response.ok()).toBeTruthy()
  const { sessionId, homeDirectory } = await response.json() as { sessionId: string; homeDirectory: string }
  const hostId = response.request().postDataJSON().hostId as string
  const local = page.getByRole('region', { name: 'Local', exact: true })
  const remote = page.getByRole('region', { name: 'Remote', exact: true })
  await expect(remote.getByText('.ssh', { exact: true })).toBeVisible()
  return { local, remote, sessionId, homeDirectory, hostId }
}

function folderFixture() {
  const root = mkdtempSync(join(homedir(), 'e2e-sftp-folders-'))
  const name = `${basename(root)} project 資料`
  const folder = join(root, name)
  mkdirSync(join(folder, 'nested folder'), { recursive: true })
  mkdirSync(join(folder, 'empty folder'))
  mkdirSync(join(root, 'downloads'))
  writeFileSync(join(folder, 'nested folder', '資料.txt'), 'nested folder contents')
  return { root, name, folder }
}

test('SFTP transfers folders recursively by drag and mixed-selection download', async ({ page }) => {
  const fixture = folderFixture()
  const sibling = `${basename(fixture.root)} companion.txt`
  writeFileSync(join(fixture.root, sibling), 'companion contents')
  const session = await openFolderSession(page)
  const remotePath = `${session.homeDirectory}/${fixture.name}`
  try {
    await session.local.getByText(basename(fixture.root), { exact: true }).click()
    await session.local.getByText(fixture.name, { exact: true }).dragTo(session.remote)
    await expect(page.getByText(`Uploaded ${fixture.name}`, { exact: true })).toBeVisible()
    await session.local.getByText(sibling, { exact: true }).dragTo(session.remote)
    await expect(session.remote.getByText(sibling, { exact: true })).toBeVisible()

    await session.local.getByText('downloads', { exact: true }).click()
    await session.remote.getByText(fixture.name, { exact: true }).click({ modifiers: ['Control'] })
    await session.remote.getByText(sibling, { exact: true }).click({ modifiers: ['Control'] })
    await session.remote.getByText(fixture.name, { exact: true }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Download 2 items', exact: true }).click()
    await expect(page.getByText('Downloaded 2 items', { exact: true })).toBeVisible()

    const downloaded = join(fixture.root, 'downloads', fixture.name)
    expect(readFileSync(join(downloaded, 'nested folder', '資料.txt'), 'utf8')).toBe('nested folder contents')
    expect(existsSync(join(downloaded, 'empty folder'))).toBeTruthy()
    expect(readFileSync(join(fixture.root, 'downloads', sibling), 'utf8')).toBe('companion contents')

    // Repeating a folder transfer merges existing directories and overwrites files;
    // trailing POSIX separators must not lose the source folder's name.
    writeFileSync(join(downloaded, 'nested folder', '資料.txt'), 'replace me')
    const repeated = await page.request.post(`${origin}/api/sftp/${session.sessionId}/download`, {
      data: { remotePath: `${remotePath}///`, localDir: join(fixture.root, 'downloads') },
    })
    expect(repeated.ok()).toBeTruthy()
    expect(readFileSync(join(downloaded, 'nested folder', '資料.txt'), 'utf8')).toBe('nested folder contents')
  } finally {
    for (const path of [remotePath, `${session.homeDirectory}/${sibling}`]) {
      await page.request.post(`${origin}/api/sftp/${session.sessionId}/delete`, { data: { path } })
    }
    await page.request.delete(`${origin}/api/sftp/session/${session.sessionId}`)
    await page.request.delete(`${origin}/api/vault/hosts/${session.hostId}`)
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('SFTP folder sync prefills pull/push paths and syncs nested and empty folders', async ({ page }) => {
  test.setTimeout(60_000)
  const fixture = folderFixture()
  const session = await openFolderSession(page)
  const remotePath = `${session.homeDirectory}/${fixture.name}`
  const ruleIds: string[] = []
  async function saveAndStart() {
    const saved = page.waitForResponse((response) => response.url().endsWith('/api/vault/sync-rules') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Add and start sync rule', exact: true }).click()
    const response = await saved
    expect(response.ok()).toBeTruthy()
    const { id } = await response.json() as { id: string }
    ruleIds.push(id)
    await expect(page.getByText('Folder sync started. Manage or stop it in Folder Sync.', { exact: true })).toBeVisible()
    return id
  }
  try {
    await session.local.getByText(basename(fixture.root), { exact: true }).click()
    await session.local.getByText(fixture.name, { exact: true }).dragTo(session.remote)
    await expect(session.remote.getByText(fixture.name, { exact: true })).toBeVisible()
    await session.local.getByText('downloads', { exact: true }).click()

    await session.remote.getByText(fixture.name, { exact: true }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Sync folder…', exact: true }).click()
    const pulled = join(fixture.root, 'downloads', fixture.name)
    await expect(page.locator('#sr-host')).toHaveValue(session.hostId)
    await expect(page.locator('#sr-local')).toHaveValue(pulled)
    await expect(page.locator('#sr-remote')).toHaveValue(remotePath)
    await expect(page.locator('#sr-direction')).toHaveValue('remoteToLocal')
    await expect(page.getByLabel('Delete files that were removed at the source', { exact: false })).not.toBeChecked()
    const pullRuleId = await saveAndStart()
    await expect.poll(() => existsSync(join(pulled, 'nested folder', '資料.txt'))).toBeTruthy()
    expect(existsSync(join(pulled, 'empty folder'))).toBeTruthy()

    const remoteDir = encodeURIComponent(`${remotePath}/nested folder`)
    const updated = await page.request.post(`${origin}/api/sftp/${session.sessionId}/upload-bytes?name=${encodeURIComponent('資料.txt')}&remoteDir=${remoteDir}`, {
      data: Buffer.from('updated remote nested contents'),
      headers: { 'Content-Type': 'application/octet-stream' },
    })
    expect(updated.ok()).toBeTruthy()
    await expect.poll(() => readFileSync(join(pulled, 'nested folder', '資料.txt'), 'utf8'), { timeout: 15_000 }).toBe('updated remote nested contents')
    await page.request.post(`${origin}/api/sync/rules/${pullRuleId}/stop`)

    await session.local.getByRole('button', { name: '..', exact: true }).click()
    await session.local.getByText(fixture.name, { exact: true }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Sync folder…', exact: true }).click()
    await expect(page.locator('#sr-local')).toHaveValue(fixture.folder)
    await expect(page.locator('#sr-remote')).toHaveValue(remotePath)
    await expect(page.locator('#sr-direction')).toHaveValue('localToRemote')
    await page.request.post(`${origin}/api/sftp/${session.sessionId}/delete`, { data: { path: remotePath } })
    await saveAndStart()

    const listed = async (path: string) => page.request.get(`${origin}/api/sftp/${session.sessionId}/list?path=${encodeURIComponent(path)}`)
    await expect.poll(async () => (await listed(`${remotePath}/empty folder`)).ok()).toBeTruthy()
    // A directory moved into a watched root produces one directory event, not a
    // separate Created event for each child. Its populated tree must still sync.
    const moved = join(fixture.root, 'move source')
    mkdirSync(join(moved, 'nested'), { recursive: true })
    mkdirSync(join(moved, 'empty'))
    writeFileSync(join(moved, 'nested', 'moved.txt'), 'moved nested contents')
    renameSync(moved, join(fixture.folder, 'moved folder'))
    await expect.poll(async () => (await listed(`${remotePath}/moved folder/empty`)).ok(), { timeout: 15_000 }).toBeTruthy()
    const remoteFile = `${remotePath}/moved folder/nested/moved.txt`
    await expect.poll(async () => {
      const response = await page.request.post(`${origin}/api/sftp/${session.sessionId}/download`, {
        data: { remotePath: remoteFile, localDir: join(fixture.root, 'downloads') },
      })
      return response.ok() ? readFileSync(join(fixture.root, 'downloads', 'moved.txt'), 'utf8') : ''
    }, { timeout: 15_000 }).toBe('moved nested contents')
  } finally {
    for (const id of ruleIds) await page.request.delete(`${origin}/api/vault/sync-rules/${id}`)
    await page.request.post(`${origin}/api/sftp/${session.sessionId}/delete`, { data: { path: remotePath } })
    await page.request.delete(`${origin}/api/sftp/session/${session.sessionId}`)
    await page.request.delete(`${origin}/api/vault/hosts/${session.hostId}`)
    rmSync(fixture.root, { recursive: true, force: true })
  }
})
