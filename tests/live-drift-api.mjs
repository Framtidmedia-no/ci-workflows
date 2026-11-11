// Falsk Supabase Management API for selvtesten: tar imot POST /v1/projects/<ref>/database/query og kjører
// spørringen mot en engangs-Postgres via docker exec, med samme svarform som det ekte API-et (JSON-liste med rader).
// Sjekker også Authorization-headeren, slik at en feil token gir 401 som i virkeligheten.
// Bruk: node tests/live-drift-api.mjs <port> <container> <forventet-token> <ref> [<katalog med nettverk.json, ssl.json, auth.json>]
// GET /network-restrictions, /ssl-enforcement og /config/auth svares fra filene i katalogen (utvidede sjekker, FRA-1896).
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const [, , port, container, token, ref, katalog] = process.argv
const GET = { '/network-restrictions': 'nettverk.json', '/ssl-enforcement': 'ssl.json', '/config/auth': 'auth.json' }
createServer((req, res) => {
  const deler = []
  req.on('data', (d) => deler.push(d))
  req.on('end', () => {
    const svar = (kode, body) => { res.writeHead(kode, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.headers.authorization !== `Bearer ${token}`) return svar(401, { message: 'Unauthorized' })
    if (req.method === 'GET' && katalog) {
      const sti = req.url.replace(`/v1/projects/${ref}`, '')
      const fil = GET[sti] && `${katalog}/${GET[sti]}`
      if (fil && existsSync(fil)) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(readFileSync(fil, 'utf8')) }
      return svar(404, { message: 'ikke funnet' })
    }
    if (req.method !== 'POST' || req.url !== `/v1/projects/${ref}/database/query`) return svar(404, { message: 'ikke funnet' })
    const { query } = JSON.parse(Buffer.concat(deler).toString('utf8'))
    try {
      const ut = execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1',
        '-c', `select coalesce(json_agg(t), '[]'::json) from (${query}) t`], { encoding: 'utf8' })
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(ut.trim())
    } catch (e) { svar(400, { message: 'sql-feil' }) }
  })
}).listen(Number(port), '127.0.0.1', () => console.log('klar'))
