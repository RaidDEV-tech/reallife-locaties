/**
 * FutureRP Fisher — FiveM fishing macro (Electron main process)
 *  • Key-systeem   : server controleert key + apparaat (1 key = 1 pc), zie config.json -> serverUrl
 *  • Groene balk   : scant een gebied midden op het scherm; zodra groen verschijnt -> direct trekken
 *  • Input         : één persistente PowerShell-worker (snel, geen native deps)
 *  • Hotkeys       : F6 start/stop, F7 noodstop
 */
const { app, BrowserWindow, ipcMain, globalShortcut, desktopCapturer, dialog, shell } = require('electron')
const WebSocket = require('ws')
const { autoUpdater } = require('electron-updater')
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto')
const { spawn } = require('child_process')

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }
const CFG = readJson(path.join(__dirname, 'config.json'), {})
const DEF = { holdS: 4, releaseS: 2, pulls: 6, timeoutS: 40, regionW: 30, regionH: 8, regionY: 50, minPixels: 80, rodSlot: 1, baitSlot: 2, reactMs: 1000, ocrX: 0, ocrY: 55, ocrW: 35, ocrH: 20, tensionWord: 'spanning', autoEat: true, eatEveryMin: 35, eatCount: 5, drinkCount: 5, eatSlot: 5, drinkSlot: 4 }

let win, running = false, testing = false, licensed = false
let S = { ...DEF }, saved = { key: '', settings: {} }
const storeFile = () => path.join(app.getPath('userData'), 'autofish.json')
const persist = () => { try { fs.writeFileSync(storeFile(), JSON.stringify(saved)) } catch {} }
const emit = (c, d) => { if (win && !win.isDestroyed()) win.webContents.send(c, d) }
const log = (m) => { console.log('[AutoFish]', m); emit('log', m) }
const nap = (ms) => new Promise(r => setTimeout(r, ms))
async function wait(ms) { const end = Date.now() + ms; while (running && Date.now() < end) await nap(Math.max(1, Math.min(50, end - Date.now()))) }

