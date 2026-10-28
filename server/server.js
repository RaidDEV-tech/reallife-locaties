// Reallife Locaties — server: keys (duur + 1 pc), Discord-koppeling, dashboard-API, admin, remote-relay
const express = require('express'), http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto')
const { WebSocketServer } = require('ws')
const E = process.env
const CFG = { port: E.PORT || 3000, admin: E.ADMIN_PASSWORD, base: (E.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''), adminKeys: (E.ADMIN_KEYS || '').split(',').map(x => x.trim()).filter(Boolean), cid: E.DISCORD_CLIENT_ID, secret: E.DISCORD_CLIENT_SECRET }
if (!CFG.admin) { console.error('Zet ADMIN_PASSWORD'); process.exit(1) }
const DBF = E.DATA_FILE || path.join(__dirname, 'data.json')
let db = {}; try { if (fs.existsSync(DBF)) db = JSON.parse(fs.readFileSync(DBF, 'utf8')) } catch (e) { console.error('Lezen mislukt:', e.message) }
db.keys ||= []; db.users ||= {}; db.sessions ||= {}
const save = () => { try { fs.writeFileSync(DBF, JSON.stringify(db, null, 2)) } catch (e) { console.error('Opslaan mislukt:', e.message) } }
const rnd = (n = 24) => crypto.randomBytes(n).toString('hex')
const app = express(); app.set('trust proxy', 1); app.use(express.json())
const PUB = path.join(__dirname, '..', 'website')
app.use(express.static(PUB))
app.get('/remote', (q, r) => r.sendFile(path.join(__dirname, 'remote.html')))
app.get('/admin', (q, r) => r.sendFile(path.join(__dirname, 'admin.html')))
app.get('/dashboard', (q, r) => r.sendFile(path.join(PUB, 'dashboard.html')))

// ── Keys ──
const find = (k) => db.keys.find(x => x.key === String(k || '').trim().toUpperCase())
function verify(key, hwid) {
  const e = find(key)
  if (!e) return { ok: false, msg: 'Ongeldige key' }
  if (e.banned) return { ok: false, msg: 'Deze key is geblokkeerd' }
  if (e.expires && Date.parse(e.expires) < Date.now()) return { ok: false, msg: 'Key is verlopen' }
  if (!hwid || String(hwid).length < 32) return { ok: false, msg: 'Ongeldig apparaat' }
  if (!e.hwid) { e.hwid = hwid; e.activated = new Date().toISOString(); if (e.days && !e.expires) e.expires = new Date(Date.now() + e.days * 864e5).toISOString(); save() }
  else if (e.hwid !== hwid) return { ok: false, msg: 'Key is al in gebruik op een ander apparaat' }
  return { ok: true, plan: e.plan, expires: e.expires, linked: !!(e.discord || e.nolink), e }
}
const pub = ({ e, ...r }) => r
app.post('/api/activate', (q, r) => {
  const v = verify(q.body.key, q.body.hwid); if (!v.ok) return r.json(v)
  // al gekoppeld aan Discord? dan direct een sessie-token teruggeven (geen login nodig)
  const out = pub(v), e = v.e
  if (e.discord || e.nolink) {  // gekoppeld, of een speciale key zonder Discord
    const uid = e.discord || 'key:' + e.key
    db.users[uid] ||= { id: uid, name: 'Directe key', settings: {}, sUpdated: 0 }
    out.token = session(uid, 'app')
  }
  r.json(out)
})

