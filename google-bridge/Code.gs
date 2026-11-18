/**
 * Note Manager bridge (read-only). Runs inside YOUR Google account as a private web app.
 *
 * What it does: when Note Manager asks (using your signed-in Google session), it returns your
 * calendar events, email metadata (subjects, senders, times, labels), the text of the few email
 * threads Note Manager asks about (to find actions and decisions; Note Manager keeps only those
 * points, not the messages), Meet / Gemini meeting-notes documents, and Chat notifications.
 * It changes nothing.
 *
 * Setup (3 minutes, once): create a new Apps Script project, paste this file, turn on the
 * "Calendar" and "Gmail" advanced services (Services +), then Deploy > New deployment > Web app,
 * Execute as: Me, Who has access: Only myself. Note Manager walks you through it.
 */

var BRIDGE_VERSION = 7
var CONTRACT = 1
// Replaced by Note Manager when you press "Copy script". Requests without it are refused.
var TOKEN = '__NOTE_MANAGER_TOKEN__'

var MAIL_QUERY = '-category:promotions -category:social -category:forums -in:drafts'
var MEET_NAME = /notes by gemini|gemini notes|transcript/i
var MAX_DOC_CHARS = 200000

// ------------------------------------------------------------------------------ entry point

function doGet(e) {
  var p = (e && e.parameter) || {}
  try {
    if (!TOKEN || p.token !== TOKEN || TOKEN.indexOf('__') === 0)
      return out({ ok: false, error: 'bad-token' })
    var me = Session.getActiveUser().getEmail()
    if (me && Session.getEffectiveUser().getEmail() !== me)
      return out({ ok: false, error: 'wrong-user' })
    var action = p.action || 'ping'
    var env = realEnv()
    var handlers = {
      ping: function () {
        return ping(env)
      },
      snapshot: function () {
        return snapshot(env, p)
      },
      calendar: function () {
        return calendar(env, p)
      },
      mail: function () {
        return mail(env, p)
      },
      meet: function () {
        return meet(env, p)
      },
      chat: function () {
        return chat(env, p)
      },
      mailBodies: function () {
        return mailBodies(env, p)
      },
      selfTest: function () {
        return selfTest(env)
      }
    }
    if (!handlers[action]) return out({ ok: false, error: 'unknown-action' })
    return out(handlers[action]())
  } catch (err) {
    return out({ ok: false, error: String(err && err.message ? err.message : err) })
  }
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  )
}

/** What the headers say about a thread: sent to me or only copied, bulk or automated, marked important. */
function threadSignals(msgs, self) {
  var hv = function (m, name) {
    return header(m, name) || ''
  }
  var theirs = msgs.filter(function (m) {
    return !self || hv(m, 'From').toLowerCase().indexOf(self) < 0
  })
  var last = theirs[theirs.length - 1]
  var has = function (s) {
    return !!self && String(s).toLowerCase().indexOf(self) >= 0
  }
  return {
    toMe: last ? has(hv(last, 'To')) : undefined,
    ccMe: last ? has(hv(last, 'Cc')) : undefined,
    bulk: msgs.some(function (m) {
      var auto = hv(m, 'Auto-Submitted')
      return (
        !!hv(m, 'List-Unsubscribe') ||
        /^(bulk|list|junk)$/i.test(hv(m, 'Precedence').trim()) ||
        (!!auto && !/^no$/i.test(auto.trim()))
      )
    }),
    important: msgs.some(function (m) {
      return (m.labelIds || []).indexOf('IMPORTANT') >= 0
    }),
    msgCount: msgs.length
  }
}

/**
 * Google refuses a burst of requests ("Service invoked too many times in a short time"), so threads
 * are fetched in small groups with a pause between them, and a refused group is retried after a rest.
 */
