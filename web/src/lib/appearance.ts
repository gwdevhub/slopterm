// Client-side appearance settings (colors + fonts). localStorage themes instantly at first
// paint (before unlock); the vault copy syncs across devices and wins once decrypted.

import { getVaultAppearance, saveVaultAppearance } from './api'

export type ThemeName = 'dark' | 'light'

export interface ColorToken {
  id: string
  // The `--app-*` custom property this token drives (see index.css's remap).
  cssVar: string
  label: string
  group: 'Base' | 'Text' | 'Status'
  hint: string
  default: string
}

// One editable token per semantic role; index.css derives the neighbouring Tailwind stops
// from these with color-mix, so a single pick shifts a whole ramp.
export const COLOR_TOKENS: ColorToken[] = [
  { id: 'accent', cssVar: '--app-accent', label: 'Accent', group: 'Base', hint: 'Buttons, active tab/nav, focus rings', default: '#4f46e5' },
  { id: 'bg', cssVar: '--app-bg', label: 'Canvas', group: 'Base', hint: 'The app background behind everything', default: '#020617' },
  { id: 'surface', cssVar: '--app-surface', label: 'Surface', group: 'Base', hint: 'Panels, sidebar, tab strip, cards', default: '#0f172a' },
  { id: 'elevated', cssVar: '--app-elevated', label: 'Elevated', group: 'Base', hint: 'Hover states, inputs, raised chips', default: '#1e293b' },
  { id: 'border', cssVar: '--app-border', label: 'Border', group: 'Base', hint: 'Dividers and outlines', default: '#334155' },
  { id: 'textStrong', cssVar: '--app-text-strong', label: 'Heading text', group: 'Text', hint: 'Headings and emphasised text', default: '#f1f5f9' },
  { id: 'text', cssVar: '--app-text', label: 'Body text', group: 'Text', hint: 'Default reading text', default: '#cbd5e1' },
  { id: 'textMuted', cssVar: '--app-text-muted', label: 'Muted text', group: 'Text', hint: 'Secondary labels and hints', default: '#94a3b8' },
  { id: 'danger', cssVar: '--app-danger', label: 'Danger', group: 'Status', hint: 'Errors and destructive actions', default: '#dc2626' },
  { id: 'warning', cssVar: '--app-warning', label: 'Warning', group: 'Status', hint: 'Warnings and cautions', default: '#f59e0b' },
  { id: 'success', cssVar: '--app-success', label: 'Success', group: 'Status', hint: 'Confirmations and healthy status', default: '#10b981' },
]

// The two built-in palettes. Dark mirrors each token's `default` (and index.css's defaults);
// light flips the neutral ramp while keeping the accent/status hues saturated.
export const COLOR_PRESETS: Record<ThemeName, Record<string, string>> = {
  dark: Object.fromEntries(COLOR_TOKENS.map((t) => [t.id, t.default])),
  light: {
    accent: '#4f46e5',
    bg: '#e7ecf3',
    surface: '#ffffff',
    elevated: '#eef2f7',
    border: '#cbd5e1',
    textStrong: '#0f172a',
    text: '#334155',
    textMuted: '#64748b',
    danger: '#dc2626',
    // A deep amber (not the mid-tone amber-700) so warning *text* clears WCAG AA on a light
    // tinted box - mid amber sits too close to its own light background otherwise.
    warning: '#92400e',
    success: '#047857',
  },
}

// A custom font supplied by the user, uploaded (stored inline as a data: URL) or fetched from
// a URL; registered as a FontFace under `family` when applied (see registerFont).
export interface FontSource {
  kind: 'upload' | 'url'
  url: string
  // Original filename/URL, shown in the UI so the user can see what's loaded.
  origin: string
}

export interface FontConfig {
  // The CSS font-family name; empty means the slot's built-in default stack. For a custom
  // source this is also the name the FontFace is registered under.
  family: string
  source: FontSource | null
  weight: number
  // px. For the interface slot this is the root font size (a UI scale); for the terminal
  // slot it's xterm's fontSize.
  size: number
  letterSpacing: number
  lineHeight: number
}

export interface AppearanceSettings {
  // Which built-in palette the colors came from; it only drives which preset the theme toggle
  // and "reset" restore to.
  theme: ThemeName
  colors: Record<string, string>
  interfaceFont: FontConfig
  terminalFont: FontConfig
}

const UI_FALLBACK = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
const MONO_FALLBACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: 'dark',
  colors: { ...COLOR_PRESETS.dark },
  interfaceFont: { family: '', source: null, weight: 400, size: 16, letterSpacing: 0, lineHeight: 1.5 },
  terminalFont: { family: '', source: null, weight: 400, size: 14, letterSpacing: 0, lineHeight: 1.0 },
}

const STORAGE_KEY = 'slopterm.appearance.v1'

function mergeFont(base: FontConfig, saved: Partial<FontConfig> | undefined): FontConfig {
  if (!saved) return { ...base }
  return {
    family: typeof saved.family === 'string' ? saved.family : base.family,
    source: saved.source ?? null,
    weight: typeof saved.weight === 'number' ? saved.weight : base.weight,
    size: typeof saved.size === 'number' ? saved.size : base.size,
    letterSpacing: typeof saved.letterSpacing === 'number' ? saved.letterSpacing : base.letterSpacing,
    lineHeight: typeof saved.lineHeight === 'number' ? saved.lineHeight : base.lineHeight,
  }
}

