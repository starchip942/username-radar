// Builds sites.json: one combined, de-duplicated list of username-check rules
// from Sherlock, Maigret, WhatsMyName and Social Analyzer.
//
// Usage: node tools/build-sites.mjs <sherlock data.json> <maigret data.json> <wmn-data.json> <social-analyzer sites.json> [out]
//
// Output format (kept short to save download size):
// { built, counts, sites: [ { n: name, u: profile url template ("{u}" = username),
//     c: [categories], x: 1 if adult, s: [sources], r: [rules] } ] }
// rule: { src, p: probe url (if different), m: method, b: body, h: headers,
//   rd: 1 = don't follow redirects, rx: username regex, sb: chars to strip,
//   fc: found status codes (["*"] = any; default 2xx), fa: found needs ALL strings,
//   fy: found needs ANY string, mc: missing codes ("!2" = not 2xx),
//   ma: missing strings (any), bl: "blocked" strings, d: "m" when no match means missing,
//   pa: 1 = partial match counts as "possible" }

import fs from 'node:fs'

const [,, sherlockPath, maigretPath, wmnPath, saPath, outPath = 'sites.json'] = process.argv
if (!saPath) {
  console.error('usage: node tools/build-sites.mjs sherlock.json maigret.json wmn.json social-analyzer.json [out]')
  process.exit(1)
}
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'))
const arr = v => (v === undefined || v === null || v === '') ? [] : (Array.isArray(v) ? v : [v])
const clean = o => { for (const k of Object.keys(o)) { const v = o[k]; if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)) delete o[k] } return o }
const ph = (s, from) => typeof s === 'string' ? s.split(from).join('{u}') : s
const phDeep = (v, from) => {
  if (typeof v === 'string') return ph(v, from)
  if (Array.isArray(v)) return v.map(x => phDeep(x, from))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, phDeep(x, from)]))
  return v
}