function fetchPaced(reqs) {
  var out = []
  var pause = function (ms) {
    if (typeof Utilities !== 'undefined' && Utilities.sleep) Utilities.sleep(ms)
  }
  for (var i = 0; i < reqs.length; i += 8) {
    if (i > 0) pause(400)
    var group = reqs.slice(i, i + 8)
    var res = null
    for (var attempt = 0; attempt < 3 && !res; attempt++) {
      try {
        res = UrlFetchApp.fetchAll(group)
      } catch (err) {
        if (
          attempt === 2 ||
          !/too many times|rate limit|quota/i.test(String(err && err.message ? err.message : err))
        )
          throw err
        pause(2500 * (attempt + 1))
      }
    }
    for (var j = 0; j < res.length; j++) out.push(res[j])
  }
  return out
}

/** Everything that touches Google services goes through this object, so the handlers can be tested. */
function realEnv() {
  return {
    now: function () {
      return new Date()
    },
    email: function () {
      return Session.getActiveUser().getEmail()
    },
    calendarTimeZone: function () {
      try {
        return Calendar.Settings.get('timezone').value
      } catch (e) {
        return Session.getScriptTimeZone()
      }
    },
    formatDate: function (d, tz, f) {
      return Utilities.formatDate(d, tz, f)
    },
    base64: function (s) {
      return Utilities.base64Encode(s)
    },
    calendarEvents: function (opts) {
      return Calendar.Events.list('primary', opts)
    },
    gmailProfile: function () {
      return Gmail.Users.getProfile('me')
    },
    gmailLabels: function () {
      return Gmail.Users.Labels.list('me').labels || []
    },
    gmailThreadIds: function (q, max, pageToken) {
      var r = Gmail.Users.Threads.list('me', {
        q: q,
        maxResults: max,
        pageToken: pageToken || undefined
      })
      return {
        ids: (r.threads || []).map(function (t) {
          return t.id
        }),
        next: r.nextPageToken || null
      }
    },
    gmailHistory: function (startHistoryId) {
      var ids = {}
      var page = null
      do {
        var r = Gmail.Users.History.list('me', {
          startHistoryId: startHistoryId,
          maxResults: 500,
          pageToken: page || undefined
        })
        ;(r.history || []).forEach(function (h) {
          ;['messagesAdded', 'labelsAdded', 'labelsRemoved'].forEach(function (k) {
            ;(h[k] || []).forEach(function (x) {
              ids[x.message.threadId] = true
            })
          })
        })
        page = r.nextPageToken || null
        if (r.historyId) ids.__historyId = r.historyId
      } while (page)
      var hid = ids.__historyId
      delete ids.__historyId
      return { ids: Object.keys(ids), historyId: hid || null }
    },
    // Many threads in parallel (one round trip), metadata only.
    gmailThreads: function (ids) {
      var token = ScriptApp.getOAuthToken()
      var reqs = ids.map(function (id) {
        return {
          url:
            'https://gmail.googleapis.com/gmail/v1/users/me/threads/' +
            id +
            '?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=To&metadataHeaders=Cc' +
            '&metadataHeaders=List-Unsubscribe&metadataHeaders=Precedence&metadataHeaders=Auto-Submitted' +
            '&fields=id,messages(id,labelIds,snippet,internalDate,payload/headers)',
          headers: { Authorization: 'Bearer ' + token },
          muteHttpExceptions: true
        }
      })
      return fetchPaced(reqs).map(function (r) {
        return r.getResponseCode() === 200 ? JSON.parse(r.getContentText()) : null
      })
    },
    // A few threads in full (text only), in parallel.
    gmailThreadsFull: function (ids) {
      var token = ScriptApp.getOAuthToken()
      var reqs = ids.map(function (id) {
        return {
          url: 'https://gmail.googleapis.com/gmail/v1/users/me/threads/' + id + '?format=full',
          headers: { Authorization: 'Bearer ' + token },
          muteHttpExceptions: true
        }
      })
      return fetchPaced(reqs).map(function (r) {
        return r.getResponseCode() === 200 ? JSON.parse(r.getContentText()) : null
      })
    },
    decodeWebSafe: function (s) {
      return Utilities.newBlob(Utilities.base64DecodeWebSafe(s)).getDataAsString('UTF-8')
    },
    docText: function (fileId) {
      return DocumentApp.openById(fileId).getBody().getText()
    },
    findDocs: function (sinceIso) {
      var out = []
      var it = DriveApp.searchFiles(
        "mimeType = 'application/vnd.google-apps.document' and modifiedDate > '" +
          sinceIso +
          "' and trashed = false and (title contains 'Notes by Gemini' or title contains 'Transcript' or title contains 'Gemini')"
      )
      while (it.hasNext() && out.length < 25) {
        var f = it.next()
        out.push({ id: f.getId(), name: f.getName(), created: f.getDateCreated().toISOString() })
      }
      return out
    },
    chatSheetRows: function () {
      var it = DriveApp.getFilesByName('Note Manager Chat Log')
      if (!it.hasNext()) return null
      var sheet = SpreadsheetApp.open(it.next()).getSheets()[0]
      return sheet.getDataRange().getValues()
    }
  }
}

