import { useRef, useState } from 'react'
import { localList, sftpDownload, sftpList, sftpUpload, sftpUploadBytes } from '../lib/api'
import { FilePane, type DraggedFile, type FilePaneSide } from './FilePane'

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
// either side).
export function SftpView({ sessionId, homeDirectory }: SftpViewProps) {
  const [localPath, setLocalPath] = useState<string>()
  const [remotePath, setRemotePath] = useState(homeDirectory)
  const [localReloadToken, setLocalReloadToken] = useState(0)
  const [remoteReloadToken, setRemoteReloadToken] = useState(0)
  const [transferStatus, setTransferStatus] = useState<{ message: string; error?: boolean } | null>(null)
  const transferIdRef = useRef(0)

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
        setRemoteReloadToken((t) => t + 1)
      } else {
        setLocalReloadToken((t) => t + 1)
      }
      // Only clears the banner if no other transfer started in the meantime.
      setTimeout(() => {
        if (transferIdRef.current === thisTransferId) setTransferStatus(null)
      }, 3000)
    } catch (err) {
      setTransferStatus({ message: err instanceof Error ? err.message : 'Transfer failed', error: true })
    }
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
          onDropOsFiles={(files) => void handleOsDrop('remote', files)}
        />
      </div>
    </div>
  )
}
