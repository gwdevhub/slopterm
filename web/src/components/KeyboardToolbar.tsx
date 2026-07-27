import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import {
  CtrlIcon,
  ShiftIcon,
  AltIcon,
  TabIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  DeleteIcon,
  InsertIcon,
  EscapeIcon,
  MoreHorizontalIcon,
  SnippetsIcon,
} from './icons'
import { listSnippets, type SavedSnippet } from '../lib/api'
import { isMobileApp } from '../lib/androidBridge'

// Special key definitions for the keyboard toolbar
const SPECIAL_KEYS = [
  { key: 'Tab', code: 'Tab', icon: TabIcon, label: 'Tab' },
  { key: 'Escape', code: 'Escape', icon: EscapeIcon, label: 'Esc' },
  { key: 'Insert', code: 'Insert', icon: InsertIcon, label: 'Ins' },
  { key: 'Delete', code: 'Delete', icon: DeleteIcon, label: 'Del' },
  { key: 'ArrowUp', code: 'ArrowUp', icon: ArrowUpIcon, label: '↑' },
  { key: 'ArrowDown', code: 'ArrowDown', icon: ArrowDownIcon, label: '↓' },
  { key: 'ArrowLeft', code: 'ArrowLeft', icon: ArrowLeftIcon, label: '←' },
  { key: 'ArrowRight', code: 'ArrowRight', icon: ArrowRightIcon, label: '→' },
  { key: 'Home', code: 'Home', icon: null, label: 'Home' },
  { key: 'End', code: 'End', icon: null, label: 'End' },
  { key: 'PageUp', code: 'PageUp', icon: null, label: 'PgUp' },
  { key: 'PageDown', code: 'PageDown', icon: null, label: 'PgDn' },
] as const

type SpecialKey = (typeof SPECIAL_KEYS)[number]

interface KeyboardToolbarProps {
  termRef: React.RefObject<Terminal | null>
  isActive: boolean
}

// Modifier key state
interface ModifierState {
  ctrl: boolean
  shift: boolean
  alt: boolean
}