// --------------------------------------------------------------------------------- helpers

function pad(n) {
  return (n < 10 ? '0' : '') + n
}

function safe(fn) {
  var t0 = Date.now()
  try {
    var data = fn()
    return { ok: true, ms: Date.now() - t0, data: data }
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: String(err && err.message ? err.message : err) }
  }
}

/** Same id the Calendar web app uses, so notes stay linked: base64("<eventId> <calendarEmail>"), no padding. */
function webEventId(env, eventId, email) {
  return env.base64(eventId + ' ' + email).replace(/=+$/, '')
}

function parseAddress(v) {
  var m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(v || '')
  if (m)
    return {
      name: m[1].replace(/\s+/g, ' ').trim() || m[2].trim(),
      email: m[2].trim().toLowerCase()
    }
  var e = String(v || '')
    .trim()
    .replace(/^</, '')
    .replace(/>$/, '')
  return { name: e, email: e.toLowerCase() }
}

function header(m, name) {
  var hs = (m.payload && m.payload.headers) || []
  for (var i = 0; i < hs.length; i++)
    if (hs[i].name.toLowerCase() === name.toLowerCase()) return hs[i].value
  return ''
}

// ----------------------------------------------------------------------------------- actions

function ping(env) {
  return { ok: true, version: BRIDGE_VERSION, contract: CONTRACT, email: env.email() }
}

/** Events 30 days back to 60 ahead, with guests, Meet link and attached documents (Gemini notes). */
function calendar(env, p) {
  var tz = env.calendarTimeZone()
  var email = (env.email() || 'primary').toLowerCase()
  var now = env.now()
  var back = Number(p.back || 30)
  var ahead = Number(p.ahead || 60)
  var events = []
  var details = []
  var attachments = []
  var page = null
  var owner = null
  do {
    var r = env.calendarEvents({
      singleEvents: true,
      orderBy: 'startTime',
      timeMin: new Date(now.getTime() - back * 86400000).toISOString(),
      timeMax: new Date(now.getTime() + ahead * 86400000).toISOString(),
      maxResults: 250,
      pageToken: page || undefined
    })
    ;(r.items || []).forEach(function (e) {
      if (e.status === 'cancelled') return
      var allDay = !!(e.start && e.start.date)
      var start = e.start && e.start.dateTime ? new Date(e.start.dateTime) : null
      var end = e.end && e.end.dateTime ? new Date(e.end.dateTime) : null
      var date = allDay ? e.start.date : start ? env.formatDate(start, tz, 'yyyy-MM-dd') : null
      if (!date) return
      var id = webEventId(env, e.id, email)
      var mine = (e.attendees || []).filter(function (a) {
        return a.self
      })[0]
      if (mine && mine.displayName) owner = mine.displayName
      var status = !mine
        ? null
        : mine.responseStatus === 'needsAction'
          ? 'needs_action'
          : mine.responseStatus || null
      events.push({
        id: id,
        date: date,
        startTime: start ? env.formatDate(start, tz, 'HH:mm') : null,
        endTime: end ? env.formatDate(end, tz, 'HH:mm') : null,
        allDay: allDay,
        title: String(e.summary || '(No title)').trim(),
        status: status,
        kind:
          e.eventType === 'workingLocation' ? 'working_location' : allDay ? 'allday' : 'meeting',
        seriesId: e.recurringEventId || null
      })
      details.push({
        id: id,
        guests: (e.attendees || [])
          .filter(function (a) {
            return a.email && !a.self && !a.resource
          })
          .map(function (a) {
            return { email: a.email, name: a.displayName || null }
          }),
        meetUrl: e.hangoutLink || null
      })
      ;(e.attachments || []).forEach(function (a) {
        if (a.fileId && /document/.test(a.mimeType || ''))
          attachments.push({ eventId: id, fileId: a.fileId, title: a.title || '' })
      })
    })
    page = r.nextPageToken || null
  } while (page)
  return {
    events: events,
    details: details,
    owner: owner,
    selfEmail: email,
    attachments: attachments,
    timeZone: tz
  }
}

