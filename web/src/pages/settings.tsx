import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import { Layout } from "@/components/layout"
import { buttonClass, errorMessage, inputClass, linkButtonClass, secondaryButtonClass } from "@/components/ui"
import { PassphraseFields, VaultGate } from "@/components/vault-gate"
import { api } from "@/lib/api"
import {
  DARK_THEMES,
  DIFF_INDICATORS,
  DIFF_STYLES,
  HUNK_SEPARATORS,
  LIGHT_THEMES,
  LINE_DIFF_TYPES,
  LINE_HOVER_HIGHLIGHTS,
  OVERFLOWS,
  THEME_TYPES,
} from "@/lib/diff-settings"
import { PROVIDER_LABELS, availableProviders, credentialFor, useInferencePreferences, type Provider } from "@/lib/inference"
import {
  EFFORTS,
  resetDiffSettings,
  updateDiffSettings,
  updateInferenceSettings,
  useDiffSettings,
  useSettings,
} from "@/lib/settings"
import { timeAgo } from "@/lib/utils"
import { currentLogin, passphraseProblem, useVault, vault, type VaultContents } from "@/lib/vault/store"
import type { TrustedReviewer, VaultKeyRecord } from "@/lib/types"

const REPO_URL = "https://github.com/hisbaan/loupe"

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <h2 className="mb-3 font-medium">{title}</h2>
      {children}
    </section>
  )
}