export function KeyboardToolbar({ termRef, isActive }: KeyboardToolbarProps) {
  const [snippets, setSnippets] = useState<SavedSnippet[]>([])
  const [showSnippetsDropdown, setShowSnippetsDropdown] = useState(false)
  const [showMoreKeysPopup, setShowMoreKeysPopup] = useState(false)
  const [modifierState, setModifierState] = useState<ModifierState>({ ctrl: false, shift: false, alt: false })
  const snippetsDropdownRef = useRef<HTMLDivElement>(null)
  const moreKeysPopupRef = useRef<HTMLDivElement>(null)

  // Fetch snippets when the toolbar becomes visible
  useEffect(() => {
    if (isActive && isMobileApp()) {
      listSnippets().then(setSnippets).catch(() => setSnippets([]))
    }
  }, [isActive])

  // Close dropdowns when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as HTMLElement
      
      if (snippetsDropdownRef.current && !snippetsDropdownRef.current.contains(target)) {
        setShowSnippetsDropdown(false)
      }
      if (moreKeysPopupRef.current && !moreKeysPopupRef.current.contains(target)) {
        setShowMoreKeysPopup(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Send a key to the terminal using xterm's write method for special characters
  const sendKey = (key: string, ctrlKey: boolean = false, shiftKey: boolean = false, altKey: boolean = false) => {
    const term = termRef.current
    if (!term) return

    // Focus the terminal before sending keys
    term.focus()

    // Map of special keys to their ANSI escape sequences
    const keyMap: Record<string, string> = {
      'Tab': '\t',
      'Escape': '\x1b',
      'Enter': '\r',
      'ArrowUp': '\x1b[A',
      'ArrowDown': '\x1b[B',
      'ArrowRight': '\x1b[C',
      'ArrowLeft': '\x1b[D',
      'Home': '\x1b[H',
      'End': '\x1b[F',
      'PageUp': '\x1b[5~',
      'PageDown': '\x1b[6~',
      'Delete': '\x1b[3~',
      'Insert': '\x1b[2~',
    }

    // Check if this is a mapped special key
    if (keyMap[key]) {
      // Handle modifier combinations for special keys
      let sequence = keyMap[key]
      
      // For Ctrl+Arrow keys (used for word navigation in many terminals)
      if (ctrlKey) {
        if (key === 'ArrowUp') sequence = '\x1b[1;5A'
        else if (key === 'ArrowDown') sequence = '\x1b[1;5B'
        else if (key === 'ArrowRight') sequence = '\x1b[1;5C'
        else if (key === 'ArrowLeft') sequence = '\x1b[1;5D'
        else if (key === 'Home') sequence = '\x1b[1;5H'
        else if (key === 'End') sequence = '\x1b[1;5F'
      }
      
      // For Shift+Tab (reverse tab)
      if (shiftKey && key === 'Tab') {
        sequence = '\x1b[Z'
      }
      
      // For Alt+key combinations
      if (altKey && !ctrlKey && !shiftKey) {
        if (keyMap[key]) {
          // Alt+key is typically Escape followed by the key sequence
          term.write('\x1b' + sequence)
          return
        }
      }
      
      term.write(sequence)
      return
    }

    // For regular character keys with modifiers
    if (key.length === 1) {
      if (ctrlKey) {
        // Ctrl+letter: convert to control character (1-26 for A-Z)
        const upperChar = key.toUpperCase()
        if (upperChar >= 'A' && upperChar <= 'Z') {
          const controlChar = String.fromCharCode(upperChar.charCodeAt(0) - 64)
          term.write(controlChar)
          return
        }
        // Ctrl+space
        if (key === ' ') {
          term.write('\x00')
          return
        }
      }
      
      if (shiftKey) {
        // Shift modifies the character
        const shiftedChar = key.toUpperCase()
        term.write(shiftedChar)
        return
      }
      
      term.write(key)
      return
    }

    // Fallback: try dispatching keyboard events
    const textarea = term.element?.querySelector('textarea')
    if (textarea) {
      const downEvent = new KeyboardEvent('keydown', {
        key,
        code: key,
        ctrlKey,
        shiftKey,
        altKey,
        metaKey: false,
        bubbles: true,
        cancelable: true,
      })
      const upEvent = new KeyboardEvent('keyup', {
        key,
        code: key,
        ctrlKey,
        shiftKey,
        altKey,
        metaKey: false,
        bubbles: true,
        cancelable: true,
      })
      textarea.dispatchEvent(downEvent)
      textarea.dispatchEvent(upEvent)
    }
  }

  // Toggle modifier key state
  const toggleModifier = (modifier: keyof ModifierState) => {
    setModifierState(prev => ({
      ...prev,
      [modifier]: !prev[modifier]
    }))
  }

  // Handle special key with current modifiers
  const handleSpecialKey = (key: SpecialKey) => {
    const term = termRef.current
    if (!term) return

    term.focus()
    
    // Get current modifier state
    const { ctrl, shift, alt } = modifierState
    
    // Send the key with current modifiers
    sendKey(key.key, ctrl, shift, alt)
    
    // Reset modifiers after sending (they're one-shot)
    setModifierState({ ctrl: false, shift: false, alt: false })
  }

  // Insert snippet into terminal
  const insertSnippet = (command: string) => {
    const term = termRef.current
    if (!term) return

    term.focus()
    term.paste(command)
    setShowSnippetsDropdown(false)
  }

  // If not mobile or not active, don't render
  if (!isMobileApp() || !isActive) {
    return null
  }

  return (
    <div className="flex flex-col bg-slate-900 border-t border-slate-800">
      {/* Main toolbar row */}
      <div className="flex items-center justify-between px-2 py-1">
        {/* Snippets button */}
        <button
          type="button"
          onClick={() => setShowSnippetsDropdown(!showSnippetsDropdown)}
          className="flex items-center justify-center w-12 h-12 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors touch-manipulation active:scale-95"
          title="Snippets"
          aria-label="Show snippets"
        >
          <SnippetsIcon className="h-6 w-6" />
        </button>

        {/* Modifier keys */}
        <div className="flex items-center space-x-1">
          <button
            type="button"
            onClick={() => toggleModifier('ctrl')}
            className={`flex items-center justify-center w-12 h-12 rounded-lg transition-colors touch-manipulation active:scale-95 ${
              modifierState.ctrl ? 'bg-indigo-600 text-white' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
            }`}
            title="Ctrl"
            aria-label="Ctrl key"
          >
            <CtrlIcon className="h-6 w-6" />
          </button>

          <button
            type="button"
            onClick={() => toggleModifier('shift')}
            className={`flex items-center justify-center w-12 h-12 rounded-lg transition-colors touch-manipulation active:scale-95 ${
              modifierState.shift ? 'bg-indigo-600 text-white' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
            }`}
            title="Shift"
            aria-label="Shift key"
          >
            <ShiftIcon className="h-6 w-6" />
          </button>

          <button
            type="button"
            onClick={() => toggleModifier('alt')}
            className={`flex items-center justify-center w-12 h-12 rounded-lg transition-colors touch-manipulation active:scale-95 ${
              modifierState.alt ? 'bg-indigo-600 text-white' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
            }`}
            title="Alt"
            aria-label="Alt key"
          >
            <AltIcon className="h-6 w-6" />
          </button>
        </div>

        {/* More keys button */}
        <button
          type="button"
          onClick={() => setShowMoreKeysPopup(!showMoreKeysPopup)}
          className="flex items-center justify-center w-12 h-12 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors touch-manipulation active:scale-95"
          title="More keys"
          aria-label="Show more keys"
        >
          <MoreHorizontalIcon className="h-6 w-6" />
        </button>
      </div>

      {/* Snippets dropdown */}
      {showSnippetsDropdown && snippets.length > 0 && (
        <div ref={snippetsDropdownRef} className="absolute bottom-full left-2 right-2 mb-2 bg-slate-800 border border-slate-700 rounded-lg shadow-lg max-h-48 overflow-y-auto z-50">
          {snippets.map((snippet) => (
            <button
              key={snippet.id}
              type="button"
              onClick={() => insertSnippet(snippet.snippet.command)}
              className="w-full px-4 py-2 text-left text-sm text-slate-200 hover:bg-slate-700 transition-colors truncate touch-manipulation"
            >
              <span className="font-medium">{snippet.snippet.name}</span>
              <span className="text-slate-400 text-xs ml-2">- {snippet.snippet.command.substring(0, 30)}</span>
            </button>
          ))}
        </div>
      )}

      {showSnippetsDropdown && snippets.length === 0 && (
        <div ref={snippetsDropdownRef} className="absolute bottom-full left-2 right-2 mb-2 bg-slate-800 border border-slate-700 rounded-lg shadow-lg p-4 z-50">
          <p className="text-sm text-slate-400">No snippets found</p>
        </div>
      )}

      {/* More keys popup */}
      {showMoreKeysPopup && (
        <div ref={moreKeysPopupRef} className="absolute bottom-full right-2 mb-2 bg-slate-800 border border-slate-700 rounded-lg shadow-lg p-2 z-50 flex flex-wrap gap-1">
          {SPECIAL_KEYS.map((key) => {
            const Icon = key.icon
            return (
              <button
                key={key.key}
                type="button"
                onClick={() => handleSpecialKey(key)}
                className="flex items-center justify-center w-10 h-10 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs transition-colors touch-manipulation active:scale-95"
                title={key.label}
              >
                {Icon ? <Icon className="h-5 w-5" /> : key.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}