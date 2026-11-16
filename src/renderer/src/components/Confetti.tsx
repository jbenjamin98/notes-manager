import { useEffect, useState } from 'react'

const COLORS = ['#6a63f0', '#8b5cf6', '#f472b6', '#38bdf8', '#34d399', '#fbbf24', '#fb923c']

/** A short burst of confetti. Remounts (via `nonce`) each time something is worth celebrating. */
export default function Confetti({
  nonce,
  onDone
}: {
  nonce: number
  onDone: () => void
}): React.JSX.Element {
  const [pieces] = useState(() =>
    Array.from({ length: 46 }, (_, i) => {
      const angle = (Math.PI * 2 * i) / 46 + Math.random() * 0.5
      const dist = 160 + Math.random() * 360
      return {
        c: COLORS[i % COLORS.length],
        dx: Math.cos(angle) * dist,
        // Pieces fly up first, then the end point sags downward like gravity.
        dy: Math.sin(angle) * dist * 0.7 + 140 + Math.random() * 120,
        rot: (Math.random() - 0.5) * 900,
        d: Math.floor(Math.random() * 120)
      }
    })
  )
  useEffect(() => {
    const t = setTimeout(onDone, 2000)
    return () => clearTimeout(t)
  }, [nonce, onDone])
  return (
    <div className="confetti" aria-hidden>
      {pieces.map((p, i) => (
        <i
          key={i}
          style={
            {
              '--c': p.c,
              '--dx': `${p.dx}px`,
              '--dy': `${p.dy}px`,
              '--rot': `${p.rot}deg`,
              '--d': `${p.d}ms`
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  )
}