/** Runs async actions with a shared busy flag and error message. */
function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      return true
    } catch (err) {
      setError(errorMessage(err))
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

export function SettingsPage() {
  const state = useVault()

  return (
    <Layout>
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="-mt-4 text-sm text-neutral-500">
          Saved to your account, so they follow you to other computers. Credentials stay in your vault.
        </p>
        <ReviewSection contents={state.status === "unlocked" ? state.contents : null} />
        <DiffViewSection />
        {state.status !== "signed_out" && <GitHubSection />}
        {state.status !== "signed_out" && <TrustedSection />}
        <h2 className="mt-2 text-lg font-semibold">Inference credentials</h2>
        {state.status === "unlocked" ? (
          <>
            <ChatGptSection contents={state.contents} />
            <ApiKeySection contents={state.contents} />
            <KeysSection keys={state.record.keys} />
          </>
        ) : (
          <Section title="Vault">
            <VaultGate />
          </Section>
        )}
      </div>
    </Layout>
  )
}

function SelectRow<T extends string>({
  label,
  value,
  choices,
  onChange,
}: {
  label: string
  value: T
  choices: { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)} className={`${inputClass} w-56`}>
        {choices.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function CheckboxRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

const themeChoices = (names: string[]) => names.map((name) => ({ value: name, label: name }))

const ALL_PROVIDERS: Provider[] = ["chatgpt", "api_key"]

/** Which model generates reviews. `contents` is null while the vault is locked. */
function ReviewSection({ contents }: { contents: VaultContents | null }) {
  const { inference } = useSettings()
  const connected = contents ? availableProviders(contents) : []
  const preferred = useInferencePreferences(connected).provider
  const provider = preferred ?? inference.provider ?? "chatgpt"
  const choices = connected.length > 0 ? connected : ALL_PROVIDERS
  const model = inference.models[provider] ?? ""
  const [models, setModels] = useState<string[]>([])
  const { busy, error, run } = useAction()

  async function loadModels() {
    await run(async () => {
      const result = await api.models(await credentialFor(provider))
      if (!result.ok) throw new Error(result.error)
      setModels(result.data.models)
    })
  }

  return (
    <Section title="Reviews">
      <div className="flex flex-col gap-2 text-sm">
        {choices.length > 1 && (
          <SelectRow
            label="Use"
            value={provider}
            choices={choices.map((p) => ({ value: p, label: PROVIDER_LABELS[p] }))}
            onChange={(next) => {
              updateInferenceSettings({ provider: next })
              setModels([])
            }}
          />
        )}
        <label className="flex items-center justify-between gap-3">
          <span>Model{choices.length === 1 && ` (${PROVIDER_LABELS[provider]})`}</span>
          <span className="flex items-center gap-2">
            {connected.includes(provider) && (
              <button type="button" disabled={busy} onClick={loadModels} className={linkButtonClass}>
                Load models
              </button>
            )}
            <input
              list="loupe-models"
              value={model}
              placeholder="e.g. gpt-5"
              onChange={(e) =>
                updateInferenceSettings({ models: { ...inference.models, [provider]: e.target.value.trim() } })
              }
              className={`${inputClass} w-56`}
            />
          </span>
          <datalist id="loupe-models">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        <SelectRow
          label="Effort"
          value={inference.effort}
          choices={EFFORTS}
          onChange={(effort) => updateInferenceSettings({ effort })}
        />
        <p className="text-neutral-500">
          {EFFORTS.find((e) => e.value === inference.effort)?.description} Every level reads the whole diff; effort sets
          how hard the model thinks and how much of the rest of the repository it looks at for context. You can also
          switch it beside a review.
        </p>
        {contents == null && <p className="text-neutral-500">Unlock your vault below to load the list of models.</p>}
        {error && <p className="text-red-600">{error}</p>}
      </div>
    </Section>
  )
}

function DiffViewSection() {
  const s = useDiffSettings()

  return (
    <Section title="Diff view">
      <div className="flex flex-col gap-2 text-sm">
        <SelectRow label="Layout" value={s.diffStyle} choices={DIFF_STYLES} onChange={(diffStyle) => updateDiffSettings({ diffStyle })} />
        <SelectRow
          label="Appearance"
          value={s.themeType}
          choices={THEME_TYPES}
          onChange={(themeType) => updateDiffSettings({ themeType })}
        />
        <SelectRow
          label="Light theme"
          value={s.lightTheme}
          choices={themeChoices(LIGHT_THEMES)}
          onChange={(lightTheme) => updateDiffSettings({ lightTheme })}
        />
        <SelectRow
          label="Dark theme"
          value={s.darkTheme}
          choices={themeChoices(DARK_THEMES)}
          onChange={(darkTheme) => updateDiffSettings({ darkTheme })}
        />
        <SelectRow label="Long lines" value={s.overflow} choices={OVERFLOWS} onChange={(overflow) => updateDiffSettings({ overflow })} />
        <SelectRow
          label="Changes within a line"
          value={s.lineDiffType}
          choices={LINE_DIFF_TYPES}
          onChange={(lineDiffType) => updateDiffSettings({ lineDiffType })}
        />
        <SelectRow
          label="Change markers"
          value={s.diffIndicators}
          choices={DIFF_INDICATORS}
          onChange={(diffIndicators) => updateDiffSettings({ diffIndicators })}
        />
        <SelectRow
          label="Between hunks"
          value={s.hunkSeparators}
          choices={HUNK_SEPARATORS}
          onChange={(hunkSeparators) => updateDiffSettings({ hunkSeparators })}
        />
        <SelectRow
          label="Highlight on hover"
          value={s.lineHoverHighlight}
          choices={LINE_HOVER_HIGHLIGHTS}
          onChange={(lineHoverHighlight) => updateDiffSettings({ lineHoverHighlight })}
        />
        <div className="mt-1 flex flex-wrap gap-x-5 gap-y-2">
          <CheckboxRow label="Line backgrounds" checked={s.backgrounds} onChange={(backgrounds) => updateDiffSettings({ backgrounds })} />
          <CheckboxRow label="Line numbers" checked={s.lineNumbers} onChange={(lineNumbers) => updateDiffSettings({ lineNumbers })} />
          <CheckboxRow label="File header" checked={s.fileHeader} onChange={(fileHeader) => updateDiffSettings({ fileHeader })} />
          <CheckboxRow
            label="Sticky file header"
            checked={s.stickyHeader}
            onChange={(stickyHeader) => updateDiffSettings({ stickyHeader })}
          />
        </div>
        <div>
          <button type="button" onClick={resetDiffSettings} className={`${linkButtonClass} mt-1`}>
            Reset to defaults
          </button>
        </div>
      </div>
    </Section>
  )
}

function GitHubSection() {
  const [installUrl, setInstallUrl] = useState<string | null>(null)

  useEffect(() => {
    api.config().then((r) => setInstallUrl(r.ok ? r.data.install_url : null))
  }, [])

  if (!installUrl) return null

  return (
    <Section title="GitHub">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="text-neutral-500">
          Loupe lists and opens pull requests in repositories where its GitHub App is installed. Add it to another
          account or organization, or change which repositories it can see.
        </span>
        <a href={installUrl} target="_blank" rel="noreferrer" className={`${secondaryButtonClass} shrink-0`}>
          Manage installations
        </a>
      </div>
    </Section>
  )
}

function TrustedSection() {
  const [trusted, setTrusted] = useState<TrustedReviewer[] | null>(null)
  const [login, setLogin] = useState("")
  const [autoLoad, setAutoLoad] = useState(false)
  const { busy, error, run } = useAction()

  useEffect(() => {
    api.trusted().then((r) => setTrusted(r.ok ? r.data.trusted : []))
  }, [])

  async function save(next: string, auto: boolean) {
    const result = await api.trust(next, auto)
    if (!result.ok) throw new Error(result.error)
    setTrusted((ts) =>
      [...(ts ?? []).filter((t) => t.login.toLowerCase() !== next.toLowerCase()), result.data].sort((a, b) =>
        a.login.localeCompare(b.login),
      ),
    )
  }

  async function add(event: FormEvent) {
    event.preventDefault()
    const name = login.trim().replace(/^@/, "")
    if (await run(() => save(name, autoLoad))) {
      setLogin("")
      setAutoLoad(false)
    }
  }

  async function remove(name: string) {
    const result = await api.untrust(name)
    if (!result.ok) throw new Error(result.error)
    setTrusted((ts) => (ts ?? []).filter((t) => t.login !== name))
  }

  return (
    <Section title="Trusted reviewers">
      <p className="mb-3 text-sm text-neutral-500">
        When one of these people has already generated a review of a pull request, Loupe offers theirs first, and
        you can update it after new commits. With auto-load on, it's shown straight away.
      </p>
      {trusted && trusted.length > 0 && (
        <ul className="mb-3 divide-y divide-neutral-200 text-sm dark:divide-neutral-800">
          {trusted.map((t) => (
            <li key={t.login} className="flex items-center gap-3 py-2">
              <span className="flex-1">@{t.login}</span>
              <label className="flex items-center gap-1.5 text-neutral-500">
                <input
                  type="checkbox"
                  checked={t.auto_load}
                  disabled={busy}
                  onChange={(e) => run(() => save(t.login, e.target.checked))}
                />
                Auto-load
              </label>
              <button type="button" disabled={busy} onClick={() => run(() => remove(t.login))} className={linkButtonClass}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="flex items-center gap-2 text-sm">
        <input
          placeholder="GitHub username"
          value={login}
          onChange={(e) => setLogin(e.target.value)}
          className={`${inputClass} min-w-0 flex-1`}
        />
        <label className="flex items-center gap-1.5 text-neutral-500">
          <input type="checkbox" checked={autoLoad} onChange={(e) => setAutoLoad(e.target.checked)} />
          Auto-load
        </label>
        <button type="submit" disabled={busy || !login.trim()} className={buttonClass}>
          Trust
        </button>
      </form>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </Section>
  )
}

function ChatGptSection({ contents }: { contents: VaultContents }) {
  const { busy, error, run } = useAction()
  const connection = contents.chatgpt
  const command = `loupe-gateway login --server ${window.location.origin}`

  return (
    <Section title="ChatGPT">
      {connection ? (
        <div className="flex items-center justify-between text-sm">
          <span>
            Connected. The current access token is valid until{" "}
            {new Date(connection.expires_at * 1000).toLocaleString()} and refreshes automatically.
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => vault.update((c) => ({ ...c, chatgpt: undefined })))}
            className={secondaryButtonClass}
          >
            Disconnect
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2 text-sm text-neutral-500">
          <p>
            Use your ChatGPT plan for reviews. Sign-in runs on your own computer with{" "}
            <code className="font-mono">loupe-gateway</code>, so your ChatGPT tokens never pass through this server
            unencrypted. Install it:
          </p>
          <ul className="list-disc pl-5">
            <li>
              Homebrew: <code className="font-mono">brew install hisbaan/tap/loupe-gateway</code>
            </li>
            <li>
              Cargo: <code className="font-mono">cargo install --git {REPO_URL} loupe-gateway --locked</code>
            </li>
            <li>
              Nix: <code className="font-mono">nix run github:hisbaan/loupe#gateway --</code>
            </li>
          </ul>
          <p>Then run this and sign in when your browser opens:</p>
          <pre className="overflow-x-auto rounded-md bg-neutral-100 px-3 py-2 font-mono text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
            {command}
          </pre>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </Section>
  )
}

function ApiKeySection({ contents }: { contents: VaultContents }) {
  const [value, setValue] = useState("")
  const { busy, error, run } = useAction()
  const saved = contents.openai_api_key

  async function save(event: FormEvent) {
    event.preventDefault()
    if (await run(() => vault.update((c) => ({ ...c, openai_api_key: value.trim() })))) setValue("")
  }

  return (
    <Section title="OpenAI API key">
      {saved && (
        <div className="mb-3 flex items-center justify-between text-sm">
          <span className="font-mono">
            {saved.slice(0, 3)}…{saved.slice(-4)}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => vault.update((c) => ({ ...c, openai_api_key: undefined })))}
            className={secondaryButtonClass}
          >
            Remove
          </button>
        </div>
      )}
      <form onSubmit={save} className="flex gap-2 text-sm">
        <input
          type="password"
          autoComplete="off"
          placeholder={saved ? "Replace with a new key" : "sk-..."}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className={`${inputClass} min-w-0 flex-1`}
        />
        <button type="submit" disabled={busy || !value.trim()} className={buttonClass}>
          Save
        </button>
      </form>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </Section>
  )
}

function KeysSection({ keys }: { keys: VaultKeyRecord[] }) {
  const [adding, setAdding] = useState<"passkey" | "passphrase" | null>(null)
  const [label, setLabel] = useState("")
  const [fields, setFields] = useState({ passphrase: "", confirm: "" })
  const { busy, error, run } = useAction()

  async function add(event: FormEvent) {
    event.preventDefault()
    if (!adding) return
    const name = label.trim() || (adding === "passkey" ? "Passkey" : "Passphrase")
    const ok = await run(async () => {
      if (adding === "passphrase") {
        const problem = passphraseProblem(fields.passphrase, fields.confirm)
        if (problem) throw new Error(problem)
      }
      const method = adding === "passkey" ? ({ kind: "passkey" } as const) : ({ kind: "passphrase", ...fields } as const)
      await vault.addKey(await currentLogin(), method, name)
    })
    if (ok) {
      setAdding(null)
      setLabel("")
      setFields({ passphrase: "", confirm: "" })
    }
  }

  function reset() {
    if (!confirm("Delete the vault? Your saved ChatGPT connection and API key are erased and can't be recovered.")) return
    void run(() => vault.reset())
  }

  return (
    <Section title="Vault keys">
      <p className="mb-3 text-sm text-neutral-500">
        Any of these unlocks your vault. Add a second one so losing a device doesn't lose your credentials.
      </p>
      <ul className="mb-3 divide-y divide-neutral-200 text-sm dark:divide-neutral-800">
        {keys.map((key) => (
          <li key={key.id} className="flex items-center justify-between py-2">
            <span>
              {key.label}{" "}
              <span className="text-neutral-500">
                · {key.kind} · added {timeAgo(key.created_at)}
              </span>
            </span>
            <button
              type="button"
              disabled={busy || keys.length === 1}
              title={keys.length === 1 ? "A vault needs at least one key" : undefined}
              onClick={() => run(() => vault.removeKey(key.id))}
              className={linkButtonClass}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>

      {adding ? (
        <form onSubmit={add} className="flex flex-col gap-2 text-sm">
          <input
            placeholder={adding === "passkey" ? "Label, e.g. Work laptop" : "Label, e.g. Backup passphrase"}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className={inputClass}
          />
          {adding === "passphrase" && <PassphraseFields {...fields} onChange={setFields} />}
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className={buttonClass}>
              {adding === "passkey" ? "Create passkey" : "Add passphrase"}
            </button>
            <button type="button" onClick={() => setAdding(null)} className={secondaryButtonClass}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2 text-sm">
          <button type="button" onClick={() => setAdding("passkey")} className={secondaryButtonClass}>
            Add passkey
          </button>
          <button type="button" onClick={() => setAdding("passphrase")} className={secondaryButtonClass}>
            Add passphrase
          </button>
          <span className="flex-1" />
          <button type="button" onClick={() => vault.lock()} className={secondaryButtonClass}>
            Lock
          </button>
          <button type="button" disabled={busy} onClick={reset} className={`${secondaryButtonClass} text-red-600`}>
            Delete vault
          </button>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </Section>
  )
}
