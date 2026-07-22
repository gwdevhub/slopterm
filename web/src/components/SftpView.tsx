import { localList, sftpList } from '../lib/api'
import { FilePane } from './FilePane'

interface SftpViewProps {
  sessionId: string
  homeDirectory: string
}

// The dual-pane SFTP browser opened by a host card's "SFTP" button: local filesystem on
// the left, the connected host's remote filesystem on the right.
export function SftpView({ sessionId, homeDirectory }: SftpViewProps) {
  return (
    <div className="flex h-full min-h-0 flex-col sm:flex-row">
      <FilePane title="Local" list={(path) => localList(path)} />
      <FilePane title="Remote" initialPath={homeDirectory} list={(path) => sftpList(sessionId, path ?? homeDirectory)} />
    </div>
  )
}
