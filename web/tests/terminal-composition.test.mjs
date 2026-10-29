// Source-level browser tests: Node erases TypeScript types, and Chromium runs the installed,
// prebuilt xterm bundle. No Vite, tsc, .NET server, or project build is involved.
import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { applyStickyModifiers, registerTerminalComposition } from '../src/lib/terminalComposition.ts'
import { finishAndroidComposing, registerCompositionBridge } from '../src/lib/androidBridge.ts'

let browser
let page
before(async () => { browser = await chromium.launch() })
after(async () => { await browser?.close() })
beforeEach(async () => {
  page = await browser.newPage({ hasTouch: true })
  await page.setContent('<div id="terminal"></div>')
  await page.addStyleTag({ path: fileURLToPath(new URL('../node_modules/@xterm/xterm/css/xterm.css', import.meta.url)) })
  await page.addScriptTag({ path: fileURLToPath(new URL('../node_modules/@xterm/xterm/lib/xterm.js', import.meta.url)) })
  // Function.toString() here is the source loaded by Node's native type erasure, not a
  // separate test reimplementation of the composition controller.
  await page.addScriptTag({ content: `${applyStickyModifiers}\n${registerTerminalComposition}` })
  await page.evaluate(() => {
    const container = document.getElementById('terminal')
    const term = new window.Terminal({ cols: 80, rows: 10 })
    term.open(container)
    const textarea = term.textarea
    const sent = []
    const commits = []
    let modifiers = { ctrl: false, alt: false }
    let finishRequests = 0
    let synchronousCommits = 0
    const composition = registerTerminalComposition(container, textarea, {
      hasModifiers: () => modifiers.ctrl || modifiers.alt,
      finishComposing: async () => { finishRequests++ },
      onSynchronousCommit: () => { synchronousCommits++ },
    })
    term.onData(data => {
      const committed = composition.consumeCommit(data)
      if (committed) commits.push(data)
      // Same terminal boundary as TerminalView: modifiers are one shot, and raw toolbar
      // keys bypass onData. The controller must identify commits before this callback runs.
      if ((modifiers.ctrl || modifiers.alt) && (data.length === 1 || committed)) {
        const [first, ...rest] = Array.from(data)
        data = applyStickyModifiers(first, modifiers) + rest.join('')
        modifiers = { ctrl: false, alt: false }
      }
      sent.push(data)
    })
    window.h = {
      term, textarea, composition, sent, commits,
      arm(value) { modifiers = value },
      start() { textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })) },
      update(text) {
        textarea.value += text
        textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: text, bubbles: true }))
      },
      end(data = '') { textarea.dispatchEvent(new CompositionEvent('compositionend', { data, bubbles: true })) },
      input(data, isComposing = false) {
        textarea.dispatchEvent(new InputEvent('input', {
          data, isComposing, inputType: 'insertText', bubbles: true, composed: true,
        }))
      },
      key(key, keyCode) {
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key, keyCode, bubbles: true, cancelable: true }))
      },
      tick() { return new Promise(resolve => setTimeout(resolve, 0)) },
      output(text) {
        const done = composition.prepareOutput()
        return new Promise(resolve => term.write(text, () => { done(); resolve() }))
      },
      snapshot() {
        const live = container.querySelector('.composition-view:not(.composition-echo)')
        const frozen = container.querySelector('.composition-echo')
        return {
          line: term.buffer.active.getLine(0).translateToString(true),
          sent: [...sent], commits: [...commits], modifiers, finishRequests, synchronousCommits,
          composing: container.classList.contains('xterm-composing'),
          live: { active: live.classList.contains('active'), text: live.textContent, left: live.style.left },
          frozen: frozen && { active: frozen.classList.contains('active'), text: frozen.textContent, left: frozen.style.left },
        }
      },
    }
  })
})
afterEach(async () => { await page?.close() })

