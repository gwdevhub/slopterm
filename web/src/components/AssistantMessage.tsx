import { useEffect, useRef, useState } from 'react'
import { assistantBlocks } from '../lib/assistantBlocks'
import { CopyIcon } from './icons'

export function AssistantMessage({ text }: { text: string }) {
  return (
    <div className="min-w-0">
      {assistantBlocks(text).map((block, index) =>
        block.kind === 'text' ? (
          <div key={index} className="whitespace-pre-wrap break-words">{block.text}</div>
        ) : (
          <CopyableBlock key={index} text={block.text} language={block.language} />
        ),
      )}
    </div>
  )
}

function CopyableBlock({ text, language }: { text: string; language: string }) {
  const [result, setResult] = useState<{ text: string; copied: boolean } | null>(null)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(resetTimer.current), [])
  const currentResult = result?.text === text ? result : null

  async function copy() {
    clearTimeout(resetTimer.current)
    try {
      await navigator.clipboard.writeText(text)
      setResult({ text, copied: true })
      resetTimer.current = setTimeout(() => setResult(null), 2000)
    } catch {
      setResult({ text, copied: false })
    }
  }

  return (
    <div className="my-2 min-w-0 overflow-hidden rounded border border-slate-700 bg-slate-950 whitespace-normal">
      <pre className="m-0 max-w-full overflow-x-auto whitespace-pre p-3 text-xs"><code>{text}</code></pre>
      <div className="flex items-center justify-between gap-2 border-t border-slate-800 px-2 py-1">
        <span className="min-w-0 truncate text-[11px] text-slate-500">{language}</span>
        <div className="flex items-center gap-1">
          <span role="status" className={`text-[11px] ${currentResult?.copied === false ? 'text-red-400' : 'text-slate-400'}`}>
            {currentResult && (currentResult.copied ? 'Copied!' : 'Could not copy. Select the text to copy manually.')}
          </span>
          <button
            type="button"
            aria-label="Copy block"
            title="Copy block"
            disabled={!text}
            onClick={() => void copy()}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-indigo-400 disabled:opacity-40"
          >
            <CopyIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  )
}
