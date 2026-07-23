import { useEffect } from 'react'
import { ConnectionForm, type ConnectionFormValues } from './ConnectionForm'
import { CloseIcon } from './icons'

interface QuickConnectModalProps {
  onSubmit: (values: ConnectionFormValues) => void
  onClose: () => void
  errorMessage?: string | null
  isConnecting?: boolean
}

// Triggered by the "Quick connect" button next to "New host" on the Hosts screen - an ad
// hoc connection that isn't saved as a Host. Used to be an inline 'connect' mode of the
// old Host Details side panel (reached only by picking a Recent), which meant there was
// no way to start one from scratch without already having a Recent entry - a real modal
// fixes both that and gives it the same escape-to-close affordance as ConfirmDialog.
export function QuickConnectModal({ onSubmit, onClose, errorMessage, isConnecting }: QuickConnectModalProps) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded border border-slate-700 bg-slate-900">
        <div className="flex items-center justify-between p-4 pb-0">
          <h3 className="font-semibold text-slate-100">Quick connect</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-200">
            <CloseIcon aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
        <ConnectionForm submitLabel="Connect" isSubmitting={isConnecting} errorMessage={errorMessage} onSubmit={onSubmit} />
      </div>
    </div>
  )
}
