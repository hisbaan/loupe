import { PatchDiff } from "@pierre/diffs/react"
import { toUnifiedPatch } from "@/lib/patch"
import type { PullFile } from "@/lib/types"

type FileDiffCardProps = {
  file: PullFile
  collapsed?: boolean
}

export function FileDiffCard({ file, collapsed = false }: FileDiffCardProps) {
  const patch = toUnifiedPatch(file)

  if (patch == null) {
    return (
      <div className="rounded-md border border-neutral-200 px-4 py-3 text-sm dark:border-neutral-800">
        <span className="font-mono">{file.filename}</span>
        <span className="ml-2 text-neutral-500">Binary or too large to display</span>
      </div>
    )
  }

  return (
    <PatchDiff
      patch={patch}
      className="overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-800"
      options={{ diffStyle: "split", themeType: "system", collapsed, stickyHeader: true }}
    />
  )
}
