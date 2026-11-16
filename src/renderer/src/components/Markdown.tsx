import type { ReactNode } from 'react'

/**
 * Light formatting for the assistant's replies: paragraphs, "- " bullets, "1." lists, **bold**,
 * *italic* and `code`. Everything else is plain text, and nothing is ever treated as HTML.
 */
type Block = { t: 'p'; text: string } | { t: 'ul'; items: string[] } | { t: 'ol'; items: string[] }

function blocks(text: string): Block[] {
  const out: Block[] = []
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    const ul = /^\s*(?:[-*•])\s+(.*)$/.exec(line)
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    const last = out[out.length - 1]
    if (ul) {
      if (last?.t === 'ul') last.items.push(ul[1])
      else out.push({ t: 'ul', items: [ul[1]] })
    } else if (ol) {
      if (last?.t === 'ol') last.items.push(ol[1])
      else out.push({ t: 'ol', items: [ol[1]] })
    } else if (!line.trim()) {
      out.push({ t: 'p', text: '' })
    } else if (last?.t === 'p' && last.text) {
      last.text += '\n' + line
    } else {
      out.push({ t: 'p', text: line })
    }
  }
  return out
}

/** **bold**, *italic*, `code`. An unfinished marker (while text is still arriving) stays literal. */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(\*\*([^*\n]+)\*\*|`([^`\n]+)`|(?<![*\w])\*([^*\n]+)\*(?![*\w]))/g
  let last = 0
  let i = 0
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    if (m[2] !== undefined) out.push(<strong key={`${key}b${i}`}>{m[2]}</strong>)
    else if (m[3] !== undefined)
      out.push(
        <code key={`${key}c${i}`} className="rounded bg-hover px-1 text-[0.92em]">
          {m[3]}
        </code>
      )
    else out.push(<em key={`${key}i${i}`}>{m[4]}</em>)
    last = at + m[0].length
    i++
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export default function Markdown({ text }: { text: string }): React.JSX.Element {
  const bs = blocks(text)
  return (
    <div className="space-y-2 text-sm leading-relaxed">
      {bs.map((b, i) =>
        b.t === 'p' ? (
          b.text ? (
            <p key={i} className="whitespace-pre-line">
              {inline(b.text, String(i))}
            </p>
          ) : null
        ) : b.t === 'ul' ? (
          <ul key={i} className="list-disc space-y-1 pl-5">
            {b.items.map((it, j) => (
              <li key={j}>{inline(it, `${i}.${j}`)}</li>
            ))}
          </ul>
        ) : (
          <ol key={i} className="list-decimal space-y-1 pl-5">
            {b.items.map((it, j) => (
              <li key={j}>{inline(it, `${i}.${j}`)}</li>
            ))}
          </ol>
        )
      )}
    </div>
  )
}
