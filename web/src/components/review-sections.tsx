import { AttentionBadge } from "@/components/attention-badge"
import { DiffColumn, type DiffColumnProps, type DiffGroup } from "@/components/diff-column"
import { Markdown } from "@/components/markdown"
import { MermaidDiagram } from "@/components/mermaid-diagram"
import { useSidebarNavigate } from "@/lib/sidebar"
import type { ReviewLayout, SectionLayout } from "@/lib/review-layout"
import { sectionAnchor } from "@/lib/utils"
import type { Review } from "@/lib/types"

/** Changes no section places. */
const REST_ANCHOR = "unreviewed"

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

function findingCount(review: Review, layout: SectionLayout) {
  const hunks = new Set(layout.section.hunk_ids)
  return review.findings.filter((f) => hunks.has(f.hunk_id)).length
}

type SectionHeaderProps = {
  layout: SectionLayout
  review: Review
  /** Where relative links in the text would resolve; links are shown as text. */
  baseUrl: string
}

/** A section's title and prose, above its code. */
function SectionHeader({ layout, review, baseUrl }: SectionHeaderProps) {
  const { section, index, slices } = layout
  const findings = findingCount(review, layout)
  return (
    <header className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-lg font-semibold">
          <span className="mr-2 text-neutral-400">{index + 1}</span>
          {section.title}
        </h2>
        <AttentionBadge attention={section.attention} />
        <span className="text-xs text-neutral-500">
          {plural(slices.length, "file")}
          {findings > 0 && ` · ${plural(findings, "finding")}`}
        </span>
      </div>
      <Markdown baseUrl={baseUrl} links={false} className="text-sm text-neutral-700 dark:text-neutral-300">
        {section.overview}
      </Markdown>
      {section.diagram && (
        <MermaidDiagram source={section.diagram.source} caption={section.diagram.caption} title={section.title} />
      )}
    </header>
  )
}

type ReviewDiffProps<T> = Omit<DiffColumnProps<T>, "groups" | "collapsed"> & {
  review: Review | null
  layout: ReviewLayout
  /** Where relative links in model text would resolve; links are shown as text. */
  baseUrl: string
}

/** The diff laid out by a review: its sections, whatever they leave out, then what the pre-pass collapsed. */
export function ReviewDiff<T>({ review, layout, baseUrl, ...props }: ReviewDiffProps<T>) {
  return <DiffColumn groups={groups(review, layout, baseUrl)} collapsed={layout.collapsed} {...props} />
}

function groups(review: Review | null, layout: ReviewLayout, baseUrl: string): DiffGroup[] {
  const groups: DiffGroup[] = review
    ? layout.sections.map((s) => ({
        key: `section-${s.index}`,
        id: sectionAnchor(s.index),
        header: <SectionHeader layout={s} review={review} baseUrl={baseUrl} />,
        slices: s.slices,
      }))
    : []
  if (layout.rest.length > 0) {
    groups.push({
      key: "rest",
      id: REST_ANCHOR,
      header: review ? (
        <header>
          <h2 className="text-lg font-semibold">Not in this review</h2>
          <p className="text-sm text-neutral-500">
            Changes the review doesn't cover, usually because they're newer than it.
          </p>
        </header>
      ) : undefined,
      slices: layout.rest,
    })
  }
  return groups
}

/** The sidebar's table of contents: each section with how closely to read it. */
export function ReviewContents({ review, layout }: { review: Review; layout: ReviewLayout }) {
  const navigate = useSidebarNavigate()
  const go = (id: string) => {
    navigate()
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })
  }
  return (
    <nav className="flex flex-col gap-1">
      <h2 className="text-xs font-medium tracking-wide text-neutral-500 uppercase">Sections</h2>
      <ol className="flex flex-col gap-1">
        {layout.sections.map((s) => {
          const findings = findingCount(review, s)
          return (
            <li key={s.index}>
              <button
                type="button"
                onClick={() => go(sectionAnchor(s.index))}
                className="flex w-full flex-col gap-1 rounded-md p-2 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900"
              >
                <span className="flex items-start gap-2 font-medium">
                  <span className="text-neutral-400">{s.index + 1}</span>
                  <span className="flex-1">{s.section.title}</span>
                </span>
                <span className="flex items-center gap-2 pl-5 text-xs text-neutral-500">
                  <AttentionBadge attention={s.section.attention} />
                  {findings > 0 && plural(findings, "finding")}
                </span>
              </button>
            </li>
          )
        })}
      </ol>
      {layout.rest.length > 0 && (
        <button
          type="button"
          onClick={() => go(REST_ANCHOR)}
          className="rounded-md p-2 text-left text-sm text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900"
        >
          Not in this review ({plural(layout.rest.length, "file")})
        </button>
      )}
    </nav>
  )
}
