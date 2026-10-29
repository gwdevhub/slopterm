import type { SyncRuleRecord } from './api'

export type FilePaneSide = 'local' | 'remote'

function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]|^\\\\/.test(path)
}

// Only local Windows paths use backslashes as separators; a backslash is a legal
// character in a POSIX remote filename (and in local filenames on Unix).
export function joinPanePath(directory: string, name: string, side: FilePaneSide): string {
  const separator = side === 'local' && isWindowsPath(directory) && directory.includes('\\') ? '\\' : '/'
  return directory.endsWith(separator) || (separator === '\\' && directory.endsWith('/'))
    ? directory + name
    : directory + separator + name
}

export function paneFileName(path: string, side: FilePaneSide): string {
  const windows = side === 'local' && isWindowsPath(path)
  return path.split(windows ? /[\\/]/ : /\//).filter(Boolean).pop() ?? path
}

// A selected folder lands *under* the other pane's current directory, just like a
// download/upload. Never silently sync the selected folder with the whole pane.
export function folderSyncDefaults(
  hostId: string,
  side: FilePaneSide,
  path: string,
  localDirectory: string,
  remoteDirectory: string,
): SyncRuleRecord {
  const name = paneFileName(path, side)
  if (name === '.' || name === '..' || name.includes('/') || (side === 'local' && /^[A-Za-z]:[\\/]*$/.test(path))) {
    throw new Error('Select a named folder rather than a filesystem root for sync.')
  }
  return {
    hostId,
    localPath: side === 'local' ? path : joinPanePath(localDirectory, name, 'local'),
    remotePath: side === 'remote' ? path : joinPanePath(remoteDirectory, name, 'remote'),
    direction: side === 'local' ? 'localToRemote' : 'remoteToLocal',
    autoStart: false,
    deleteExtraneous: false,
    skipUnchanged: true,
  }
}
