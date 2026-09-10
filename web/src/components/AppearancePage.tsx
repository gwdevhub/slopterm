import { useState } from 'react'
import {
  COLOR_PRESETS,
  COLOR_TOKENS,
  DEFAULT_APPEARANCE,
  getAppearance,
  setAppearance,
  type AppearanceSettings,
  type ColorToken,
  type ThemeName,
} from '../lib/appearance'
import { FontSettings, type FontPreset } from './FontSettings'

const THEMES: { id: ThemeName; label: string }[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
]

const INTERFACE_PRESETS: FontPreset[] = [
  { label: 'System default', value: '' },
  { label: 'Inter', value: 'Inter' },
  { label: 'Roboto', value: 'Roboto' },
  { label: 'Segoe UI', value: 'Segoe UI' },
  { label: 'Helvetica Neue', value: 'Helvetica Neue' },
  { label: 'Georgia (serif)', value: 'Georgia' },
]

const TERMINAL_PRESETS: FontPreset[] = [
  { label: 'System monospace', value: '' },
  { label: 'Menlo', value: 'Menlo' },
  { label: 'Consolas', value: 'Consolas' },
  { label: 'JetBrains Mono', value: 'JetBrains Mono' },
  { label: 'Fira Code', value: 'Fira Code' },
  { label: 'Cascadia Code', value: 'Cascadia Code' },
]

const GROUPS: ColorToken['group'][] = ['Base', 'Text', 'Status']

function ColorRow({ token, value, onChange }: { token: ColorToken; value: string; onChange: (hex: string) => void }) {
  return (
    <div className="flex items-center gap-3 rounded border border-slate-800 bg-slate-950/40 p-2.5">
      <input
        type="color"
        aria-label={token.label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-9 shrink-0 cursor-pointer rounded border border-slate-700 bg-transparent"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-slate-100">{token.label}</p>
        <p className="truncate text-xs text-slate-400">{token.hint}</p>
      </div>
      <input
        type="text"
        aria-label={`${token.label} hex`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="w-24 shrink-0 rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-xs text-slate-100 focus:border-slate-400 focus:outline-none"
      />
    </div>
  )
}

// The Appearance screen: every edit applies live via setAppearance and persists, so there's
// no Save button by design; "Reset to defaults" is the escape hatch.
export function AppearancePage() {
  const [settings, setSettings] = useState<AppearanceSettings>(() => getAppearance())

  function update(next: AppearanceSettings) {
    setSettings(next)
    setAppearance(next)
  }

  function setColor(id: string, hex: string) {
    update({ ...settings, colors: { ...settings.colors, [id]: hex } })
  }

  // Switching theme loads that palette wholesale (discarding per-color tweaks, which is the
  // point of picking a fresh theme); fonts are left alone.
  function selectTheme(theme: ThemeName) {
    update({ ...settings, theme, colors: { ...COLOR_PRESETS[theme] } })
  }

  // Reset returns colors to the current theme's stock palette and fonts to their defaults,
  // keeping whichever theme is selected rather than snapping back to dark.
  function resetAll() {
    update({
      ...structuredClone(DEFAULT_APPEARANCE),
      theme: settings.theme,
      colors: { ...COLOR_PRESETS[settings.theme] },
    })
  }

  return (
    <div data-selectable-text className="mx-auto flex w-full max-w-2xl select-text flex-col gap-4 p-4 sm:p-6">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold text-slate-100">Appearance</h2>
        <button
          type="button"
          onClick={resetAll}
          className="shrink-0 rounded bg-slate-800 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-700"
        >
          Reset to defaults
        </button>
      </div>

      <section className="flex flex-col gap-3 rounded border border-slate-700 bg-slate-900 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-medium text-slate-100">Colors</h3>
            <p className="mt-0.5 text-sm text-slate-400">
              Each color drives a whole family of shades across the app - the app updates as you edit.
            </p>
          </div>
          <div className="inline-flex shrink-0 rounded border border-slate-700 bg-slate-950 p-0.5" role="group" aria-label="Theme">
            {THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-pressed={settings.theme === t.id}
                onClick={() => selectTheme(t.id)}
                className={`rounded px-3 py-1 text-sm ${
                  settings.theme === t.id ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-slate-800'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        {GROUPS.map((group) => (
          <div key={group} className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{group}</p>
            <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
              {COLOR_TOKENS.filter((t) => t.group === group).map((token) => (
                <ColorRow key={token.id} token={token} value={settings.colors[token.id]} onChange={(hex) => setColor(token.id, hex)} />
              ))}
            </div>
          </div>
        ))}
      </section>

      <FontSettings
        title="Interface font"
        description="The sans-serif font used across the app's menus, buttons and text."
        value={settings.interfaceFont}
        onChange={(next) => update({ ...settings, interfaceFont: next })}
        presets={INTERFACE_PRESETS}
        size={{ min: 12, max: 22, step: 1, help: 'Size scales the entire interface (like a zoom level), not just text.' }}
        previewSample="The quick brown fox jumps over the lazy dog — 0123456789"
      />

      <FontSettings
        title="Terminal font"
        description="The monospace font for the terminal (and inline code / command text elsewhere)."
        value={settings.terminalFont}
        onChange={(next) => update({ ...settings, terminalFont: next })}
        presets={TERMINAL_PRESETS}
        size={{ min: 8, max: 28, step: 1, help: 'Size, weight and spacing apply to the terminal itself.' }}
        previewSample="$ ssh user@host  # 0O1lI |-> {} [] ()"
        previewClassName="font-mono"
      />
    </div>
  )
}