// ─── Key-systeem: server controleert key + 1 apparaat per key ─────────────────
const SERVER = (CFG.serverUrl || 'http://localhost:3000').replace(/\/$/, '')
let HWID = ''
async function getHwid() {
  if (HWID) return HWID
  const raw = await new Promise(r => require('child_process').execFile('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_ComputerSystemProduct).UUID'], { windowsHide: true }, (e, o) => r(e ? '' : String(o).trim())))
  HWID = crypto.createHash('sha256').update(raw + '|' + os.hostname() + '|' + os.cpus()[0].model).digest('hex')
  return HWID
}
const api = async (p, body, tok) => {
  try {
    const r = await fetch(SERVER + p, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-token': tok || '' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(6000) })
    return await r.json()
  } catch { return { ok: false, offline: true, msg: 'Server niet bereikbaar' } }
}
async function checkKey(key) {
  const r = await api('/api/activate', { key: String(key).trim().toUpperCase(), hwid: await getHwid() })
  return { ...r, online: !r.offline }
}

// ─── PowerShell worker: toetsen, muis, schermscan ────────────────────────────
const PS = `
Add-Type -ReferencedAssemblies System.Drawing,System.Windows.Forms -TypeDefinition @"
using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.Windows.Forms;
public class W {
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern void mouse_event(int f, int x, int y, int d, int e);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte sc, int f, int e);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  public static void Ev(byte sc, int f) { keybd_event(0, sc, f, 0); }
  public static void Click(int px, int py) { Rectangle b = Screen.PrimaryScreen.Bounds; SetCursorPos(b.X + b.Width * px / 1000, b.Y + b.Height * py / 1000); System.Threading.Thread.Sleep(40); mouse_event(2, 0, 0, 0, 0); System.Threading.Thread.Sleep(50); mouse_event(4, 0, 0, 0, 0); }
  public static void Init() { SetProcessDPIAware(); }
  public static void Move(int dx, int dy) { mouse_event(1, dx, dy, 0, 0); }
  public static void Mouse(bool down) { mouse_event(down ? 2 : 4, 0, 0, 0, 0); }
  public static void Key(byte sc) { keybd_event(0, sc, 8, 0); System.Threading.Thread.Sleep(70); keybd_event(0, sc, 10, 0); }
  public static void Cap(string path, int xp, int yp, int wp, int hp) {
    Rectangle b = Screen.PrimaryScreen.Bounds;
    int x = b.X + b.Width * xp / 100, y = b.Y + b.Height * yp / 100, w = Math.Max(20, b.Width * wp / 100), h = Math.Max(10, b.Height * hp / 100);
    using (Bitmap bmp = new Bitmap(w * 2, h * 2)) { using (Graphics g = Graphics.FromImage(bmp)) { g.CopyFromScreen(x, y, 0, 0, new Size(w, h)); } bmp.Save(path, ImageFormat.Png); }
  }
  public static int Scan(int rw, int rh, int cy, bool red) {
    Rectangle b = Screen.PrimaryScreen.Bounds;
    int w = Math.Max(4, b.Width * rw / 100), h = Math.Max(2, b.Height * rh / 100);
    int x = b.X + (b.Width - w) / 2, y = b.Y + b.Height * cy / 100 - h / 2;
    using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
      using (Graphics g = Graphics.FromImage(bmp)) g.CopyFromScreen(x, y, 0, 0, new Size(w, h));
      BitmapData d = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      byte[] px = new byte[d.Stride * h]; Marshal.Copy(d.Scan0, px, 0, px.Length); bmp.UnlockBits(d);
      int n = 0;
      for (int i = 0; i + 3 < px.Length; i += 4) { int B = px[i], G = px[i + 1], R = px[i + 2]; if (red ? (R > 170 && R > G + 80 && R > B + 80) : (G > 140 && G > R + 60 && G > B + 60)) n++; }
      return n;
    }
  }
}
"@

[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime] | Out-Null
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | ? { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Aw($op, $t) { $n = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $n.Wait(-1) | Out-Null; $n.Result }
$eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
function Ocr($p) {
  try {
    $f = Aw ([Windows.Storage.StorageFile]::GetFileFromPathAsync($p)) ([Windows.Storage.StorageFile])
    $s = Aw ($f.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $d = Aw ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($s)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $b = Aw ($d.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $r = Aw ($eng.RecognizeAsync($b)) ([Windows.Media.Ocr.OcrResult])
    ($r.Text -replace '\s+', ' ')
  } catch { '' }
}
[W]::Init()
[Console]::Out.WriteLine('R'); [Console]::Out.Flush()
while (($l = [Console]::In.ReadLine()) -ne $null) {
  $p = $l.Split(' ')
  switch ($p[0]) {
    'M' { [W]::Move([int]$p[1], [int]$p[2]) }
    'O' { $f = Join-Path $env:TEMP 'rl-ocr.png'; [W]::Cap($f, [int]$p[1], [int]$p[2], [int]$p[3], [int]$p[4]); [Console]::Out.WriteLine('O ' + (Ocr $f)); [Console]::Out.Flush() }
    'D' { [W]::Mouse($true) }
    'U' { [W]::Mouse($false) }
    'E' { [W]::Ev([byte]$p[2], [int]$p[1]) }
    'C' { [W]::Click([int]$p[1], [int]$p[2]) }
    'K' { [W]::Key([byte]$p[1]) }
    'S' { [Console]::Out.WriteLine('S ' + [W]::Scan([int]$p[1], [int]$p[2], [int]$p[3], $false)); [Console]::Out.Flush() }
    'T' { [Console]::Out.WriteLine('S ' + [W]::Scan([int]$p[1], [int]$p[2], [int]$p[3], $true)); [Console]::Out.Flush() }
  }
}
`
let worker = null, ready = null, pending = null, pendingO = null
function ensureWorker() {
  if (ready) return ready
  ready = new Promise((res, rej) => {
    const f = path.join(os.tmpdir(), 'autofish-worker.ps1')
    fs.writeFileSync(f, PS)
    worker = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f], { windowsHide: true })
    let buf = ''
    worker.stdout.on('data', (d) => {
      buf += d; let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
        if (l === 'R') res()
        else if (l.startsWith('O ') && pendingO) { const p = pendingO; pendingO = null; p(l.slice(2)) }
        else if (l.startsWith('S ') && pending) { const p = pending; pending = null; p(+l.slice(2)) }
      }
    })
    worker.on('error', rej)
    worker.on('exit', () => { worker = null; ready = null })
  })
  return ready
}
const send = (c) => { if (worker) worker.stdin.write(c + '\n') }
const scan = (red) => new Promise(r => {
  pending = r; send(`${red ? 'T' : 'S'} ${S.regionW} ${S.regionH} ${S.regionY}`)
  setTimeout(() => { if (pending === r) { pending = null; r(0) } }, 2500)
})
// OCR van het meldingsgebied (standaard linksonder) — leest bv. "Veel spanning: laat de muisknop even los!"
const ocr = () => new Promise(r => {
  pendingO = r; send(`O ${S.ocrX} ${S.ocrY} ${S.ocrW} ${S.ocrH}`)
  setTimeout(() => { if (pendingO === r) { pendingO = null; r('') } }, 2500)
})
const key = (sc) => send('K ' + sc)           // scancode: 1 = 0x02, 2 = 0x03
const click = async () => { send('D'); await nap(80); send('U') }

