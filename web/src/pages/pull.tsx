import { useEffect, useState } from "react"
import { GuidedReview } from "@/components/guided-review"
import { Layout } from "@/components/layout"
import { SelfReview } from "@/components/self-review"
import { api, type ApiResult } from "@/lib/api"
import { cn } from "@/lib/utils"
import type { PullResponse } from "@/lib/types"

type PullPageProps = {
  owner: string
  repo: string
  number: number
}

type Mode = "guided" | "self"

export function PullPage({ owner, repo, number }: PullPageProps) {
  const [result, setResult] = useState<ApiResult<PullResponse> | null>(null)
  // null: follow the default for the pull request (self-review for drafts).
  const [chosenMode, setMode] = useState<Mode | null>(null)

  useEffect(() => {
    let cancelled = false
    api.pull(owner, repo, number).then((r) => {
      if (!cancelled) setResult(r)
    })
    return () => {
      cancelled = true
    }
  }, [owner, repo, number])

  if (!result) return <Layout>Loading…</Layout>
  if (!result.ok) {
    const message =
      result.status === 401
        ? "Sign in to view this pull request."
        : result.status === 404
          ? "Pull request not found, or you don't have access to it."
          : result.error
    return <Layout>{message}</Layout>
  }

  const { pull, files, truncated } = result.data
  const mode = chosenMode ?? (pull.draft ? "self" : "guided")
  const collapsedFiles = files.filter((f) => f.analysis.collapsible).length
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
        <p className="text-sm text-neutral-500">
          {owner}/{repo} #{pull.number} · {pull.user.login} wants to merge {pull.head.ref} into {pull.base.ref}
          {pull.draft && " · draft"}
        </p>
        <h1 className="mt-1 text-2xl font-semibold">{pull.title}</h1>
        <p className="mt-2 text-sm text-neutral-500">
          {files.length} files changed
          {collapsedFiles > 0 && ` · ${collapsedFiles} collapsed`}
        </p>
        {truncated && <p className="mt-2 text-sm text-amber-600">GitHub only returns the first 3000 files of this pull request.</p>}
        <div className="mt-4 flex gap-6 border-b border-neutral-200 dark:border-neutral-800">
          {tab("guided", "Guided review")}
          {tab("self", "Self-review")}
        </div>
      </div>

      {mode === "guided" ? (
        <GuidedReview owner={owner} repo={repo} number={number} pr={result.data} />
      ) : (
        <SelfReview owner={owner} repo={repo} number={number} pr={result.data} />
      )}
    </Layout>
  )
}
