// Run the production source with Node type erasure and the installed xterm bundle.
// No application build, bundler, TypeScript compiler or backend is involved.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

let browser
let page
before(async () => { browser = await chromium.launch({ headless: true }) })
after(async () => { await browser?.close() })
beforeEach(async () => {
  page = await browser.newPage({ hasTouch: true })
  await page.setContent('<div id="terminal"></div>')
  for (const name of ['androidTerminalInput', 'androidBridge']) {
    const source = readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8')
    await page.addScriptTag({ content: stripTypeScriptTypes(source).replaceAll('export ', '') })
  }
  await page.addStyleTag({ path: fileURLToPath(new URL('../node_modules/@xterm/xterm/css/xterm.css', import.meta.url)) })
  await page.addScriptTag({ path: fileURLToPath(new URL('../node_modules/@xterm/xterm/lib/xterm.js', import.meta.url)) })
  await page.evaluate(() => {
    const container = document.getElementById('terminal')
    const term = new window.Terminal({ cols: 80, rows: 10 })
    term.open(container)
    term.focus()
    const textarea = term.textarea
    const sent = []
    const input = registerAndroidTerminalInput(container, textarea, { send: data => term.input(data, true) })
    term.onData(data => sent.push(data))
    registerCompositionBridge(textarea, requestNative => input.finish(requestNative))
    window.h = {
      container, term, textarea, sent, input,
      start() { textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })) },
      edit(value, composing = true, data = value) {
        textarea.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data }))
        textarea.value = value
        textarea.dispatchEvent(new InputEvent('input', {
          bubbles: true, composed: true, inputType: 'insertText', data, isComposing: composing,
        }))
      },
      end(data = '') { textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data })) },
      key(key, keyCode) {
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key, keyCode, bubbles: true, cancelable: true }))
      },
      tick() { return new Promise(resolve => setTimeout(resolve, 0)) },
      output(text) { return new Promise(resolve => term.write(text, resolve)) },
      snapshot() {
        return {
          sent: [...sent], value: textarea.value,
          preview: container.querySelectorAll('.composition-view.active, .composition-echo').length,
          lines: Array.from({ length: 5 }, (_, i) => term.buffer.active.getLine(i).translateToString(true)),
        }
      },
    }
  })
})
afterEach(async () => { await page?.close() })

test('php-zts is streamed once before space, with no overlay or duplicated commit', async () => {
  const result = await page.evaluate(async () => {
    const h = window.h
    h.start()
    for (const value of ['p', 'ph', 'php', 'php-', 'php-z', 'php-zt', 'php-zts']) h.edit(value)
    const typing = h.snapshot()
    await h.output(h.sent.join(''))
    h.end('zts') // Android data is not necessarily the whole transaction
    h.edit('php-zts ', false, ' ')
    await h.tick()
    return { typing, final: h.snapshot() }
  })
  assert.equal(result.typing.sent.join(''), 'php-zts')
  assert.equal(result.typing.preview, 0)
  assert.equal(result.final.sent.join(''), 'php-zts ')
  assert.equal(result.final.value, '')
  assert.equal(result.final.lines[0], 'php-zts')
})

test('both final-input/end event orders and a missing end send the final value once', async () => {
  for (const order of ['input-first', 'end-first', 'missing-end']) {
    const result = await page.evaluate(async order => {
      const h = window.h
      h.sent.length = 0
      h.start()
      h.edit('befor')
      if (order === 'end-first') h.end('befor')
      h.edit('before/', false, '/')
      if (order === 'input-first') h.end('befor')
      await h.tick()
      h.end('before') // belated end must not revive cleared text
      await h.tick()
      return h.snapshot()
    }, order)
    assert.equal(result.sent.join(''), 'before/')
    assert.equal(result.value, '')
    assert.equal(result.preview, 0)
  }
})

test('replacements, deletions, cancellation and Unicode update only the changed suffix', async () => {
  const result = await page.evaluate(async () => {
    const h = window.h
    h.start()
    h.edit('php-zst')
    h.edit('php-zts')
    h.edit('php-zt')
    h.edit('')
    h.end()
    await h.tick()
    h.start()
    h.edit('か😀')
    h.edit('が😀')
    h.edit('が😃')
    h.end()
    await h.tick()
    return h.snapshot()
  })
  assert.deepEqual(result.sent, [
    'php-zst', '\x7f\x7fts', '\x7f', '\x7f'.repeat(6),
    'か😀', '\x7f\x7fが😀', '\x7f😃',
  ])
})

