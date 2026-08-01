import type { Terminal } from '@xterm/xterm'

// Every touch gesture the terminal itself answers to, as one state machine: a plain drag scrolls
// the scrollback, a long press selects the word under the finger (and dragging on from there
// extends the selection), and a double tap sends Tab. They belong together rather than in three
// separate listeners because they all begin with the same touchstart and only diverge later - on
// how far the finger moved and how long it stayed down.
//
// None of this comes from xterm.js. Its SelectionService runs on mouse events, which a touchscreen
// only ever synthesizes for a tap - never for the press-and-drag a selection needs - and since v6
// its viewport is a vscode-derived scrollable element with wheel handling but no touch handling at
// all (the .xterm-viewport element is not a native scroll container: its scrollHeight always
// equals its clientHeight, so a finger has nothing to pan). That's why the terminal on Android
// could be neither scrolled back nor selected.

// xterm's own default `wordSeparator` option, so a long press picks out the same word a desktop
// double-click does.
const WORD_SEPARATORS = ' ()[]{}\'"`'
// Long enough that it can't fire during the flick of a scroll, short enough to still feel like a
// press-and-hold rather than a wait. Between Android's own 500ms and iOS's ~350ms.
const LONG_PRESS_MS = 420
// A finger never holds perfectly still; anything inside this is still "a press", not a drag.
const MOVE_TOLERANCE_PX = 12
const DOUBLE_TAP_MS = 400
const DOUBLE_TAP_SLOP_PX = 30

// Where the "Copy" bubble goes and what it would put on the clipboard. Coordinates are relative to
// the terminal's own container element, so the caller can position it with no geometry of its own;
// `placement` is which side of the selection there was room on.
export interface TouchSelection {
  text: string
  left: number
  top: number
  placement: 'above' | 'below'
}

interface TerminalTouchCallbacks {
  // A double tap asks for completion, the way tapping Tab in the key toolbar does.
  onDoubleTap: () => void
  // null whenever the selection goes away (dismissed, scrolled, or replaced).
  onSelectionChange: (selection: TouchSelection | null) => void
  // Raw bytes straight to the remote, for the scroll that a full-screen app has to be told about
  // as cursor keys (see scrollByPixels). The socket is the caller's - xterm has no public way to
  // inject input, and writing to the terminal itself would only echo it locally.
  onSendKey: (data: string) => void
}