// ─── Visserslogica ───────────────────────────────────────────────────────────
let lastEat = Date.now()
async function eat() {
  if (!S.autoEat || Date.now() - lastEat < S.eatEveryMin * 60000) return
  log('Tijd om te eten en drinken'); lastEat = Date.now()
  for (const [slot, n] of [[S.eatSlot, S.eatCount], [S.drinkSlot, S.drinkCount]])
    for (let i = 0; i < n && running; i++) { key(1 + slot); await wait(600); await click(); await wait(S.eatDelayMs || 7600) }
}
async function cycle() {
  await eat(); if (!running) return
  log('Aas op de haak (' + S.baitSlot + ')');   key(1 + S.baitSlot); await wait(600)
  log('Hengel pakken (' + S.rodSlot + ')');    key(1 + S.rodSlot); await wait(800)
  log('Uitwerpen');            await click(); await wait(500)
  if (!running) return

  log('Wachten op groene balk…')
  const t0 = Date.now(); let hits = 0
  while (running && Date.now() - t0 < S.timeoutS * 1000) {
    const n = await scan(); emit('meter', n)
    if (n >= S.minPixels) { if (++hits >= 2) break } else hits = 0   // 2x na elkaar = geen vals alarm
    await nap(30)
  }
  if (!running) return
  if (hits < 2) { log('Geen balk gezien, opnieuw proberen'); return }

  log('Sla aan! Direct binnentrekken…'); await wait(S.reactMs)
  for (let i = 1; i <= S.pulls && running; i++) {
    log(`Trek ${i}/${S.pulls}`); send('D')
    // vasthouden; zodra de melding 'spanning' linksonder verschijnt: muisknop even los
    const t1 = Date.now()
    while (running && Date.now() - t1 < S.holdS * 1000) {
      if ((await ocr()).toLowerCase().includes(String(S.tensionWord).toLowerCase())) { send('U'); log('Hoge spanning, even loslaten'); await wait(450); send('D') }
      await nap(40)
    }
    send('U'); if (i < S.pulls) await wait(S.releaseS * 1000)
  }
  if (running) { log('Vis gevangen ✔'); emit('caught', 1) }
}
async function run() {
  try { await ensureWorker() } catch (e) { log('PowerShell fout: ' + e.message); running = false; emit('state', 'stopped'); return }
  emit('state', 'running'); log('Macro gestart')
  while (running) { await cycle(); await wait(300) }
  send('U'); emit('state', 'stopped'); log('Macro gestopt')
}
function start() {
  if (running || testing) return
  if (!licensed) { log('Geen geldige key'); emit('locked', ''); return }
  running = true; lastEat = Date.now(); run()
}
function stop() { running = false; testing = false; send('U') }
async function test() {
  if (running || !licensed) return
  if (testing) { testing = false; return }
  try { await ensureWorker() } catch { return }
  testing = true; emit('state', 'testing')
  while (testing) { emit('meter', await scan()); await nap(80) }
  emit('meter', 0); emit('state', 'stopped')
}
const toggle = () => (running ? stop() : start())
async function fastQuit() { await ensureWorker(); await tap('f8'); await nap(500); await typeText('quit'); await nap(150); await tap('enter') }

