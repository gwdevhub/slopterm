import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = resolve(HERE, '../server')
const CONTEXT_DIR = resolve(HERE, '.tmp')
const CONTEXT_FILE = resolve(CONTEXT_DIR, 'context.json')

const SSH_CONTAINER_NAME = `slopterm-e2e-sshd-${process.pid}`
const SSH_USERNAME = 'slopterm_test'
const SSH_PASSWORD = 'slopterm_test_pw'

async function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  // Real SSH daemons (and the Kestrel server below) take a moment to bind - poll rather
  // than assume the process is ready the instant it's spawned.
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolvePoll) => {
      const socket = createConnection({ host, port })
      socket.once('connect', () => {
        socket.destroy()
        resolvePoll(true)
      })
      socket.once('error', () => resolvePoll(false))
    })
    if (ok) return
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`Timed out waiting for ${host}:${port} to accept connections`)
}

function waitForServerUrl(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      reject(new Error(`slopterm server did not print its URL within ${timeoutMs}ms. Output so far:\n${output}`))
    }, timeoutMs)

    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      const match = output.match(/(http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-fA-F]+)/)
      if (match) {
        clearTimeout(timer)
        child.stdout.off('data', onData)
        resolvePromise(match[1])
      }
    }

    child.stdout.on('data', onData)
    child.stderr.on('data', (chunk) => {
      output += chunk.toString()
    })
  })
}

export default async function globalSetup() {
  rmSync(CONTEXT_DIR, { recursive: true, force: true })
  mkdirSync(CONTEXT_DIR, { recursive: true })

  // Disposable, throwaway SSH server for the test to connect to - bound to loopback
  // only, random host port, auto-removed on stop. Never reuses a real user's sshd.
  // E2E_DOCKER_NETWORK is only for running this harness itself inside a container
  // that reaches the Docker daemon over a mounted socket (Docker-outside-of-Docker);
  // it's unset (default bridge networking) on any normal machine or CI runner.
  // container:<id> networking shares the target container's network namespace, so
  // published ports (-p) don't apply there - the SSH port is just its normal fixed 2222.
  const dockerNetwork = process.env.E2E_DOCKER_NETWORK
  const networkArgs = dockerNetwork ? ['--network', dockerNetwork] : []
  const portArgs = dockerNetwork ? [] : ['-p', '127.0.0.1::2222']

  execFileSync('docker', [
    'run', '-d', '--rm',
    '--name', SSH_CONTAINER_NAME,
    ...networkArgs,
    ...portArgs,
    '-e', 'PUID=1000', '-e', 'PGID=1000',
    '-e', 'PASSWORD_ACCESS=true',
    '-e', `USER_NAME=${SSH_USERNAME}`,
    '-e', `USER_PASSWORD=${SSH_PASSWORD}`,
    'lscr.io/linuxserver/openssh-server:latest',
  ])

  let sshPort: number
  if (dockerNetwork) {
    sshPort = 2222
  } else {
    const portMapping = execFileSync('docker', ['port', SSH_CONTAINER_NAME, '2222']).toString().trim()
    sshPort = Number(portMapping.split(':').pop())
    if (!Number.isFinite(sshPort)) {
      throw new Error(`Could not parse SSH host port from docker port output: "${portMapping}"`)
    }
  }
  await waitForPort('127.0.0.1', sshPort, 30_000)

  // Fresh vault dir per run - never touches a real developer's actual vault, and
  // guarantees a clean "vault doesn't exist yet" state for the setup-flow test.
  const vaultDir = resolve(CONTEXT_DIR, 'vault')
  const serverProcess = spawn('dotnet', ['run', '--no-launch-profile'], {
    cwd: SERVER_DIR,
    env: { ...process.env, SLOPTERM_VAULT_DIR: vaultDir },
  }) as ChildProcessWithoutNullStreams
  const baseUrl = await waitForServerUrl(serverProcess, 60_000)

  writeFileSync(
    CONTEXT_FILE,
    JSON.stringify({ baseUrl, sshHost: '127.0.0.1', sshPort, sshUsername: SSH_USERNAME, sshPassword: SSH_PASSWORD }),
  )

  return async () => {
    serverProcess.kill('SIGTERM')
    try {
      execFileSync('docker', ['rm', '-f', SSH_CONTAINER_NAME])
    } catch {
      // best-effort cleanup
    }
    rmSync(CONTEXT_DIR, { recursive: true, force: true })
  }
}
