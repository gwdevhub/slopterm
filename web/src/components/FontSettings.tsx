import { useRef, useState, type ChangeEvent } from 'react'
import type { FontConfig } from '../lib/appearance'

// A self-contained editor for a single font "slot" - family, weight, size, letter-spacing and
// line-height, with a live preview. It only edits a FontConfig; applying it is the caller's job.

export interface FontPreset {
  label: string
  // The CSS family name, or '' for the slot's built-in default stack.
  value: string
}

interface FontSettingsProps {
  title: string
  description: string
  value: FontConfig
  onChange: (next: FontConfig) => void
  presets: FontPreset[]
  // Size control bounds/labelling - the interface slot scales the whole UI, the terminal slot
  // is a plain glyph size, so the range and helper text differ.
  size: { min: number; max: number; step: number; help: string }
  previewSample: string
  previewClassName?: string
}

const WEIGHTS = [
  { label: 'Thin (100)', value: 100 },
  { label: 'Light (300)', value: 300 },
  { label: 'Regular (400)', value: 400 },
  { label: 'Medium (500)', value: 500 },
  { label: 'Semibold (600)', value: 600 },
  { label: 'Bold (700)', value: 700 },
  { label: 'Black (900)', value: 900 },
]

// Uploaded fonts are stored inline as data: URLs in localStorage, so keep them modest - a few
// MB of base64 blows the storage quota and the font just won't persist.
const MAX_FONT_BYTES = 2 * 1024 * 1024

const controlClasses =
  'rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 focus:border-slate-400 focus:outline-none'

function stripExtension(name: string): string {
  return name.replace(/\.(woff2?|ttf|otf|eot)$/i, '')
}

export function FontSettings({ title, description, value, onChange, presets, size, previewSample, previewClassName }: FontSettingsProps) {
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // "custom" covers both an uploaded and a URL source; the preset dropdown otherwise selects a
  // built-in family and clears any custom source.
  const usingCustom = value.source !== null
  const selectValue = usingCustom ? '__custom__' : value.family

  function patch(next: Partial<FontConfig>) {
    onChange({ ...value, ...next })
  }

  function handlePresetChange(event: ChangeEvent<HTMLSelectElement>) {
    const next = event.target.value
    setUploadError(null)
    if (next === '__custom__') {
      // Switch into custom mode with an empty URL source the user then fills in (or uploads).
      patch({ source: { kind: 'url', url: '', origin: '' }, family: value.family && !presets.some((p) => p.value === value.family) ? value.family : '' })
    } else {
      patch({ family: next, source: null })
    }
  }

  function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    setUploadError(null)
    if (!file) return
    if (file.size > MAX_FONT_BYTES) {
      setUploadError(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB - keep uploads under 2 MB so they persist.`)
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : ''
      if (!url) return
      const name = stripExtension(file.name)
      patch({ source: { kind: 'upload', url, origin: file.name }, family: name })
    }
    reader.onerror = () => setUploadError('Could not read that file.')
    reader.readAsDataURL(file)
  }

  function handleUrlChange(event: ChangeEvent<HTMLInputElement>) {
    const url = event.target.value
    // Auto-name the family from the URL's filename when the user hasn't typed one, so the
    // FontFace has something to register under; a name they've typed is kept as-is.
    const guessed = stripExtension(url.split('/').pop()?.split('?')[0] ?? '')
    patch({ source: { kind: 'url', url, origin: url }, family: value.family || guessed })
  }

  const previewStyle = {
    fontFamily: value.family ? `"${value.family}", ${previewClassName === 'font-mono' ? 'monospace' : 'sans-serif'}` : undefined,
    fontWeight: value.weight,
    fontSize: `${value.size}px`,
    letterSpacing: `${value.letterSpacing}px`,
    lineHeight: value.lineHeight,
  }

  return (
    <section className="rounded border border-slate-700 bg-slate-900 p-4">
      <h3 className="font-medium text-slate-100">{title}</h3>
      <p className="mt-0.5 text-sm text-slate-400">{description}</p>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-400">Family</span>
          <select className={controlClasses} value={selectValue} onChange={handlePresetChange}>
            {presets.map((preset) => (
              <option key={preset.value || 'default'} value={preset.value}>
                {preset.label}
              </option>
            ))}
            <option value="__custom__">Custom (upload or URL)…</option>
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-400">Weight</span>
          <select className={controlClasses} value={value.weight} onChange={(e) => patch({ weight: Number(e.target.value) })}>
            {WEIGHTS.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {usingCustom && (
        <div className="mt-3 flex flex-col gap-2 rounded border border-slate-800 bg-slate-950/40 p-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-slate-400">Font name (used in CSS)</span>
            <input
              className={controlClasses}
              value={value.family}
              placeholder="My Custom Font"
              onChange={(e) => patch({ family: e.target.value })}
            />
          </label>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-xs font-medium text-slate-400">Font URL (woff2/woff/ttf/otf)</span>
              <input
                className={controlClasses}
                value={value.source?.kind === 'url' ? value.source.url : ''}
                placeholder="https://example.com/font.woff2"
                onChange={handleUrlChange}
              />
            </label>
            <span className="pb-1.5 text-center text-xs text-slate-500 sm:pb-2.5">or</span>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="shrink-0 rounded bg-slate-800 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-700"
            >
              Upload font…
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".woff,.woff2,.ttf,.otf,font/*"
              className="hidden"
              onChange={handleUpload}
            />
          </div>
          {value.source?.kind === 'upload' && value.source.origin && (
            <p className="text-xs text-slate-400">Uploaded: {value.source.origin}</p>
          )}
          {uploadError && <p className="text-xs text-red-400">{uploadError}</p>}
        </div>
      )}

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-400">Size ({value.size}px)</span>
          <input
            type="range"
            min={size.min}
            max={size.max}
            step={size.step}
            value={value.size}
            onChange={(e) => patch({ size: Number(e.target.value) })}
            className="accent-indigo-500"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-400">Letter spacing ({value.letterSpacing}px)</span>
          <input
            type="range"
            min={-2}
            max={4}
            step={0.1}
            value={value.letterSpacing}
            onChange={(e) => patch({ letterSpacing: Number(e.target.value) })}
            className="accent-indigo-500"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-400">Line height ({value.lineHeight})</span>
          <input
            type="range"
            min={1}
            max={2.2}
            step={0.05}
            value={value.lineHeight}
            onChange={(e) => patch({ lineHeight: Number(e.target.value) })}
            className="accent-indigo-500"
          />
        </label>
      </div>

      <p className="mt-2 text-xs text-slate-500">{size.help}</p>

      <div className="mt-3">
        <span className="text-xs font-medium text-slate-400">Preview</span>
        <div
          className={`mt-1 overflow-x-auto rounded border border-slate-800 bg-slate-950 p-3 text-slate-100 ${previewClassName ?? ''}`}
          style={previewStyle}
        >
          {previewSample}
        </div>
      </div>
    </section>
  )
}