/** Email metadata as rows. `sinceHistoryId` makes it incremental; `pageToken` pages a first full read. */
function mail(env, p) {
  var tz = env.calendarTimeZone()
  var self = (env.gmailProfile().emailAddress || env.email() || '').toLowerCase()
  var labels = {}
  env.gmailLabels().forEach(function (l) {
    labels[l.id] = { name: l.name, user: l.type === 'user' }
  })
  var ids
  var next = null
  var historyId = null
  var resync = false
  if (p.sinceHistoryId) {
    try {
      var h = env.gmailHistory(p.sinceHistoryId)
      ids = h.ids.slice(0, 400)
      historyId = h.historyId
    } catch (err) {
      resync = true // too old: the app should do a full read
    }
  }
  if (!ids) {
    var q = MAIL_QUERY + ' newer_than:' + Number(p.days || 30) + 'd'
    var l = env.gmailThreadIds(q, Math.min(Number(p.max || 100), 100), p.pageToken)
    ids = l.ids
    next = l.next
  }
  var rows = []
  env.gmailThreads(ids).forEach(function (t) {
    if (!t || !t.messages) return
    var msgs = t.messages.filter(function (m) {
      return (m.labelIds || []).indexOf('DRAFT') < 0
    })
    if (!msgs.length) return
    var last = msgs[msgs.length - 1]
    var seen = {}
    var senders = []
    msgs.forEach(function (m) {
      var a = parseAddress(header(m, 'From'))
      if (a.email && !seen[a.email]) {
        seen[a.email] = true
        senders.push({ name: a.email === self ? 'me' : a.name, email: a.email })
      }
    })
    var all = {}
    msgs.forEach(function (m) {
      ;(m.labelIds || []).forEach(function (x) {
        all[x] = true
      })
    })
    var chips = []
    if (all.INBOX) chips.push('Inbox')
    Object.keys(all).forEach(function (x) {
      if (labels[x] && labels[x].user) chips.push(labels[x].name)
    })
    rows.push({
      legacyId: t.id,
      threadId: null,
      senders: senders.reverse(),
      subject: header(msgs[0], 'Subject') || header(last, 'Subject'),
      snippet: last.snippet || '',
      lastMs: Number(last.internalDate || env.now().getTime()),
      unread: !!all.UNREAD,
      starred: !!all.STARRED,
      labels: chips,
      signals: threadSignals(msgs, self)
    })
  })
  if (!historyId) {
    try {
      historyId = env.gmailProfile().historyId || null
    } catch (e) {
      historyId = null
    }
  }
  return {
    rows: rows,
    nextPageToken: next,
    historyId: historyId,
    resync: resync,
    selfEmail: self,
    timeZone: tz
  }
}

