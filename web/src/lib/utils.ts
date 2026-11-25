import type { Pull, PullFile } from "@/lib/types"

export function cn(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ")
}

export function sectionAnchor(index: number) {
  return `section:${index}`
}

function scrollTo(element: Element | null) {
  element?.scrollIntoView({ behavior: "smooth", block: "start" })
}

/** Scrolls to the first card showing the file (a file can be split over several). */
export function scrollToFile(filename: string) {
  scrollTo(document.querySelector(`[data-file="${CSS.escape(filename)}"]`))
}

/** Scrolls to the card showing a hunk. */
export function scrollToHunk(hunkId: string) {
  scrollTo(document.querySelector(`[data-hunks~="${CSS.escape(hunkId)}"]`))
}

export function timeAgo(unixSeconds: number) {
  const seconds = Math.max(0, Date.now() / 1000 - unixSeconds)
  if (seconds < 60) return "just now"
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

/** The file on GitHub at the pull request's head, or its base if the change removes it. */
export function githubFileUrl(pull: Pull, file: PullFile) {
  const repoUrl = pull.html_url.replace(/\/pull\/\d+$/, "")
  const sha = file.status === "removed" ? pull.base.sha : pull.head.sha
  return `${repoUrl}/blob/${sha}/${file.filename.split("/").map(encodeURIComponent).join("/")}`
}
