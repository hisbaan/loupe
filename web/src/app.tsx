import { ConnectPage } from "@/pages/connect"
import { HomePage } from "@/pages/home"
import { PullPage } from "@/pages/pull"
import { usePathname } from "@/lib/router"

const PULL_ROUTE = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/

export function App() {
  const pathname = usePathname()

  if (pathname === "/connect") return <ConnectPage />

  const pull = PULL_ROUTE.exec(pathname)
  if (pull) return <PullPage owner={pull[1]} repo={pull[2]} number={Number(pull[3])} />

  return <HomePage />
}
