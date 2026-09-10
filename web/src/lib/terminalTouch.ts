import type { Terminal } from '@xterm/xterm'

// Touch gestures the terminal answers to: drag scrolls, long press selects the word, double
// tap sends Tab. xterm's SelectionService runs on mouse events, which touch never synthesizes.

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

// A drag handle under one end of a selection, in container-relative coordinates. `visible` is
// false when that end has scrolled off, so the caller doesn't draw it.
export interface TouchHandle {
  left: number
  top: number
  visible: boolean
}

// Where the "Copy" bubble goes and what it would copy, in the terminal container's coordinates;
// `placement` is which side of the selection there was room on.
export interface TouchSelection {
  text: string
  left: number
  top: number
  placement: 'above' | 'below'
  startHandle: TouchHandle
  endHandle: TouchHandle
}

export interface TerminalTouchController {
  dispose: () => void
  // Drags one end of the live selection to the cell under the given screen point; the caller
  // forwards handle touchmoves here, since a handle sits outside the terminal container.
  moveHandle: (which: 'start' | 'end', clientX: number, clientY: number) => void
}

interface TerminalTouchCallbacks {
  // A double tap asks for completion, the way tapping Tab in the key toolbar does.
  onDoubleTap: () => void
  // null whenever the selection goes away (dismissed, scrolled, or replaced).
  onSelectionChange: (selection: TouchSelection | null) => void
  // Raw bytes straight to the remote, for a full-screen app that must be told to scroll (see
  // scrollByPixels). The socket is the caller's - xterm can't inject input publicly.
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
): TerminalTouchController {
  // Measured off the rendered screen layer rather than tracked, since cell size changes with
  // the font and resizes; a rect per gesture step is cheaper than keeping dimensions in sync.
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
      // Pressing the gap between words, or past the end of the line, takes the whole line -
      // usually the thing worth copying on a phone.
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
    // Under each end of the selection: the first under the left edge of the first cell, the
    // second under the right edge of the last (end.col is exclusive).
    const handleAt = (cell: Cell): TouchHandle => ({
      left: clamp(offsetX + cell.col * m.cellWidth, 0, containerRect.width),
      top: offsetY + (cell.row - viewportY + 1) * m.cellHeight,
      visible: cell.row >= viewportY && cell.row < viewportY + term.rows,
    })
    return {
      text,
      left: clamp(offsetX + (start.col + 0.5) * m.cellWidth, 0, containerRect.width),
      top: placement === 'above' ? topOfStart : bottomOfEnd,
      placement,
      startHandle: handleAt(start),
      endHandle: handleAt({ col: end.col, row: end.row }),
    }
  }

  // The word the long press landed on; the selection always contains it and only grows from it,
  // which is easier to control than a free anchor.
  let anchor: { start: Cell; end: Cell } | null = null
  // What's actually selected now (the word plus how far the finger dragged); kept separate
  // because the anchor stays put while the handles adjust this.
  let range: { start: Cell; end: Cell } | null = null

  function applySelection(dragPoint?: Cell) {
    if (!anchor) return
    let { start, end } = anchor
    if (dragPoint) {
      if (distance(start, dragPoint) < 0) start = dragPoint
      if (distance(end, dragPoint) > 0) end = dragPoint
    }
    selectRange(start, end)
  }

  function selectRange(start: Cell, end: Cell) {
    const length = distance(start, end)
    if (length <= 0) {
      clearSelection()
      return
    }
    range = { start, end }
    term.select(start.col, start.row, length)
    onSelectionChange(bubbleFor(start, end))
  }

  // Drags one end of the existing selection, making it extendable across lines after the press
  // ended. Neither end can be dragged through the other.
  function moveHandle(which: 'start' | 'end', clientX: number, clientY: number) {
    if (!range) return
    const cell = pointToCell(clientX, clientY)
    if (!cell) return
    if (which === 'start') {
      if (distance(cell, range.end) <= 0) return
      selectRange(cell, range.end)
      return
    }
    if (distance(range.start, cell) <= 0) return
    selectRange(range.start, cell)
  }

  function clearSelection() {
    anchor = null
    range = null
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
    // The alternate buffer has no scrollback: a full-screen app must be *told* to scroll. A
    // mouse report if it asked for one, otherwise a cursor key per line.
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
    // Prevented from the first move of a gesture we've taken over: once Chromium has started a
    // scroll of its own, a later preventDefault is ignored.
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
      // The selection must survive the finger coming off: xterm's SelectionService clears on
      // mousedown, so the synthesized compatibility mouse events have to be suppressed.
      event.preventDefault()
      return
    }
    // A scroll drag was never a tap either.
    if (endedMode !== 'press') return
    if (event.touches.length > 0 || event.changedTouches.length !== 1) return
    // With a selection up, a tap dismisses it and must not double as half of a double tap.
    // Reading our own anchor, not term.hasSelection().
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
    // Suppressing the compatibility mouse events keeps xterm from selecting the word underneath
    // and stops the browser's double-tap zoom.
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

  return {
    dispose: () => {
      cancelLongPress()
      container.removeEventListener('touchstart', onTouchStart)
      container.removeEventListener('touchmove', onTouchMove)
      container.removeEventListener('touchend', onTouchEnd)
      container.removeEventListener('touchcancel', onTouchCancel)
    },
    moveHandle,
  }
}
