/*
 * Draws the installer's artwork (a night sky of connected stars, matching the app's constellation
 * chart) into build/*.bmp. Run with: npm run art:installer
 * It renders HTML in a hidden Electron window and saves the pictures as the 24-bit BMPs that the
 * NSIS installer needs, so no image tools are required.
 */
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync, mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const ROOT = resolve(__dirname, '..')
const ICON =
  'data:image/png;base64,' +
  require('node:fs')
    .readFileSync(join(ROOT, 'build', 'icon.png'))
    .toString('base64')

const page = (w, h, seed, body) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:#0b0d24;font-family:"Segoe UI",system-ui,sans-serif}
  .sky{position:absolute;inset:0;background:
    radial-gradient(120% 70% at 20% 0%, #4b3bb0 0%, rgba(75,59,176,0) 60%),
    radial-gradient(90% 60% at 100% 100%, #0e7490 0%, rgba(14,116,144,0) 62%),
    linear-gradient(180deg,#14163f 0%,#0b0d24 100%)}
  canvas{position:absolute;inset:0}
  .t{position:absolute;color:#fff}
</style></head><body><div class="sky"></div><canvas id="c" width="${w}" height="${h}"></canvas>${body}
<script>
  let s=${seed}; const rnd=()=>{s=(s*1664525+1013904223)>>>0;return s/4294967296}
  const c=document.getElementById('c').getContext('2d'); const W=${w},H=${h}
  const pts=[]; const n=Math.round(W*H/1500)
  for(let i=0;i<n;i++)pts.push({x:rnd()*W,y:rnd()*H,r:rnd()<.12?1.6+rnd()*1.4:.5+rnd()*.8})
  // Constellation lines between near neighbours of the brighter stars.
  const big=pts.filter(p=>p.r>1.5)
  c.lineWidth=.8
  for(const a of big)for(const b of big){const d=Math.hypot(a.x-b.x,a.y-b.y);if(a!==b&&d<${Math.round(Math.min(w, h) * 0.7)}&&a.x<b.x){
    c.strokeStyle='rgba(167,180,255,'+(.5-d/${Math.round(Math.min(w, h) * 1.8)})+')';c.beginPath();c.moveTo(a.x,a.y);c.lineTo(b.x,b.y);c.stroke()}}
  for(const p of pts){
    const g=c.createRadialGradient(p.x,p.y,0,p.x,p.y,p.r*(p.r>1.5?6:3))
    g.addColorStop(0,'rgba(255,255,255,'+(p.r>1.5?1:.8)+')');g.addColorStop(.25,'rgba(190,200,255,.55)');g.addColorStop(1,'rgba(190,200,255,0)')
    c.fillStyle=g;c.beginPath();c.arc(p.x,p.y,p.r*(p.r>1.5?6:3),0,7);c.fill()
  }
</script></body></html>`

const sidebar = `
  <img class="t" src="${ICON}" style="left:42px;top:34px;width:80px;height:80px;filter:drop-shadow(0 0 14px rgba(140,160,255,.9))">
  <div class="t" style="left:0;right:0;top:128px;text-align:center;font-size:19px;font-weight:700;letter-spacing:.3px">Note Manager</div>
  <div class="t" style="left:14px;right:14px;top:158px;text-align:center;font-size:11px;line-height:1.45;color:#c7d0ff">Every note,<br>every name,<br>one constellation.</div>
  <div class="t" style="left:0;right:0;bottom:16px;text-align:center;font-size:9.5px;color:#8f9bdc;letter-spacing:1.4px">LOCAL · PRIVATE · YOURS</div>`

const header = `
  <img class="t" src="${ICON}" style="right:12px;top:8px;width:41px;height:41px;filter:drop-shadow(0 0 8px rgba(140,160,255,.9))">`

function bmp24(img, w, h) {
  const bgra = img.resize({ width: w, height: h, quality: 'best' }).toBitmap()
  const row = Math.ceil((w * 3) / 4) * 4
  const out = Buffer.alloc(54 + row * h)
  out.write('BM')
  out.writeUInt32LE(out.length, 2)
  out.writeUInt32LE(54, 10)
  out.writeUInt32LE(40, 14)
  out.writeInt32LE(w, 18)
  out.writeInt32LE(h, 22)
  out.writeUInt16LE(1, 26)
  out.writeUInt16LE(24, 28)
  out.writeUInt32LE(row * h, 34)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4
      const d = 54 + (h - 1 - y) * row + x * 3
      out[d] = bgra[s]
      out[d + 1] = bgra[s + 1]
      out[d + 2] = bgra[s + 2]
    }
  return out
}

let win
async function render(name, w, h, seed, body) {
  win ??= new BrowserWindow({
    show: false,
    width: 400,
    height: 400,
    useContentSize: true,
    webPreferences: { offscreen: true }
  })
  win.setContentSize(w, h)
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page(w, h, seed, body)))
  await new Promise((r) => setTimeout(r, 400))
  const img = await win.webContents.capturePage()
  writeFileSync(join(ROOT, 'build', `${name}.bmp`), bmp24(img, w, h))
  if (process.env.ART_PREVIEW)
    writeFileSync(join(process.env.ART_PREVIEW, `${name}.png`), img.toPNG())
}

app.setPath('userData', mkdtempSync(join(tmpdir(), 'nm-art-data-')))
app.disableHardwareAcceleration()
app
  .whenReady()
  .then(async () => {
    await render('installerSidebar', 164, 314, 7, sidebar)
    await render('uninstallerSidebar', 164, 314, 21, sidebar)
    await render('installerHeader', 150, 57, 3, header)
    app.quit()
  })
  .catch((e) => {
    console.error(e)
    app.exit(1)
  })