test('Enter flushes text before CR; later end events cannot resend it', async () => {
  const result = await page.evaluate(async () => {
    const h = window.h
    h.start()
    h.edit('pwd')
    h.key('Enter', 13)
    await h.output('pwd\r\n/home/m\r\n❯❯ ')
    h.end('pwd')
    await h.tick()
    return h.snapshot()
  })
  assert.deepEqual(result.sent, ['pwd', '\r'])
  assert.deepEqual(result.lines.slice(0, 3), ['pwd', '/home/m', '❯❯ '])
  assert.equal(result.preview, 0)
})

test('ordinary Android and hardware typing uses DOM input, never xterm keypress too', async () => {
  await page.keyboard.type('php-zts')
  await page.waitForTimeout(10)
  assert.equal(await page.evaluate(() => h.sent.join('')), 'php-zts')
  await page.keyboard.press('Enter')
  assert.equal(await page.evaluate(() => h.sent.join('')), 'php-zts\r')
})

test('plain repeated punctuation and successive identical compositions are distinct edits', async () => {
  const result = await page.evaluate(async () => {
    const h = window.h
    for (let i = 0; i < 2; i++) {
      h.start()
      h.edit('same')
      h.end()
      await h.tick()
    }
    for (let i = 0; i < 3; i++) {
      h.key('Unidentified', 229)
      h.edit('/', false)
      await h.tick()
    }
    return h.snapshot()
  })
  assert.equal(result.sent.join(''), 'samesame///')
})

for (const nativeEnd of [true, false]) {
  test(`toolbar completion drains before Tab (${nativeEnd ? 'delayed native end' : 'native end omitted'})`, async () => {
    const result = await page.evaluate(async nativeEnd => {
      const h = window.h
      let requests = 0
      window.SloptermAndroid = { finishComposing() {
        requests++
        if (nativeEnd) setTimeout(() => h.end(), 10)
      } }
      h.start()
      h.edit('/var')
      await Promise.all([
        finishAndroidComposing().then(() => h.sent.push('\t')),
        finishAndroidComposing().then(() => h.sent.push('\t')),
      ])
      await h.output('/var/')
      h.start()
      h.edit('ww')
      await finishAndroidComposing()
      h.sent.push('\t')
      return { ...h.snapshot(), requests }
    }, nativeEnd)
    assert.deepEqual(result.sent, ['/var', '\t', '\t', 'ww', '\t'])
    assert.equal(result.value, '')
    assert.equal(result.requests, 2)
  })
}

test('soft Backspace on an empty transaction and soft Enter without keydown reach the shell', async () => {
  const result = await page.evaluate(async () => {
    const h = window.h
    h.textarea.dispatchEvent(new InputEvent('beforeinput', {
      inputType: 'deleteContentBackward', bubbles: true, cancelable: true,
    }))
    h.start()
    h.edit('ls')
    h.textarea.dispatchEvent(new InputEvent('beforeinput', {
      inputType: 'insertLineBreak', bubbles: true, cancelable: true,
    }))
    await h.tick()
    return h.snapshot()
  })
  assert.deepEqual(result.sent, ['\x7f', 'ls', '\r'])
})

test('shell echo, prompt redraws and no-echo mode never create a local text preview', async () => {
  const result = await page.evaluate(async () => {
    const h = window.h
    await h.output('Password: ')
    h.start()
    h.edit('secret')
    const password = h.snapshot()
    h.end()
    await h.tick()
    await h.output('\r\n❯❯ ')
    h.start()
    h.edit('pwd')
    await h.output('pwd\r\n/home/m\r\n❯❯ ')
    h.end()
    await h.tick()
    return { password, final: h.snapshot() }
  })
  assert.equal(result.password.lines[0], 'Password: ')
  assert.equal(result.password.preview, 0)
  assert.equal(result.final.preview, 0)
  assert.deepEqual(result.final.lines.slice(0, 4), ['Password: ', '❯❯ pwd', '/home/m', '❯❯ '])
})

