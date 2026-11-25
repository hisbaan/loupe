import { useCallback, useEffect, useState } from "react"
import { Conversation } from "@/components/conversation"
import { GuidedReview } from "@/components/guided-review"
import { Layout } from "@/components/layout"
import { ReviewPanel } from "@/components/review-panel"
import { SelfReview } from "@/components/self-review"
import { StackNav } from "@/components/stack-nav"
import { linkButtonClass } from "@/components/ui"
import { api, type ApiResult } from "@/lib/api"
import { useDiscussion } from "@/lib/discussion"
import { cn, scrollToFile } from "@/lib/utils"
import type { PullResponse } from "@/lib/types"

type PullPageProps = {
  owner: string
  repo: string
  number: number
}

type Mode = "guided" | "self" | "conversation"

export function PullPage({ owner, repo, number }: PullPageProps) {
  const [result, setResult] = useState<ApiResult<PullResponse> | null>(null)
  // null: follow the default for the pull request (self-review for drafts).
  const [chosenMode, setMode] = useState<Mode | null>(null)
  const [installUrl, setInstallUrl] = useState<string | null>(null)
  const discussion = useDiscussion(owner, repo, number)

  const load = useCallback(() => api.pull(owner, repo, number), [owner, repo, number])

  useEffect(() => {
    let cancelled = false
    load().then((r) => {
      if (!cancelled) setResult(r)
    })
    api.config().then((r) => {
      if (!cancelled && r.ok) setInstallUrl(r.data.install_url)
    })
    return () => {
      cancelled = true
    }
  }, [load])

  if (!result) return <Layout>Loading…</Layout>
  if (!result.ok) {
    if (result.status === 404) {
      return (
        <Layout>
          <p>Pull request not found, or you don't have access to it.</p>
          <p className="mt-2 text-sm text-neutral-500">
            For a private repository, Loupe's GitHub App also has to be installed on the account or organization that
            owns it.
            {installUrl && (
              <>
                {" "}
                <a href={installUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline dark:text-blue-400">
                  Install it
                </a>
                .
              </>
            )}
          </p>
        </Layout>
      )
    }
    return <Layout>{result.status === 401 ? "Sign in to view this pull request." : result.error}</Layout>
  }

  const { pull, files, truncated } = result.data
  const mode = chosenMode ?? (pull.draft ? "self" : "guided")
  const collapsedFiles = files.filter((f) => f.analysis.collapsible).length
  const loaded = discussion.discussion
  // Pushed to since this page loaded: comments would land on lines that moved.
  const stale = loaded != null && loaded.head_sha !== pull.head.sha
  const conversationCount = loaded ? loaded.comments.length + loaded.reviews.length + loaded.threads.length : null

  async function loadNewCommits() {
    // In-app, not a page load, which would reload everything.
    setResult(await load())
    await discussion.reload()
  }

  function showFile(path: string) {
    setMode("guided")
    // After the diff renders.
    window.setTimeout(() => scrollToFile(path), 50)
  }

  const tab = (value: Mode, label: string) => (
    <button
      type="button"
      onClick={() => setMode(value)}
      className={cn(
        "border-b-2 px-1 pb-2 text-sm",
        mode === value
          ? "border-neutral-900 font-medium dark:border-neutral-100"
          : "border-transparent text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100",
      )}
    >
      {label}
    </button>
  )

  return (
    <Layout wide>
      <div className="mb-6">
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-neutral-500">
              {owner}/{repo} #{pull.number} · {pull.user.login} wants to merge {pull.head.ref} into {pull.base.ref}
              {pull.draft && " · draft"}
              {pull.state !== "open" && ` · ${pull.state}`}
            </p>
            <h1 className="mt-1 text-2xl font-semibold">{pull.title}</h1>
          </div>
          <div className="flex shrink-0 items-center gap-3 text-sm">
            <a
              href={pull.html_url}
              target="_blank"
              rel="noreferrer"
              className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
            >
              Open on GitHub ↗
            </a>
            <ReviewPanel owner={owner} repo={repo} pull={pull} state={discussion} />
          </div>
        </div>
        <p className="mt-2 text-sm text-neutral-500">
          {files.length} files changed
          {collapsedFiles > 0 && ` · ${collapsedFiles} collapsed`}
        </p>
        {truncated && <p className="mt-2 text-sm text-amber-600">GitHub only returns the first 3000 files of this pull request.</p>}
        {stale && (
          <p className="mt-2 text-sm text-amber-600">
            New commits were pushed since this page loaded, so comments and reviews are paused.{" "}
            <button type="button" onClick={loadNewCommits} className={linkButtonClass}>
              Load them
            </button>
          </p>
        )}
        {discussion.error && !loaded && (
          <p className="mt-2 text-sm text-red-600">Couldn't load comments from GitHub: {discussion.error}</p>
        )}
        <StackNav owner={owner} repo={repo} number={number} />
        <div className="mt-4 flex gap-6 border-b border-neutral-200 dark:border-neutral-800">
          {tab("guided", "Guided review")}
          {tab("self", "Self-review")}
          {tab("conversation", conversationCount ? `Conversation (${conversationCount})` : "Conversation")}
        </div>
      </div>

      {/* Keyed by head commit so loading new commits refetches which reviews are current. */}
      {mode === "guided" && (
        <GuidedReview key={pull.head.sha} owner={owner} repo={repo} number={number} pr={result.data} discussion={discussion} />
      )}
      {mode === "self" && <SelfReview key={pull.head.sha} owner={owner} repo={repo} number={number} pr={result.data} />}
      {mode === "conversation" && (
        <Conversation owner={owner} repo={repo} pull={pull} state={discussion} onShowFile={showFile} />
      )}
    </Layout>
  )
}