// ── Discord-koppeling ──
const links = new Map()  // linkId -> { key, done, token }
const session = (uid, kind) => { const t = rnd(); db.sessions[t] = { uid, kind, t: Date.now() }; save(); return t }
const cookie = (q) => Object.fromEntries((q.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(x => x[1]))
const me = (q) => { const t = q.headers['x-token'] || cookie(q).rl; const s = db.sessions[t]; return s && db.users[s.uid] ? db.users[s.uid] : null }
app.post('/api/link/start', (q, r) => {
  const v = verify(q.body.key, q.body.hwid); if (!v.ok) return r.json(v)
  if (!CFG.cid) return r.json({ ok: false, msg: 'Discord niet ingesteld op server' })
  const id = rnd(12); links.set(id, { key: v.e.key }); setTimeout(() => links.delete(id), 6e5)
  r.json({ ok: true, id, url: CFG.base + '/auth/discord?state=' + id })
})
app.get('/api/link/poll', (q, r) => { const l = links.get(q.query.id); r.json(l && l.token ? { ok: true, token: l.token } : { ok: false }) })
app.get('/auth/discord', (q, r) => r.redirect('https://discord.com/oauth2/authorize?' + new URLSearchParams({ client_id: CFG.cid, redirect_uri: CFG.base + '/auth/discord/callback', response_type: 'code', scope: 'identify', state: q.query.state || 'web' })))
app.get('/auth/discord/callback', async (q, r) => {
  try {
    const UA = { 'User-Agent': 'DiscordBot (' + CFG.base + ', 1.0)' }
    const dj = async (url, opt) => { const x = await fetch(url, opt), t = await x.text(); try { return JSON.parse(t) } catch { throw new Error('Discord gaf geen JSON (status ' + x.status + '): ' + t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 160)) } }
    const tk = await dj('https://discord.com/api/oauth2/token', { method: 'POST', headers: { ...UA, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: CFG.cid, client_secret: CFG.secret, grant_type: 'authorization_code', code: q.query.code, redirect_uri: CFG.base + '/auth/discord/callback' }) })
    if (!tk.access_token) throw new Error('Discord weigert de code: ' + (tk.error_description || tk.error || JSON.stringify(tk)))
    const d = await dj('https://discord.com/api/users/@me', { headers: { ...UA, authorization: 'Bearer ' + tk.access_token } })
    if (!tk.access_token) throw new Error('Discord weigert de code: ' + (tk.error_description || tk.error || JSON.stringify(tk)))
    if (!d.id) throw new Error('Geen gebruiker ontvangen van Discord')
    const u = db.users[d.id] ||= { id: d.id, settings: {}, sUpdated: 0 }; u.name = d.global_name || d.username; u.avatar = d.avatar
    const l = links.get(q.query.state)
    if (l) { const e = find(l.key); if (e) e.discord = d.id; l.token = session(d.id, 'app') }
    else if (!db.keys.some(k => k.discord === d.id)) { save(); return r.status(403).send('Geen licentie gekoppeld aan dit Discord-account. Activeer eerst een key in de loader.') }
    const t = session(d.id, 'web'); save()
    r.setHeader('Set-Cookie', `rl=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`); r.redirect('/dashboard.html')
  } catch (e) { console.error('Discord callback:', e); r.status(400).send('Discord-login mislukt: ' + (e && e.message || e)) }
})

// ── Dashboard-API (web + app) ──
app.get('/api/me', (q, r) => {
  const u = me(q); if (!u) return r.status(401).json({ ok: false })
  r.json({ ok: true, name: u.name, id: u.id, avatar: u.avatar, settings: u.settings, sUpdated: u.sUpdated, keys: db.keys.filter(k => k.discord === u.id).map(k => ({ plan: k.plan, expires: k.expires, banned: k.banned, pc: !!k.hwid })) })
})
app.post('/api/settings', (q, r) => { const u = me(q); if (!u) return r.status(401).json({ ok: false }); u.settings = q.body.settings || {}; u.sUpdated = Date.now(); save(); r.json({ ok: true, sUpdated: u.sUpdated }) })
app.post('/api/logout', (q, r) => { delete db.sessions[cookie(q).rl]; save(); r.json({ ok: true }) })