test('paste retains xterm bracketed-paste encoding and does not resend the old edit', async () => {
  const result = await page.evaluate(async () => {
    const h = window.h
    await h.output('\x1b[?2004h')
    h.start()
    h.edit('echo ')
    const transfer = new DataTransfer()
    transfer.setData('text/plain', 'hello')
    h.textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
    h.end()
    await h.tick()
    return h.snapshot()
  })
  assert.deepEqual(result.sent, ['echo ', '\x1b[200~hello\x1b[201~'])
})

test('dispose resolves an outstanding drain and removes capture listeners', async () => {
  const result = await page.evaluate(async () => {
    const h = window.h
    h.start()
    h.edit('x')
    const finished = h.input.finish()
    h.input.dispose()
    await finished
    h.term.input('y', true)
    return h.snapshot()
  })
  assert.deepEqual(result.sent, ['x', 'y'])
  assert.equal(result.value, '')
})

test('a composition restarting during an in-flight native finish cannot strand a toolbar key', async () => {
  const result = await page.evaluate(async () => {
    const h = window.h
    h.start()
    h.edit('first')
    const finished = h.input.finish()
    h.end()
    h.start()
    h.edit('firstsecond')
    await finished
    h.sent.push('\t')
    return h.snapshot()
  })
  assert.deepEqual(result.sent, ['first', 'second', '\t'])
  assert.equal(result.value, '')
})

test('xterm still encodes control keys and application-mode arrows after Android input', async () => {
  const result = await page.evaluate(async () => {
    const h = window.h
    await h.output('\x1b[?1h')
    h.start()
    h.edit('pwd')
    h.key('ArrowLeft', 37)
    h.textarea.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'c', keyCode: 67, ctrlKey: true, bubbles: true, cancelable: true,
    }))
    return h.snapshot()
  })
  assert.deepEqual(result.sent, ['pwd', '\x1bOD', '\x03'])
  assert.equal(result.value, '')
})

test('a background terminal cannot own the active terminal finish request', async () => {
  const result = await page.evaluate(async () => {
    const h = window.h
    let otherFinishes = 0
    const background = document.createElement('textarea')
    document.body.appendChild(background)
    const unregister = registerCompositionBridge(background, async () => { otherFinishes++ })
    h.start()
    h.edit('active')
    await finishAndroidComposing()
    unregister()
    return { ...h.snapshot(), otherFinishes }
  })
  assert.deepEqual(result.sent, ['active'])
  assert.equal(result.value, '')
  assert.equal(result.otherFinishes, 0)
})

test('Android input respects xterm disableStdin and clears terminal selection as user input', async () => {
  const result = await page.evaluate(async () => {
    const h = window.h
    await h.output('select me')
    h.term.select(0, 0, 6)
    h.edit('x', false)
    const selected = h.term.hasSelection()
    await h.tick()
    h.term.options.disableStdin = true
    h.edit('ignored', false)
    await h.tick()
    return { ...h.snapshot(), selected }
  })
  assert.deepEqual(result.sent, ['x'])
  assert.equal(result.selected, false)
})

test('idle toolbar actions run in the next microtask without posting native finish', async () => {
  const result = await page.evaluate(async () => {
    const order = []
    let requests = 0
    window.SloptermAndroid = { finishComposing() { requests++ } }
    finishAndroidComposing().then(() => order.push('toolbar'))
    await Promise.resolve()
    order.push('after-microtask')
    return { order, requests }
  })
  assert.deepEqual(result.order, ['toolbar', 'after-microtask'])
  assert.equal(result.requests, 0)
})

test('physical typing with interleaved output preserves the full command exactly once', async () => {
  const command = 'printf "%s\\n" php-zts'
  await page.evaluate(() => {
    h.term.onData(data => setTimeout(() => h.term.write(data === '\r' ? '\r\n' : data), 1))
  })
  await page.keyboard.type(command, { delay: 10 })
  await page.keyboard.press('Enter')
  await page.waitForTimeout(30)
  const result = await page.evaluate(() => h.snapshot())
  assert.equal(result.sent.join(''), `${command}\r`)
  assert.equal(result.lines[0], command)
})
