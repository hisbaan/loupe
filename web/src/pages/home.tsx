import { useEffect, useState, type FormEvent } from "react"
import { Layout } from "@/components/layout"
import { Link } from "@/components/link"
import { api } from "@/lib/api"
import { navigate } from "@/lib/router"
import type { Me } from "@/lib/types"

const PR_URL = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/

export function HomePage() {
  const [me, setMe] = useState<Me | null | undefined>(undefined)
  const [configured, setConfigured] = useState(true)
  const [url, setUrl] = useState("")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.me().then((result) => setMe(result.ok ? result.data : null))
    api.config().then((result) => result.ok && setConfigured(result.data.github_configured))
  }, [])

  function openPull(event: FormEvent) {
    event.preventDefault()
    const match = PR_URL.exec(url)
    if (!match) {
      setError("Paste a GitHub pull request URL")
      return
    }
    navigate(`/${match[1]}/${match[2]}/pull/${match[3]}`)
  }

  if (me === undefined) return <Layout>{null}</Layout>

  if (me === null && !configured) {
    return (
      <Layout>
        <div className="mx-auto mt-24 max-w-md text-center">
          <h1 className="text-2xl font-semibold">Loupe isn't set up yet</h1>
          <p className="mt-2 text-neutral-500">
            It needs a GitHub App before anyone can sign in. If you run this server,{" "}
            <Link href="/setup" className="text-blue-600 hover:underline dark:text-blue-400">
              finish setup
            </Link>{" "}
            with the token from its log.
          </p>
        </div>
      </Layout>
    )
  }

  if (me === null) {
    return (
      <Layout>
        <div className="mx-auto mt-24 max-w-md text-center">
          <h1 className="text-2xl font-semibold">Guided pull request reviews</h1>
          <p className="mt-2 text-neutral-500">Sign in with GitHub to review pull requests you have access to.</p>
          <a
            href="/auth/github/login"
            className="mt-6 inline-block rounded-md bg-neutral-900 px-4 py-2 text-white dark:bg-neutral-100 dark:text-neutral-900"
          >
            Sign in with GitHub
          </a>
        </div>
      </Layout>
    )
  }

  return (
    <Layout aside={<span className="text-sm text-neutral-500">{me.login}</span>}>
      <form onSubmit={openPull} className="mx-auto mt-24 flex max-w-xl gap-2">
        <input
          value={url}
          onChange={(event) => {
            setUrl(event.target.value)
            setError(null)
          }}
          placeholder="https://github.com/owner/repo/pull/123"
          className="flex-1 rounded-md border border-neutral-300 bg-transparent px-3 py-2 dark:border-neutral-700"
        />
        <button type="submit" className="rounded-md bg-neutral-900 px-4 py-2 text-white dark:bg-neutral-100 dark:text-neutral-900">
          Open
        </button>
      </form>
      {error && <p className="mt-2 text-center text-sm text-red-600">{error}</p>}
    </Layout>
  )
}