const sites = new Map() // key -> site
function keyOf (url) {
  return url.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').replace(/[/?#]+$/, '')
}
// Russian sites (.ru / .su / .рф) are left out on purpose
const RUSSIAN = /\.(ru|su|xn--p1ai|рф)$/i
function hostOf (url) { try { return new URL(url.split('{u}').join('x')).hostname } catch { return '' } }
function add (src, name, url, rule, cats, nsfw, rank) {
  if (!url || !url.includes('{u}') || !/^https?:\/\//i.test(url)) return false
  if (RUSSIAN.test(hostOf(url)) || (rule.p && RUSSIAN.test(hostOf(rule.p)))) return false
  const k = keyOf(url)
  let s = sites.get(k)
  if (!s) { s = { n: name, u: url, c: [], x: 0, s: [], r: [] }; sites.set(k, s) }
  rule.src = src
  if (rule.p === url) delete rule.p
  clean(rule)
  const sig = JSON.stringify(rule)
  if (!s.r.some(r => JSON.stringify(r) === sig)) s.r.push(rule)
  if (!s.s.includes(src)) s.s.push(src)
  for (const c of arr(cats)) { const t = String(c).toLowerCase().trim(); if (t && !s.c.includes(t)) s.c.push(t) }
  if (nsfw) s.x = 1
  if (rank > 0 && (!s.rank || rank < s.rank)) s.rank = rank
  return true
}
const counts = {}
const bump = (k, ok) => { counts[k] = counts[k] || { read: 0, used: 0 }; counts[k].read++; if (ok) counts[k].used++ }

// 1) WhatsMyName (most actively maintained, checked first so its name wins)
{
  const w = read(wmnPath)
  for (const e of w.sites) {
    if (e.valid === false) { bump('whatsmyname', false); continue }
    const nsfw = /nsfw/i.test(e.cat || '')
    const probe = ph(e.uri_check, '{account}')
    const rule = {
      p: probe,
      m: e.post_body ? 'POST' : undefined,
      b: e.post_body ? ph(e.post_body, '{account}') : undefined,
      h: e.headers,
      sb: e.strip_bad_char,
      fc: [e.e_code],
      fa: arr(ph(e.e_string, '{account}')),
      mc: [e.m_code],
      ma: arr(ph(e.m_string, '{account}'))
    }
    const display = ph(e.uri_pretty || e.uri_check, '{account}')
    bump('whatsmyname', add('whatsmyname', e.name, display, rule, nsfw ? ['adult'] : [e.cat], nsfw))
  }
}

// 2) Sherlock
{
  const s = read(sherlockPath)
  for (const [name, e] of Object.entries(s)) {
    if (name.startsWith('$')) continue
    const types = arr(e.errorType)
    const rule = {
      p: e.urlProbe ? ph(e.urlProbe, '{}') : undefined,
      m: e.request_method && e.request_method !== 'GET' ? e.request_method : undefined,
      b: e.request_payload ? JSON.stringify(phDeep(e.request_payload, '{}')) : undefined,
      h: e.headers,
      rx: e.regexCheck,
      d: 'm'
    }
    if (types.includes('message')) { rule.ma = arr(e.errorMsg); rule.fc = ['*'] }
    if (types.includes('status_code')) { rule.mc = ['!2', ...arr(e.errorCode)]; delete rule.fc }
    if (types.includes('response_url')) { rule.rd = 1; rule.mc = ['!2']; delete rule.fc }
    const url = ph(e.url, '{}')
    bump('sherlock', add('sherlock', name, url, rule, e.isNSFW ? ['adult'] : [], !!e.isNSFW))
  }
}

// 3) Maigret (sites can inherit settings from forum "engines")
{
  const m = read(maigretPath)
  for (const [name, raw] of Object.entries(m.sites)) {
    let e = raw
    if (raw.engine && m.engines[raw.engine]) e = { ...m.engines[raw.engine].site, ...raw }
    if (e.disabled || (e.type && e.type !== 'username') || !e.checkType) { bump('maigret', false); continue }
    const fill = t => t && t.replace('{urlMain}', (e.urlMain || '').replace(/\/$/, '')).replace('{urlSubpath}', e.urlSubpath || '').split('{username}').join('{u}')
    const url = fill(e.url)
    const tags = arr(e.tags)
    const nsfw = tags.includes('porn') || tags.includes('adult') || tags.includes('nsfw')
    const rule = {
      p: e.urlProbe ? fill(e.urlProbe) : undefined,
      m: e.requestMethod && e.requestMethod !== 'GET' ? e.requestMethod : (e.requestHeadOnly && e.checkType === 'status_code' ? 'HEAD' : undefined),
      b: e.requestPayload ? JSON.stringify(phDeep(e.requestPayload, '{username}')) : undefined,
      h: e.headers,
      rx: e.regexCheck,
      bl: e.errors ? Object.keys(e.errors) : undefined,
      d: 'm'
    }
    if (e.checkType === 'message') {
      rule.fc = ['*']
      rule.ma = arr(e.absenceStrs).map(x => ph(x, '{username}'))
      rule.fy = arr(e.presenseStrs).map(x => ph(x, '{username}'))
    } else if (e.checkType === 'status_code') {
      rule.mc = ['!2']
    } else if (e.checkType === 'response_url') {
      rule.rd = 1; rule.mc = ['!2']
    } else { bump('maigret', false); continue }
    bump('maigret', add('maigret', name, url, rule, tags.filter(t => t.length > 2), nsfw, Number(e.alexaRank) || 0))
  }
}

// 4) Social Analyzer
{
  const sa = read(saPath)
  const shared = Object.fromEntries((sa.shared_detections || []).map(x => [x.name, x.detections]))
  for (const e of sa.websites_entries) {
    let dets = []
    for (const d of e.detections || []) {
      if (d.type === 'shared' && shared[d.name]) dets.push(...shared[d.name])
      else if (d.type === 'normal' || d.type === 'advanced') dets.push(d)
    }
    dets = dets.filter(d => d.type === 'normal' || d.type === 'advanced')
    if (!dets.length) { bump('social-analyzer', false); continue }
    const yes = [...new Set(dets.filter(d => d.return === 'true').map(d => ph(d.string, '{username}')))]
    const no = [...new Set(dets.filter(d => d.return === 'false').map(d => ph(d.string, '{username}')))]
    const rule = { fc: ['*'], fa: yes, ma: no, pa: yes.length > 1 ? 1 : undefined }
    let url = ph(e.url, '{username}')
    const host = (() => { try { return new URL(url.replace('{u}', 'x')).hostname.replace(/^www\./, '') } catch { return '' } })()
    const cat = (e.type || '').split('>').map(x => x.trim()).filter(Boolean).slice(-1)
    const nsfw = e.nsfw === 'true'
    bump('social-analyzer', add('social-analyzer', host, url, rule, nsfw ? ['adult', ...cat] : cat, nsfw, Number(e.global_rank) || 0))
  }
}

// "Important" sites are never hidden for being unreliable: popular (top 10,000 by
// traffic rank), in the hand-picked Sherlock/WhatsMyName lists, or known to 2+ tools.
for (const s of sites.values()) {
  if (s.s.includes('sherlock') || s.s.includes('whatsmyname') || s.s.length > 1 || (s.rank && s.rank <= 10000)) s.i = 1
  delete s.rank
}
const list = [...sites.values()].sort((a, b) => a.n.localeCompare(b.n, 'en', { sensitivity: 'base' }))
const out = { built: new Date().toISOString(), counts, total: list.length, sites: list }
fs.writeFileSync(outPath, JSON.stringify(out))
console.log(JSON.stringify(counts), 'total sites:', list.length, 'rules:', list.reduce((n, s) => n + s.r.length, 0),
  'multi-source:', list.filter(s => s.s.length > 1).length, 'important:', list.filter(s => s.i).length, 'size:', (fs.statSync(outPath).size / 1e6).toFixed(2) + 'MB')