/** Gemini notes / transcripts: attached to events first (exact), then found by name in Drive. */
function meet(env, p) {
  var known = {}
  String(p.known || '')
    .split(',')
    .forEach(function (k) {
      if (k) known[k] = true
    })
  var since = p.since || new Date(env.now().getTime() - 14 * 86400000).toISOString()
  var found = []
  var byFile = {}
  var cal = null
  try {
    cal = calendar(env, { back: 14, ahead: 1 })
  } catch (e) {
    cal = null
  }
  if (cal) {
    cal.attachments.forEach(function (a) {
      if (MEET_NAME.test(a.title) && !known[a.fileId] && !byFile[a.fileId]) {
        byFile[a.fileId] = true
        found.push({ fileId: a.fileId, name: a.title, eventId: a.eventId, created: null })
      }
    })
  }
  env.findDocs(since.slice(0, 10)).forEach(function (d) {
    if (!known[d.id] && !byFile[d.id]) {
      byFile[d.id] = true
      found.push({ fileId: d.id, name: d.name, eventId: null, created: d.created })
    }
  })
  var files = []
  found.slice(0, 25).forEach(function (f) {
    var text = ''
    try {
      text = String(env.docText(f.fileId) || '').slice(0, MAX_DOC_CHARS)
    } catch (e) {
      return
    }
    files.push({
      fileId: f.fileId,
      name: f.name,
      kind: /transcript/i.test(f.name) ? 'transcript' : 'notes',
      createdAt: f.created || env.now().toISOString(),
      eventId: f.eventId,
      text: text
    })
  })
  return { files: files }
}

/**
 * Chat WITHOUT the Chat API (which needs a Cloud project): Chat's own email notifications
 * (missed direct messages and mentions) read from Gmail, plus an optional sheet that a Google
 * Workspace Flow fills ("Note Manager Chat Log": time, space, sender, text, mentioned). Partial by nature.
 */
function chat(env, p) {
  var days = Number(p.days || 7)
  var msgs = []
  var l = env.gmailThreadIds(
    'from:(chat-noreply@google.com OR noreply-chat@google.com) newer_than:' + days + 'd',
    100,
    null
  )
  env.gmailThreads(l.ids).forEach(function (t) {
    if (!t || !t.messages) return
    t.messages.forEach(function (m) {
      var subject = header(m, 'Subject')
      var from = parseAddress(header(m, 'From'))
      var parsed = parseChatNotification(subject, from.name, m.snippet || '')
      msgs.push({
        id: 'gmail:' + m.id,
        space: parsed.dm ? 'dm:' + parsed.sender : parsed.space,
        spaceType: parsed.dm ? 'dm' : 'space',
        sender: parsed.sender,
        text: parsed.text,
        createdAt: new Date(Number(m.internalDate)).toISOString(),
        mentionsMe: parsed.mentioned,
        fromMe: false,
        thread: t.id
      })
    })
  })
  var rows = env.chatSheetRows()
  if (rows && rows.length > 1) {
    var cutoff = env.now().getTime() - days * 86400000
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i]
      var when = new Date(r[0]).getTime()
      if (!when || when < cutoff) continue
      msgs.push({
        id: 'sheet:' + when + ':' + i,
        space: /direct|dm/i.test(String(r[1]))
          ? 'dm:' + String(r[2] || 'Someone')
          : String(r[1] || 'Chat'),
        spaceType: /direct|dm/i.test(String(r[1])) ? 'dm' : 'space',
        sender: String(r[2] || 'Someone'),
        text: String(r[3] || '').slice(0, 300),
        createdAt: new Date(when).toISOString(),
        mentionsMe: /^(y|yes|true|1)/i.test(String(r[4] || '')),
        fromMe: false,
        thread: null
      })
    }
  }
  return { messages: msgs, coverage: 'partial' }
}

