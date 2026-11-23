import { ConnectPage } from "@/pages/connect"
import { HomePage } from "@/pages/home"
import { PullPage } from "@/pages/pull"
import { SettingsPage } from "@/pages/settings"
import { SetupCallbackPage, SetupPage } from "@/pages/setup"
import { usePathname } from "@/lib/router"

const PULL_ROUTE = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/

export function App() {
  const pathname = usePathname()

  if (pathname === "/connect") return <ConnectPage />
  if (pathname === "/settings") return <SettingsPage />
  if (pathname === "/setup") return <SetupPage />
  if (pathname === "/setup/callback") return <SetupCallbackPage />

  const pull = PULL_ROUTE.exec(pathname)
  // Keyed so moving between pull requests (e.g. layers of a stack) starts fresh.
  if (pull) return <PullPage key={pathname} owner={pull[1]} repo={pull[2]} number={Number(pull[3])} />

  return <HomePage />
}
