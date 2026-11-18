// Smoke test: launches the BUILT app (run `npx electron-vite build` first) on a throw-away profile and
// vault, drives it over the Chrome DevTools Protocol, and checks the main screens. Needs a desktop session.
// Usage: npm run e2e        (screenshots land in e2e/out)
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '..')
const OUT = join(REPO, 'e2e', 'out')
mkdirSync(OUT, { recursive: true })
const PORT = 9340

// ---------------------------------------------------------------- synthetic profile
const vault = mkdtempSync(join(tmpdir(), 'nm-e2e-vault-'))
const userData = mkdtempSync(join(tmpdir(), 'nm-e2e-ud-'))
mkdirSync(join(vault, 'notes', '2026'), { recursive: true })
const p2 = (n) => String(n).padStart(2, '0')
const iso = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
const now = new Date()
const day = (back) => iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back))
const note = (file, id, title, type, date, account, body) =>
  writeFileSync(
    join(vault, 'notes', '2026', file),
    `---\nid: "${id}"\ntitle: "${title}"\ntype: "${type}"\ndate: "${date}"\n${account ? `account: "${account}"\n` : ''}---\n\n${body}\n`
  )
note(
  'a.md',
  '01JE2E0000000000000000001',
  'NextMRO Weekly 1',
  'meeting',
  day(0),
  'Navy NextMRO',
  'Cutover moves to December 4 because the firewall rules are late.\n- [ ] Update firewall rules | @Me | due:' +
    day(0)
)
note(
  'b.md',
  '01JE2E0000000000000000002',
  'NextMRO Weekly 2',
  'meeting',
  day(7),
  'Navy NextMRO',
  'Cutover plan reviewed.'
)
note(
  'c.md',
  '01JE2E0000000000000000003',
  'NextMRO Weekly 3',
  'meeting',
  day(14),
  'Navy NextMRO',
  'Kickoff.'
)
note(
  'd.md',
  '01JE2E0000000000000000004',
  'Budget review',
  'meeting',
  day(2),
  'Finance',
  'Budget numbers.'
)
note(
  'e.md',
  '01JE2E0000000000000000005',
  'Old brain dump',
  'adhoc',
  '2025-03-02',
  '',
  'Thoughts about the migration.'
)

// ---------------------------------------------------------------- fake Gemini
const seenPrompts = []
const fake = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = JSON.parse(raw || '{}')
    const user = body.contents?.[0]?.parts?.[0]?.text ?? ''
    const sys = body.systemInstruction?.parts?.[0]?.text ?? ''
    seenPrompts.push(user)
    const said = /They say: ([^\n]*)/.exec(user)?.[1] ?? ''
    const out = /You tag one line/.test(sys)
      ? /Rhea/.test(user)
        ? {
            tags: [
              { text: 'Rhea', kind: 'person' },
              { text: 'rollout', kind: 'topic' }
            ]
          }
        : { tags: [] }
      : /Sources so far:/.test(user)
        ? /plate this week/.test(said)
          ? /Meeting ·|Lookup · calendar/.test(user)
            ? {
                action: 'answer',
                answer:
                  'You have **one meeting** this week: Script standup. Nothing else is booked.',
                cited: []
              }
            : { action: 'lookup', lookups: [{ tool: 'calendar', args: {} }] }
          : /Send the deck to Sarah/.test(said)
            ? {
                action: 'answer',
                answer: 'That reads like one to-do, for Sarah.',
                cited: [],
                offer: { kind: 'tasks', label: 'Turn these into tasks' }
              }
            : {
                action: 'answer',
                answer:
                  'The cutover moves to **December 4** [1].\n- Owner: Sarah\n- Why: firewall rules are late',
                cited: [1],
                followups: ['Who owns the firewall work?', 'Why is it late?']
              }
        : user === 'ping'
          ? { ok: true }
          : /Summarise the meeting note/.test(sys)
            ? {
                tldr: 'Cutover slips to December 4.',
                decisions: ['Move the cutover'],
                open_questions: [],
                next_steps: ['Send the plan']
              }
            : /follow-up email/.test(sys)
              ? {
                  recipient_name: null,
                  subject: 'Follow-up: NextMRO Weekly 1',
                  body: 'Hi all,\n\nThanks for the time.'
                }
              : /Plan the day/.test(sys)
                ? {
                    headline: 'Start with the firewall rules.',
                    priorities: ['Update firewall rules: due today'],
                    heads_up: []
                  }
                : /Snippets:|Sources:/.test(user)
                  ? {
                      answer: 'The cutover moves to December 4 [1].',
                      cited: [1],
                      followups: ['Who owns the firewall work?', 'Why is it late?']
                    }
                  : {
                      reply: 'Found one task.',
                      tasks: [
                        {
                          description: 'Send the deck',
                          owner: 'Sarah',
                          due_phrase: 'next Thursday'
                        }
                      ],
                      notes: [],
                      reminders: []
                    }
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }],
        usageMetadata: {}
      })
    )
  })
})
await new Promise((r) => fake.listen(0, '127.0.0.1', r))

// ---------------------------------------------------------------- fake Apps Script (the private script)
const scriptCalls = []
const fakeScript = createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  const action = u.searchParams.get('action')
  scriptCalls.push(action)
  const me = 'me@example.com'
  const today = iso(new Date())
  const out =
    action === 'ping'
      ? { ok: true, version: 8, contract: 1, email: me }
      : action === 'selfTest'
        ? {
            ok: true,
            version: 8,
            email: me,
            sections: {
              calendar: { ok: true },
              mail: { ok: true },
              meet: { ok: true },
              chat: { ok: true }
            }
          }
        : action === 'calendar'
          ? {
              events: [
                {
                  id: 'evt-script-1',
                  date: today,
                  startTime: '23:00',
                  endTime: '23:30',
                  allDay: false,
                  title: 'Script standup',
                  status: 'accepted',
                  kind: 'meeting'
                }
              ],
              details: [],
              owner: 'E2E Person',
              selfEmail: me,
              attachments: []
            }
          : action === 'mail'
            ? {
                rows: [
                  {
                    legacyId: 'abc123',
                    threadId: 'abc123',
                    senders: [{ name: 'Priya Shah', email: 'priya@example.com' }],
                    subject: 'Budget numbers for Friday',
                    snippet: 'Can you send me the numbers?',
                    lastMs: Date.now() - 3600_000,
                    unread: true,
                    starred: false,
                    labels: []
                  }
                ],
                nextPageToken: null,
                historyId: '1',
                resync: false,
                selfEmail: me
              }
            : action === 'chat'
              ? { messages: [] }
              : action === 'meet'
                ? { files: [] }
                : action === 'mailBodies'
                  ? { threads: [] }
                  : { ok: false, error: 'unknown action' }
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(out))
})
await new Promise((r) => fakeScript.listen(0, '127.0.0.1', r))

// ---------------------------------------------------------------- launch
const env = {
  ...process.env,
  NM_VAULT: vault,
  NM_SHOW_CAPTURE: '1',
  NM_BRIDGE_BASE: `http://127.0.0.1:${fakeScript.address().port}`,
  NM_LLM_GEMINI_URL: `http://127.0.0.1:${fake.address().port}/gemini`
}
delete env.ELECTRON_RUN_AS_NODE // set by VS Code terminals; would make Electron run as plain Node
const exe = join(
  REPO,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
)
const child = spawn(exe, [REPO, `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`], {
  env,
  stdio: 'ignore'
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function connect(match) {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const t = list.find((x) => x.type === 'page' && match(x.url))
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl)
        await new Promise((r) => (ws.onopen = r))
        let id = 0
        const pending = new Map()
        ws.onmessage = (m) => {
          const d = JSON.parse(m.data)
          if (d.id && pending.has(d.id)) pending.get(d.id)(d)
        }
        const send = (method, params = {}) =>
          new Promise((r) => {
            const i = ++id
            pending.set(i, r)
            ws.send(JSON.stringify({ id: i, method, params }))
          })
        const ev = async (expr) => {
          const r = await send('Runtime.evaluate', {
            expression: expr,
            awaitPromise: true,
            returnByValue: true
          })
          if (r.result.exceptionDetails)
            throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300))
          return r.result.result.value
        }
        // A hidden window never answers a screenshot: give up after a few seconds, don't hang.
        const shot = async (name) => {
          const r = await Promise.race([
            send('Page.captureScreenshot', { format: 'png' }),
            sleep(6000).then(() => null)
          ])
          if (r?.result?.data) writeFileSync(join(OUT, name), Buffer.from(r.result.data, 'base64'))
          else console.log('NOTE screenshot skipped (window hidden):', name)
        }
        return { send, ev, shot }
      }
    } catch {
      /* not up yet */
    }
    await sleep(500)
  }
  throw new Error('app window did not appear')
}