/** Chat notification subjects look like "Alex Kim: hello" (DM) or "Alex Kim mentioned you in Project X". Tolerant on purpose. */
function parseChatNotification(subject, fromName, snippet) {
  var s = String(subject || '')
  var mention = /mentioned you/i.test(s) || /mentioned you/i.test(snippet)
  var m = /^(.+?) mentioned you in (.+)$/i.exec(s)
  if (m)
    return {
      sender: m[1].trim(),
      space: m[2].trim(),
      dm: false,
      mentioned: true,
      text: snippet.slice(0, 300)
    }
  m = /^(?:New message from |Message from )?(.+?)(?: in (.+?))?:\s*(.*)$/i.exec(s)
  if (m)
    return {
      sender: m[1].trim(),
      space: m[2] ? m[2].trim() : 'Direct message',
      dm: !m[2],
      mentioned: mention,
      text: (m[3] || snippet).slice(0, 300)
    }
  var who =
    String(fromName || '')
      .replace(/\s*\(Google Chat\)\s*$/i, '')
      .trim() || 'Someone'
  return {
    sender: who,
    space: 'Chat',
    dm: false,
    mentioned: mention,
    text: (s + ' ' + snippet).trim().slice(0, 300)
  }
}

/** The readable text of a message: the plain part, else the HTML part with tags removed. */
function messageText(env, payload) {
  var plain = []
  var html = []
  function walk(part) {
    if (!part) return
    if (part.body && part.body.data) {
      var t = env.decodeWebSafe(part.body.data)
      if (/^text\/plain/i.test(part.mimeType || '')) plain.push(t)
      else if (/^text\/html/i.test(part.mimeType || '')) html.push(t)
    }
    ;(part.parts || []).forEach(walk)
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

/** Drop quoted history and signatures so only what the sender wrote remains. */
function ownText(text) {
  var out = []
  var lines = String(text || '')
    .replace(/\r/g, '')
    .split('\n')
  for (var i = 0; i < lines.length; i++) {
    var t = lines[i].trim()
    if (/^on .{8,120}wrote:?$/i.test(t) || /^-{2,}\s*(original|forwarded) message/i.test(t)) break
    if (t === '--') break
    if (t.charAt(0) === '>') continue
    out.push(lines[i])
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * The text of up to 25 threads (the last few messages of each), so Note Manager can find actions,
 * decisions and questions in them. Read-only; nothing is stored here.
 */
function mailBodies(env, p) {
  var ids = String(p.ids || '')
    .split(',')
    .filter(function (x) {
      return x
    })
    .slice(0, 25)
  var threads = ids.length ? env.gmailThreadsFull(ids) : []
  var out = []
  threads.forEach(function (t) {
    if (!t || !t.messages || !t.messages.length) return
    var msgs = t.messages.slice(-4).map(function (m) {
      var from = parseAddress(header(m, 'From'))
      return {
        id: m.id,
        from: from.name || from.email,
        fromEmail: from.email,
        at: new Date(Number(m.internalDate)).toISOString(),
        text: ownText(messageText(env, m.payload)).slice(0, 20000)
      }
    })
    out.push({ threadId: t.id, subject: header(t.messages[0], 'Subject'), messages: msgs })
  })
  return { threads: out }
}

/** Each section on its own, so one failure never hides the rest. */
function snapshot(env, p) {
  return {
    ok: true,
    version: BRIDGE_VERSION,
    contract: CONTRACT,
    email: env.email(),
    sections: {
      calendar: safe(function () {
        return calendar(env, p)
      }),
      mail: safe(function () {
        return mail(env, p)
      }),
      meet: safe(function () {
        return meet(env, p)
      }),
      chat: safe(function () {
        return chat(env, p)
      })
    }
  }
}

function selfTest(env) {
  var t = {
    ok: true,
    version: BRIDGE_VERSION,
    contract: CONTRACT,
    email: env.email(),
    sections: {
      calendar: safe(function () {
        var r = calendar(env, { back: 1, ahead: 1 })
        return { events: r.events.length }
      }),
      mail: safe(function () {
        var r = mail(env, { days: 1, max: 5 })
        return { rows: r.rows.length }
      }),
      meet: safe(function () {
        var r = meet(env, {})
        return { files: r.files.length }
      }),
      chat: safe(function () {
        var r = chat(env, { days: 1 })
        return { messages: r.messages.length }
      })
    }
  }
  return t
}
