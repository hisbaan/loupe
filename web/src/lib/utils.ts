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

/** Scrolls to the card showing a hunk. */
export function scrollToHunk(hunkId: string) {
  scrollTo(document.querySelector(`[data-hunks~="${CSS.escape(hunkId)}"]`))
}

/** How long the target has to stay put before scrollAndHold lets go. */
const HOLD_STILL_MS = 3000
/** Gives up regardless, in case something keeps moving. */
const HOLD_MAX_MS = 15000
const USER_SCROLL_EVENTS = ["wheel", "touchstart", "keydown", "pointerdown"] as const
let releaseHold: (() => void) | null = null

/**
 * Scrolls to what `find` returns and keeps it in place while the page around
 * it is still loading (a review arriving shifts everything below its summary),
 * until it has stayed put for a while or you scroll yourself. `find` is asked
 * again every frame, so it can return something better once that renders.
 */
export function scrollAndHold(find: () => Element | null) {
  releaseHold?.()
  const started = performance.now()
  let still = started
  let target: Element | null = null
  let top = 0
  let frame = 0

  const release = () => {
    cancelAnimationFrame(frame)
    for (const event of USER_SCROLL_EVENTS) window.removeEventListener(event, release, true)
    if (releaseHold === release) releaseHold = null
  }
  const tick = (now: number) => {
    const found = find()
    if (found && (found !== target || Math.abs(found.getBoundingClientRect().top - top) > 1)) {
      found.scrollIntoView({ block: "start" })
      target = found
      top = found.getBoundingClientRect().top
      still = now
    }
    if (now - started > HOLD_MAX_MS || (target && now - still > HOLD_STILL_MS)) release()
    else frame = requestAnimationFrame(tick)
  }

  releaseHold = release
  for (const event of USER_SCROLL_EVENTS) window.addEventListener(event, release, { capture: true, passive: true })
  frame = requestAnimationFrame(tick)
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
