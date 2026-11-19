import { useEffect, useState, type FormEvent } from "react"
import { buttonClass, errorMessage, inputClass, linkButtonClass, secondaryButtonClass } from "@/components/ui"
import type { VaultRecord } from "@/lib/types"
import { PrfUnsupportedError, prfMaybeSupported } from "@/lib/vault/passkey"
import { MIN_PASSPHRASE, currentLogin, passphraseProblem, useVault, vault, type KeyMethod } from "@/lib/vault/store"

/**
 * Creates or unlocks the vault. Renders nothing once it's unlocked, so callers
 * can show it unconditionally above content that needs credentials.
 */
export function VaultGate() {
  const state = useVault()
  switch (state.status) {
    case "loading":
      return <p className="text-sm text-neutral-500">Loading vault…</p>
    case "error":
      return (
        <p className="text-sm text-red-600">
          Couldn't load your vault: {state.message}.{" "}
          <button type="button" onClick={vault.retry} className={linkButtonClass}>
            Retry
          </button>
        </p>
      )
    case "signed_out":
      return (
        <p className="text-sm text-neutral-500">
          <a href="/auth/github/login" className={linkButtonClass}>
            Sign in with GitHub
          </a>{" "}
          to use your credential vault.
        </p>
      )
    case "none":
      return <CreateVault />
    case "locked":
      return <UnlockVault record={state.record} />
    case "unlocked":
      return null
  }
}

/** Passphrase fields for browsers or passkey providers without PRF. */
export function PassphraseFields({
  passphrase,
  confirm,
  onChange,
}: {
  passphrase: string
  confirm: string
  onChange: (next: { passphrase: string; confirm: string }) => void
}) {
  return (
    <>
      <input
        type="password"
        autoComplete="new-password"
        placeholder={`Passphrase (at least ${MIN_PASSPHRASE} characters)`}
        value={passphrase}
        onChange={(e) => onChange({ passphrase: e.target.value, confirm })}
        className={inputClass}
      />
      <input
        type="password"
        autoComplete="new-password"
        placeholder="Confirm passphrase"
        value={confirm}
        onChange={(e) => onChange({ passphrase, confirm: e.target.value })}
        className={inputClass}
      />
    </>
  )
}

function CreateVault() {
  const [mode, setMode] = useState<KeyMethod["kind"]>("passkey")
  const [fields, setFields] = useState({ passphrase: "", confirm: "" })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void prfMaybeSupported().then((ok) => {
      if (!ok) setMode("passphrase")
    })
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const problem = mode === "passphrase" ? passphraseProblem(fields.passphrase, fields.confirm) : null
    if (problem) return setError(problem)
    setBusy(true)
    setError(null)
    try {
      const method: KeyMethod = mode === "passkey" ? { kind: "passkey" } : { kind: "passphrase", passphrase: fields.passphrase }
      await vault.create(await currentLogin(), method, mode === "passkey" ? "Passkey" : "Passphrase")
    } catch (err) {
      if (err instanceof PrfUnsupportedError) setMode("passphrase")
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 text-sm">
      <p className="text-neutral-500">
        Loupe keeps your ChatGPT sign-in and API keys in a vault encrypted in your browser. The server stores it but
        can't read it.
      </p>
      {mode === "passphrase" && <PassphraseFields {...fields} onChange={setFields} />}
      <button type="submit" disabled={busy} className={buttonClass}>
        {mode === "passkey" ? "Create vault with a passkey" : "Create vault with a passphrase"}
      </button>
      <button type="button" onClick={() => setMode(mode === "passkey" ? "passphrase" : "passkey")} className={linkButtonClass}>
        {mode === "passkey" ? "Use a passphrase instead" : "Use a passkey instead"}
      </button>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </form>
  )
}

function UnlockVault({ record }: { record: VaultRecord }) {
  const hasPasskey = record.keys.some((k) => k.kind === "passkey")
  const hasPassphrase = record.keys.some((k) => k.kind === "passphrase")
  const [passphrase, setPassphrase] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function unlock(method: KeyMethod) {
    setBusy(true)
    setError(null)
    try {
      await vault.unlock(method)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="text-neutral-500">Your credential vault is locked.</p>
      {hasPasskey && (
        <button type="button" disabled={busy} onClick={() => unlock({ kind: "passkey" })} className={buttonClass}>
          Unlock with passkey
        </button>
      )}
      {hasPassphrase && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void unlock({ kind: "passphrase", passphrase })
          }}
          className="flex gap-2"
        >
          <input
            type="password"
            autoComplete="current-password"
            placeholder="Passphrase"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            className={`${inputClass} min-w-0 flex-1`}
          />
          <button type="submit" disabled={busy || !passphrase} className={secondaryButtonClass}>
            Unlock
          </button>
        </form>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  )
}
