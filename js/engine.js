// Username Radar - checking logic (no page/UI code here).
// Every site can have rules from up to four tools. Each rule is judged on its
// own, then the rules vote to give one answer per site.

export const VERDICTS = ['found', 'possible', 'missing', 'unknown']

const fill = (s, u) => typeof s === 'string' ? s.split('{u}').join(u) : s

function regexOk (rx, username) {
  if (!rx) return true
  try { return new RegExp(rx).test(username) } catch { return true }
}

function stripChars (username, chars) {
  if (!chars) return username
  let out = username
  for (const ch of chars) out = out.split(ch).join('')
  return out
}

// Turn sites + username into a list of web requests. Rules that need the very
// same request share it, so a page is only downloaded once.
export function buildRequests (sites, username, { skipAdult = false, info = false, onlySites = null } = {}) {
  const requests = new Map()
  const checks = [] // one per site
  for (const site of sites) {
    if (skipAdult && site.x) continue
    if (onlySites && !onlySites.has(site)) continue
    const entry = { site, username, rules: [], skipped: 0 }
    for (const rule of site.r) {
      const name = stripChars(username, rule.sb)
      if (!regexOk(rule.rx, name)) { entry.skipped++; continue }
      const url = fill(rule.p || site.u, encodeURIComponent(name))
      const body = rule.b ? fill(rule.b, name) : undefined
      const method = rule.m || (body ? 'POST' : 'GET')
      const key = [method, url, body || '', rule.rd ? 1 : 0, JSON.stringify(rule.h || {})].join('|')
      let req = requests.get(key)
      if (!req) {
        req = { key, url, method, body, headers: rule.h, noRedirect: !!rule.rd, strings: [], lowerStrings: [], info }
        requests.set(key, req)
      }
      const lower = rule.src === 'social-analyzer'
      const list = lower ? req.lowerStrings : req.strings
      const idx = s => { const v = fill(s, name); let i = list.indexOf(v); if (i < 0) { list.push(v); i = list.length - 1 } return i }
      entry.rules.push({
        rule,
        req,
        lower,
        fa: (rule.fa || []).map(idx),
        fy: (rule.fy || []).map(idx),
        ma: (rule.ma || []).map(idx),
        bl: (rule.bl || []).map(idx)
      })
    }
    if (entry.rules.length) checks.push(entry)
  }
  return { checks, requests: [...requests.values()] }
}

function codeMatch (list, status) {
  for (const c of list) {
    if (c === '*') return true
    if (c === '!2' && (status < 200 || status >= 300)) return true
    if (Number(c) === status) return true
  }
  return false
}

// Judge one rule against one response. Returns found / possible / missing / blocked / error / unclear
export function judgeRule (r, res) {
  if (!res) return 'error'
  if (res.e) return 'error'
  if (res.cf) return 'blocked'
  const hits = r.lower ? (res.hl || []) : (res.h || [])
  const hit = i => !!hits[i]
  if (r.bl.some(hit)) return 'blocked'
  const st = res.s
  if (st === 429 || st >= 500) return 'error'
  const rule = r.rule
  // A bare 401/403 usually means the site blocked the checker, not "no account"
  const hasStrings = r.fa.length || r.fy.length || r.ma.length
  if ((st === 401 || st === 403) && !hasStrings && !(rule.mc || []).includes(st)) return 'blocked'

  const mc = rule.mc || []
  if (mc.length || r.ma.length) {
    const codesOk = !mc.length || codeMatch(mc, st)
    const strOk = !r.ma.length || r.ma.some(hit)
    if (codesOk && strOk) return 'missing'
  }
  const fcOk = rule.fc ? codeMatch(rule.fc, st) : (st >= 200 && st < 300)
  const faOk = r.fa.every(hit)
  const fyOk = !r.fy.length || r.fy.some(hit)
  if (fcOk && faOk && fyOk) return 'found'
  if (rule.pa && fcOk && r.fa.some(hit)) return 'possible'
  return rule.d === 'm' ? 'missing' : 'unclear'
}

// Combine the rule answers of one site into one answer.
export function combine (answers) {
  let found = 0; let possible = 0; let missing = 0
  for (const a of answers) {
    if (a === 'found') found++
    else if (a === 'possible') possible++
    else if (a === 'missing') missing++
  }
  if (found && found > missing) return 'found' // most checks agree
  if (found || possible) return 'possible'
  if (missing) return 'missing'
  return 'unknown'
}

export function judgeCheck (check, responses, ignoreRules = null) {
  const answers = check.rules.map((r, i) => (ignoreRules && ignoreRules.has(i)) ? 'ignored' : judgeRule(r, responses.get(r.req.key)))
  return { answers, verdict: combine(answers.filter(a => a !== 'ignored')) }
}

// Fake username for the double-check (a site that says "yes" to this is lying).
export function fakeUsername () {
  const abc = 'abcdefghijklmnopqrstuvwxyz'
  let s = ''
  for (let i = 0; i < 11; i++) s += abc[Math.floor(Math.random() * abc.length)]
  return 'qz' + s
}

// Spelling variations (idea from Social Analyzer's string analysis).
export function variations (input) {
  const u = input.trim()
  const parts = u.split(/[\s._-]+/).filter(Boolean)
  const out = new Set()
  if (parts.length > 1) {
    const rev = [...parts].reverse()
    for (const p of [parts, rev]) for (const sep of ['', '.', '_', '-']) out.add(p.join(sep).toLowerCase())
    out.add((parts[0][0] + parts.slice(1).join('')).toLowerCase())
    out.add((parts[0] + parts[parts.length - 1][0]).toLowerCase())
  } else {
    const w = u.toLowerCase()
    for (const v of [w, `${w}_`, `_${w}`, `${w}1`, `real${w}`, `${w}official`, `the${w}`, `its${w}`]) out.add(v)
  }
  out.delete(u)
  out.delete(u.toLowerCase())
  return [...out]
}

// Find accounts on known sites inside a list of links (idea from Maigret).
export function buildLinkIndex (sites) {
  const byHost = new Map()
  for (const s of sites) {
    let u
    try { u = new URL(s.u.split('{u}').join('USERNAMEX')) } catch { continue }
    const host = u.hostname.replace(/^www\./, '')
    if (host.includes('USERNAMEX')) continue // username in the host name (e.g. name.tumblr.com) - skip
    const path = (u.pathname + u.search).replace(/\/$/, '')
    const esc = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('USERNAMEX', '([A-Za-z0-9._-]{2,40})')
    if (!esc.includes('([A-Za-z0-9')) continue
    const re = new RegExp('^' + esc + '/?$', 'i')
    if (!byHost.has(host)) byHost.set(host, [])
    byHost.get(host).push({ site: s, re })
  }
  return byHost
}

export function findLinkedAccounts (links, index) {
  const found = []
  for (const link of links || []) {
    let u
    try { u = new URL(link) } catch { continue }
    const list = index.get(u.hostname.replace(/^www\./, ''))
    if (!list) continue
    const path = (u.pathname + u.search).replace(/\/$/, '')
    for (const { site, re } of list) {
      const m = re.exec(path) || re.exec(u.pathname.replace(/\/$/, ''))
      if (m) { found.push({ site: site.n, username: decodeURIComponent(m[1]), link }); break }
    }
  }
  return found
}
