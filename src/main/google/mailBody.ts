/** One email thread's text, as the sources hand it over. Read in memory; never stored. */
export interface MailBody {
  threadId: string
  subject: string
  messages: { id: string; from: string; fromEmail: string; at: string; text: string }[]
}

/** Gmail API message parts to readable text: the plain part, else the HTML part without tags. */
export function textOfPayload(payload: GmailPart | undefined): string {
  const plain: string[] = []
  const html: string[] = []
  const walk = (p: GmailPart | undefined): void => {
    if (!p) return
    if (p.body?.data) {
      const t = Buffer.from(p.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
        'utf8'
      )
      if (/^text\/plain/i.test(p.mimeType ?? '')) plain.push(t)
      else if (/^text\/html/i.test(p.mimeType ?? '')) html.push(t)
    }
    for (const c of p.parts ?? []) walk(c)
  }
  walk(payload)
  if (plain.length) return plain.join('\n')
  return html
    .join('\n')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
}

export interface GmailPart {
  mimeType?: string
  body?: { data?: string }
  parts?: GmailPart[]
}
