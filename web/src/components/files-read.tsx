/** Which repository files the model read while reviewing, as a disclosure. */
export function FilesRead({ files }: { files: string[] }) {
  if (files.length === 0) return <span>read no other files</span>
  return (
    <details className="inline-block">
      <summary className="cursor-pointer">
        read {files.length} {files.length === 1 ? "file" : "files"}
      </summary>
      <ul className="mt-1 font-mono">
        {files.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
    </details>
  )
}
