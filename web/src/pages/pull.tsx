import { useEffect, useState } from "react"
import { FileDiffCard } from "@/components/file-diff-card"
import { Layout } from "@/components/layout"
import { api, type ApiResult } from "@/lib/api"
import type { PullResponse } from "@/lib/types"

type PullPageProps = {
  owner: string
  repo: string
  number: number
}

export function PullPage({ owner, repo, number }: PullPageProps) {
  const [result, setResult] = useState<ApiResult<PullResponse> | null>(null)

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
  const collapsedFiles = files.filter((f) => f.analysis.collapsible).length
  return (
    <Layout>
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
      <div className="flex flex-col gap-4">
        {files.map((file) => (
          <FileDiffCard key={file.filename} file={file} />
        ))}
      </div>
    </Layout>
  )
}
