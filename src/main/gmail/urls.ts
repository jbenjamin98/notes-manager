/** Pure Gmail URL builders (kept separate from Electron so they can be unit-tested). */

const BASE = 'https://mail.google.com/mail/u/0/'

export const searchUrl = (q: string): string => `${BASE}#search/${encodeURIComponent(q)}`

/** A thread by its legacy id, or (without one) a subject search that finds it. */
export const threadUrl = (linkId: string | null, subject: string): string =>
  linkId
    ? `${BASE}#all/${encodeURIComponent(linkId)}`
    : searchUrl(`subject:"${subject.replace(/"/g, '')}"`)

/** Pre-filled compose view. Opening it never sends anything. */
export function composeUrl(p: { to?: string; subject: string; body: string }): string {
  const q = (k: string, v: string): string => `&${k}=${encodeURIComponent(v)}`
  return `${BASE}?view=cm&fs=1&tf=1${p.to ? q('to', p.to) : ''}${q('su', p.subject)}${q('body', p.body)}`
}
