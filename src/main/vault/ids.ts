import { randomBytes, createHash } from 'node:crypto'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** 26-char ULID: 48-bit timestamp + 80 random bits. Sortable, filename-independent identity. */
export function ulid(now = Date.now()): string {
  let t = now
  let time = ''
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time
    t = Math.floor(t / 32)
  }
  const rnd = randomBytes(10)
  let bits = ''
  for (const b of rnd) bits += b.toString(2).padStart(8, '0')
  let rand = ''
  for (let i = 0; i < 16; i++) rand += CROCKFORD[parseInt(bits.slice(i * 5, i * 5 + 5), 2)]
  return time + rand
}

const B36 = '0123456789abcdefghijklmnopqrstuvwxyz'

/** Inline task marker, e.g. `t7k2x9q`. Globally unique enough; collisions are detected and re-issued. */
export function taskId(): string {
  const b = randomBytes(6)
  let s = 't'
  for (const x of b) s += B36[x % 36]
  return s
}

export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')