// ── Admin ──
const tokens = new Map(), fails = {}
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y) }
app.post('/api/admin/login', (q, r) => {
  if ((fails[q.ip] || 0) >= 5) return r.status(429).json({ ok: false, msg: 'Te veel pogingen' })
  if (![CFG.admin, ...CFG.adminKeys].some(p => eq(q.body.password, p))) { fails[q.ip] = (fails[q.ip] || 0) + 1; setTimeout(() => delete fails[q.ip], 6e5); return r.status(401).json({ ok: false, msg: 'Fout wachtwoord' }) }
  const t = rnd(); tokens.set(t, Date.now() + 12 * 36e5); r.json({ ok: true, token: t })
})
const auth = (q, r, n) => (tokens.get(q.headers['x-token']) > Date.now() ? n() : r.status(401).json({ ok: false, msg: 'Niet ingelogd' }))
app.get('/api/admin/keys', auth, (q, r) => r.json(db.keys.map(k => ({ ...k, discordName: db.users[k.discord]?.name }))))
app.post('/api/admin/keys', auth, (q, r) => {
  const { count = 1, plan = 'lifetime', days = 0, note = '', nolink = false } = q.body, out = []
  for (let i = 0; i < Math.min(+count || 1, 100); i++) {
    const key = [1, 2, 3, 4].map(() => crypto.randomBytes(2).toString('hex').toUpperCase()).join('-')
    const e = { key, plan: String(plan).slice(0, 20), note: String(note).slice(0, 60), hwid: null, discord: null, nolink: !!nolink, banned: false, created: new Date().toISOString(), days: +days || 0, expires: null }
    db.keys.push(e); out.push(e)
  }
  save(); r.json(out)
})
app.post('/api/admin/keys/:k/:act', auth, (q, r) => {
  const e = find(q.params.k); if (!e) return r.status(404).json({ ok: false })
  const a = q.params.act
  if (a === 'reset') e.hwid = null; else if (a === 'unlink') e.discord = null; else if (a === 'ban') e.banned = !e.banned
  else if (a === 'extend') e.expires = new Date(Math.max(Date.now(), Date.parse(e.expires) || 0) + (+q.body.days || 1) * 864e5).toISOString()
  else if (a === 'delete') db.keys = db.keys.filter(x => x !== e)
  save(); r.json({ ok: true })
})

// ── Remote relay: PC <-> telefoon met 6-cijferige code (alleen na toestemming op de pc) ──
const server = http.createServer(app), wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4e6 })
const rooms = new Map(), tries = {}
wss.on('connection', (ws, req) => {
  let room = null, role = null
  ws.on('message', (d, bin) => {
    if (!room) {
      let m; try { m = JSON.parse(d) } catch { return ws.close() }
      if (m.role === 'host') {
        if (!verify(m.key, m.hwid).ok || !/^\d{6}$/.test(m.code)) return ws.close()
        room = { host: ws, viewer: null }; rooms.set(m.code, room); role = 'host'; ws.code = m.code
      } else if (m.role === 'viewer') {
        const ip = req.socket.remoteAddress; tries[ip] = (tries[ip] || 0) + 1; setTimeout(() => tries[ip]--, 6e4)
        const rm = tries[ip] <= 8 && rooms.get(String(m.code))
        if (!rm || rm.viewer) { ws.send(JSON.stringify({ t: 'err', msg: 'Code onbekend, pc offline of al verbonden' })); return ws.close() }
        room = rm; role = 'viewer'; rm.viewer = ws; rm.host.send(JSON.stringify({ t: 'viewer', on: true }))
      } else return ws.close()
      return ws.send(JSON.stringify({ t: 'ok' }))
    }
    const peer = role === 'host' ? room.viewer : room.host
    if (peer && peer.readyState === 1) peer.send(d, { binary: bin })
  })
  ws.on('close', () => {
    if (!room) return
    if (role === 'host') { if (room.viewer) room.viewer.close(); rooms.delete(ws.code) }
    else { room.viewer = null; if (room.host.readyState === 1) room.host.send(JSON.stringify({ t: 'viewer', on: false })) }
  })
})
server.listen(CFG.port, () => console.log('Server op ' + CFG.base))
