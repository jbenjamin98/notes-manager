/**
 * Regenerates the app icons from scripts/icon/*.svg. Run with Electron (it does the drawing):
 *   env -u ELECTRON_RUN_AS_NODE npx electron scripts/make-icons.cjs
 * Writes build/icon.png, build/icon.ico (16-256 px), resources/icon.png and resources/tray16/32.png.
 * Everything keeps a transparent background, so no white corners.
 */
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const root = path.resolve(__dirname, '..')

const render = async (svgFile, size) => {
  const svg = fs.readFileSync(path.join(__dirname, 'icon', svgFile), 'utf8')
  const win = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: false }
  })
  const html = `<!doctype html><body style="margin:0;background:transparent;overflow:hidden">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`
  const tmp = path.join(require('os').tmpdir(), `nm-icon-${size}-${Date.now()}.html`)
  fs.writeFileSync(tmp, html)
  await win.loadFile(tmp)
  fs.rmSync(tmp, { force: true })
  await new Promise((r) => setTimeout(r, 250))
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })
  win.destroy()
  return img
}

/** A Windows .ico holding PNG images (supported since Vista). */
const ico = (pngs) => {
  const n = pngs.length
  const head = Buffer.alloc(6 + 16 * n)
  head.writeUInt16LE(0, 0)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(n, 4)
  let offset = head.length
  pngs.forEach(({ size, buf }, i) => {
    const o = 6 + 16 * i
    head.writeUInt8(size >= 256 ? 0 : size, o)
    head.writeUInt8(size >= 256 ? 0 : size, o + 1)
    head.writeUInt8(0, o + 2)
    head.writeUInt8(0, o + 3)
    head.writeUInt16LE(1, o + 4)
    head.writeUInt16LE(32, o + 6)
    head.writeUInt32LE(buf.length, o + 8)
    head.writeUInt32LE(offset, o + 12)
    offset += buf.length
  })
  return Buffer.concat([head, ...pngs.map((p) => p.buf)])
}

app.on('window-all-closed', () => {}) // keep running between renders
app.whenReady().then(async () => {
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const big = await render('icon.svg', 1024)
  fs.writeFileSync(path.join(root, 'build/icon.png'), big.toPNG())
  fs.writeFileSync(path.join(root, 'resources/icon.png'), (await render('icon.svg', 512)).toPNG())
  const pngs = []
  for (const s of sizes) pngs.push({ size: s, buf: (await render(s <= 32 ? 'tray.svg' : 'icon.svg', s)).toPNG() })
  fs.writeFileSync(path.join(root, 'build/icon.ico'), ico(pngs))
  for (const v of ['dark', 'light'])
    for (const s of [16, 32])
      fs.writeFileSync(path.join(root, `resources/tray-${v}${s}.png`), (await render(`tray-${v}.svg`, s)).toPNG())
  // report the corner pixel's transparency so a regression is obvious
  const bm = big.toBitmap()
  console.log('corner alpha (0 = transparent):', bm[3])
  app.quit()
})
