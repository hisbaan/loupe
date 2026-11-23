import { useEffect, useMemo, useState } from "react"
import { Layout } from "@/components/layout"
import { Link } from "@/components/link"
import { OpenPullDialog } from "@/components/open-pull-dialog"
import { inputClass, linkButtonClass } from "@/components/ui"
import { api, type ApiResult } from "@/lib/api"
import type { Me, PullListResponse, PullReason, PullSummary } from "@/lib/types"
import { cn, timeAgo } from "@/lib/utils"

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

/** The last list, kept for the session so returning home shows it at once. */
let lastList: PullListResponse | null = null

const iconButtonClass =
  "rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-50 dark:hover:bg-neutral-900 dark:hover:text-neutral-100"

function PullList({ installUrl }: { installUrl: string | null }) {
  const [list, setList] = useState<PullListResponse | null>(lastList)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [filter, setFilter] = useState("")
  const [hideDrafts, setHideDrafts] = useState(false)

  function show(result: ApiResult<PullListResponse>) {
    if (result.ok) {
      lastList = result.data
      setList(result.data)
      setError(null)
    } else setError(result.error)
  }

  async function refresh() {
    setLoading(true)
    show(await api.pulls(true))
    setLoading(false)
  }

  // Revalidates the session's list; the server caches it briefly too.
  useEffect(() => {
    api.pulls().then(show)
  }, [])

  const stacks = useMemo(() => findStacks(list?.pulls ?? []), [list])
  const query = filter.trim().toLowerCase()
  const shown = list?.pulls.filter(
    (pull) =>
      !(hideDrafts && pull.draft) &&
      (!query ||
        `${pull.title} ${pull.repo}#${pull.number} ${pull.author.login}`.toLowerCase().includes(query)),
  )

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center gap-1">
        <h1 className="flex-1 text-lg font-semibold">Pull requests</h1>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          title="Refresh"
          aria-label="Refresh"
          className={iconButtonClass}
        >
          <svg
            viewBox="0 0 16 16"
            className={`size-4 ${loading ? "animate-spin" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v2.5H11" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          title="Open a pull request by URL"
          aria-label="Open a pull request by URL"
          className={iconButtonClass}
        >
          <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M8 3v10M3 8h10" />
          </svg>
        </button>
      </div>
      <OpenPullDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />

      {list && list.pulls.length > 0 && (
        <div className="mt-4 flex items-center gap-4">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter by title, repository or author"
            aria-label="Filter pull requests"
            className={`${inputClass} flex-1 text-sm`}
          />
          <label className="flex shrink-0 items-center gap-1.5 text-sm text-neutral-500">
            <input type="checkbox" checked={hideDrafts} onChange={(event) => setHideDrafts(event.target.checked)} />
            Hide drafts
          </label>
        </div>
      )}

      {error && <p className="mt-6 text-sm text-red-600">{error}</p>}
      {list?.partial && (
        <p className="mt-6 text-sm text-amber-600">
          Some repositories couldn't be loaded from GitHub, so this list may be incomplete.
        </p>
      )}
      {!error && list === null && <p className="mt-6 text-sm text-neutral-500">Loading…</p>}
      {list?.pulls.length === 0 && (
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
      {list && list.pulls.length > 0 && shown?.length === 0 && (
        <p className="mt-6 text-sm text-neutral-500">No pull requests match.</p>
      )}
      {shown &&
        SECTIONS.map(({ reason, title }) => {
          const items = shown.filter((pull) => pull.reasons[0] === reason)
          if (items.length === 0) return null
          return (
            <section key={reason} className="mt-6">
              <h2 className="text-sm font-medium text-neutral-500">{title}</h2>
              <ul className="mt-2 divide-y divide-neutral-200 rounded-md border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
                {groupStacks(items, stacks).map((group) => (
                  <li key={pullKey(group[0])}>
                    {group.length > 1 && (
                      <div className="px-3 pt-2 text-xs text-neutral-500">
                        Stack of {stacks.get(pullKey(group[0]))!.size} onto {stacks.get(pullKey(group[0]))!.base}
                      </div>
                    )}
                    <div className={cn(group.length > 1 && "ml-3 border-l-2 border-neutral-200 dark:border-neutral-800")}>
                      {group.map((pull) => (
                        <PullRow key={pullKey(pull)} pull={pull} stack={stacks.get(pullKey(pull))} />
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
    </div>
  )
}

type StackPlace = {
  /** Identifies the stack: its bottom pull request. */
  id: string
  /** 1-based, bottom first. */
  position: number
  size: number
  /** The branch the bottom layer targets. */
  base: string
}

const pullKey = (pull: PullSummary) => `${pull.repo}#${pull.number}`

/**
 * Stacks among the listed pull requests: chains in one repository where each
 * targets the branch of the one below. A branch with several pull requests on
 * top of it ends the chain, as on the server.
 */
function findStacks(pulls: PullSummary[]): Map<string, StackPlace> {
  const branch = (repo: string, ref: string) => `${repo}:${ref}`
  const local = pulls.filter((p) => !p.cross_repository)
  const byHead = new Map(local.map((p) => [branch(p.repo, p.head_ref), p]))
  const byBase = new Map<string, PullSummary[]>()
  for (const p of local) byBase.set(branch(p.repo, p.base_ref), [...(byBase.get(branch(p.repo, p.base_ref)) ?? []), p])
  const above = (p: PullSummary) => {
    const next = byBase.get(branch(p.repo, p.head_ref))
    return next?.length === 1 ? next[0] : undefined
  }

  const places = new Map<string, StackPlace>()
  for (const start of local) {
    if (places.has(pullKey(start))) continue
    let bottom = start
    const seen = new Set([pullKey(start)])
    for (;;) {
      const below = byHead.get(branch(bottom.repo, bottom.base_ref))
      if (!below || seen.has(pullKey(below)) || above(below) !== bottom) break
      seen.add(pullKey(below))
      bottom = below
    }
    const chain = [bottom]
    for (let next = above(bottom); next && !chain.includes(next); next = above(next)) chain.push(next)
    if (chain.length < 2) continue
    chain.forEach((p, i) =>
      places.set(pullKey(p), { id: pullKey(bottom), position: i + 1, size: chain.length, base: bottom.base_ref }),
    )
  }
  return places
}

/** Puts each stack's pull requests together, top first, where its first one appears. */
function groupStacks(items: PullSummary[], stacks: Map<string, StackPlace>): PullSummary[][] {
  const groups: PullSummary[][] = []
  const byStack = new Map<string, PullSummary[]>()
  for (const pull of items) {
    const place = stacks.get(pullKey(pull))
    if (!place) {
      groups.push([pull])
      continue
    }
    let group = byStack.get(place.id)
    if (!group) {
      group = []
      byStack.set(place.id, group)
      groups.push(group)
    }
    group.push(pull)
  }
  const position = (pull: PullSummary) => stacks.get(pullKey(pull))!.position
  for (const group of byStack.values()) group.sort((a, b) => position(b) - position(a))
  return groups
}

function PullRow({ pull, stack }: { pull: PullSummary; stack?: StackPlace }) {
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
          {stack && (
            <span className="shrink-0 rounded border border-neutral-300 px-1 text-xs text-neutral-500 dark:border-neutral-700">
              {stack.position}/{stack.size}
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
