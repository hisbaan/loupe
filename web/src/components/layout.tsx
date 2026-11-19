import type { ReactNode } from "react"
import { Link } from "@/components/link"

type LayoutProps = {
  children: ReactNode
  aside?: ReactNode
  wide?: boolean
}

export function Layout({ children, aside, wide = false }: LayoutProps) {
  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b border-neutral-200 px-6 py-3 dark:border-neutral-800">
        <Link href="/" className="font-semibold tracking-tight">
          loupe
        </Link>
        <div className="flex items-center gap-4 text-sm">
          {aside}
          <Link href="/settings" className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100">
            Settings
          </Link>
        </div>
      </header>
      <main className={wide ? "px-6 py-8" : "mx-auto max-w-7xl px-6 py-8"}>{children}</main>
    </div>
  )
}
