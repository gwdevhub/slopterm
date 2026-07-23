import { useRef, useState } from 'react'
import {
  localDelete,
  localList,
  localMkdir,
  localRename,
  sftpDelete,
  sftpDownload,
  sftpList,
  sftpMkdir,
  sftpRename,
  sftpUpload,
  sftpUploadBytes,
} from '../lib/api'
import { FilePane, type DraggedFile, type FilePaneActions, type FilePaneSide } from './FilePane'

interface SftpViewProps {
  sessionId: string
  homeDirectory: string
}

function fileName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

// The dual-pane SFTP browser opened by a host card's "SFTP" button: local filesystem on
// the left, the connected host's remote filesystem on the right. Dragging a file from one
// pane onto the other uploads/downloads it into whichever directory that pane currently
// shows - this is the one place that needs to know about both panes at once, so it owns
// the transfer itself rather than FilePane (which stays a single reusable component for
// either side). It also owns the file-management actions (rename/delete/mkdir plus the
// bulk transfer of a pane's selection onto the other pane), handing each pane a
// FilePaneActions bundle that hits the local or remote endpoints as appropriate.
export function SftpView({ sessionId, homeDirectory }: SftpViewProps) {
  const [localPath, setLocalPath] = useState<string>()
  const [remotePath, setRemotePath] = useState(homeDirectory)
  const [localReloadToken, setLocalReloadToken] = useState(0)
  const [remoteReloadToken, setRemoteReloadToken] = useState(0)
  const [transferStatus, setTransferStatus] = useState<{ message: string; error?: boolean } | null>(null)
  const transferIdRef = useRef(0)

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
    const name = fileName(file.path)
    setTransferStatus({ message: destSide === 'remote' ? `Uploading ${name}…` : `Downloading ${name}…` })
    try {
      if (destSide === 'remote') {
        await sftpUpload(sessionId, file.path, destDir)
      } else {
        await sftpDownload(sessionId, file.path, destDir)
      }
      setTransferStatus({ message: destSide === 'remote' ? `Uploaded ${name}` : `Downloaded ${name}` })
      if (destSide === 'remote') {
        reloadRemote()
      } else {
        reloadLocal()
      }
      // Only clears the banner if no other transfer started in the meantime.
      setTimeout(() => {
        if (transferIdRef.current === thisTransferId) setTransferStatus(null)
      }, 3000)
    } catch (err) {
      setTransferStatus({ message: err instanceof Error ? err.message : 'Transfer failed', error: true })
    }
  }

  // Transferring a pane's selection is the multi-select counterpart of drag-and-drop:
  // local files upload into the remote pane's current dir, remote files download into the
  // local pane's current dir. Runs sequentially so one failure surfaces without leaving the
  // banner mid-count.
  async function transferSelection(fromSide: FilePaneSide, paths: string[]) {
    const destDir = fromSide === 'local' ? remotePath : localPath
    if (!destDir || paths.length === 0) return

    const thisTransferId = ++transferIdRef.current
    const verb = fromSide === 'local' ? 'Uploading' : 'Downloading'
    for (const path of paths) {
      setTransferStatus({ message: `${verb} ${fileName(path)}…` })
      if (fromSide === 'local') await sftpUpload(sessionId, path, destDir)
      else await sftpDownload(sessionId, path, destDir)
    }

    setTransferStatus({ message: `${fromSide === 'local' ? 'Uploaded' : 'Downloaded'} ${paths.length} file${paths.length === 1 ? '' : 's'}` })
    if (fromSide === 'local') reloadRemote()
    else reloadLocal()
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
  }

  // Files dragged in from the OS's own file manager (Explorer/Finder/Nautilus). On the
  // remote pane this uploads them into its current directory (their bytes come straight
  // from the browser, so there's no local path for the path-based upload above). The local
  // pane can't be a target this way - a browser File has no source path on this machine to
  // copy from - so it just reports that rather than silently doing nothing.
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
    </div>
  )
}
