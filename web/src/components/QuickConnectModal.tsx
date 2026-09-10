import { useEffect } from 'react'
import { ConnectionForm, type ConnectionFormValues } from './ConnectionForm'
import { CloseIcon } from './icons'

interface QuickConnectModalProps {
  onSubmit: (values: ConnectionFormValues) => void
  onClose: () => void
  errorMessage?: string | null
  isConnecting?: boolean
}

// Triggered by the "Quick connect" button on the Hosts screen - an ad hoc connection that
// isn't saved as a Host.
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