const results = []
const check = (name, ok, extra = '') => {
  results.push(ok)
  console.log(ok ? 'PASS' : 'FAIL', name, extra)
}
const setValue = (sel, v, proto = 'HTMLInputElement') =>
  `(()=>{const t=document.querySelector(${JSON.stringify(sel)});Object.getOwnPropertyDescriptor(window.${proto}.prototype,'value').set.call(t,${JSON.stringify(v)});t.dispatchEvent(new Event('input',{bubbles:true}))})()`
const keydown = (key, ctrl = false, shift = false) =>
  `window.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},ctrlKey:${ctrl},shiftKey:${shift},bubbles:true}))`

try {
  const main = await connect((u) => !u.includes('#capture'))
  await main.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false
  })
  for (
    let i = 0;
    i < 30 && !(await main.ev('document.getElementById("root")?.children.length'));
    i++
  )
    await sleep(500)
  await sleep(1500)
  const text = () => main.ev('document.body.innerText.replace(/\\s+/g," ")')
  const clickText = (t, sel = 'button') =>
    main.ev(
      `(()=>{const b=[...document.querySelectorAll(${JSON.stringify(sel)})].find(x=>x.innerText.trim()===${JSON.stringify(t)});if(!b)return false;b.click();return true})()`
    )

  // first-run guide
  check(
    'setup guide shows on first run',
    await main.ev(`!!document.querySelector('[role=dialog][aria-label="Setup guide"]')`)
  )
  await main.shot('01-guide.png')
  // step 3 is the real Google setup (private script wizard), not a dead-end sign-in button
  for (let i = 0; i < 2; i++) {
    await main.ev(
      `[...document.querySelectorAll('[role=dialog][aria-label="Setup guide"] button')].find(b=>/^(Next|Continue)/.test(b.textContent.trim()))?.click()`
    )
    await sleep(300)
  }
  check(
    'setup guide Google step has the private-script setup',
    await main.ev(
      `!!document.querySelector('[role=dialog][aria-label="Setup guide"] [data-testid=bridge-setup]')`
    )
  )
  await main.shot('01b-guide-google.png')
  // AI step: a pasted key is saved and checked without a button, and survives moving between steps
  const guideBtn = (label) =>
    main.ev(
      `[...document.querySelectorAll('[role=dialog][aria-label="Setup guide"] button')].find(b=>b.textContent.trim()===${JSON.stringify(label)})?.click()`
    )
  await guideBtn('Next')
  await sleep(500)
  await main.ev(
    setValue('input[aria-label="Google Gemini API key"]', 'AIza-fake-wizard-key-123456')
  )
  for (let i = 0; i < 30; i++) {
    if (await main.ev(`!!document.querySelector('[data-testid=ai-connected]')`)) break
    await sleep(200)
  }
  check(
    'wizard saves and checks a pasted AI key on its own',
    await main.ev(`!!document.querySelector('[data-testid=ai-connected]')`),
    await main.ev(`document.querySelector('[data-testid=key-status]')?.textContent`)
  )
  await main.shot('01c-guide-ai.png')
  await guideBtn('Back')
  await sleep(500)
  await guideBtn('Next')
  await sleep(600)
  check(
    'the AI key is still shown as connected after leaving the step',
    await main.ev(
      `!!document.querySelector('[data-testid=ai-connected]') && document.querySelector('[data-testid=setup-checklist] [data-done=true]')!==null`
    )
  )
  await main.ev(`window.api.invoke('llm:set-key',{provider:'gemini',key:''})`)
  await main.ev(
    `document.querySelector('[role=dialog][aria-label="Setup guide"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`
  )
  await sleep(500)
  check(
    'Esc closes the guide',
    !(await main.ev(`!!document.querySelector('[role=dialog][aria-label="Setup guide"]')`))
  )

  // home
  check(
    'home screen with greeting and ring',
    /Good (morning|afternoon|evening)|Working late|midnight/.test(await text()) &&
      (await main.ev(`document.querySelectorAll('.ring').length`)) === 2
  )
  await main.shot('02-home.png')

  // dashboard: categories as cards -> buckets -> notes
  await main.ev(`document.querySelector('button[aria-label=Notes]').click()`)
  await sleep(800)
  check(
    'dashboard opens with glance cards',
    /your notes/i.test(await text()) &&
      /waiting on/i.test(await text()) &&
      /browse your notes/i.test(await text())
  )
  await main.shot('03-dashboard.png')
  check(
    'no Meetings tab, no Sky',
    !(await main.ev(`!!document.querySelector('[role=tab][aria-label=Meetings]')`)) &&
      !(await text()).includes('Sky')
  )
  await main.ev(
    `(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.includes('Customers, vendors'));b&&b.click()})()`
  )
  await sleep(700)
  check(
    'a view shows bucket cards',
    (await text()).includes('Your Notes › Companies') && (await text()).includes('Navy NextMRO')
  )
  await main.ev(
    `(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.startsWith('Navy NextMRO'));b&&b.click()})()`
  )
  await sleep(700)
  check(
    'a bucket shows its notes',
    (await text()).includes('› Navy NextMRO') &&
      (await main.ev(`document.querySelectorAll('main button h3, .lib-item h3').length`)) >= 3
  )
  await main.shot('03b-bucket.png')
  // Back from a note returns to this bucket, not the front door of the page
  await main.ev(
    `(()=>{const b=[...document.querySelectorAll('main button h3, .lib-item h3')][0];b&&b.closest('button').click()})()`
  )
  await sleep(900)
  // Delete needs two clicks: the first only arms it, Esc disarms it, and nothing is deleted.
  await main.ev(`document.querySelector('[data-testid=note-delete]')?.click()`)
  await sleep(150)
  const armed = await main.ev(`document.querySelector('[data-testid=note-delete]')?.dataset.armed`)
  await main.ev(
    `document.querySelector('[data-testid=note-delete]')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`
  )
  await sleep(150)
  check(
    'a first click on Delete only arms it; Esc disarms it and the note stays',
    armed === 'true' &&
      (await main.ev(`document.querySelector('[data-testid=note-delete]')?.dataset.armed`)) ===
        'false' &&
      (await main.ev(`!!document.querySelector('.cm-editor')`))
  )
  await main.ev(`document.querySelector('[data-testid=nav-back]')?.click()`)
  await sleep(800)
  check(
    'Back returns to the bucket you were in',
    (await text()).includes('› Navy NextMRO') &&
      !(await main.ev(`!!document.querySelector('.cm-editor')`))
  )
  // The Home button (tasks gauge, today at a glance) is always one click away
  await main.ev(`document.querySelector('[data-testid=nav-home]').click()`)
  await sleep(700)
  check(
    'the Home button opens the tasks gauge',
    /tasks? (due or overdue|left today)/i.test(await text()) &&
      (await main.ev(
        `document.querySelector('[data-testid=nav-home]').getAttribute('aria-current')`
      )) === 'page'
  )
  // The sidebar tabs follow the page: nothing is highlighted on Home, the matching tab elsewhere
  const selectedTabs = () =>
    main.ev(
      `[...document.querySelectorAll('[role=tablist] [role=tab][aria-selected=true]')].map(b=>b.getAttribute('aria-label'))`
    )
  check(
    'on Home no sidebar tab is highlighted',
    (await selectedTabs()).length === 0,
    JSON.stringify(await selectedTabs())
  )
  await main.ev(`document.querySelector('button[aria-label=Tasks]').click()`)
  await sleep(500)
  check('on the Tasks page the Tasks tab is highlighted', (await selectedTabs()).join() === 'Tasks')
  await main.ev(`document.querySelector('[data-testid=nav-home]').click()`)
  await sleep(500)
  check('back on Home the tab highlight is gone again', (await selectedTabs()).length === 0)
  await main.ev(`window.api.invoke('app:set-theme',{mode:'dark'})`)
  await main.ev(`document.querySelector('button[aria-label=Notes]').click()`)
  await sleep(600)
  await main.ev(
    `[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Navy NextMRO') || b.textContent.trim().startsWith('Companies'))?.click()`
  )
  await sleep(500)
  await main.ev(
    `(()=>{const b=[...document.querySelectorAll('nav[aria-label="Where you are"] button')].find(x=>x.innerText==='Your Notes');b&&b.click()})()`
  )
  await sleep(500)
  await main.ev(setValue('input[aria-label="Search every note"]', 'migration'))
  const found = () =>
    main.ev(
      `[...document.querySelectorAll('section[aria-label="Search results"] h3')].map(h=>h.textContent).join('|')`
    )
  for (let i = 0; i < 30 && (await found()) !== 'Old brain dump'; i++) await sleep(200)
  check('search finds a note by its text', (await found()) === 'Old brain dump', await found())
  await main.ev(setValue('input[aria-label="Search every note"]', ''))

  // new note: type a title, or pick a meeting; resync lives here
  await main.ev(keydown('n', true))
  await sleep(500)
  check(
    'New Note modal opens with resync',
    ((await main.ev(`!!document.querySelector('[role=dialog][aria-label="New Note"]')`)) &&
      (await text()).includes('Sign in to Google')) ||
      (await text()).includes('Resync meetings')
  )
  await main.shot('03c-newnote.png')
  await main.ev(setValue('input[aria-label="Note title"]', 'Planning chat'))
  await main.ev(
    `document.querySelector('input[aria-label="Note title"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`
  )
  await sleep(1500)
  check(
    'typed title creates a note that opens',
    await main.ev(
      `!!document.querySelector('input[aria-label="Note title"]') && document.querySelector('input[aria-label="Note title"]').value === 'Planning chat'`
    )
  )

  // rich-text toolbar
  check(
    'formatting toolbar is there',
    await main.ev(`!!document.querySelector('[role=toolbar][aria-label=Formatting]')`)
  )
  await main.ev(
    `(()=>{const c=document.querySelector('.cm-content');c.focus();document.execCommand('insertText',false,'Buy cake')})()`
  )
  await sleep(200)
  await main.ev(`document.querySelector('[aria-label="Task (checkbox)"]').click()`)
  await sleep(300)
  await main.ev(`document.execCommand('insertParagraph')`)
  await main.ev(`document.execCommand('insertText',false,'Plain line after')`)
  await sleep(300)
  check(
    'live preview shows a real checkbox off the active line',
    (await main.ev(`document.querySelectorAll('.cm-check').length`)) === 1
  )
  await main.ev(
    `document.querySelector('.cm-content').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))`
  )
  check(
    'task button turns the line into a task with a real checkbox',
    (await main.ev(`document.querySelector('.cm-content').innerText`)).includes('Buy cake')
  )
  await main.shot('03d-editor.png')

  // Rich text (default) renders everything and hides the task id; Markdown shows the syntax
  await sleep(1800) // autosave, then the indexer stamps the task with its ^id
  check(
    'Rich text view shows no task id and no raw "- [ ]"',
    await main.ev(
      `(()=>{const t=document.querySelector('.cm-content').innerText;return !/\\^[a-z0-9]{4,}/i.test(t) && !t.includes('- [ ]')})()`
    )
  )
  await main.ev(
    `[...document.querySelectorAll('[role=tab]')].find(b=>b.textContent.trim()==='Markdown').click()`
  )
  await sleep(400)
  check(
    'Markdown view shows the raw syntax',
    (await main.ev(`document.querySelectorAll('.cm-check').length`)) === 0 &&
      (await main.ev(`document.querySelector('.cm-content').innerText`)).includes('- [')
  )
  await main.shot('03e-editor-markdown.png')
  await main.ev(keydown('M', true, true))
  await sleep(400)
  check(
    'Ctrl+Shift+M flips back to Rich text',
    (await main.ev(`document.querySelectorAll('.cm-check').length`)) === 1
  )
  // typing at the end of a task line in Rich text keeps the hidden id at the end
  await main.ev(
    `(()=>{const l=[...document.querySelectorAll('.cm-line')].find(x=>x.innerText.includes('Buy cake'));const r=document.createRange();r.selectNodeContents(l);r.collapse(false);const g=getSelection();g.removeAllRanges();g.addRange(r);document.querySelector('.cm-content').focus();document.execCommand('insertText',false,' more')})()`
  )
  await sleep(300)
  await main.ev(
    `[...document.querySelectorAll('[role=tab]')].find(b=>b.textContent.trim()==='Markdown').click()`
  )
  await sleep(300)
  check(
    'typing at the end of a task keeps its id after the text',
    /Buy cake more\s+\^[a-z0-9]{4,}/i.test(
      await main.ev(`document.querySelector('.cm-content').innerText`)
    )
  )
  await main.ev(keydown('M', true, true))
  await sleep(300)
  // a pasted Google Doc address becomes a chip
  await main.ev(
    `(()=>{const l=[...document.querySelectorAll('.cm-line')].find(x=>x.innerText.includes('Plain line after'));const r=document.createRange();r.selectNodeContents(l);r.collapse(false);const g=getSelection();g.removeAllRanges();g.addRange(r);document.querySelector('.cm-content').focus();document.execCommand('insertText',false,' https://docs.google.com/document/d/1AbCdEf/edit')})()`
  )
  await sleep(400)
  check(
    'a pasted Google Doc address shows as a chip',
    await main.ev(`document.querySelectorAll('.cm-drive-chip').length === 1`)
  )

  // entities: categories, duplicates, merge
  await main.ev(
    `window.api.invoke('entities:upsert',{category:'person',name:'Joe Cardone',aliases:[]})`
  )
  await main.ev(`window.api.invoke('entities:upsert',{category:'person',name:'Joe C',aliases:[]})`)
  await main.ev(
    `window.api.invoke('entities:upsert',{category:'project',name:'Cutover',aliases:[]})`
  )
  await sleep(1500)
  const sugg = JSON.parse(
    await main.ev(`window.api.invoke('entities:suggestions').then(r=>JSON.stringify(r.data))`)
  )
  check(
    'duplicate Joe C / Joe Cardone suggested',
    sugg.some((x) => x.names.includes('Joe Cardone') && x.names.includes('Joe C'))
  )
  const lst = JSON.parse(
    await main.ev(
      `window.api.invoke('entities:manage-list').then(r=>JSON.stringify(r.data.map(e=>[e.name,e.category])))`
    )
  )
  check(
    'projects are a category',
    lst.some((e) => e[0] === 'Cutover' && e[1] === 'project')
  )
  await main.ev(
    `window.api.invoke('entities:merge',{category:'person',canonical:'Joe Cardone',others:['Joe C']})`
  )
  await sleep(1500)
  const after = JSON.parse(
    await main.ev(
      `window.api.invoke('entities:manage-list').then(r=>JSON.stringify(r.data.filter(e=>e.category==='person').map(e=>[e.name,e.aliases])))`
    )
  )
  check(
    'merge keeps one person with the other as nickname',
    after.some((e) => e[0] === 'Joe Cardone' && e[1].includes('Joe C')) &&
      !after.some((e) => e[0] === 'Joe C')
  )

  // notifications report back, whatever the hour
  const nt = JSON.parse(
    await main.ev(`window.api.invoke('nudges:test').then(r=>JSON.stringify(r.data))`)
  )
  check(
    'test notification reports what Windows did',
    typeof nt.supported === 'boolean' && typeof nt.shown === 'boolean',
    JSON.stringify(nt)
  )

  // palette
  await main.ev(keydown('k', true))
  await sleep(500)
  check(
    'palette opens',
    await main.ev(`!!document.querySelector('[role=dialog][aria-label="Command palette"]')`)
  )
  await main.ev(setValue('input[aria-label="Search"]', 'firewall'))
  await sleep(400)
  check('palette finds a task', /firewall/i.test(await text()))
  await main.shot('04-palette.png')
  await main.ev(
    `document.querySelector('[role=dialog][aria-label="Command palette"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`
  )
  await sleep(300)
  check(
    'Esc closes the palette',
    !(await main.ev(`!!document.querySelector('[role=dialog][aria-label="Command palette"]')`))
  )

  // quick capture window
  const cap = await connect((u) => u.includes('#capture'))
  await sleep(1000)
  await cap.ev(`document.querySelector('button[aria-label="Text shortcuts"]').click()`)
  await sleep(300)
  check(
    'capture window shows text shortcuts',
    (await cap.ev('document.body.innerText')).includes('@Name') &&
      (await cap.ev('document.body.innerText')).includes('!high')
  )
  await cap.ev(
    `[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Priority')).click()`
  )
  await sleep(200)
  check(
    'capture buttons insert syntax',
    (await cap.ev(`document.querySelector('textarea[aria-label="Quick task"]').value`)).includes(
      '!high'
    )
  )
  await cap.shot('04b-capture-help.png')
  // Real key presses (not synthetic events): the text box must have focus for these to work.
  const VK = { Tab: 9, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 }
  const realKey = async (c, key) => {
    await c.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key,
      code: key,
      windowsVirtualKeyCode: VK[key]
    })
    await c.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code: key,
      windowsVirtualKeyCode: VK[key]
    })
    await sleep(350)
  }
  const capMode = () => cap.ev(`document.querySelector('textarea').getAttribute('aria-label')`)
  check(
    'capture text box has focus when shown',
    await cap.ev(`document.activeElement && document.activeElement.tagName === 'TEXTAREA'`)
  )
  await realKey(cap, 'ArrowDown')
  check('real ArrowDown switches to a note', (await capMode()) === 'Quick note', await capMode())
  await cap.shot('04c-capture-note.png')
  await realKey(cap, 'ArrowUp')
  check('real ArrowUp switches back to a task', (await capMode()) === 'Quick task', await capMode())
  await realKey(cap, 'Tab')
  check('real Tab switches to a note', (await capMode()) === 'Quick note', await capMode())
  // Long text: the window grows, then offers to continue in the app.
  const h0 = await cap.ev('window.innerHeight')
  await cap.ev(
    setValue(
      'textarea[aria-label="Quick note"]',
      'Long thoughts' + ' about the vendor plan and the cutover'.repeat(10),
      'HTMLTextAreaElement'
    )
  )
  await sleep(600)
  const h1 = await cap.ev('window.innerHeight')
  check('capture window grows with the text', h1 > h0, `${h0} -> ${h1}`)
  check(
    'long text offers to keep writing in the app',
    await cap.ev(`!!document.querySelector('[data-testid=capture-handoff]')`)
  )
  await cap.shot('04d-capture-long.png')
  await cap.ev(setValue('textarea[aria-label="Quick note"]', '', 'HTMLTextAreaElement'))
  await sleep(300)
  await realKey(cap, 'Tab')
  await cap.ev(
    setValue(
      'textarea[aria-label="Quick task"]',
      'Send budget tomorrow !high',
      'HTMLTextAreaElement'
    )
  )
  await sleep(300)
  await cap.ev(
    `document.querySelector('textarea[aria-label="Quick task"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`
  )
  await sleep(1500)
  const inbox = existsSync(join(vault, 'inbox')) ? readdirSync(join(vault, 'inbox')) : []
  check(
    'quick capture writes a task',
    inbox.length > 0 && readFileSync(join(vault, 'inbox', inbox[0]), 'utf8').includes('Send budget')
  )

  // the same window switches to an ad hoc note with Tab
  await sleep(1200)
  await cap.ev(`window.dispatchEvent(new Event('focus'))`)
  await cap.ev(
    `document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}))`
  )
  await sleep(400)
  check(
    'Tab switches the capture window to a note',
    await cap.ev(`!!document.querySelector('textarea[aria-label="Quick note"]')`)
  )
  await cap.ev(
    setValue(
      'textarea[aria-label="Quick note"]',
      'Vendor call thoughts\nThey can start in January.',
      'HTMLTextAreaElement'
    )
  )
  await sleep(200)
  await cap.ev(
    `document.querySelector('textarea[aria-label="Quick note"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`
  )
  await sleep(1500)
  check(
    'quick note becomes an ad hoc note',
    await main.ev(
      `window.api.invoke('notes:list').then(r=>r.ok && r.data.some(n=>n.title==='Vendor call thoughts'))`
    )
  )

  // Done with the capture window: hide it and give the main window focus back, so the rest of
  // the run is not slowed by a covered or unfocused window.
  await main.ev(`window.api.invoke('capture:hide')`)
  await main.send('Page.bringToFront')
  await main.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await sleep(500)

  // ---- Auto-tagging: the missing @ and # are written as you type (real key presses)
  await main.ev(
    `window.api.invoke('llm:set-key',{provider:'gemini',key:'AIza-fake-test-key-123456'})`
  )
  await main.ev(
    `window.api.invoke('entities:upsert',{category:'person',name:'Matt Rowe',aliases:['Matt']})`
  )
  for (const t of ['Cat note one\nI really like #cats', 'Cat note two\nMore thoughts on #cats'])
    await main.ev(`window.api.invoke('notes:quick-note',{text:${JSON.stringify(t)}})`)
  await sleep(1500)
  await main.ev(`document.querySelector('button[aria-label=Notes]').click()`)
  await sleep(500)
  await main.ev(
    `(()=>{const b=[...document.querySelectorAll('nav button')].find(x=>x.innerText.includes('Vendor call thoughts'));b&&b.click()})()`
  )
  await sleep(1500)
  const typeKeys = async (str) => {
    for (const ch of str) {
      if (ch === '\n') {
        await main.send('Input.dispatchKeyEvent', {
          type: 'rawKeyDown',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          text: '\r'
        })
        await main.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13
        })
      } else {
        await main.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: ch,
          text: ch,
          unmodifiedText: ch
        })
        await main.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
      }
      await sleep(25)
    }
  }
  await main.ev(`document.querySelector('.cm-content').focus()`)
  await main.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'End',
    code: 'End',
    windowsVirtualKeyCode: 35,
    modifiers: 2
  })
  await main.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'End',
    code: 'End',
    windowsVirtualKeyCode: 35,
    modifiers: 2
  })
  await typeKeys('\nTell Matt he likes cats ')
  await sleep(500)
  const edText = () => main.ev(`document.querySelector('.cm-content').innerText`)
  check(
    'typing "Tell Matt he likes cats " writes "Tell @Matt he likes #cats"',
    (await edText()).includes('Tell @Matt he likes #cats'),
    JSON.stringify((await edText()).slice(-80))
  )
  await main.shot('11-autotag.png')
  // One Ctrl+Z puts the plain word back (the tag is its own undo step)
  await main.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'z',
    code: 'KeyZ',
    windowsVirtualKeyCode: 90,
    modifiers: 2
  })
  await main.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'z',
    code: 'KeyZ',
    windowsVirtualKeyCode: 90,
    modifiers: 2
  })
  await sleep(400)
  check(
    'one Ctrl+Z takes the last tag off again',
    (await edText()).includes('Tell @Matt he likes cats') && !(await edText()).includes('#cats')
  )
  // Taking a tag off is remembered, so it is not put back (and it is listed in Settings)
  await sleep(400)
  check(
    'a tag you take off is remembered in the never-tag list',
    await main.ev(
      `window.api.invoke('settings:get').then(r=>r.ok && r.data.autoTag.ignore.includes('cats'))`
    )
  )
  // New names and topics: the small model is asked a moment after the line is finished
  await typeKeys('Ask Rhea about the rollout plan.')
  for (let i = 0; i < 25 && !(await edText()).includes('@Rhea'); i++) await sleep(250)
  check(
    "a new name and topic are tagged with the model's help, and the name joins People",
    (await edText()).includes('@Rhea') &&
      (await edText()).includes('#rollout') &&
      (await main.ev(
        `window.api.invoke('entities:manage-list').then(r=>r.ok && r.data.some(e=>e.name==='Rhea'))`
      ))
  )
  // A weak guess ("with Zorblax") is a maybe-tag: dotted underline, Tab writes it, nothing changes by itself
  await typeKeys('\nWe met with Zorblax yesterday.')
  for (let i = 0; i < 25 && !(await main.ev(`!!document.querySelector('.cm-maybe-tag')`)); i++)
    await sleep(250)
  check(
    'a weak guess is offered as a maybe-tag and is not written for you',
    (await main.ev(`!!document.querySelector('.cm-maybe-tag')`)) &&
      !(await edText()).includes('@Zorblax'),
    JSON.stringify([
      await main.ev(`document.querySelectorAll('.cm-maybe-tag').length`),
      (await edText()).slice(-90)
    ])
  )
  await main.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Tab',
    code: 'Tab',
    windowsVirtualKeyCode: 9
  })
  await main.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Tab',
    code: 'Tab',
    windowsVirtualKeyCode: 9
  })
  for (let i = 0; i < 20 && !(await edText()).includes('@Zorblax'); i++) await sleep(250)
  check('Tab turns the maybe-tag into a real tag', (await edText()).includes('@Zorblax'))
  // A name shared by two people is still tagged, and waits in Review Names
  for (const n of ['Priya Nair', 'Priya Shah'])
    await main.ev(
      `window.api.invoke('entities:upsert',{category:'person',name:${JSON.stringify(n)},aliases:[]})`
    )
  await sleep(2500)
  await typeKeys('\nAsk Priya ')
  await sleep(600)
  check(
    'a shared first name is still tagged ("Ask @Priya")',
    (await edText()).includes('Ask @Priya'),
    JSON.stringify((await edText()).slice(-60))
  )
  let waiting = 0
  for (let i = 0; i < 40 && waiting === 0; i++) {
    await sleep(300)
    waiting = await main.ev(
      `window.api.invoke('names:review').then(r=>r.ok ? r.data.filter(g=>g.short==='Priya').reduce((n,g)=>n+g.mentions.length,0) : 0)`
    )
  }
  check('the tagged shared name is waiting in Review Names', waiting > 0, String(waiting))
  await main.ev(`document.querySelector('button[aria-label=Knowledge]').click()`)
  await sleep(1500)
  check(
    'the Knowledge sidebar shows the review count',
    await main.ev(
      `(()=>{const c=document.querySelector('[data-testid=review-count]');return !!c && Number(c.textContent)>0})()`
    )
  )
  await main.shot('12-review-count.png')
  await main.ev(`document.querySelector('button[aria-label=Notes]').click()`)
  await sleep(400)
  await main.ev(`document.querySelector('button[aria-label=Knowledge]').click()`)
  await sleep(500)
  await main.ev(
    `[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Topics'))?.click()`
  )
  await sleep(2500)
  check(
    'the connections chart draws glowing stars',
    await main.ev(
      `document.querySelectorAll('svg[aria-label^="Relationship graph"] .nm-twinkle').length > 10`
    )
  )
  await main.shot('13-constellation.png')
  await main.ev(`document.querySelector('button[aria-label=Notes]').click()`)
  await sleep(400)

  // Quick capture tags the description, not the owner (clear the never-tag list first)
  await main.ev(`window.api.invoke('settings:update',{autoTag:{ignore:[]}})`)
  await sleep(300)
  await main.ev(`window.api.invoke('tasks:quick-add',{text:'Tell Matt he likes cats'})`)
  await sleep(800)
  const tagged = readdirSync(join(vault, 'inbox'))
    .map((n) => readFileSync(join(vault, 'inbox', n), 'utf8'))
    .join('\n')
  check(
    'quick-add writes the tags into the task text',
    tagged.includes('Tell @Matt he likes #cats'),
    tagged
      .split('\n')
      .filter((l) => /likes/.test(l))
      .join(' / ')
  )
  // Settings has the controls
  await main.ev(`document.querySelector('button[aria-label=Settings]').click()`)
  await sleep(700)
  check(
    'Settings has Auto-Tagging with a never-tag list',
    (await text()).includes('Tag names and topics as I type') &&
      (await main.ev(`!!document.querySelector('[data-testid=tag-ignore]')`))
  )
  check(
    'Tag health counts the tags you kept and took off',
    await main.ev(
      `(()=>{const t=document.querySelector('[data-testid=tag-health-summary]')?.innerText ?? '';return /automatic tags kept/.test(t) && /taken off/.test(t)})()`
    )
  )
  await main.ev(`document.querySelector('button[aria-label=Settings]').click()`)
  await sleep(500)

  // A task is always mine, even when it is about someone: the @Name is a tag, not the owner
  await main.ev(
    `window.api.invoke('tasks:quick-add',{text:'Complete the onboarding documentation for @John Smith'})`
  )
  await sleep(800)
  check(
    '"... for @John Smith" is my task, tagged with John Smith',
    await main.ev(
      `window.api.invoke('tasks:list').then(r=>r.ok && r.data.some(t=>/onboarding documentation for @John Smith/.test(t.description) && t.owner==='Me' && t.isMine))`
    )
  )
  // Only the explicit "waiting on X: ..." form is a Waiting On note line
  const qa = await main.ev(
    `window.api.invoke('tasks:quick-add',{text:'Waiting on Priya: send the budget numbers friday'}).then(r=>r.ok && r.data.kind)`
  )
  await sleep(600)
  const waitingNow = await main.ev(
    `window.api.invoke('waiting:list').then(r=>r.ok ? r.data.map(w=>w.who+': '+w.text) : [])`
  )
  check(
    '"Waiting on Priya: ..." becomes a Waiting On note, not a task',
    qa === 'waiting' &&
      waitingNow.some((w) => w.startsWith('Priya: send the budget numbers')) &&
      !(await main.ev(
        `window.api.invoke('tasks:list').then(r=>r.data.some(t=>/budget numbers/.test(t.description) && t.owner==='Priya'))`
      )),
    JSON.stringify(waitingNow)
  )

  // Tasks can be filtered by what they are about (the John Smith task above)
  await main.ev(`document.querySelector('button[aria-label=Tasks]').click()`)
  await sleep(500)
  await main.ev(
    `[...document.querySelectorAll('[role=navigation][aria-label=Tasks] button')].find(b=>b.textContent.trim().startsWith('All Tasks'))?.click()`
  )
  await sleep(900)
  check(
    'Tasks has an About filter listing John Smith',
    await main.ev(
      `(()=>{const s=document.querySelector('[data-testid=tasks-about]');return !!s && [...s.options].some(o=>o.textContent==='John Smith')})()`
    )
  )
  await main.shot('14-tasks-about.png')

  // Tasks dashboard: calendar, open tasks and the Action Center with scored mail
  await main.ev(
    `[...document.querySelectorAll('[role=navigation][aria-label=Tasks] button')].find(b=>b.textContent.trim().startsWith('Overview'))?.click()`
  )
  await sleep(600)
  check(
    'the Dashboard has a calendar, a compact open-task list and an Action Center',
    await main.ev(
      `!!document.querySelector('[data-testid=tasks-dashboard] [data-testid=panel-calendar]') && !!document.querySelector('[data-testid=tasks-compact]') && !document.querySelector('[data-testid=tasks-search]') && !!document.querySelector('[data-testid=action-center]')`
    )
  )
  check(
    'the Action Center is open by default and the calendar is folded away',
    await main.ev(
      `!!document.querySelector('[data-testid=action-center]') && !document.querySelector('[data-testid=mini-calendar]')`
    )
  )
  await main.ev(`document.querySelector('[data-testid=panel-calendar]').click()`)
  await sleep(400)
  check(
    'opening the calendar folds the Action Center, so only one is open',
    await main.ev(
      `!!document.querySelector('[data-testid=mini-calendar]') && !document.querySelector('[data-testid=action-center]')`
    )
  )
  await main.shot('14a-dashboard-calendar.png')
  await main.ev(`document.querySelector('[data-testid=panel-action]').click()`)
  await sleep(400)
  {
    const { DatabaseSync: Dbm } = await import('node:sqlite')
    const dm = new Dbm(join(userData, 'index.db'))
    const nowLocal = new Date(Date.now() - 3600_000)
      .toLocaleString('sv')
      .slice(0, 16)
      .replace(' ', 'T')
    const ins = dm.prepare(
      `INSERT OR REPLACE INTO email_threads (id, link_id, subject, snippet, sender_name, sender_email, last_sender_is_me,
         last_message_at, unread, starred, labels_json, in_inbox, i_participated, to_me, cc_me, bulk, important_label, msg_count)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, 1, 0, '[]', 1, 0, ?, 0, ?, 0, 1)`
    )
    ins.run(
      'e2e-imp',
      'e2e-imp',
      'Budget approval needed',
      'Can you approve the budget by Friday?',
      'Dana Cole',
      'dana@acme.com',
      nowLocal,
      1,
      0
    )
    ins.run(
      'e2e-news',
      'e2e-news',
      'Big sale this week',
      'Everything half price',
      'Shop',
      'offers@shop.example.com',
      nowLocal,
      0,
      1
    )
    dm.close()
  }
  await main.ev(
    `[...document.querySelectorAll('[data-testid=action-center] button')].find(b=>b.textContent.trim()==='Check now').click()`
  )
  await sleep(900)
  check(
    'the Action Center lists the important email and holds back the newsletter',
    await main.ev(
      `(()=>{const t=document.querySelector('[data-testid=action-list]')?.innerText ?? '';return t.includes('Budget approval needed') && !t.includes('Big sale')})()`
    )
  )
  await main.ev(`document.querySelector('[data-testid=ac-tab-hidden]').click()`)
  await sleep(400)
  check(
    'the newsletter is under Hidden',
    await main.ev(
      `(document.querySelector('[data-testid=action-list]')?.innerText ?? '').includes('Big sale')`
    )
  )
  await main.ev(`document.querySelector('[data-testid=ac-tab-needs-you]').click()`)
  await sleep(300)
  await main.ev(`document.querySelector('[data-testid=mark-not-important]').click()`)
  await sleep(700)
  {
    const { DatabaseSync: Dbw } = await import('node:sqlite')
    const dw = new Dbw(join(userData, 'index.db'))
    const w = dw.prepare("SELECT weight FROM sender_weights WHERE key = 'dana@acme.com'").get()
    dw.close()
    check('Not important teaches it about the sender', w?.weight === -3, JSON.stringify(w))
  }
  // Marked not important, the card now sits under Hidden: block the sender from there
  await main.ev(`document.querySelector('[data-testid=ac-tab-hidden]').click()`)
  await sleep(400)
  await main.ev(
    `[...document.querySelectorAll('[data-testid=action-card]')].find(c=>c.innerText.includes('Budget approval needed')).querySelector('[data-testid=block-sender]').click()`
  )
  await sleep(300)
  await main.ev(
    `[...document.querySelectorAll('[data-testid=action-card]')].find(c=>c.innerText.includes('Budget approval needed')).querySelector('[data-testid=block-options] button').click()`
  )
  await sleep(800)
  {
    const { DatabaseSync: Dbk } = await import('node:sqlite')
    const dk = new Dbk(join(userData, 'index.db'))
    const m = dk.prepare("SELECT pattern FROM email_mutes WHERE pattern = 'dana@acme.com'").get()
    dk.exec('DELETE FROM email_mutes')
    dk.close()
    check('Block stops a sender from showing up', !!m, JSON.stringify(m))
  }
  check(
    'the blocked sender is gone from the Action Center',
    await main.ev(
      `!(document.querySelector('[data-testid=action-list]')?.innerText ?? '').includes('Budget approval needed')`
    )
  )
  await main.ev(`document.querySelector('[data-testid=ac-tab-needs-you]').click()`)
  await main.ev(
    `[...document.querySelectorAll('[role=navigation][aria-label=Tasks] button')].find(b=>b.textContent.trim().startsWith('All Tasks'))?.click()`
  )
  await sleep(600)
  check(
    'the Tasks page has the full toolbar: status, search, sort, priority',
    await main.ev(
      `!!document.querySelector('[data-testid=tasks-toolbar] [data-testid=tasks-search]') && !!document.querySelector('[data-testid=tasks-sort]') && !!document.querySelector('[data-testid=prio-High]') && !!document.querySelector('[data-testid=task-chip-overdue]')`
    )
  )
  await main.ev(
    `(()=>{const i=document.querySelector('[data-testid=tasks-search]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'zzzz-no-such-task');i.dispatchEvent(new Event('input',{bubbles:true}))})()`
  )
  await sleep(400)
  check(
    'searching tasks narrows the list',
    (await main.ev(`document.querySelectorAll('[data-testid=tasks-page] li').length`)) === 0
  )
  await main.ev(
    `(()=>{const i=document.querySelector('[data-testid=tasks-search]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'');i.dispatchEvent(new Event('input',{bubbles:true}))})()`
  )
  await sleep(300)
  await main.shot('14b-dashboard.png')
  {
    const { DatabaseSync: Dbc } = await import('node:sqlite')
    const dc = new Dbc(join(userData, 'index.db'))
    dc.exec("DELETE FROM email_threads WHERE id LIKE 'e2e-%'; DELETE FROM sender_weights;")
    dc.close()
  }

  // Meeting Series: a repeating meeting becomes one page with its sessions
  {
    const { DatabaseSync: Db2 } = await import('node:sqlite')
    const d2 = new Db2(join(userData, 'index.db'))
    const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)
    for (const [id, off] of [
      ['ev-ps-1', -7],
      ['ev-ps-2', 0],
      ['ev-ps-3', 7]
    ])
      d2.prepare(
        `INSERT OR REPLACE INTO calendar_events (id, title, start_at, end_at, date, all_day, kind) VALUES (?, 'Platform Standup', ?, ?, ?, 0, 'meeting')`
      ).run(id, day(off) + 'T10:00:00Z', day(off) + 'T10:30:00Z', day(off))
    // A renamed occurrence that Google says belongs to the same repeating series
    d2.prepare(
      "UPDATE calendar_events SET series_id = 'rep-ps' WHERE id IN ('ev-ps-1','ev-ps-2')"
    ).run()
    d2.prepare(
      `INSERT OR REPLACE INTO calendar_events (id, title, start_at, end_at, date, all_day, kind, series_id) VALUES ('ev-ps-4', 'Team Sync (moved)', ?, ?, ?, 0, 'meeting', 'rep-ps')`
    ).run(day(14) + 'T10:00:00Z', day(14) + 'T10:30:00Z', day(14))
    d2.close()
  }
  await main.ev(keydown('k', true))
  await sleep(300)
  await main.ev(setValue('input[aria-label="Search"]', 'meeting series'))
  await sleep(300)
  await main.ev(`document.querySelector('[role=option]').click()`)
  await sleep(1200)
  check(
    'Meeting Series lists the repeating meeting',
    (
      await main.ev(`document.querySelector('[data-testid=series-list]')?.innerText ?? ''`)
    ).includes('Platform Standup')
  )
  await main.ev(
    `[...document.querySelectorAll('[data-testid=series-list] button')].find(b=>b.textContent.includes('Platform Standup')).click()`
  )
  await sleep(1000)
  check(
    'a series page joins a renamed occurrence by Google repeat id, and offers the master page',
    await main.ev(
      `(()=>{const t=document.querySelector('[data-testid=series-detail]')?.innerText ?? '';return t.includes('4 sessions') && t.includes('Start Next Session') && t.includes('Create Master Page')})()`
    )
  )
  await main.shot('15-series.png')
  {
    // Leave the calendar as it was for the checks that follow
    const { DatabaseSync: Db3 } = await import('node:sqlite')
    const d3 = new Db3(join(userData, 'index.db'))
    d3.prepare("DELETE FROM calendar_events WHERE id LIKE 'ev-ps-%'").run()
    d3.close()
  }
  await main.ev(`document.querySelector('button[aria-label=Notes]').click()`)
  await sleep(400)

  // Inbox: an insight with a source reference becomes a task that keeps a readable link back
  const { DatabaseSync } = await import('node:sqlite')
  const sdb = new DatabaseSync(join(userData, 'index.db'))
  sdb
    .prepare(
      `INSERT INTO insights (id, kind, text, owner, due, confidence, source_type, source_ref, source_label, source_snippet, source_at, dedupe_key)
       VALUES ('11111111-2222-4333-8444-555555555555','ask','Send Priya the budget numbers','Me','2026-11-20',0.8,'chat','{"space":"dm:Priya"}','Chat · Priya · Nov 14','Can you send me the budget numbers by Friday?','2026-11-14T15:00:00Z','ask:budget-numbers-priya')`
    )
    .run()
  sdb
    .prepare(
      `INSERT INTO insights (id, kind, text, owner, due, confidence, source_type, source_ref, source_label, source_snippet, source_at, dedupe_key)
       VALUES ('99999999-2222-4333-8444-555555555555','decision','Cutover moves to Dec 4',NULL,NULL,0.8,'chat','{"space":"dm:Priya"}','Chat · Priya · Nov 14','We agreed the cutover moves to Dec 4.','2026-11-14T15:00:00Z','decision:cutover-dec-4')`
    )
    .run()
  sdb.close()
  await main.ev(
    `document.querySelector('button[aria-label="Tasks"], button[title="Tasks"]')?.click()`
  )
  await sleep(400)
  await main.ev(
    `[...document.querySelectorAll('[role=navigation][aria-label=Tasks] button')].find(b=>b.textContent.trim().startsWith('Action Center'))?.click()`
  )
  await sleep(1500)
  check(
    'the Action Center shows what matters with a readable source',
    (await text()).includes('Send Priya the budget numbers') &&
      (await text()).includes('Chat · Priya · Nov 14'),
    (await text()).slice(0, 600)
  )
  check(
    'a decision is not in the Action Center',
    !(await text()).includes('Cutover moves to Dec 4')
  )
  await main.shot('07-inbox.png')
  await main.ev(`document.querySelector('[data-testid=ac-section-facts]')?.click()`)
  await sleep(1000)
  check(
    'Decisions & Facts lists the decision to keep or mark not pertinent',
    await main.ev(
      `(()=>{const t=document.querySelector('[data-testid=facts-page]')?.innerText ?? '';return t.includes('Cutover moves to Dec 4') && t.includes('Not pertinent')})()`
    )
  )
  await main.shot('07b-facts.png')
  // The Email and Chat lists are sections of the same page (no orphaned pages).
  for (const [id, label] of [
    ['mail', 'Email'],
    ['chat', 'Chat']
  ]) {
    await main.ev(`document.querySelector('[data-testid=ac-section-${id}]')?.click()`)
    await sleep(500)
    check(
      `the Action Center has an ${label} section`,
      await main.ev(`!!document.querySelector('[data-testid=${id}-section]')`)
    )
  }
  await main.shot('07c-mail-section.png')
  await main.ev(`document.querySelector('[data-testid=ac-section-act]')?.click()`)
  await sleep(300)
  await main.ev(
    `[...document.querySelectorAll('[role=navigation][aria-label=Tasks] button')].find(b=>b.textContent.trim().startsWith('Action Center'))?.click()`
  )
  await sleep(1000)
  await main.ev(
    `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Add as Task').click()`
  )
  await sleep(1800)
  const ibx = readdirSync(join(vault, 'inbox'))
  const ibxText = ibx.map((n) => readFileSync(join(vault, 'inbox', n), 'utf8')).join('\n')
  check(
    'accepting writes a task with a link back to the source',
    ibxText.includes(
      'Send Priya the budget numbers [Chat · Priya · Nov 14](nm://src/11111111-2222-4333-8444-555555555555)'
    )
  )
  check(
    'the task list shows the source, not the link syntax',
    await main.ev(
      `window.api.invoke('tasks:list').then(r=>r.ok && r.data.some(t=>t.description==='Send Priya the budget numbers' && t.sourceLabel==='Chat · Priya · Nov 14'))`
    )
  )

  // The model provider allows only so many calls a minute. The tagging checks above used some, so
  // wait for the window to clear before the Co-Pilot steps (they make several calls in a row).
  for (let i = 0; i < 80; i++) {
    const used = await main.ev(
      `window.api.invoke('llm:status').then(r=>r.ok ? Math.max(0,...r.data.providers.map(p=>p.usage.lastMinute)) : 0)`
    )
    if (used <= 1) break
    await sleep(1000)
  }
  // Co-Pilot (fake Gemini)
  await main.ev(
    `window.api.invoke('llm:set-key',{provider:'gemini',key:'AIza-fake-test-key-123456'})`
  )
  await main.ev(keydown('j', true))
  await sleep(500)
  const send = async (t) => {
    await main.ev(setValue('textarea[aria-label="Message"]', t, 'HTMLTextAreaElement'))
    await sleep(100)
    await main.ev(
      `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Send').click()`
    )
    await sleep(1500)
    // Answers are typed out; wait for the typing to finish (the cursor goes away)
    for (let i = 0; i < 30 && (await main.ev(`!!document.querySelector('aside .caret')`)); i++)
      await sleep(200)
  }
  await send('When is the cutover moving?')
  for (let i = 0; i < 30 && !(await text()).includes('December 4'); i++) await sleep(200)
  check(
    'Co-Pilot answers with a citation',
    (await text()).includes('December 4') &&
      (await main.ev(
        `[...document.querySelectorAll('aside button')].some(b=>b.textContent.includes('NextMRO'))`
      )),
    (
      await main.ev(`[...document.querySelectorAll('aside')].map(a=>a.innerText).join(' || ')`)
    ).slice(-1200)
  )
  await send('Send the deck to Sarah next Thursday; contact joe@example.com')
  check(
    'a to-do dump gets an offer, not cards',
    (await main.ev(`document.querySelectorAll('[data-testid=proposal]').length`)) === 0 &&
      (await main.ev(
        `[...document.querySelectorAll('aside button')].some(b=>b.textContent.includes('Turn these into tasks'))`
      ))
  )
  await main.ev(
    `[...document.querySelectorAll('aside button')].find(b=>b.textContent.includes('Turn these into tasks')).click()`
  )
  for (
    let i = 0;
    i < 30 && (await main.ev(`document.querySelectorAll('[data-testid=proposal]').length`)) === 0;
    i++
  )
    await sleep(200)
  check(
    'the offer button creates a card to approve',
    (await main.ev(`document.querySelectorAll('[data-testid=proposal]').length`)) === 1
  )
  // A question that needs a lookup: it checks the calendar, shows what it did, formats the answer
  await send('What is on my plate this week?')
  for (let i = 0; i < 30 && !(await text()).includes('Looked at your calendar'); i++)
    await sleep(200)
  check(
    'the assistant looks things up, formats the answer and says what it looked at',
    (await text()).includes('Looked at your calendar') &&
      (await main.ev(`!!document.querySelector('aside strong')`)) &&
      (await text()).includes('Script standup')
  )
  await main.shot('05-copilot.png')

  // AI modes, follow-ups, one-click actions on a note
  await main.ev(
    `[...document.querySelectorAll('[role=radiogroup][aria-label="AI usage"] button')].find(b=>b.textContent.trim()==='Detailed').click()`
  )
  await sleep(700)
  check(
    'mode switch saves Heavy',
    (await main.ev(`window.api.invoke('settings:get').then(r=>r.data.llm.mode)`)) === 'heavy'
  )
  await send('When is the cutover moving?')
  await sleep(1500)
  check(
    'Heavy suggests follow-up questions',
    await main.ev(
      `[...document.querySelectorAll('aside button')].some(b=>b.textContent.includes('Who owns the firewall work'))`
    )
  )
  await main.shot('05b-followups.png')

  await main.ev(`document.querySelector('button[aria-label=Notes]').click()`)
  await sleep(500)
  await main.ev(
    `(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.includes('NextMRO Weekly 1'));b&&b.click()})()`
  )
  await sleep(900)
  check(
    'quick-action chips act on the open note',
    await main.ev(
      `[...document.querySelectorAll('[aria-label="Quick actions"] button')].some(b=>b.textContent.includes('Summarize this note'))`
    )
  )
  await main.ev(
    `[...document.querySelectorAll('[aria-label="Quick actions"] button')].find(b=>b.textContent.includes('Summarize this note')).click()`
  )
  await sleep(2600)
  for (let i = 0; i < 30 && !(await text()).includes('Cutover slips to December 4'); i++)
    await sleep(200)
  check(
    'the Summarize chip uses the model when AI works (no rule-based shortcut)',
    (await text()).includes('Cutover slips to December 4') &&
      !(await text()).includes('Quick answer on your computer')
  )
  // Without a working AI key the same chip falls back to the on-computer answer, with an AI redo button
  await main.ev(`window.api.invoke('llm:set-key',{provider:'gemini',key:''})`)
  await sleep(500)
  await main.ev(`document.querySelector('button[aria-label^="Close Co-Pilot"]').click()`)
  await sleep(300)
  await main.ev(keydown('j', true))
  await sleep(700)
  await main.ev(
    `[...document.querySelectorAll('[aria-label="Quick actions"] button')].find(b=>b.textContent.includes('Summarize this note')).click()`
  )
  await sleep(2600)
  check(
    'with no AI key the chip falls back to the on-computer answer and offers AI',
    (await text()).includes('Quick answer on your computer') &&
      (await text()).includes('Polish With AI')
  )
  await main.ev(
    `window.api.invoke('llm:set-key',{provider:'gemini',key:'AIza-fake-test-key-123456'})`
  )
  await sleep(500)
  await main.ev(
    `[...document.querySelectorAll('[aria-label="Quick actions"] button')].find(b=>b.textContent.includes('Draft follow-up')).click()`
  )
  const hasEmailCard = () =>
    main.ev(
      `[...document.querySelectorAll('[data-testid=proposal] button')].some(b=>b.textContent.includes('Open in Gmail'))`
    )
  for (let i = 0; i < 40 && !(await hasEmailCard()); i++) await sleep(250)
  check(
    'follow-up becomes an email card (nothing sent)',
    await main.ev(
      `[...document.querySelectorAll('[data-testid=proposal] button')].some(b=>b.textContent.includes('Open in Gmail'))`
    )
  )
  await main.shot('05c-actions.png')
  // Scrolling up stays put while new messages arrive (regression: the view was dragged down)
  const scrollable = await main.ev(
    `(()=>{const s=document.querySelector('[data-testid=assistant-scroll]');return s.scrollHeight>s.clientHeight+100})()`
  )
  if (scrollable) {
    await main.ev(
      `(()=>{const s=document.querySelector('[data-testid=assistant-scroll]');s.scrollTop=0;s.dispatchEvent(new Event('scroll'))})()`
    )
    await sleep(300)
    await main.ev(`window.api.invoke('assistant:send',{text:'what is due today',mode:'quick'})`)
    await sleep(1500)
    check(
      'assistant never drags the view while messages arrive',
      await main.ev(
        `(()=>{const s=document.querySelector('[data-testid=assistant-scroll]');return s.scrollTop<40 && !document.querySelector('[data-testid=jump-latest]')})()`
      )
    )
  } else check('assistant history is long enough to scroll', false)
  await main.ev(
    `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Clear')?.click()`
  )
  await main.ev(`document.querySelector('button[aria-label^="Close Co-Pilot"]').click()`)
  await sleep(300)

  // weekly review + settings
  await main.ev(keydown('k', true))
  await sleep(300)
  await main.ev(setValue('input[aria-label="Search"]', 'weekly'))
  await sleep(300)
  await main.ev(`document.querySelector('[role=option]').click()`)
  await sleep(900)
  check(
    'weekly review page',
    (await text()).includes('Weekly Review') && (await text()).includes('tasks done')
  )
  await main.ev(`document.querySelector('button[aria-label=Settings]').click()`)
  await sleep(700)
  const s = await text()
  check(
    'settings has time zone, backup, diagnostics',
    ['Time Zone', 'Back Up My Notes', 'Copy Diagnostics'].every((x) => s.includes(x))
  )
  check(
    'settings has the Google private-script setup and health',
    (await text()).includes('private script') && (await text()).includes('Meeting notes')
  )
  check(
    'no one is asked to create a Google project or paste a client ID',
    !(await text()).includes('Client ID') &&
      !(await text()).includes('Google Cloud Console') &&
      (await main.ev(`!!document.querySelector('[data-testid=google-signin]')`))
  )
  const verify = await main.ev(
    `window.api.invoke('google:bridge-verify').then(r=>r.data && r.data.code)`
  )
  check(
    'bridge verify reports not-configured when unset',
    verify === 'not-configured',
    String(verify)
  )
  const script = await main.ev(
    `window.api.invoke('google:bridge-script').then(r=>r.data.script.includes('BRIDGE_VERSION') && !r.data.script.includes('__NOTE_MANAGER_TOKEN__'))`
  )
  check('copied script has the private key filled in', script === true)
  const chat = await main.ev(
    `window.api.invoke('chat:overview').then(r=>r.ok && Array.isArray(r.data.conversations) && r.data.source)`
  )
  check('chat overview works with nothing connected', chat === 'none', String(chat))
  await main.shot('06-settings.png')
  const tz = await main.ev(`window.api.invoke('settings:get').then(r=>r.data.timezone)`)
  check('time zone setting present', typeof tz === 'string' && tz.includes('/'), tz)
  const diag = await main.ev(`window.api.invoke('app:diagnostics').then(r=>r.data)`)
  check('diagnostics has no note text', diag.includes('Note Manager') && !diag.includes('firewall'))

  // the AI sparkle stays visible in both themes
  const sparkColors = async () =>
    main.ev(
      `(()=>{const st=getComputedStyle(document.documentElement);return [st.getPropertyValue('--spark-a').trim(),st.getPropertyValue('--spark-b').trim()].join('|')})()`
    )
  await main.ev(`window.api.invoke('app:set-theme',{mode:'light'})`)
  await sleep(600)
  await main.ev(
    `document.querySelector('button[aria-label="Co-Pilot (Ctrl+J)"]')?.scrollIntoView()`
  )
  await main.shot('08-sparkle-light.png')
  const lightSpark = await sparkColors()
  await main.ev(`window.api.invoke('app:set-theme',{mode:'dark'})`)
  await sleep(600)
  await main.shot('08-sparkle-dark.png')
  const darkSpark = await sparkColors()
  check(
    'the AI sparkle has its own colours for light and dark',
    lightSpark !== darkSpark && lightSpark.includes('#') && darkSpark.includes('#'),
    `${lightSpark} / ${darkSpark}`
  )
  await main.ev(`window.api.invoke('app:set-theme',{mode:'system'})`)

  // Private script: set up once, and every screen agrees it is connected (regression: "Not connected")
  const connState = () =>
    main.ev(`window.api.invoke('google:connection').then(r=>r.ok && r.data.state)`)
  check('before setup, Google reads "not set up"', (await connState()) === 'not-set-up')
  check(
    'sidebar says what is wrong instead of "Not connected"',
    await main.ev(
      `(()=>{const b=document.querySelector('[data-testid=google-status]');return !!b && b.textContent.includes('Google not set up')})()`
    )
  )
  await main.ev(`window.api.invoke('google:bridge-script')`)
  await main.ev(
    `window.api.invoke('google:bridge-configure',{url:'https://script.google.com/macros/s/AKfyE2EFAKE/exec'})`
  )
  const ver = await main.ev(`window.api.invoke('google:bridge-verify').then(r=>r.ok && r.data.ok)`)
  check('the script verifies', ver === true)
  // Another screen saving one Google option must not wipe the script address.
  await main.ev(`window.api.invoke('settings:update',{google:{meetNotes:false}})`)
  const kept = await main.ev(`window.api.invoke('settings:get').then(r=>r.data.google.bridgeUrl)`)
  check('saving one Google option keeps the script address', /AKfyE2EFAKE/.test(kept), kept)
  for (let i = 0; i < 40 && (await connState()) !== 'ok'; i++) await sleep(250)
  check('after setup, the connection is ok', (await connState()) === 'ok', await connState())
  await sleep(500)
  check(
    'sidebar and Settings agree it is connected',
    await main.ev(
      `(()=>{const b=document.querySelector('[data-testid=google-status]');const p=document.querySelector('[data-testid=google-connection]');return b.dataset.state==='ok' && /Synced/.test(b.textContent) && p && p.dataset.state==='ok' && !/Not connected/.test(document.querySelector('[data-testid=google-health]').textContent)})()`
    )
  )
  await main.ev(
    `[...document.querySelectorAll('[data-testid=google-connection] button')].find(b=>b.textContent.trim()==='Refresh Now').click()`
  )
  for (let i = 0; i < 40 && !/Refreshed:/.test(await text()); i++) await sleep(250)
  check('Refresh Now says what it did', /Refreshed: [0-9]+ meeting/.test(await text()))
  check(
    'the script was really called',
    scriptCalls.includes('calendar') && scriptCalls.includes('mail')
  )
  await main.ev(
    `document.querySelector('[data-testid=google-connection]').scrollIntoView({block:'center'})`
  )
  await main.shot('06b-google-connected.png')

  // Settings nav is a quiet list (no boxed chips) and follows the scroll
  check(
    'settings has a section list, not a box of tags',
    await main.ev(
      `(()=>{const n=[...document.querySelectorAll('nav[aria-label="Settings sections"]')];return n.length>0 && !!document.querySelector('nav[aria-label="Settings sections"] [aria-current=location]')})()`
    )
  )
  await main.ev(
    `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Back')?.click()`
  )
  await sleep(500)

  // Calendar works at every size: grid when wide, a list when narrow, one day when tiny
  await main.ev(`document.querySelector('button[aria-label=Tasks], button[title=Tasks]')?.click()`)
  await sleep(300)
  await main.ev(
    `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Calendar')?.click()`
  )
  await sleep(900)
  const calViews = []
  for (const w of [1280, 900, 700, 500]) {
    await main.send('Emulation.setDeviceMetricsOverride', {
      width: w,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false
    })
    const want = { 1280: 'month', 900: 'month', 700: 'agenda', 500: 'day' }[w]
    const viewNow = () =>
      main.ev(`document.querySelector('[data-testid=calendar]')?.dataset.view ?? 'none'`)
    for (let i = 0; i < 30 && (await viewNow()) !== want; i++) await sleep(200)
    calViews.push(await viewNow())
    await main.shot(`09-calendar-${w}.png`)
  }
  const overflow = await main.ev(
    `document.documentElement.scrollWidth > document.documentElement.clientWidth + 2`
  )
  check(
    'calendar adapts: month grid wide, list when narrow, a day when tiny',
    calViews[0] === 'month' && calViews.includes('agenda') && calViews[3] === 'day' && !overflow,
    calViews.join(',')
  )
  await main.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false
  })
  await sleep(500)

  // Back goes to where you just were
  await main.ev(
    `[...document.querySelectorAll('[role=navigation][aria-label=Tasks] button')].find(b=>b.textContent.trim().startsWith('Action Center'))?.click()`
  )
  await sleep(700)
  await main.ev(
    `[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith('NextMRO Weekly 1'))?.click() ?? document.querySelector('button[aria-label=Notes]').click()`
  )
  await sleep(500)
  await main.ev(`window.api.invoke('notes:list').then(()=>0)`)
  await main.ev(
    `(()=>{const b=[...document.querySelectorAll('nav button')].find(x=>x.innerText.includes('NextMRO Weekly 1'));b&&b.click()})()`
  )
  await sleep(900)
  const backText = await main.ev(
    `document.querySelector('[data-testid=nav-back]')?.textContent ?? ''`
  )
  await main.ev(`document.querySelector('[data-testid=nav-back]')?.click()`)
  await sleep(800)
  check(
    'Back returns to the previous screen',
    /Back to/.test(backText) && !(await main.ev(`!!document.querySelector('.cm-editor')`)),
    backText
  )
  await main.shot('10-back.png')
} catch (e) {
  console.log('ERROR', e.message)
  results.push(false)
} finally {
  child.kill()
  fake.close()
  fakeScript.close()
  const ok = results.length > 0 && results.every(Boolean)
  console.log(ok ? `ALL PASSED (${results.length})` : 'SOME FAILED')
  process.exit(ok ? 0 : 1)
}
