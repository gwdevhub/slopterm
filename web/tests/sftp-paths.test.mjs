// Run directly with Node 22's native type stripping; no project build or compiler.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { folderSyncDefaults, joinPanePath, paneFileName } from '../src/lib/sftpPaths.ts'

test('pane paths retain POSIX, Windows drive, and UNC separators', () => {
  assert.equal(joinPanePath('/', 'nested folder', 'remote'), '/nested folder')
  assert.equal(joinPanePath('/srv/files/', '資料', 'remote'), '/srv/files/資料')
  assert.equal(joinPanePath('C:\\Users\\me', 'folder', 'local'), 'C:\\Users\\me\\folder')
  assert.equal(joinPanePath('C:\\', 'folder', 'local'), 'C:\\folder')
  assert.equal(joinPanePath('C:/Users/me/', 'folder', 'local'), 'C:/Users/me/folder')
  assert.equal(joinPanePath('C:\\Users\\me/', 'folder', 'local'), 'C:\\Users\\me/folder')
  assert.equal(joinPanePath('\\\\server\\share', 'folder', 'local'), '\\\\server\\share\\folder')
})

test('a POSIX backslash in a filename is not treated as a separator', () => {
  assert.equal(paneFileName('/srv/a\\b/', 'remote'), 'a\\b')
  assert.equal(paneFileName('/tmp/a\\b', 'local'), 'a\\b')
  assert.equal(joinPanePath('/tmp/a\\b', 'nested', 'local'), '/tmp/a\\b/nested')
  assert.equal(paneFileName('C:\\Users\\me\\folder\\', 'local'), 'folder')
  assert.equal(paneFileName('C:/Users/me\\folder/', 'local'), 'folder')
  assert.equal(paneFileName('\\\\server\\share\\folder', 'local'), 'folder')
})

test('pull sync targets the selected remote folder under the local pane', () => {
  assert.deepEqual(folderSyncDefaults('host-1', 'remote', '/srv/project data/', 'C:\\Downloads', '/srv'), {
    hostId: 'host-1',
    localPath: 'C:\\Downloads\\project data',
    remotePath: '/srv/project data/',
    direction: 'remoteToLocal',
    autoStart: false,
    deleteExtraneous: false,
    skipUnchanged: true,
  })
})

test('push sync preserves the selected folder name and remote POSIX paths', () => {
  const rule = folderSyncDefaults('host-2', 'local', 'C:\\Projects\\nested folder\\', 'C:\\Projects', '/')
  assert.equal(rule.localPath, 'C:\\Projects\\nested folder\\')
  assert.equal(rule.remotePath, '/nested folder')
  assert.equal(rule.direction, 'localToRemote')
  assert.equal(rule.deleteExtraneous, false)
})

test('sync preserves literal whitespace, Unicode, and POSIX backslashes', () => {
  const rule = folderSyncDefaults('host', 'remote', '/srv/資料 a\\b ', '/tmp/downloads', '/srv')
  assert.equal(rule.localPath, '/tmp/downloads/資料 a\\b ')
  assert.equal(rule.remotePath, '/srv/資料 a\\b ')
})

test('sync rejects filesystem roots instead of merging their contents into the destination pane', () => {
  for (const [side, path] of [['remote', '/'], ['local', '/'], ['local', 'C:\\'], ['local', 'C:/']]) {
    assert.throws(() => folderSyncDefaults('host', side, path, '/tmp', '/srv'), /named folder/)
  }
})

test('folder actions remain connected from the pane through recursive API handlers', () => {
  const source = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8')
  const pane = source('../src/components/FilePane.tsx')
  assert.match(pane, /handleTransfer\(targets\)/)
  assert.doesNotMatch(pane, /targets\.filter\(.*!.*isDirectory/)
  assert.doesNotMatch(pane, /draggable=\{!entry\.isDirectory\}/)
  assert.match(pane, /target\.isDirectory && actions\.syncFolder/)
  assert.match(source('../src/App.tsx'), /hostId=\{tab\.request\?\.hostId\}/)
  const host = source('../../core/SloptermHost.cs')
  assert.match(host, /session\.UploadAsync\(request\.LocalPath, request\.RemoteDir, ct\)/)
  assert.match(host, /session\.DownloadAsync\(request\.RemotePath, request\.LocalDir, ct\)/)
  const session = source('../../core/SftpSession.cs')
  assert.match(session, /await UploadAsync\(child, destination, ct\)/)
  assert.match(session, /await DownloadEntryAsync\(SftpPaths\.JoinRemote\(remotePath, entry\.Name\), localPath, entry, ct\)/)
})
