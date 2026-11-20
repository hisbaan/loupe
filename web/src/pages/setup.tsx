import { useEffect, useRef, useState, type FormEvent } from "react"
import { Layout } from "@/components/layout"
import { buttonClass, inputClass, linkButtonClass, secondaryButtonClass } from "@/components/ui"
import { api } from "@/lib/api"

// The setup token is needed again on the callback page, after GitHub's
// redirect, so it's kept for this tab only.
const TOKEN_KEY = "loupe.setup_token"

function Page({ children }: { children: React.ReactNode }) {
  return (
    <Layout>
      <div className="mx-auto mt-16 flex max-w-xl flex-col gap-4">{children}</div>
    </Layout>
  )
}

/** First-run setup: create Loupe's GitHub App from a manifest. */
export function SetupPage() {
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) ?? "")
  const [name, setName] = useState(`Loupe (${window.location.hostname})`.slice(0, 34))
  const [owner, setOwner] = useState<"me" | "org">("me")
  const [organization, setOrganization] = useState("")
  const [isPublic, setPublic] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.config().then((r) => setConfigured(r.ok ? r.data.github_configured : null))
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    const result = await api.setupManifest({
      token: token.trim(),
      name: name.trim(),
      organization: owner === "org" ? organization.trim() : null,
      public: isPublic,
    })
    if (!result.ok) return setError(result.error)
    sessionStorage.setItem(TOKEN_KEY, token.trim())
    // GitHub takes the manifest as a form POST.
    const form = document.createElement("form")
    form.method = "post"
    form.action = result.data.action
    const field = document.createElement("input")
    field.type = "hidden"
    field.name = "manifest"
    field.value = result.data.manifest
    form.append(field)
    document.body.append(form)
    form.submit()
  }

  if (configured === null) return <Page>Loading…</Page>
  if (configured) {
    return (
      <Page>
        <h1 className="text-2xl font-semibold">Already set up</h1>
        <p className="text-neutral-500">Loupe is connected to its GitHub App.</p>
      </Page>
    )
  }

  return (
    <Page>
      <h1 className="text-2xl font-semibold">Set up Loupe</h1>
      <p className="text-sm text-neutral-500">
        Loupe signs people in and reads pull requests through a GitHub App. This creates one for this server with
        read-only access to code, pull requests and metadata. You'll get its credentials to put in your{" "}
        <code className="font-mono">.env</code>.
      </p>
      <form onSubmit={submit} className="flex flex-col gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-neutral-500">Setup token (printed in the server's log at startup)</span>
          <input value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" className={inputClass} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-neutral-500">App name (unique across GitHub, at most 34 characters)</span>
          <input value={name} maxLength={34} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </label>
        <fieldset className="flex flex-col gap-1">
          <span className="text-neutral-500">Owner</span>
          <label className="flex items-center gap-2">
            <input type="radio" checked={owner === "me"} onChange={() => setOwner("me")} /> My account
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={owner === "org"} onChange={() => setOwner("org")} /> An organization
          </label>
          {owner === "org" && (
            <input
              placeholder="Organization name"
              value={organization}
              onChange={(e) => setOrganization(e.target.value)}
              className={inputClass}
            />
          )}
        </fieldset>
        <label className="flex items-start gap-2">
          <input type="checkbox" checked={isPublic} onChange={(e) => setPublic(e.target.checked)} className="mt-1" />
          <span>
            Let other accounts and organizations install it
            <span className="block text-neutral-500">
              Needed for anyone else to review private repositories outside the owner's account. Public repositories
              work either way.
            </span>
          </span>
        </label>
        <button type="submit" disabled={!token.trim() || !name.trim()} className={buttonClass}>
          Create GitHub App
        </button>
        {error && <p className="text-red-600">{error}</p>}
      </form>
    </Page>
  )
}

type Result = { env: string; app_url: string; install_url: string }

/** Reads GitHub's redirect parameters once and drops the single-use code from the address bar. */
function readCallback() {
  const params = new URLSearchParams(window.location.search)
  const code = params.get("code")
  const state = params.get("state")
  const token = sessionStorage.getItem(TOKEN_KEY)
  window.history.replaceState(null, "", window.location.pathname)
  return code && state && token ? { code, state, token } : null
}

/** Where GitHub sends the admin back after creating the app. */
export function SetupCallbackPage() {
  const [params] = useState(readCallback)
  const [result, setResult] = useState<Result | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  // The code works once, so don't send it twice (e.g. StrictMode effects).
  const sent = useRef(false)
  const error = params ? failure : "This page is only useful straight after creating the app. Start again from /setup."

  useEffect(() => {
    if (!params || sent.current) return
    sent.current = true
    api.setupConvert(params).then((r) => {
      sessionStorage.removeItem(TOKEN_KEY)
      if (r.ok) setResult(r.data)
      else setFailure(r.error)
    })
  }, [params])

  if (error) {
    return (
      <Page>
        <h1 className="text-2xl font-semibold">Setup didn't finish</h1>
        <p className="text-red-600">{error}</p>
        <a href="/setup" className={linkButtonClass}>
          Back to setup
        </a>
      </Page>
    )
  }
  if (!result) return <Page>Finishing setup…</Page>

  return (
    <Page>
      <h1 className="text-2xl font-semibold">GitHub App created</h1>
      <ol className="flex list-decimal flex-col gap-3 pl-5 text-sm">
        <li>
          Add these lines to your <code className="font-mono">.env</code>. They're shown only once; the secret can be
          regenerated in the{" "}
          <a href={result.app_url} target="_blank" rel="noreferrer" className={linkButtonClass}>
            app's settings
          </a>{" "}
          if lost.
          <pre className="mt-2 overflow-x-auto rounded-md bg-neutral-100 p-3 font-mono text-xs dark:bg-neutral-900">
            {result.env}
          </pre>
          <button
            type="button"
            onClick={() => navigator.clipboard.writeText(result.env).then(() => setCopied(true))}
            className={`mt-2 ${secondaryButtonClass}`}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </li>
        <li>Restart Loupe.</li>
        <li>
          <a href={result.install_url} target="_blank" rel="noreferrer" className={linkButtonClass}>
            Install the app
          </a>{" "}
          on the accounts and organizations whose private repositories you want to review.
        </li>
      </ol>
    </Page>
  )
}
