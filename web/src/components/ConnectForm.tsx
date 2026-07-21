import { useState, type FormEvent } from 'react'
import type { ConnectRequest } from '../lib/api'

interface ConnectFormProps {
  onConnect: (request: ConnectRequest) => void
  errorMessage: string | null
  isConnecting: boolean
}

export function ConnectForm({ onConnect, errorMessage, isConnecting }: ConnectFormProps) {
  const [host, setHost] = useState('')
  const [port, setPort] = useState(22)
  const [username, setUsername] = useState('')
  const [authMethod, setAuthMethod] = useState<'password' | 'privateKey'>('password')
  const [password, setPassword] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    onConnect({
      host,
      port,
      username,
      authMethod,
      password: authMethod === 'password' ? password : undefined,
      privateKey: authMethod === 'privateKey' ? privateKey : undefined,
      passphrase: authMethod === 'privateKey' ? passphrase : undefined,
      columns: 80,
      rows: 24,
    })
  }

  const inputClasses =
    'w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 focus:border-slate-400 focus:outline-none'
  const labelClasses = 'mb-1 block text-sm font-medium text-slate-300'

  return (
    <form
      onSubmit={handleSubmit}
      className="mx-auto flex w-full max-w-md flex-col gap-4 p-4 sm:p-6"
    >
      <h1 className="text-xl font-semibold text-slate-100">New SSH connection</h1>

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="flex-1">
          <label className={labelClasses} htmlFor="host">Host</label>
          <input
            id="host"
            className={inputClasses}
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="example.com"
            required
          />
        </div>
        <div className="w-full sm:w-24">
          <label className={labelClasses} htmlFor="port">Port</label>
          <input
            id="port"
            type="number"
            className={inputClasses}
            value={port}
            onChange={(e) => setPort(Number(e.target.value))}
            required
          />
        </div>
      </div>

      <div>
        <label className={labelClasses} htmlFor="username">Username</label>
        <input
          id="username"
          className={inputClasses}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
      </div>

      <div>
        <span className={labelClasses}>Authentication</span>
        <div className="flex gap-4 text-sm text-slate-300">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={authMethod === 'password'}
              onChange={() => setAuthMethod('password')}
            />
            Password
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={authMethod === 'privateKey'}
              onChange={() => setAuthMethod('privateKey')}
            />
            Private key
          </label>
        </div>
      </div>

      {authMethod === 'password' ? (
        <div>
          <label className={labelClasses} htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            className={inputClasses}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
      ) : (
        <>
          <div>
            <label className={labelClasses} htmlFor="privateKey">Private key</label>
            <textarea
              id="privateKey"
              className={`${inputClasses} h-32 font-mono text-xs`}
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              required
            />
          </div>
          <div>
            <label className={labelClasses} htmlFor="passphrase">Passphrase (optional)</label>
            <input
              id="passphrase"
              type="password"
              className={inputClasses}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </div>
        </>
      )}

      {errorMessage && (
        <p className="rounded border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-300">
          {errorMessage}
        </p>
      )}

      <button
        type="submit"
        disabled={isConnecting}
        className="rounded bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
      >
        {isConnecting ? 'Connecting…' : 'Connect'}
      </button>
    </form>
  )
}
