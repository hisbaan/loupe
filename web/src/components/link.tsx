import type { AnchorHTMLAttributes, MouseEvent } from "react"
import { navigate } from "@/lib/router"

/**
 * An in-app link. Navigating without a page load keeps the vault unlocked, since
 * its key only lives in memory.
 */
export function Link({ href, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event)
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate(href)
  }
  return <a href={href} onClick={handleClick} {...props} />
}