test('insertText before compositionend cannot send or echo a composing path segment twice', async () => {
  const result = await page.evaluate(async () => {
    const h = window.h
    await h.output('/text/')
    h.start()
    h.update('before')
    await h.tick()
    const left = h.snapshot().live.left
    // Some IMEs send insertText without a preceding keydown; xterm's generic handler must
    // not send the word while CompositionHelper still owns this textarea region.
    h.input('before')
    const beforeEnd = h.snapshot()
    h.end('before')
    // The slash can be inserted after compositionend but before xterm's deferred send.
    h.textarea.value += '/'
    h.input('/')
    const duringCommit = h.snapshot()
    await h.tick()
    const committed = h.snapshot()
    await h.output(h.sent.join(''))
    return { left, beforeEnd, duringCommit, committed, echoed: h.snapshot() }
  })
  assert.deepEqual(result.beforeEnd.sent, [])
  assert.equal(result.beforeEnd.frozen.active, true)
  assert.equal(result.duringCommit.frozen.active, true)
  assert.equal(result.duringCommit.frozen.left, result.left)
  assert.deepEqual(result.committed.sent, ['before/'])
  assert.deepEqual(result.committed.commits, ['before/'])
  assert.equal(result.echoed.line, '/text/before/')
  assert.equal(result.echoed.frozen.active, false)
})

test('slash/keyCode 229 commits the final textarea value once, not unreliable compositionend.data', async () => {
  const result = await page.evaluate(async () => {
    const h = window.h
    await h.output('/text/')
    h.start()
    h.update('befor')
    await h.tick()
    h.key('Unidentified', 229)
    h.end('befor')
    h.textarea.value = 'before/'
    h.input('/')
    await h.tick()
    await h.output(h.sent.join(''))
    return h.snapshot()
  })
  assert.deepEqual(result.sent, ['before/'])
  assert.equal(result.line, '/text/before/')
})

test('a final non-composing insertText commits even when the WebView omits compositionend', async () => {
  const result = await page.evaluate(async () => {
    const h = window.h
    h.start()
    h.update('before')
    await h.tick()
    h.textarea.value += '/'
    h.input('/')
    await h.tick()
    const committed = h.snapshot()
    // A belated native end is redundant with the synthesized end, not new input.
    h.end('before')
    await h.tick()
    return { committed, afterLateEnd: h.snapshot() }
  })
  assert.deepEqual(result.committed.sent, ['before/'])
  assert.equal(result.committed.composing, false)
  assert.deepEqual(result.afterLateEnd.sent, ['before/'])
})

test('insertText still marked composing stays editable until the final composition commit', async () => {
  const result = await page.evaluate(async () => {
    const h = window.h
    h.start()
    h.update('か')
    await h.tick()
    h.input('か', true)
    await h.tick()
    const composing = h.snapshot()
    h.end('か')
    h.textarea.value = 'が'
    await h.tick()
    return { composing, committed: h.snapshot() }
  })
  assert.deepEqual(result.composing.sent, [])
  assert.equal(result.composing.composing, true)
  assert.deepEqual(result.committed.sent, ['が'])
})

test('Enter sends the composed word before CR and preserves the preview until output parses', async () => {
  const result = await page.evaluate(async () => {
    const h = window.h
    h.start()
    h.update('hello')
    await h.tick()
    h.key('Enter', 13)
    const afterEnter = h.snapshot()
    await h.output('hello\r\n')
    return { afterEnter, echoed: h.snapshot() }
  })
  assert.deepEqual(result.afterEnter.sent, ['hello', '\r'])
  assert.deepEqual(result.afterEnter.commits, ['hello'])
  assert.equal(result.afterEnter.frozen.active, true)
  assert.equal(result.afterEnter.composing, false)
  assert.equal(result.afterEnter.synchronousCommits, 1)
  assert.equal(result.echoed.frozen.active, false)
})

test('a late compositionend cannot revive an already-echoed keydown snapshot', async () => {
  const result = await page.evaluate(async () => {
    const h = window.h
    h.start()
    h.update('before')
    await h.tick()
    h.key('Enter', 13)
    await h.output('before\r\n')
    h.end('before')
    const afterLateEnd = h.snapshot()
    await h.tick()
    return { afterLateEnd, later: h.snapshot() }
  })
  assert.equal(result.afterLateEnd.frozen.active, false)
  assert.deepEqual(result.later.sent, ['before', '\r'])
})

test('a slash keydown followed by a late native end cannot resend the path segment', async () => {
  const result = await page.evaluate(async () => {
    const h = window.h
    await h.output('/text/')
    h.start()
    h.update('before')
    await h.tick()
    h.key('/', 191)
    h.textarea.value += '/'
    await h.output('before/')
    h.end('before')
    await h.tick()
    return h.snapshot()
  })
  assert.deepEqual(result.sent, ['before', '/'])
  assert.equal(result.line, '/text/before/')
  assert.equal(result.frozen.active, false)
})

