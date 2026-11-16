import { useEffect, useRef, useState } from 'react'
import Markdown from './Markdown'

const reduced = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Reveals text a little at a time so a new answer feels written, not dropped. A click shows it all;
 * old messages and reduced-motion users get the full text straight away.
 */
export default function Typewriter({
  text,
  animate,
  onProgress
}: {
  text: string
  animate: boolean
  onProgress?: () => void
}): React.JSX.Element {
  const skip = !animate || reduced()
  const [shown, setShown] = useState(skip ? text.length : 0)
  const cb = useRef(onProgress)
  useEffect(() => {
    cb.current = onProgress
  })

  useEffect(() => {
    if (skip) return
    let raf = 0
    let n = 0
    const step = Math.max(2, Math.ceil(text.length / 80)) // about 1.3 seconds however long it is
    const tick = (): void => {
      n = Math.min(text.length, n + step)
      setShown(n)
      cb.current?.()
      if (n < text.length) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [text, skip])

  const done = shown >= text.length
  return (
    <div onClick={() => setShown(text.length)} title={done ? undefined : 'Click to show all'}>
      <Markdown text={text.slice(0, shown)} />
      {!done && <span className="caret" aria-hidden />}
    </div>
  )
}