// Merges a saved/synced blob over the defaults so a partial or older payload never leaves
// anything undefined; used for both the localStorage cache and the vault copy.
export function mergeAppearance(saved: Partial<AppearanceSettings> | null | undefined): AppearanceSettings {
  if (!saved || typeof saved !== 'object') return structuredClone(DEFAULT_APPEARANCE)
  return {
    theme: saved.theme === 'light' ? 'light' : 'dark',
    colors: { ...DEFAULT_APPEARANCE.colors, ...(saved.colors ?? {}) },
    interfaceFont: mergeFont(DEFAULT_APPEARANCE.interfaceFont, saved.interfaceFont),
    terminalFont: mergeFont(DEFAULT_APPEARANCE.terminalFont, saved.terminalFont),
  }
}

export function loadAppearance(): AppearanceSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? mergeAppearance(JSON.parse(raw) as Partial<AppearanceSettings>) : structuredClone(DEFAULT_APPEARANCE)
  } catch {
    return structuredClone(DEFAULT_APPEARANCE)
  }
}

function save(settings: AppearanceSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Quota exceeded (font too big) or storage disabled - the live settings still apply for
    // this session, they just won't persist.
  }
}

// The full family stack a slot resolves to, custom family first (quoted) then the fallback.
export function interfaceFontFamily(font: FontConfig): string {
  return font.family ? `"${font.family}", ${UI_FALLBACK}` : UI_FALLBACK
}

export function terminalFontFamily(font: FontConfig): string {
  return font.family ? `"${font.family}", ${MONO_FALLBACK}` : MONO_FALLBACK
}

// FontFaces already handed to the browser, keyed by family -> the src we registered, so a
// re-apply with the same font is a no-op but a changed source re-registers.
const registeredFonts = new Map<string, string>()

async function registerFont(font: FontConfig) {
  if (!font.source || !font.family) return
  if (registeredFonts.get(font.family) === font.source.url) return
  registeredFonts.set(font.family, font.source.url)
  try {
    const face = new FontFace(font.family, `url("${font.source.url}")`)
    await face.load()
    document.fonts.add(face)
    // The terminal measures glyphs at construction/refit time, so nudge subscribers to
    // re-apply now that the real font (not just its fallback) is available.
    emit()
  } catch {
    // Bad URL/format - leave the fallback stack in place. Let the user notice and fix it.
    registeredFonts.delete(font.family)
  }
}

let current: AppearanceSettings = loadAppearance()

type Listener = (settings: AppearanceSettings) => void
const listeners = new Set<Listener>()

function emit() {
  for (const fn of listeners) fn(current)
}

// TerminalView subscribes so xterm's font tracks the terminal slot live (CSS can't reach it).
export function subscribeAppearance(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getAppearance(): AppearanceSettings {
  return current
}

// Writes the settings onto <html> as CSS custom properties, registers custom fonts, and
// notifies subscribers; just style writes, safe to call on every keystroke.
export function applyAppearance(settings: AppearanceSettings) {
  current = settings
  const root = document.documentElement

  // Tells the browser to render native widgets (form controls, the color picker popovers,
  // default scrollbars) in the matching light/dark flavour.
  root.style.colorScheme = settings.theme

  // Flip the derived-stop direction with the theme (see index.css): in light mode "text"
  // shades darken and "fill/tint" shades lighten, so status boxes etc. stay legible.
  const light = settings.theme === 'light'
  root.style.setProperty('--fg-tint', light ? 'black' : 'white')
  root.style.setProperty('--bg-tint', light ? 'white' : 'black')

  for (const token of COLOR_TOKENS) {
    root.style.setProperty(token.cssVar, settings.colors[token.id] ?? token.default)
  }

  const ui = settings.interfaceFont
  root.style.setProperty('--app-ui-family', interfaceFontFamily(ui))
  // Root font-size scales every rem-based Tailwind size at once, so this reads as a UI zoom.
  root.style.fontSize = `${ui.size}px`
  const body = document.body
  body.style.fontWeight = String(ui.weight)
  body.style.letterSpacing = `${ui.letterSpacing}px`
  body.style.lineHeight = String(ui.lineHeight)

  // The mono family also backs inline code / font-mono UI so it matches the terminal.
  root.style.setProperty('--app-mono-family', terminalFontFamily(settings.terminalFont))

  void registerFont(ui)
  void registerFont(settings.terminalFont)

  emit()
}

// Coalesces the vault write - the editor calls setAppearance on every slider tick, but only
// the last change in a burst is synced.
let vaultPushTimer: ReturnType<typeof setTimeout> | null = null
function scheduleVaultPush() {
  if (vaultPushTimer) clearTimeout(vaultPushTimer)
  vaultPushTimer = setTimeout(() => {
    vaultPushTimer = null
    // Best-effort: no-ops while the vault is locked, and a transient failure just means this
    // device is momentarily out of sync (the local cache still has it).
    void saveVaultAppearance(current).catch(() => {})
  }, 400)
}

// Editor entry point: apply + cache immediately, sync to the vault shortly after.
export function setAppearance(settings: AppearanceSettings) {
  save(settings)
  applyAppearance(settings)
  scheduleVaultPush()
}

// Called once the vault is unlocked (App.tsx). The vault copy wins over the local cache when
// present; when absent, seed it from this device so a customization propagates.
export async function pullAppearanceFromVault(): Promise<void> {
  let remote: unknown
  try {
    remote = await getVaultAppearance()
  } catch {
    return // vault unreachable/locked - keep the local cache as-is
  }

  if (remote && typeof remote === 'object') {
    const merged = mergeAppearance(remote as Partial<AppearanceSettings>)
    save(merged)
    applyAppearance(merged)
  } else if (JSON.stringify(current) !== JSON.stringify(DEFAULT_APPEARANCE)) {
    void saveVaultAppearance(current).catch(() => {})
  }
}