test('a custom key handler bypassing xterm does not discard the later real compositionend', async () => {
  const result = await page.evaluate(async () => {
    const h = window.h
    h.term.attachCustomKeyEventHandler(event => event.key !== 'Enter')
    h.start()
    h.update('hello')
    await h.tick()
    h.key('Enter', 13)
    await h.tick()
    const afterInterceptedKey = h.snapshot()
    h.input('hello', true)
    h.end()
    await h.tick()
    return { afterInterceptedKey, committed: h.snapshot() }
  })
  assert.equal(result.afterInterceptedKey.composing, true)
  assert.deepEqual(result.committed.sent, ['hello'])
  assert.deepEqual(result.committed.commits, ['hello'])
})

test('queued output cannot clear a newer commit or acknowledge input not yet sent', async () => {
  const result = await page.evaluate(async () => {
    const h = window.h
    const beforeAnyCommit = h.composition.prepareOutput()
    h.start()
    h.update('first')
    await h.tick()
    h.end()
    const beforeSend = h.composition.prepareOutput()
    await h.tick()
    const oldOutput = h.composition.prepareOutput()
    h.start()
    h.update('second')
    await h.tick()
    h.end()
    await h.tick()
    beforeAnyCommit()
    beforeSend()
    oldOutput()
    const beforeEcho = h.snapshot()
    await h.output('firstsecond')
    return { beforeEcho, afterEcho: h.snapshot() }
  })
  assert.equal(result.beforeEcho.frozen.active, true)
  assert.equal(result.beforeEcho.frozen.text, 'second')
  assert.equal(result.afterEcho.frozen.active, false)
})

test('a new composition keeps the old snapshot until an actual next-word update', async () => {
  const result = await page.evaluate(async () => {
    const h = window.h
    h.start()
    h.update('hello')
    await h.tick()
    h.end()
    h.start()
    const restarted = h.snapshot()
    await h.tick()
    h.update('world')
    const updated = h.snapshot()
    await h.tick()
    h.end()
    await h.tick()
    return { restarted, updated, committed: h.snapshot() }
  })
  assert.equal(result.restarted.frozen.active, true)
  assert.equal(result.restarted.frozen.text, 'hello')
  assert.equal(result.restarted.live.text, '')
  assert.equal(result.updated.frozen.active, false)
  assert.equal(result.updated.live.text, 'world')
  assert.deepEqual(result.committed.sent, ['hello', 'world'])
  assert.equal(result.committed.synchronousCommits, 0)
})

test('identical path segments and ordinary repeated input are never deduplicated', async () => {
  const result = await page.evaluate(async () => {
    const h = window.h
    await h.output('/')
    for (let i = 0; i < 2; i++) {
      h.start()
      h.update('before')
      await h.tick()
      h.end()
      h.textarea.value += '/'
      h.input('/')
      await h.tick()
      await h.output(h.sent.at(-1))
    }
    h.input('/')
    h.input('/')
    return h.snapshot()
  })
  assert.equal(result.line, '/before/before/')
  assert.deepEqual(result.sent, ['before/', 'before/', '/', '/'])
})

test('non-composing keyCode 229 punctuation still reaches xterm once per key', async () => {
  const result = await page.evaluate(async () => {
    const h = window.h
    for (let i = 0; i < 3; i++) {
      h.key('Unidentified', 229)
      h.textarea.value += '/'
      h.input('/')
      await h.tick()
    }
    return h.snapshot()
  })
  assert.deepEqual(result.sent, ['/', '/', '/'])
  assert.deepEqual(result.commits, [])
})

for (const viaEnter of [false, true]) {
  test(`sticky Ctrl applies to a whole ${viaEnter ? 'Enter' : 'IME'} commit without a phantom preview`, async () => {
    const result = await page.evaluate(async viaEnter => {
      const h = window.h
      h.arm({ ctrl: true, alt: false })
      h.start()
      h.update('open')
      await h.tick()
      if (viaEnter) h.key('Enter', 13)
      else { h.end(); await h.tick() }
      const afterCommit = h.snapshot()
      h.textarea.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }))
      h.input('o')
      return { afterCommit, nextCharacter: h.snapshot() }
    }, viaEnter)
    assert.deepEqual(result.afterCommit.sent, viaEnter ? ['\x0fpen', '\r'] : ['\x0fpen'])
    assert.equal(result.afterCommit.frozen.active, false)
    assert.deepEqual(result.afterCommit.modifiers, { ctrl: false, alt: false })
    assert.equal(result.afterCommit.finishRequests, 1)
    assert.equal(result.nextCharacter.sent.at(-1), 'o')
  })
}

