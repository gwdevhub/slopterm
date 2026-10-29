import { useRef, useState } from 'react'
import {
  localDelete,
  localList,
  localMkdir,
  localRename,
  listHosts,
  sftpDelete,
  sftpDownload,
  sftpList,
  sftpMkdir,
  sftpRename,
  sftpUpload,
  sftpUploadBytes,
  startSyncRule,
  type SavedHost,
  type SyncRuleRecord,
} from '../lib/api'
import { folderSyncDefaults, paneFileName } from '../lib/sftpPaths'
import { FilePane, type DraggedFile, type FilePaneActions, type FilePaneSide } from './FilePane'
import { SyncRuleModal } from './SyncSection'

interface SftpViewProps {
  sessionId: string
  homeDirectory: string
  hostId?: string
}

// The dual-pane SFTP browser: local filesystem on the left, the host's remote filesystem on
// the right. It owns transfers and file-management actions, handing each pane a FilePaneActions.
export function SftpView({ sessionId, homeDirectory, hostId }: SftpViewProps) {
  const [localPath, setLocalPath] = useState<string>()
  const [remotePath, setRemotePath] = useState(homeDirectory)
  const [localReloadToken, setLocalReloadToken] = useState(0)
  const [remoteReloadToken, setRemoteReloadToken] = useState(0)
  const [transferStatus, setTransferStatus] = useState<{ message: string; error?: boolean } | null>(null)
  const transferIdRef = useRef(0)
  const [syncDraft, setSyncDraft] = useState<{ hosts: SavedHost[]; defaults: SyncRuleRecord } | null>(null)

  async function configureFolderSync(side: FilePaneSide, path: string) {
    if (!hostId) throw new Error('Save this host before creating a folder sync rule.')
    if (!localPath) throw new Error('Wait for the local folder listing before configuring sync.')
    const hosts = await listHosts()
    if (!hosts.some((host) => host.id === hostId)) throw new Error('The saved host for this SFTP tab no longer exists.')
    setSyncDraft({ hosts, defaults: folderSyncDefaults(hostId, side, path, localPath, remotePath) })
  }

  async function startFolderSync(id: string) {
    setSyncDraft(null)
    ++transferIdRef.current
    try {
      await startSyncRule(id)
      setTransferStatus({ message: 'Folder sync started. Manage or stop it in Folder Sync.' })
    } catch (err) {
      setTransferStatus({ message: `Sync rule saved, but could not start: ${err instanceof Error ? err.message : 'Unknown error'}. Manage it in Folder Sync.`, error: true })
    }
  }

  function reloadLocal() {
    setLocalReloadToken((t) => t + 1)
  }

  function reloadRemote() {
    setRemoteReloadToken((t) => t + 1)
  }

  async function handleDrop(destSide: FilePaneSide, file: DraggedFile) {
    const destDir = destSide === 'local' ? localPath : remotePath
    if (!destDir) return

    const thisTransferId = ++transferIdRef.current
    const name = paneFileName(file.path, file.side)
    setTransferStatus({ message: destSide === 'remote' ? `Uploading ${name}…` : `Downloading ${name}…` })
    try {
      if (destSide === 'remote') {
        await sftpUpload(sessionId, file.path, destDir)
      } else {
        await sftpDownload(sessionId, file.path, destDir)
      }
      setTransferStatus({ message: destSide === 'remote' ? `Uploaded ${name}` : `Downloaded ${name}` })
      // Only clears the banner if no other transfer started in the meantime.
      setTimeout(() => {
        if (transferIdRef.current === thisTransferId) setTransferStatus(null)
      }, 3000)
    } catch (err) {
      setTransferStatus({ message: err instanceof Error ? err.message : 'Transfer failed', error: true })
    } finally {
      // A failed recursive transfer may still have copied some children.
      if (destSide === 'remote') reloadRemote()
      else reloadLocal()
    }
  }

  // The multi-select counterpart of drag-and-drop: a pane's selection transfers into the
  // other pane's current dir. Runs sequentially so one failure surfaces without a mid-count banner.
  async function transferSelection(fromSide: FilePaneSide, paths: string[]) {
    const destDir = fromSide === 'local' ? remotePath : localPath
    if (!destDir || paths.length === 0) return

    const thisTransferId = ++transferIdRef.current
    const verb = fromSide === 'local' ? 'Uploading' : 'Downloading'
    try {
      for (const path of paths) {
        setTransferStatus({ message: `${verb} ${paneFileName(path, fromSide)}…` })
        if (fromSide === 'local') await sftpUpload(sessionId, path, destDir)
        else await sftpDownload(sessionId, path, destDir)
      }
    } catch (err) {
      setTransferStatus({ message: err instanceof Error ? err.message : 'Transfer failed', error: true })
      throw err
    } finally {
      if (fromSide === 'local') reloadRemote()
      else reloadLocal()
    }

    setTransferStatus({ message: `${fromSide === 'local' ? 'Uploaded' : 'Downloaded'} ${paths.length} item${paths.length === 1 ? '' : 's'}` })
    setTimeout(() => {
      if (transferIdRef.current === thisTransferId) setTransferStatus(null)
    }, 3000)
  }

  const localActions: FilePaneActions = {
    rename: async (path, newName) => {
      await localRename(path, newName)
      reloadLocal()
    },
    remove: async (paths) => {
      for (const path of paths) await localDelete(path)
      reloadLocal()
    },
    makeDirectory: async (parentDir, name) => {
      await localMkdir(parentDir, name)
      reloadLocal()
    },
    transfer: (paths) => transferSelection('local', paths),
    syncFolder: (path) => configureFolderSync('local', path),
  }

  const remoteActions: FilePaneActions = {
    rename: async (path, newName) => {
      await sftpRename(sessionId, path, newName)
      reloadRemote()
    },
    remove: async (paths) => {
      for (const path of paths) await sftpDelete(sessionId, path)
      reloadRemote()
    },
    makeDirectory: async (parentDir, name) => {
      await sftpMkdir(sessionId, parentDir, name)
      reloadRemote()
    },
    transfer: (paths) => transferSelection('remote', paths),
    syncFolder: (path) => configureFolderSync('remote', path),
  }

  // Files dragged in from the OS's file manager upload into the remote pane. The local pane
  // can't be a target this way - a browser File has no source path on this machine.
  async function handleOsDrop(destSide: FilePaneSide, files: FileList) {
    if (destSide === 'local') {
      setTransferStatus({ message: 'Drag files onto the remote pane to upload them.', error: true })
      return
    }
    if (!remotePath) return

    for (const file of Array.from(files)) {
      const thisTransferId = ++transferIdRef.current
      setTransferStatus({ message: `Uploading ${file.name}…` })
      try {
        await sftpUploadBytes(sessionId, file, remotePath)
        setTransferStatus({ message: `Uploaded ${file.name}` })
        setRemoteReloadToken((t) => t + 1)
        setTimeout(() => {
          if (transferIdRef.current === thisTransferId) setTransferStatus(null)
        }, 3000)
      } catch (err) {
        setTransferStatus({ message: err instanceof Error ? err.message : 'Upload failed', error: true })
      }
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {transferStatus && (
        <p className={`shrink-0 border-b border-slate-800 px-3 py-1.5 text-sm ${transferStatus.error ? 'bg-red-950/60 text-red-300' : 'bg-slate-900 text-slate-300'}`}>
          {transferStatus.message}
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <FilePane
          title="Local"
          side="local"
          list={(path) => localList(path)}
          reloadToken={localReloadToken}
          onPathChange={setLocalPath}
          onDropFile={(file) => void handleDrop('local', file)}
          actions={localActions}
          transferLabel="Upload"
          onDropOsFiles={(files) => void handleOsDrop('local', files)}
        />
        <FilePane
          title="Remote"
          side="remote"
          initialPath={homeDirectory}
          list={(path) => sftpList(sessionId, path ?? homeDirectory)}
          reloadToken={remoteReloadToken}
          onPathChange={setRemotePath}
          onDropFile={(file) => void handleDrop('remote', file)}
          actions={remoteActions}
          transferLabel="Download"
          onDropOsFiles={(files) => void handleOsDrop('remote', files)}
        />
      </div>
      {syncDraft && (
        <SyncRuleModal
          rule={null}
          hosts={syncDraft.hosts}
          defaults={syncDraft.defaults}
          submitLabel="Add and start sync rule"
          onClose={() => setSyncDraft(null)}
          onSaved={(id) => void startFolderSync(id)}
        />
      )}
    </div>
  )
}
