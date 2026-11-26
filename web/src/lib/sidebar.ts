import { createContext, useContext } from "react"

/** Closes the sidebar when it's open over the diff, so the place a link jumps to shows. */
export const SidebarNavigateContext = createContext<() => void>(() => {})

/** For sidebar links that scroll the diff: call before scrolling. */
export const useSidebarNavigate = () => useContext(SidebarNavigateContext)