test('paste/arrow data cannot consume Ctrl while an IME commit is pending', async () => {
  const result = await page.evaluate(async () => {
    const h = window.h
    h.arm({ ctrl: true, alt: false })
    h.start()
    h.update('open')
    await h.tick()
    h.end()
    h.term.input('\x1b[D', true)
    // Deliver paste bytes through the public input API: term.paste() also clears the
    // textarea, and toolbar paste waits for the commit before doing that.
    h.term.input('paste', true)
    const pending = h.snapshot()
    await h.tick()
    return { pending, committed: h.snapshot() }
  })
  assert.deepEqual(result.pending.sent, ['\x1b[D', 'paste'])
  assert.equal(result.pending.modifiers.ctrl, true)
  assert.deepEqual(result.committed.sent, ['\x1b[D', 'paste', '\x0fpen'])
})

test('revised CJK text and a surrogate pair commit the final textarea contents', async () => {
  const result = await page.evaluate(async () => {
    const h = window.h
    h.start()
    h.update('か')
    await h.tick()
    h.end('か')
    h.textarea.value = 'が😀'
    h.input('が😀')
    await h.tick()
    await h.output(h.sent.join(''))
    return h.snapshot()
  })
  assert.deepEqual(result.sent, ['が😀'])
  assert.equal(result.line, 'が😀')
})

test('canceling composition drops its preview; teardown also invalidates queued output callbacks', async () => {
  const result = await page.evaluate(async () => {
    const h = window.h
    h.start()
    h.update('cancel')
    await h.tick()
    h.end()
    h.textarea.value = ''
    await h.tick()
    const canceled = h.snapshot()
    const staleOutput = h.composition.prepareOutput()
    h.composition.dispose()
    staleOutput()
    h.term.input('x', true)
    return { canceled, disposed: h.snapshot() }
  })
  assert.deepEqual(result.canceled.sent, [])
  assert.equal(result.canceled.frozen.active, false)
  assert.equal(result.disposed.frozen, null)
  assert.equal(result.disposed.composing, false)
  assert.deepEqual(result.disposed.sent, ['x'])
})

test('the no-echo backstop belongs to the latest frozen word', async () => {
  await page.clock.install()
  await page.evaluate(async () => {
    const h = window.h
    h.start()
    h.update('first')
    await h.tick()
    h.end()
    await h.tick()
  })
  await page.clock.fastForward(500)
  await page.evaluate(async () => {
    const h = window.h
    h.start()
    h.update('second')
    await h.tick()
    h.end()
    await h.tick()
  })
  await page.clock.fastForward(501)
  assert.equal(await page.evaluate(() => window.h.snapshot().frozen.active), true)
  await page.clock.fastForward(500)
  assert.equal(await page.evaluate(() => window.h.snapshot().frozen.active), false)
})

test('native toolbar slash/Ctrl keys wait for a delayed or synchronous commit, with overlapping taps', async () => {
  const previousWindow = globalThis.window
  try {
    for (const synchronous of [false, true]) {
      const textarea = new EventTarget()
      const sent = []
      let requests = 0
      // Match xterm's listener order and its deferred compositionend send. This exercises
      // the actual Android bridge source under Node, including its shared resolver queue.
      textarea.addEventListener('compositionend', () => setTimeout(() => sent.push('before'), 0))
      const bridge = registerCompositionBridge(textarea)
      globalThis.window = { SloptermAndroid: {
        finishComposing() {
          requests++
          setTimeout(() => {
            if (synchronous) {
              sent.push('before')
              bridge.committed()
            } else textarea.dispatchEvent(new Event('compositionend'))
          }, 20)
        },
      } }
      textarea.dispatchEvent(new Event('compositionstart'))
      await Promise.all([
        finishAndroidComposing().then(() => sent.push('/')),
        finishAndroidComposing().then(() => sent.push('\x03')),
      ])
      assert.deepEqual(sent, ['before', '/', '\x03'])
      assert.equal(requests, 1)
      bridge.dispose()
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})