// ─── IPC ─────────────────────────────────────────────────────────────────────
// ─── Discord-koppeling + dashboard-sync ──────────────────────────────────────
async function pullSettings() {
  if (!saved.token) return
  const m = await api('/api/me', null, saved.token)
  if (m && m.ok && m.sUpdated > (saved.sUpdated || 0)) { S = { ...DEF, ...m.settings }; saved.settings = S; saved.sUpdated = m.sUpdated; persist(); emit('settings', S) }
}
const pushSettings = () => saved.token && api('/api/settings', { settings: S }, saved.token).then(r => { if (r.ok) { saved.sUpdated = r.sUpdated; persist() } })
async function linkDiscord() {
  const r = await api('/api/link/start', { key: saved.key, hwid: await getHwid() })
  if (!r.ok) return r
  shell.openExternal(r.url)
  for (let i = 0; i < 100; i++) {                       // max ~5 min wachten op bevestiging
    await nap(3000)
    const p = await api('/api/link/poll?id=' + r.id)
    if (p.ok) { saved.token = p.token; persist(); await pullSettings(); return { ok: true } }
  }
  return { ok: false, msg: 'Koppelen duurde te lang, probeer opnieuw' }
}
ipcMain.handle('link', linkDiscord)
ipcMain.handle('dashboard', () => { shell.openExternal(SERVER + '/dashboard.html') })
setInterval(pullSettings, 20000)
ipcMain.handle('init', async () => {
  saved = readJson(storeFile(), saved); S = { ...DEF, ...saved.settings }
  let info = null
  if (saved.key) { const r = await checkKey(saved.key); licensed = r.ok; info = r.ok ? r : null; if (r.token) { saved.token = r.token; persist() } }
  return { licensed, info, settings: S, linked: !!saved.token }
})
ipcMain.handle('activate', async (_e, k) => {
  const r = await checkKey(k)
  if (r.ok) { licensed = true; saved.key = String(k).trim().toUpperCase(); if (r.token) saved.token = r.token; persist() }
  return { ...r, linked: !!saved.token }
})
ipcMain.on('set', (_e, s) => { S = { ...S, ...s }; saved.settings = S; persist(); pushSettings() })
ipcMain.on('fastquit', () => fastQuit()); ipcMain.on('start', start); ipcMain.on('stop', stop); ipcMain.on('test', test)
ipcMain.on('win', (_e, a) => { if (!win) return; a === 'min' ? win.minimize() : win.close() })

// Key opnieuw controleren (ingetrokken key stopt de macro) — alleen als online
setInterval(async () => {
  if (!licensed || !saved.key) return
  const r = await checkKey(saved.key)
  if (!r.ok && r.online) { licensed = false; stop(); emit('locked', r.msg) }
}, 15 * 60 * 1000)

