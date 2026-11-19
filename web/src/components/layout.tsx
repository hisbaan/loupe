import type { ReactNode } from "react"

type LayoutProps = {
  children: ReactNode
  aside?: ReactNode
  wide?: boolean
}

export function Layout({ children, aside, wide = false }: LayoutProps) {
  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b border-neutral-200 px-6 py-3 dark:border-neutral-800">
        <a href="/" className="font-semibold tracking-tight">
          loupe
        </a>
        {aside}
      </header>
      <main className={wide ? "px-6 py-8" : "mx-auto max-w-7xl px-6 py-8"}>{children}</main>
    </div>
  )
}
