// Release builds for colleagues must carry the company's Google sign-in client, or everyone would
// be left with the private-script setup. Fails the build with a clear message when it is missing.
// `npm run build:win:script-only` builds without it on purpose (personal builds).
const { existsSync, readFileSync } = require('fs')
const { resolve } = require('path')

const allow = process.argv.includes('--allow-missing')
const file = resolve(__dirname, '..', 'build', 'google-client.json')
let id = ''
if (existsSync(file)) {
  try {
    id = (JSON.parse(readFileSync(file, 'utf8')).clientId || '').trim()
  } catch (e) {
    console.error(`build/google-client.json is not valid JSON: ${e.message}`)
    process.exit(1)
  }
}
const ok = /^[\w-]+\.apps\.googleusercontent\.com$/.test(id)
if (ok) {
  console.log(`Google sign-in: built in (${id.slice(0, 12)}…)`)
  process.exit(0)
}
if (allow) {
  console.log('Google sign-in: not built in (script-only build). People will use the private script.')
  process.exit(0)
}
console.error(
  [
    '',
    'This release build has no Google sign-in client.',
    '  Put the client IT created in build/google-client.json:',
    '    { "clientId": "1234-abc.apps.googleusercontent.com", "clientSecret": "GOCSPX-..." }',
    '  (see docs/IT-GOOGLE-SIGN-IN.md), or build without it on purpose:',
    '    npm run build:win:script-only',
    ''
  ].join('\n')
)
process.exit(1)
