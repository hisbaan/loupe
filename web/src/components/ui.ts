// Shared Tailwind class strings for the few control styles Loupe uses.

export const buttonClass =
  "rounded-md bg-neutral-900 px-3 py-1.5 text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"

export const secondaryButtonClass =
  "rounded-md border border-neutral-300 px-3 py-1.5 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"

export const inputClass = "rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700"

export const linkButtonClass = "text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
