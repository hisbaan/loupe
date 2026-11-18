import { useSyncExternalStore } from "react"

// Deliberately tiny: Loupe has a handful of routes. Swap for a real router once
// that stops being true.

function subscribe(onChange: () => void) {
  window.addEventListener("popstate", onChange)
  return () => window.removeEventListener("popstate", onChange)
}

export function usePathname() {
  return useSyncExternalStore(subscribe, () => window.location.pathname)
}

export function navigate(to: string) {
  window.history.pushState(null, "", to)
  window.dispatchEvent(new PopStateEvent("popstate"))
}
