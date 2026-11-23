import { useEffect, useState } from "react"
import { Layout } from "@/components/layout"
import { Link } from "@/components/link"
import { OpenPullDialog } from "@/components/open-pull-dialog"
import { linkButtonClass } from "@/components/ui"
import { api } from "@/lib/api"
import type { Me, PullReason, PullSummary } from "@/lib/types"
import { timeAgo } from "@/lib/utils"

export function HomePage() {
  const [me, setMe] = useState<Me | null | undefined>(undefined)
  const [configured, setConfigured] = useState(true)
  const [installUrl, setInstallUrl] = useState<string | null>(null)

  useEffect(() => {
    api.me().then((result) => setMe(result.ok ? result.data : null))
    api.config().then((result) => {
      if (!result.ok) return
      setConfigured(result.data.github_configured)
      setInstallUrl(result.data.install_url)
    })
  }, [])

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
      <PullList installUrl={installUrl} />
    </Layout>
  )
}

const SECTIONS: { reason: PullReason; title: string }[] = [
  { reason: "review_requested", title: "Review requested" },
  { reason: "authored", title: "Your pull requests" },
  { reason: "maintainer", title: "Open in your repositories" },
]

function PullList({ installUrl }: { installUrl: string | null }) {
  const [pulls, setPulls] = useState<PullSummary[] | null>(null)
  const [partial, setPartial] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  useEffect(() => {
    api.pulls().then((result) => {
      if (result.ok) {
        setPulls(result.data.pulls)
        setPartial(result.data.partial)
      } else setError(result.error)
    })
  }, [])

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Pull requests</h1>
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          title="Open a pull request by URL"
          aria-label="Open a pull request by URL"
          className="rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-900 dark:hover:text-neutral-100"
        >
          <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M8 3v10M3 8h10" />
          </svg>
        </button>
      </div>
      <OpenPullDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />

      {error && <p className="mt-6 text-sm text-red-600">{error}</p>}
      {partial && (
        <p className="mt-6 text-sm text-amber-600">
          Some repositories couldn't be loaded from GitHub, so this list may be incomplete.
        </p>
      )}
      {!error && pulls === null && <p className="mt-6 text-sm text-neutral-500">Loading…</p>}
      {pulls?.length === 0 && (
        <p className="mt-6 text-sm text-neutral-500">
          No open pull requests in repositories Loupe can see.{" "}
          {installUrl && (
            <a href={installUrl} className={linkButtonClass}>
              Install the GitHub App
            </a>
          )}{" "}
          on more repositories, or use + to open one by URL.
        </p>
      )}
      {pulls &&
        SECTIONS.map(({ reason, title }) => {
          const items = pulls.filter((pull) => pull.reasons[0] === reason)
          if (items.length === 0) return null
          return (
            <section key={reason} className="mt-6">
              <h2 className="text-sm font-medium text-neutral-500">{title}</h2>
              <ul className="mt-2 divide-y divide-neutral-200 rounded-md border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
                {items.map((pull) => (
                  <li key={`${pull.repo}#${pull.number}`}>
                    <PullRow pull={pull} />
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
    </div>
  )
}

function PullRow({ pull }: { pull: PullSummary }) {
  return (
    <Link
      href={`/${pull.repo}/pull/${pull.number}`}
      className="flex items-center gap-3 px-3 py-2.5 hover:bg-neutral-50 dark:hover:bg-neutral-900"
    >
      {pull.author.avatar_url ? (
        <img src={pull.author.avatar_url} alt="" className="size-6 shrink-0 rounded-full" />
      ) : (
        <span className="size-6 shrink-0 rounded-full bg-neutral-200 dark:bg-neutral-800" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate">{pull.title}</span>
          {pull.draft && (
            <span className="shrink-0 rounded border border-neutral-300 px-1 text-xs text-neutral-500 dark:border-neutral-700">
              Draft
            </span>
          )}
        </div>
        <div className="truncate text-xs text-neutral-500">
          {pull.repo}#{pull.number} by {pull.author.login}
        </div>
      </div>
      <span className="shrink-0 text-xs text-neutral-500">{timeAgo(Date.parse(pull.updated_at) / 1000)}</span>
    </Link>
  )
}
