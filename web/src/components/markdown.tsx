import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn } from "@/lib/utils"

type MarkdownProps = {
  children: string
  /** Where the text lives on GitHub; relative links resolve against it. */
  baseUrl: string
  className?: string
}

/** Hosts images load from; anything else is shown as a link, so a comment can't make the browser call out. */
const IMAGE_HOSTS = /(^|\.)(github\.com|githubusercontent\.com)$/

/**
 * GitHub markdown written by other people (comments, reviews, descriptions).
 * Rendered as React elements, never as HTML: raw HTML in the source is
 * dropped, and links keep only http(s) and mailto.
 */
export function Markdown({ children, baseUrl, className }: MarkdownProps) {
  return (
    <div className={cn("markdown break-words", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => safeUrl(url, baseUrl)}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

function safeUrl(url: string, base: string): string {
  try {
    const resolved = new URL(url, base)
    return ["http:", "https:", "mailto:"].includes(resolved.protocol) ? resolved.href : ""
  } catch {
    return ""
  }
}

const components: Components = {
  a: ({ href, title, children }) =>
    href ? (
      <a href={href} title={title} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    ) : (
      <>{children}</>
    ),
  img: ({ src, alt }) => <Image src={typeof src === "string" ? src : ""} alt={alt ?? ""} />,
  pre: ({ node, children, ...props }) => {
    const code = node?.children[0]
    const classes = code?.type === "element" ? code.properties.className : undefined
    const suggestion = Array.isArray(classes) && classes.includes("language-suggestion")
    if (!suggestion) return <pre {...props}>{children}</pre>
    return (
      <div className="suggestion">
        <div className="suggestion-label">Suggested change</div>
        <pre {...props}>{children}</pre>
      </div>
    )
  },
}

function Image({ src, alt }: { src: string; alt: string }) {
  let host = ""
  try {
    host = new URL(src).hostname
  } catch {
    // Not a URL: shown as a link below, which goes nowhere.
  }
  if (!src || !IMAGE_HOSTS.test(host)) {
    return src ? (
      <a href={src} target="_blank" rel="noreferrer noopener">
        {alt || "image"}
      </a>
    ) : null
  }
  return <img src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" />
}
