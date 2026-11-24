// Shared Tailwind class strings for the few control styles Loupe uses.

export const buttonClass =
  "rounded-md bg-neutral-900 px-3 py-1.5 text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"

export const secondaryButtonClass =
  "rounded-md border border-neutral-300 px-3 py-1.5 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"

/** A compact secondary button, for actions on a comment or thread. */
export const smallButtonClass =
  "rounded-md border border-neutral-300 px-2 py-1 text-xs font-medium hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"

/** A borderless button for low-key actions, such as edit and delete. */
export const ghostButtonClass =
  "rounded-md px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-50 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"

export const inputClass = "rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 dark:border-neutral-700"

export const linkButtonClass = "text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A note shown inside the diff, under a line. */
export const noteClass =
  "border-y border-neutral-200 bg-white px-3 py-2 font-sans text-sm dark:border-neutral-800 dark:bg-neutral-950"
