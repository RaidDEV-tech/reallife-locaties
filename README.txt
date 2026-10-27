REALLIFE LOCATIES — setup
=========================
server/   keys + Discord + dashboard-API + admin (/admin) + telefoon-remote (/remote)
app/      Windows-loader (Electron)     website/  site + dashboard

1. Discord: discord.com/developers -> New Application -> OAuth2 -> Redirects: <BASE_URL>/auth/discord/callback
   Kopieer Client ID + Client Secret.
2. Server (bv. Render): root dir "server", build "npm install", start "node server.js".
   Env vars: ADMIN_PASSWORD, BASE_URL (https://jouwdomein.nl), DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET,
   ADMIN_KEYS=068789,068497 (admin-keys voor /admin, komma-gescheiden), DATA_FILE=/data/data.json (+ Persistent Disk op /data, anders raak je keys kwijt).
3. app/config.json -> "serverUrl": jouw BASE_URL. GitHub-naam in app/package.json.
4. .exe bouwen: push naar GitHub, dan  git tag v3.1.0 && git push --tags  (workflow bouwt de .exe).
5. Keys maken: <BASE_URL>/admin  (aantal, duur, notitie). Duur start pas bij eerste gebruik.
Lokaal testen: cd server && npm install && ADMIN_PASSWORD=x node server.js
