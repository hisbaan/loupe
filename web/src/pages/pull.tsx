import { useEffect, useState } from "react"
import { FileDiffCard } from "@/components/file-diff-card"
import { Layout } from "@/components/layout"
import { ReviewControls } from "@/components/review-controls"
import { ReviewSummary } from "@/components/review-summary"
import { Walkthrough } from "@/components/walkthrough"
import { api, type ApiResult } from "@/lib/api"
import { fileAnchor } from "@/lib/utils"
import type { PullResponse, ReviewRecord } from "@/lib/types"

type PullPageProps = {
  owner: string
  repo: string
  number: number
}

export function PullPage({ owner, repo, number }: PullPageProps) {
  const [result, setResult] = useState<ApiResult<PullResponse> | null>(null)
  const [record, setRecord] = useState<ReviewRecord | null>(null)

  useEffect(() => {
    let cancelled = false
    api.pull(owner, repo, number).then((r) => {
      if (!cancelled) setResult(r)
    })
    api.reviews(owner, repo, number).then((r) => {
      if (!cancelled && r.ok) setRecord(r.data.reviews[0] ?? null)
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
  const collapsedFiles = files.filter((f) => f.analysis.collapsible).length
  const fileByHunk = new Map(files.flatMap((f) => f.analysis.hunks.map((h) => [h.id, f.filename] as const)))

  function selectHunk(hunkId: string) {
    const filename = fileByHunk.get(hunkId)
    if (filename) document.getElementById(fileAnchor(filename))?.scrollIntoView({ behavior: "smooth" })
  }

  return (
    <Layout wide>
      <div className="mb-6">
        <p className="text-sm text-neutral-500">
          {owner}/{repo} #{pull.number} · {pull.user.login} wants to merge {pull.head.ref} into {pull.base.ref}
        </p>
        <h1 className="mt-1 text-2xl font-semibold">{pull.title}</h1>
        <p className="mt-2 text-sm text-neutral-500">
          {files.length} files changed
          {collapsedFiles > 0 && ` · ${collapsedFiles} collapsed`}
        </p>
        {truncated && <p className="mt-2 text-sm text-amber-600">GitHub only returns the first 3000 files of this pull request.</p>}
      </div>

      <div className="flex gap-6">
        <aside className="sticky top-4 flex h-fit max-h-[calc(100vh-2rem)] w-72 shrink-0 flex-col gap-4 overflow-y-auto">
          <ReviewControls owner={owner} repo={repo} number={number} hasReview={record != null} onReview={setRecord} />
          {record && <Walkthrough review={record.review} onSelectHunk={selectHunk} />}
        </aside>

        <div className="min-w-0 flex-1">
          {record && <ReviewSummary record={record} />}
          <div className="flex flex-col gap-4">
            {files.map((file) => (
              <FileDiffCard key={file.filename} file={file} assessments={record?.review.hunks} />
            ))}
          </div>
        </div>
      </div>
    </Layout>
  )
}
