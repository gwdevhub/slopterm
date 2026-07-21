export interface ConnectRequest {
  host: string
  port: number
  username: string
  authMethod: 'password' | 'privateKey'
  password?: string
  privateKey?: string
  passphrase?: string
  columns: number
  rows: number
}

export interface ConnectResponse {
  sessionId: string
}

export async function connect(request: ConnectRequest): Promise<ConnectResponse> {
  const res = await fetch('/api/ssh/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })

  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error ?? `Connect failed with status ${res.status}`)
  }

  return res.json()
}

export async function disconnect(sessionId: string): Promise<void> {
  await fetch(`/api/ssh/session/${sessionId}`, { method: 'DELETE' })
}

export function terminalSocketUrl(sessionId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws/terminal/${sessionId}`
}