// ─── Afstandsbediening: alleen je EIGEN pc, uit tot jij het aanzet, koppelcode ─
const SC = {}
'1234567890'.split('').forEach((c, i) => SC[c] = [2 + i, 0])
;[['qwertyuiop', 0x10], ['asdfghjkl', 0x1E], ['zxcvbnm', 0x2C]].forEach(([r, b]) => r.split('').forEach((c, i) => SC[c] = [b + i, 0]))
for (let i = 1; i <= 10; i++) SC['f' + i] = [0x3A + i, 0]
Object.assign(SC, { f11: [0x57, 0], f12: [0x58, 0], enter: [0x1C, 0], escape: [1, 0], esc: [1, 0], space: [0x39, 0], ' ': [0x39, 0], tab: [0x0F, 0], backspace: [0x0E, 0], shift: [0x2A, 0], ctrl: [0x1D, 0], up: [0x48, 1], left: [0x4B, 1], right: [0x4D, 1], down: [0x50, 1] })
const ev = (n, up) => { const e = SC[String(n).toLowerCase()]; if (e) send(`E ${(up ? 10 : 8) | e[1]} ${e[0]}`) }
const tap = async (n) => { ev(n); await nap(60); ev(n, true); await nap(40) }
const typeText = async (t) => { for (const c of String(t).slice(0, 60)) await tap(c) }
let held = {}, rws = null, rtimer = null, camV = [0, 0]
setInterval(() => { if (rws && (camV[0] || camV[1])) send(`M ${Math.round(camV[0] * 25)} ${Math.round(camV[1] * 25)}`) }, 16)
function joy(x, y) {
  const want = { w: y < -.35, s: y > .35, a: x < -.35, d: x > .35 }
  for (const k in want) if (!!held[k] !== want[k]) { ev(k, !want[k]); held[k] = want[k] }
}
async function remoteMsg(m) {
  if (m.t === 'key') await tap(m.k)
  else if (m.t === 'text') await typeText(m.s)
  else if (m.t === 'click') send(`C ${Math.round(m.x * 1000)} ${Math.round(m.y * 1000)}`)
  else if (m.t === 'joy') joy(+m.x || 0, +m.y || 0)
  else if (m.t === 'cam') { camV = [+m.x || 0, +m.y || 0] }
  else if (m.t === 'macro' && m.n === 'quit') await fastQuit()
}
async function frame() {
  if (!rws || rws.readyState !== 1) return
  const s = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 } })
  if (s[0]) rws.send(s[0].thumbnail.toJPEG(55))
}
async function startRemote() {
  if (!licensed) return { on: false }
  const c = await dialog.showMessageBox(win, { type: 'warning', title: 'Toestemming voor remote toegang', message: 'Hiermee kan jouw gekoppelde telefoon je scherm zien en toetsenbord/muis bedienen.', detail: 'Zet dit alleen aan op je eigen pc. Stoppen kan altijd met de knop in de loader of Ctrl+Shift+F12.', buttons: ['Ja', 'Nee'], defaultId: 1, cancelId: 1 })
  if (c.response !== 0) return { on: false }
  await ensureWorker()
  const code = String(crypto.randomInt(100000, 1000000))
  rws = new WebSocket(SERVER.replace(/^http/, 'ws') + '/ws')
  rws.on('open', async () => rws.send(JSON.stringify({ role: 'host', code, key: saved.key, hwid: await getHwid() })))
  rws.on('message', (d, bin) => {
    if (bin) return
    let m; try { m = JSON.parse(d) } catch { return }
    if (m.t === 'viewer') { clearInterval(rtimer); if (m.on) rtimer = setInterval(frame, 70); else { joy(0, 0); camV = [0, 0] } emit('remote', { on: true, code, viewer: m.on }) }
    else remoteMsg(m)
  })
  rws.on('close', () => { clearInterval(rtimer); joy(0, 0); rws = null; emit('remote', { on: false }) })
  emit('remote', { on: true, code, viewer: false }); return { on: true, code }
}
ipcMain.handle('remote', async () => (rws ? (rws.close(), { on: false }) : startRemote()))

// ─── Admin (wachtwoord wordt op de SERVER gecontroleerd, niet in de app) ──────
let adminTok = ''
ipcMain.handle('adminLogin', async (_e, pw) => { const r = await api('/api/admin/login', { password: pw }); if (r.ok) adminTok = r.token; return { ok: !!r.ok, msg: r.msg } })
ipcMain.handle('admin', (_e, p, body) => api(p, body, adminTok))

// ─── Automatische updates via GitHub Releases ────────────────────────────────
function configureAutoUpdates() {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-available', (i) => log(`Update ${i.version} gevonden, downloaden…`))
  autoUpdater.on('error', (e) => log('Update-check mislukt: ' + e.message))
  autoUpdater.on('update-downloaded', async (i) => {
    const r = await dialog.showMessageBox(win, { type: 'info', title: 'Update klaar', message: `FutureRP Fisher ${i.version} is klaar om te installeren.`, detail: 'Herstart nu, of de update wordt geïnstalleerd zodra je de app sluit.', buttons: ['Nu herstarten', 'Later'], defaultId: 0, cancelId: 1 })
    if (r.response === 0) autoUpdater.quitAndInstall()
  })
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000)
}

// ─── Venster & lifecycle ─────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1000, height: 660, resizable: false, frame: false, backgroundColor: '#0a1020',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  })
  win.loadFile(path.join(__dirname, 'src', 'index.html'))
  win.on('closed', () => { stop(); win = null })
}
app.whenReady().then(() => {
  createWindow()
  configureAutoUpdates()
  globalShortcut.register('F6', toggle)
  globalShortcut.register('Control+Shift+F12', () => { if (rws) rws.close(); log('Remote noodstop') })
  globalShortcut.register('F7', () => { log('F7 noodstop'); stop() })
})
app.on('window-all-closed', () => { globalShortcut.unregisterAll(); stop(); if (rws) rws.close(); if (worker) worker.kill(); app.quit() })
