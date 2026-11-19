export function cn(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ")
}

export function fileAnchor(filename: string) {
  return `file:${filename}`
}

export function diagramAnchor(stepIndex: number) {
  return `diagram:${stepIndex}`
}

export function timeAgo(unixSeconds: number) {
  const seconds = Math.max(0, Date.now() / 1000 - unixSeconds)
  if (seconds < 60) return "just now"
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}
