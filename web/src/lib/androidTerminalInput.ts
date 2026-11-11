interface InputOptions {
  send: (data: string, text: boolean) => void
}

// A sticky modifier applies to one Unicode character, not an entire edited word.
export function applyStickyModifiers(char: string, armed: { ctrl: boolean; alt: boolean }): string {
  let bytes = char
  if (armed.ctrl) {
    const code = char.toLowerCase().charCodeAt(0)
    if (code >= 97 && code <= 122) bytes = String.fromCharCode(code - 96)
    else if (char === ' ') bytes = '\x00'
  }
  return armed.alt ? `\x1b${bytes}` : bytes
}

// Android edits a textarea, not a stream of key presses. Keep one snapshot of that
// editable transaction and send only its changed suffix. In particular, neither
// compositionend.data nor input.data is an additional string to append.
export function changedSuffix(previous: string, next: string): string {
  const before = Array.from(previous)
  const after = Array.from(next)
  let common = 0
  while (common < before.length && before[common] === after[common]) common++
  return '\x7f'.repeat(before.length - common) + after.slice(common).join('')
}

export function registerAndroidTerminalInput(
  container: HTMLElement,
  textarea: HTMLTextAreaElement,
  options: InputOptions,
) {
  let sent = ''
  let composing = false
  let disposed = false
  let resetTimer: ReturnType<typeof setTimeout> | undefined
  let finishTimer: ReturnType<typeof setTimeout> | undefined
  let finishing: Promise<void> | undefined
  let resolveFinish: (() => void) | undefined

  textarea.value = ''
  textarea.setAttribute('autocomplete', 'off')
  textarea.setAttribute('autocorrect', 'off')
  textarea.setAttribute('autocapitalize', 'off')
  textarea.spellcheck = false

  function sync() {
    const next = textarea.value
    const delta = changedSuffix(sent, next)
    sent = next
    if (delta) options.send(delta, true)
  }

  function reset() {
    clearTimeout(resetTimer)
    resetTimer = undefined
    sent = ''
    textarea.value = ''
  }

  function settle() {
    clearTimeout(resetTimer)
    // WebView may deliver the final input after compositionend. Keep the snapshot
    // until that edit has landed, so it cannot send the committed word twice.
    resetTimer = setTimeout(() => {
      if (composing || disposed) return
      sync()
      reset()
      clearTimeout(finishTimer)
      const resolve = resolveFinish
      resolveFinish = undefined
      finishing = undefined
      resolve?.()
    }, 0)
  }

  function owns(event: Event) {
    if (event.target !== textarea) return false
    // Capture on the ancestor, before xterm's capture listeners on the textarea.
    // xterm must never see half of an Android edit transaction.
    event.stopImmediatePropagation()
    return true
  }

  const onStart = (event: Event) => {
    if (!owns(event)) return
    clearTimeout(resetTimer)
    composing = true
  }
  const onUpdate = (event: Event) => {
    if (!owns(event)) return
    // compositionupdate precedes the DOM mutation on real WebViews. input is the
    // authoritative edit notification; do not read event.data or preview it here.
  }
  const onEnd = (event: Event) => {
    if (!owns(event)) return
    composing = false
    settle()
  }
  const onInput = (event: Event) => {
    if (!owns(event)) return
    const input = event as InputEvent
    sync()
    composing = input.isComposing
    if (!composing) settle()
  }
  const onBeforeInput = (event: Event) => {
    if (event.target !== textarea) return
    const input = event as InputEvent
    // An empty editing transaction has no DOM character to delete, but the shell
    // can still have a whole command line. Handle IMEs that send no Backspace key.
    if (input.inputType === 'deleteContentBackward' && !textarea.value && !composing) {
      event.preventDefault()
      event.stopImmediatePropagation()
      options.send('\x7f', false)
    } else if (input.inputType === 'insertLineBreak' || input.inputType === 'insertParagraph') {
      event.preventDefault()
      event.stopImmediatePropagation()
      boundary()
      options.send('\r', false)
    }
  }

  function boundary() {
    sync()
    composing = false
    reset()
  }

  const onKeyDown = (event: Event) => {
    if (event.target !== textarea) return
    const key = event as KeyboardEvent
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(key.key)) return
    // Printable hardware keys also use DOM input, just like the soft keyboard.
    // Let browser editing happen, while stopping xterm's keypress/input duplicate.
    if (key.keyCode === 229 || key.isComposing ||
        (Array.from(key.key).length === 1 && !key.ctrlKey && !key.altKey && !key.metaKey)) {
      event.stopImmediatePropagation()
      return
    }
    // xterm remains responsible for encoding arrows, Ctrl keys, function keys,
    // Enter and Backspace (including application-cursor mode). The current text
    // has already gone out; forget its edit context before moving the cursor.
    boundary()
  }
  const onKeyPress = (event: Event) => {
    if (event.target === textarea) event.stopImmediatePropagation()
  }
  const onPaste = (event: Event) => {
    if (event.target === textarea) boundary()
  }
  const onBlur = (event: Event) => {
    if (event.target === textarea) boundary()
  }

  const listeners: Array<[string, EventListener]> = [
    ['compositionstart', onStart], ['compositionupdate', onUpdate],
    ['compositionend', onEnd], ['beforeinput', onBeforeInput], ['input', onInput],
    ['keydown', onKeyDown], ['keypress', onKeyPress], ['paste', onPaste], ['blur', onBlur],
  ]
  for (const [type, listener] of listeners) container.addEventListener(type, listener, true)

  return {
    finish(requestNative?: () => void): Promise<void> {
      if (disposed) return Promise.resolve()
      if (finishing) return finishing
      if (!composing) {
        boundary()
        return Promise.resolve()
      }
      finishing = new Promise<void>((resolve) => { resolveFinish = resolve })
      const result = finishing
      // Also bound a composition restarted while the settle task is queued.
      // Native finishComposingText is asynchronous and some keyboards omit its
      // end event. Drain the actual DOM value before releasing a toolbar key.
      finishTimer = setTimeout(() => {
        composing = false
        settle()
      }, 250)
      requestNative?.()
      return result
    },
    dispose() {
      disposed = true
      clearTimeout(resetTimer)
      clearTimeout(finishTimer)
      for (const [type, listener] of listeners) container.removeEventListener(type, listener, true)
      resolveFinish?.()
      resolveFinish = undefined
      reset()
    },
  }
}
