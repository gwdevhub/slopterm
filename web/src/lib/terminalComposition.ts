interface CompositionOptions {
  hasModifiers: () => boolean
  finishComposing: () => Promise<void>
  onSynchronousCommit?: () => void
}

// A sticky modifier applies to one Unicode character, not an entire committed word.
export function applyStickyModifiers(char: string, armed: { ctrl: boolean; alt: boolean }): string {
  let bytes = char
  if (armed.ctrl) {
    const code = char.toLowerCase().charCodeAt(0)
    if (code >= 97 && code <= 122) bytes = String.fromCharCode(code - 96)
    else if (char === ' ') bytes = '\x00'
  }
  return armed.alt ? `\x1b${bytes}` : bytes
}

// xterm owns the textarea and the committed bytes. This only arbitrates its generic input
// path against its composition path, and keeps a preview alive until output supersedes it.
export function registerTerminalComposition(
  container: HTMLElement,
  textarea: HTMLTextAreaElement,
  options: CompositionOptions,
) {
  const livePreview = container.querySelector<HTMLElement>('.composition-view')
  const echoPreview = document.createElement('div')
  echoPreview.classList.add('composition-view', 'composition-echo')
  livePreview?.parentElement?.appendChild(echoPreview)

  interface Commit {
    start: number
    end?: number
    sent: boolean
    synchronous: boolean
  }
  let composing: { start: number } | undefined
  let pending: Commit | undefined
  let lastCommit: Commit | undefined
  let frozen: Commit | undefined
  let freezeTimeout: ReturnType<typeof setTimeout> | undefined
  let commitTimeout: ReturnType<typeof setTimeout> | undefined

  function unfreeze() {
    clearTimeout(freezeTimeout)
    freezeTimeout = undefined
    frozen = undefined
    echoPreview.classList.remove('active')
  }

  function finalize(synchronous = false) {
    // A real keydown can finalize before compositionend. The late end must not recreate an
    // already-echoed word from xterm's retained textContent (notably at a path's next slash).
    if (!composing) return
    pending = { start: composing.start, sent: false, synchronous }
    lastCommit = pending
    composing = undefined
    container.classList.remove('xterm-composing')
    unfreeze()
    // Capture before xterm sends synchronously and consumes/disarms the modifier.
    if (options.hasModifiers() || !livePreview?.textContent) return
    frozen = pending
    echoPreview.style.cssText = livePreview.style.cssText
    echoPreview.textContent = livePreview.textContent
    echoPreview.classList.add('active')
    freezeTimeout = setTimeout(unfreeze, 1000)
  }

  function expirePendingCommit() {
    clearTimeout(commitTimeout)
    const commit = pending
    commitTimeout = setTimeout(() => {
      if (pending !== commit) return
      // A canceled composition produces no onData and must not leave a phantom preview.
      if (commit && !commit.sent && frozen === commit) unfreeze()
      if (commit && !commit.sent && commit.synchronous && lastCommit === commit && livePreview?.classList.contains('active')) {
        // A custom key handler returned before CompositionHelper ran: xterm is still
        // composing, so subsequent insertText must still belong to that same region.
        composing = { start: commit.start }
        container.classList.add('xterm-composing')
      }
      pending = undefined
    }, 0)
  }

  const onStart = () => {
    // xterm bounds a delayed commit at the next composition's start, rather than swallowing
    // the next word. Keep the same boundary when identifying the onData that belongs to it.
    if (pending) pending.end = textarea.value.length
    lastCommit = undefined
    composing = { start: textarea.value.length }
    container.classList.add('xterm-composing')
  }
  const onUpdate = () => {
    unfreeze()
    if (options.hasModifiers()) void options.finishComposing()
  }
  const onEnd = (event: CompositionEvent) => {
    if (event.target !== textarea) return
    if (!composing && lastCommit?.sent) {
      // Keydown already sent this textarea range. An IME may still deliver its native end
      // later; letting xterm finalize it again would resend the word (and its trailing '/').
      event.stopPropagation()
      return
    }
    // A custom key handler (e.g. copying a selection) may have bypassed xterm's keydown
    // finalization. Only an observed onData above proves it committed.
    if (!composing && lastCommit) composing = { start: lastCommit.start }
    finalize()
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target !== textarea || [16, 17, 18, 20, 229].includes(event.keyCode)) return
    finalize(true)
    expirePendingCommit()
  }
  const onInput = (event: InputEvent) => {
    if (event.target !== textarea || event.inputType !== 'insertText') return
    if (composing || (pending && !pending.sent)) {
      // Mobile IMEs may emit insertText as well as compositionend, sometimes without a
      // keydown. xterm's generic input listener otherwise sends it immediately, then its
      // delayed composition send reads the SAME textarea range again. The echo also moves
      // the still-live overlay to the end, displaying e.g. /text/before/before. Leave the
      // value/default edit alone: CompositionHelper reads the final text, including '/'.
      event.stopPropagation()
      if (composing && !event.isComposing) {
        // Some WebViews finish with a non-composing insertText but omit compositionend.
        // Finish through the SAME xterm path; otherwise the toolbar's native-finish
        // backstop would release while this word was still stranded in the textarea.
        textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
      }
    }
  }

  textarea.addEventListener('compositionstart', onStart)
  textarea.addEventListener('compositionupdate', onUpdate)
  // An ancestor's capture listener runs before xterm's own textarea listeners, including
  // its capture keydown which can send the commit synchronously and stop propagation.
  container.addEventListener('compositionend', onEnd, true)
  container.addEventListener('keydown', onKeyDown, true)
  container.addEventListener('input', onInput, true)
  // xterm schedules its send in its compositionend listener. Expire AFTER that timer, not
  // from capture, so modifiers still recognize a whole word when the delayed onData fires.
  textarea.addEventListener('compositionend', expirePendingCommit)

  return {
    consumeCommit(data: string): boolean {
      if (!pending || pending.sent || !data) return false
      const expected = textarea.value.slice(pending.start, pending.end)
      // Identify the owned textarea range, not a tick-wide "any data is IME" flag: an arrow
      // or a paste in that tick must not consume a sticky Ctrl. Never deduplicate by text;
      // identical words in successive compositions are distinct input.
      if (data !== expected) return false
      pending.sent = true
      if (pending.synchronous) options.onSynchronousCommit?.()
      return true
    },
    prepareOutput(): () => void {
      // A queued write callback belongs only to the preview present when output arrived,
      // and cannot acknowledge a commit whose bytes had not even gone out yet.
      const preview = frozen?.sent ? frozen : undefined
      return () => {
        if (preview && frozen === preview) unfreeze()
      }
    },
    dispose() {
      clearTimeout(commitTimeout)
      pending = undefined
      composing = undefined
      lastCommit = undefined
      unfreeze()
      container.classList.remove('xterm-composing')
      textarea.removeEventListener('compositionstart', onStart)
      textarea.removeEventListener('compositionupdate', onUpdate)
      container.removeEventListener('compositionend', onEnd, true)
      container.removeEventListener('keydown', onKeyDown, true)
      container.removeEventListener('input', onInput, true)
      textarea.removeEventListener('compositionend', expirePendingCommit)
      echoPreview.remove()
    },
  }
}