// A cell in the buffer: absolute row (scrollback included), not a viewport row.
interface Cell {
  col: number
  row: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function registerTerminalTouch(
  term: Terminal,
  container: HTMLElement,
  { onDoubleTap, onSelectionChange, onSendKey }: TerminalTouchCallbacks,
): () => void {
  // Measured off the rendered screen layer rather than tracked: the cell size changes with the
  // font (Appearance settings) and the row/column count with every resize, and a getBoundingClientRect
  // per gesture step is far cheaper than keeping a copy of xterm's internal render dimensions in
  // sync with both.
  function metrics() {
    const screen = container.querySelector<HTMLElement>('.xterm-screen')
    if (!screen) return null
    const rect = screen.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    return { rect, cellWidth: rect.width / term.cols, cellHeight: rect.height / term.rows }
  }

  function pointToCell(clientX: number, clientY: number): Cell | null {
    const m = metrics()
    if (!m) return null
    const col = clamp(Math.floor((clientX - m.rect.left) / m.cellWidth), 0, term.cols - 1)
    const viewportRow = clamp(Math.floor((clientY - m.rect.top) / m.cellHeight), 0, term.rows - 1)
    return { col, row: term.buffer.active.viewportY + viewportRow }
  }

  // Reading order, so "is this cell before that one" is a single comparison.
  function distance(from: Cell, to: Cell): number {
    return (to.row - from.row) * term.cols + (to.col - from.col)
  }

  // The word under the finger, as [start, end) columns on one row.
  function wordAt({ col, row }: Cell): { start: Cell; end: Cell } {
    const text = term.buffer.active.getLine(row)?.translateToString(true) ?? ''
    const isWordChar = (char: string | undefined) => !!char && !WORD_SEPARATORS.includes(char)
    if (!isWordChar(text[col])) {
      // Pressing the gap between words, or past the end of the line, takes the whole line. On a
      // phone that's usually the thing worth copying anyway (a path, a URL, an error message),
      // and selecting one blank cell would be no use to anybody.
      return { start: { col: 0, row }, end: { col: text.length, row } }
    }
    let start = col
    while (start > 0 && isWordChar(text[start - 1])) start--
    let end = col + 1
    while (end < text.length && isWordChar(text[end])) end++
    return { start: { col: start, row }, end: { col: end, row } }
  }

  function bubbleFor(start: Cell, end: Cell): TouchSelection | null {
    const m = metrics()
    const text = term.getSelection()
    if (!m || !text) return null
    const containerRect = container.getBoundingClientRect()
    const offsetX = m.rect.left - containerRect.left
    const offsetY = m.rect.top - containerRect.top
    const viewportY = term.buffer.active.viewportY
    // Centred on the first selected cell, and above the selection unless it starts too close to
    // the top edge for the bubble to fit - in which case it goes under the last selected row.
    const topOfStart = offsetY + (start.row - viewportY) * m.cellHeight
    const bottomOfEnd = offsetY + (end.row - viewportY + 1) * m.cellHeight
    const placement = topOfStart > 44 ? 'above' : 'below'
    return {
      text,
      left: clamp(offsetX + (start.col + 0.5) * m.cellWidth, 0, containerRect.width),
      top: placement === 'above' ? topOfStart : bottomOfEnd,
      placement,
    }
  }

  // The word the long press landed on. The selection always contains it and only ever grows from
  // it, in whichever direction the finger drags - which is both easier to control on a small
  // screen than a free anchor and impossible to collapse to nothing by accident.
  let anchor: { start: Cell; end: Cell } | null = null

  function applySelection(dragPoint?: Cell) {
    if (!anchor) return
    let { start, end } = anchor
    if (dragPoint) {
      if (distance(start, dragPoint) < 0) start = dragPoint
      if (distance(end, dragPoint) > 0) end = dragPoint
    }
    const length = distance(start, end)
    if (length <= 0) {
      clearSelection()
      return
    }
    term.select(start.col, start.row, length)
    onSelectionChange(bubbleFor(start, end))
  }

  function clearSelection() {
    anchor = null
    term.clearSelection()
    onSelectionChange(null)
  }

  // Pixels the finger has moved but that haven't yet added up to a whole line, so a slow drag
  // still scrolls smoothly instead of rounding every step away to zero.
  let scrollRemainderPx = 0

  function scrollByPixels(deltaY: number) {
    const m = metrics()
    if (!m) return
    scrollRemainderPx += deltaY
    const lines = Math.trunc(scrollRemainderPx / m.cellHeight)
    if (lines === 0) return
    scrollRemainderPx -= lines * m.cellHeight
    // The content follows the finger: dragging down (positive) reveals earlier lines.
    if (term.buffer.active.type === 'normal') {
      term.scrollLines(-lines)
      return
    }
    // The alternate buffer has no scrollback to move through: a full-screen app (nano, vim, man)
    // has to be *told* to scroll. A wheel does this on the desktop, so the same thing happens
    // here - a mouse report where the app asked for one, and otherwise a cursor key per line, in
    // whichever form the app's own keypad mode calls for.
    if (term.modes.mouseTrackingMode !== 'none') {
      for (let i = 0; i < Math.abs(lines); i++) {
        term.element?.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: lines > 0 ? -m.cellHeight : m.cellHeight,
            bubbles: true,
            cancelable: true,
          }),
        )
      }
      return
    }
    const key = `\x1b${term.modes.applicationCursorKeysMode ? 'O' : '['}${lines > 0 ? 'A' : 'B'}`
    onSendKey(key.repeat(Math.abs(lines)))
  }

  let mode: 'idle' | 'press' | 'scroll' | 'select' = 'idle'
  let startX = 0
  let startY = 0
  let lastY = 0
  let longPressTimer: ReturnType<typeof setTimeout> | undefined
  let lastTapAt = 0
  let lastTapX = 0
  let lastTapY = 0

  function cancelLongPress() {
    clearTimeout(longPressTimer)
    longPressTimer = undefined
  }

  function onTouchStart(event: TouchEvent) {
    // Anything multi-touch (a pinch, a stray second finger) is not one of ours.
    if (event.touches.length !== 1) {
      cancelLongPress()
      mode = 'idle'
      return
    }
    const touch = event.touches[0]
    startX = touch.clientX
    startY = touch.clientY
    lastY = touch.clientY
    scrollRemainderPx = 0
    mode = 'press'
    cancelLongPress()
    longPressTimer = setTimeout(() => {
      longPressTimer = undefined
      const cell = pointToCell(startX, startY)
      if (!cell) return
      mode = 'select'
      anchor = wordAt(cell)
      applySelection()
      // The same short tick a native long-press selection gives, so it's clear the press
      // registered without having to look away from the finger. No-op where unsupported.
      navigator.vibrate?.(15)
    }, LONG_PRESS_MS)
  }

  function onTouchMove(event: TouchEvent) {
    if (mode === 'idle' || event.touches.length !== 1) return
    const touch = event.touches[0]
    // Prevented from the first move of a gesture we've taken over, not from the point we decide
    // which gesture it is: once Chromium has started a scroll of its own, a later preventDefault
    // is ignored, and the terminal would pan its container instead of its scrollback.
    event.preventDefault()
    if (mode === 'press') {
      if (
        Math.abs(touch.clientX - startX) < MOVE_TOLERANCE_PX &&
        Math.abs(touch.clientY - startY) < MOVE_TOLERANCE_PX
      ) {
        return
      }
      cancelLongPress()
      mode = 'scroll'
      // Scrolling away from a selection dismisses it, rather than leaving its bubble pointing at
      // a row that has since moved somewhere else.
      if (anchor) clearSelection()
    }
    if (mode === 'scroll') {
      scrollByPixels(touch.clientY - lastY)
      lastY = touch.clientY
      return
    }
    const cell = pointToCell(touch.clientX, touch.clientY)
    if (cell) applySelection(cell)
  }

  function onTouchEnd(event: TouchEvent) {
    cancelLongPress()
    const endedMode = mode
    mode = 'idle'
    if (endedMode === 'select') {
      // The selection has to survive the finger coming off - which it only does if the
      // compatibility mouse events this touch would otherwise synthesize never fire: xterm's own
      // SelectionService clears the selection on mousedown, so releasing after a long press would
      // wipe the highlight the press just put up (leaving nothing but the Copy bubble pointing at
      // it). Cancelling the touch's default is what suppresses them.
      event.preventDefault()
      return
    }
    // A scroll drag was never a tap either.
    if (endedMode !== 'press') return
    if (event.touches.length > 0 || event.changedTouches.length !== 1) return
    // With a selection up, a tap anywhere dismisses it - the standard way out of a selection on a
    // touchscreen, and it must not double as half of a double tap. Deliberately reading our own
    // anchor rather than term.hasSelection(): the selection may be xterm's, but whether the user
    // is in the middle of a touch selection is ours to know.
    if (anchor) {
      clearSelection()
      lastTapAt = 0
      return
    }
    const touch = event.changedTouches[0]
    const isDoubleTap =
      event.timeStamp - lastTapAt < DOUBLE_TAP_MS &&
      Math.abs(touch.clientX - lastTapX) < DOUBLE_TAP_SLOP_PX &&
      Math.abs(touch.clientY - lastTapY) < DOUBLE_TAP_SLOP_PX
    // A third tap must not pair with the second and fire again, so a match resets the clock
    // rather than carrying this tap's time forward.
    lastTapAt = isDoubleTap ? 0 : event.timeStamp
    lastTapX = touch.clientX
    lastTapY = touch.clientY
    if (!isDoubleTap) return
    // Suppressing the compatibility mouse events this tap would otherwise synthesize is what
    // keeps xterm from selecting the word underneath as a side effect of asking for completion
    // (and stops the browser's double-tap zoom, belt-and-braces with the touch-action style on
    // the container).
    event.preventDefault()
    onDoubleTap()
  }

  function onTouchCancel() {
    cancelLongPress()
    mode = 'idle'
  }

  container.addEventListener('touchstart', onTouchStart, { passive: false })
  container.addEventListener('touchmove', onTouchMove, { passive: false })
  container.addEventListener('touchend', onTouchEnd, { passive: false })
  container.addEventListener('touchcancel', onTouchCancel)

  return () => {
    cancelLongPress()
    container.removeEventListener('touchstart', onTouchStart)
    container.removeEventListener('touchmove', onTouchMove)
    container.removeEventListener('touchend', onTouchEnd)
    container.removeEventListener('touchcancel', onTouchCancel)
  }
}
