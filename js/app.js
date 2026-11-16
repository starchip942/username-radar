import {
  buildRequests, judgeCheck, judgeRule, fakeUsername,
  buildLinkIndex, findLinkedAccounts, VERDICTS
} from './engine.js'

const WORKER = 'https://username-radar.metesahin10.workers.dev'
const PARALLEL = 12 // batches running at the same time
let BATCH = 8 // updated from the worker (version 2 takes 20 links per call)
const PAGE = 200

const $ = id => document.getElementById(id)
const state = {
  sites: [], built: '', linkIndex: null,
  results: [], // { username, site, verdict, answers, note, info }
  linked: [],
  tab: 'found', shown: PAGE, running: false, stop: false, junk: new Map(), junkHidden: 0
}

// ---------- worker check ----------
async function testWorker () {
  try {
    const r = await fetch(WORKER)
    const info = await r.json().catch(() => ({}))
    if (info.capError || !r.ok) throw new Error('unavailable')
    BATCH = Math.max(1, Math.min(info.maxBatch || 8, 20))
    return true
  } catch (e) {
    return false
  }
}

// ---------- talking to the worker ----------
async function sendBatch (batch) {
  const items = batch.map(q => ({
    url: q.url, method: q.method, body: q.body, headers: q.headers, noRedirect: q.noRedirect,
    strings: q.strings, lowerStrings: q.lowerStrings, info: q.info
  }))
  try {
    const r = await fetch(WORKER, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) })
    if (r.status === 403) throw Object.assign(new Error('origin'), { fatal: true })
    if (r.status === 429 || r.status === 503) throw Object.assign(new Error('hard cap'), { fatal: true, hard: true, status: r.status })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const data = await r.json()
    if (!Array.isArray(data.results)) throw new Error('bad answer')
    return data.results
  } catch (e) {
    if (e.fatal) throw e
    // The call failed as a whole (e.g. too much work for one call): split it in two and try again
    if (batch.length > 2) {
      const half = Math.ceil(batch.length / 2)
      return [...await sendBatch(batch.slice(0, half)), ...await sendBatch(batch.slice(half))]
    }
    return batch.map(() => ({ e: 'worker call failed' }))
  }
}

// Runs all requests through the worker; fills responses map; calls onProgress(done,total)
async function runRequests (requests, responses, onProgress) {
  const batches = []
  for (let i = 0; i < requests.length; i += BATCH) batches.push(requests.slice(i, i + BATCH))
  let next = 0; let done = 0; let fatal = null
  async function lane () {
    while (next < batches.length && !state.stop) {
      const b = batches[next++]
      let res
      try { res = await sendBatch(b) } catch (e) { fatal = e; state.stop = true; return }
      b.forEach((q, i) => responses.set(q.key, res[i] || { e: 'no answer' }))
      done += b.length
      onProgress(done, requests.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, batches.length) }, lane))
  if (fatal) throw fatal
}

// Unreliable small sites remembered in this browser and skipped for 7 days
const JUNK_DAYS = 7
function loadJunk () {
  let raw = {}
  try { raw = JSON.parse(localStorage.getItem('junkSites2') || '{}') } catch {}
  const now = Date.now()
  const m = new Map()
  for (const [u, t] of Object.entries(raw)) if (now - t < JUNK_DAYS * 864e5) m.set(u, t)
  return m
}
function saveJunk () {
  try { localStorage.setItem('junkSites2', JSON.stringify(Object.fromEntries(state.junk))) } catch {}
}
function markJunk (site) { if (!site.i) { state.junk.set(site.u, Date.now()); return true } return false }

const needsRetry = r => !r || r.e || r.s === 429 || r.s >= 500

// ---------- scanning one username ----------
async function scanUsername (username, opts, report) {
  const pool = state.sites.filter(s => !state.junk.has(s.u))
  const { checks, requests } = buildRequests(pool, username, { skipAdult: opts.skipAdult })
  const responses = new Map()
  report(`Checking “${username}” on ${checks.length.toLocaleString()} sites…`, 0)
  await runRequests(requests, responses, (d, t) => report(null, d / t * 0.8))

  // Retry the ones that timed out or errored (like Social Analyzer's re-check)
  const retry = requests.filter(q => needsRetry(responses.get(q.key)))
  if (retry.length && !state.stop) {
    report(`Retrying ${retry.length} sites that didn't answer…`, 0.8)
    const again = new Map()
    await runRequests(retry, again, (d, t) => report(null, 0.8 + d / t * 0.07))
    for (const [k, v] of again) if (!needsRetry(v)) responses.set(k, v)
  }

  const out = checks.map(c => ({ check: c, ...judgeCheck(c, responses) }))

  // Double-check: ask the same sites about a name nobody uses (like Maigret/Sherlock self-tests)
  const hits = out.filter(o => o.verdict === 'found' || o.verdict === 'possible')
  if (opts.doubleCheck && hits.length && !state.stop) {
    report(`Double-checking ${hits.length} hits with a fake name…`, 0.87)
    const fake = fakeUsername()
    const f = buildRequests(state.sites, fake, { onlySites: new Set(hits.map(h => h.check.site)) })
    const fres = new Map()
    await runRequests(f.requests, fres, (d, t) => report(null, 0.87 + d / t * 0.07))
    const fakeBySite = new Map(f.checks.map(c => [c.site, c]))
    for (const h of hits) {
      const fc = fakeBySite.get(h.check.site)
      if (!fc) continue
      const liars = new Set()
      h.check.rules.forEach((r, i) => {
        const fr = fc.rules.find(x => x.rule === r.rule)
        if (!fr) return
        const a = judgeRule(fr, fres.get(fr.req.key))
        if (a === 'found' || a === 'possible') liars.add(i)
      })
      if (liars.size) {
        const j = judgeCheck(h.check, responses, liars)
        h.answers = j.answers
        h.verdict = j.verdict
        h.note = 'Some checks for this site were ignored because they say yes to any name.'
        if (liars.size === h.check.rules.length) {
          // Every check says yes even to a made-up name: junk unless it's an important site
          if (markJunk(h.check.site)) h.verdict = 'junk'
          else { h.verdict = 'possible'; h.note = 'This site says yes to any name, so open the link to check by hand.' }
        }
      }
    }
  }

  // Read the profile pages of the hits: title, description, picture, links (like Maigret)
  const good = out.filter(o => o.verdict === 'found' || o.verdict === 'possible')
  if (good.length && !state.stop) {
    report(`Reading ${good.length} matching profiles…`, 0.94)
    const infoReqs = good.map((o, i) => ({
      key: 'info' + i, url: o.check.site.u.split('{u}').join(encodeURIComponent(username)),
      method: 'GET', strings: [], lowerStrings: [], info: true
    }))
    const ires = new Map()
    await runRequests(infoReqs, ires, (d, t) => report(null, 0.94 + d / t * 0.06))
    good.forEach((o, i) => {
      const r = ires.get('info' + i)
      if (!r || r.e) return
      // The actual profile page says "not found" (404/410) or sends you to the home page: no account
      let toHome = false
      try { toHome = r.f && new URL(r.f).pathname.length <= 1 && new URL(o.check.site.u.split('{u}').join('x')).pathname.length > 1 && !(r.s >= 300 && r.s < 400) } catch {}
      if (r.s === 404 || r.s === 410 || toHome) {
        o.verdict = markJunk(o.check.site) ? 'junk' : 'missing'
        o.note = 'The profile page doesn’t exist (' + (toHome ? 'sends you to the home page' : r.s) + ').'
        return
      }
      o.info = { title: r.ot || r.t, desc: r.d, image: r.i, links: r.k }
    })
  }

  saveJunk()
  for (const o of out) {
    if (o.verdict === 'junk') { state.junkHidden++; continue }
    state.results.push({
      username, site: o.check.site, verdict: o.verdict, answers: o.answers,
      sources: o.check.rules.map(r => r.rule.src), note: o.note, info: o.info
    })
    if (o.info && o.info.links) {
      for (const acc of findLinkedAccounts(o.info.links, state.linkIndex)) {
        if (!state.linked.some(l => l.link === acc.link)) state.linked.push({ ...acc, from: o.check.site.n })
      }
    }
  }
}

// ---------- UI ----------
function selectedUsernames () {
  return [...new Set($('usernames').value.split(/[,\n]+/).map(s => s.trim()).filter(Boolean))]
}

let renderTimer = 0
function scheduleRender () { if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = 0; render() }, 250) }

function render () {
  if (!state.results.length) { $('resultsCard').hidden = true; return }
  $('resultsCard').hidden = false
  const counts = Object.fromEntries(VERDICTS.map(v => [v, 0]))
  for (const r of state.results) if (r.verdict in counts) counts[r.verdict]++
  for (const b of $('tabs').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.tab === state.tab)
    b.querySelector('span').textContent = counts[b.dataset.tab].toLocaleString()
  }
  const hints = {
    found: 'Checks agree an account with this name exists.',
    possible: 'Some checks say yes, others say no or only partly match. Open the link to make sure.',
    missing: 'No account with this name was found.',
    unknown: 'The site blocked the check, timed out or was down.'
  }
  $('tabHint').textContent = hints[state.tab]
  const multi = new Set(state.results.map(r => r.username)).size > 1
  const list = state.results.filter(r => r.verdict === state.tab)
  const ul = $('results')
  ul.innerHTML = ''
  for (const r of list.slice(0, state.shown)) ul.append(resultItem(r, multi))
  $('moreBtn').hidden = list.length <= state.shown
  $('moreBtn').textContent = `Show more (${(list.length - state.shown).toLocaleString()} left)`

  $('linkedBox').hidden = !state.linked.length
  const lu = $('linked')
  lu.innerHTML = ''
  for (const l of state.linked) {
    const li = document.createElement('li')
    const main = document.createElement('div'); main.className = 'main'
    const name = document.createElement('div'); name.className = 'name'; name.textContent = `${l.site}: ${l.username}`
    const btn = document.createElement('button'); btn.className = 'secondary small-btn'; btn.textContent = 'Scan this name'
    btn.disabled = state.running
    btn.onclick = () => { $('usernames').value = l.username; $('scanForm').requestSubmit() }
    name.append(btn)
    const a = document.createElement('a'); a.href = l.link; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = l.link
    const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = 'seen on ' + l.from
    main.append(name, a, meta); li.append(main); lu.append(li)
  }
}

function resultItem (r, multi) {
  const li = document.createElement('li')
  if (r.info && r.info.image && /^https:/.test(r.info.image)) {
    const img = document.createElement('img'); img.loading = 'lazy'; img.alt = ''; img.referrerPolicy = 'no-referrer'
    img.src = r.info.image; img.onerror = () => img.remove(); li.append(img)
  }
  const main = document.createElement('div'); main.className = 'main'
  const name = document.createElement('div'); name.className = 'name'
  name.innerHTML = `<span class="dot ${r.verdict}"></span>`
  name.append(r.site.n + (multi ? ` — ${r.username}` : ''))
  const link = r.site.u.split('{u}').join(encodeURIComponent(r.username))
  const a = document.createElement('a'); a.href = link; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = link
  main.append(name, a)
  if (r.info && (r.info.title || r.info.desc)) {
    const d = document.createElement('div'); d.className = 'desc'
    d.textContent = [r.info.title, r.info.desc].filter(Boolean).join(' — ')
    main.append(d)
  }
  const meta = document.createElement('div'); meta.className = 'meta'
  const votes = r.answers.filter(a => a !== 'ignored')
  meta.textContent = `${r.site.c.slice(0, 3).join(', ') || 'uncategorized'} · checks: ${votes.join(', ')} · from ${[...new Set(r.sources)].join(', ')}`
  main.append(meta)
  if (r.note) { const n = document.createElement('div'); n.className = 'meta'; n.textContent = r.note; main.append(n) }
  li.append(main)
  return li
}

// ---------- exports ----------
function rows () {
  return state.results.map(r => ({
    username: r.username, site: r.site.n, url: r.site.u.split('{u}').join(encodeURIComponent(r.username)),
    result: r.verdict, checks: r.answers.join(' '), sources: [...new Set(r.sources)].join(' '),
    categories: r.site.c.join(' '), title: r.info?.title || '', description: r.info?.desc || '', note: r.note || ''
  }))
}
function download (name, text, type) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type }))
  a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}
// Markdown download (Output.markdown): same plain lines as a .txt (bare links, no extra formatting) so it stays just as small
function exportMd () {
  const names = [...new Set(state.results.map(r => r.username))]
  const lines = [`# ${names.join(', ')}`, `${new Date().toLocaleString()}`]
  for (const [v, title] of [['found', 'Found'], ['possible', 'Possible']]) {
    const list = rows().filter(x => x.result === v)
    lines.push('', `## ${title} (${list.length})`)
    for (const x of list) lines.push(`- ${x.site}${names.length > 1 ? ' (' + x.username + ')' : ''}: ${x.url}`)
  }
  if (state.linked.length) {
    lines.push('', `## Linked (${state.linked.length})`)
    for (const l of state.linked) lines.push(`- ${l.site} (${l.username}): ${l.link}`)
  }
  download('Output.markdown', lines.join('\n') + '\n', 'text/markdown')
}
// ---------- start ----------
async function startScan (e) {
  e.preventDefault()
  if (state.running) return
  const names = selectedUsernames()
  if (!names.length) return
  if (!(await testWorker())) {
    $('progressCard').hidden = false
    $('status').textContent = 'The scanner is not reachable right now. Try again in a minute.'
    return
  }
  state.running = true; state.stop = false
  state.results = []; state.linked = []; state.shown = PAGE; state.tab = 'found'; state.junkHidden = 0
  $('scanBtn').disabled = true; $('stopBtn').hidden = false; $('progressCard').hidden = false
  const opts = { skipAdult: false, doubleCheck: true }
  const started = Date.now()
  state.progress = 0
  $('eta').textContent = 'Starting…'
  // Approximate time left, updated every second
  const etaTimer = setInterval(() => {
    const f = state.progress
    const secs = (Date.now() - started) / 1000
    let text = Math.floor(f * 100) + '%'
    if (f > 0.03 && f < 1) {
      const left = Math.max(5, Math.round(secs * (1 - f) / f))
      text += ' · about ' + (left >= 90 ? Math.round(left / 60) + ' min' : (left < 60 ? Math.ceil(left / 5) * 5 + ' sec' : '1 min')) + ' left'
    } else if (f <= 0.03) text += ' · estimating time…'
    $('eta').textContent = text
  }, 1000)
  try {
    for (let i = 0; i < names.length && !state.stop; i++) {
      const prefix = names.length > 1 ? `[${i + 1}/${names.length}] ` : ''
      let label = ''
      await scanUsername(names[i], opts, (msg, frac) => {
        if (state.stop) return
        if (msg) label = msg
        state.progress = (i + frac) / names.length
        $('bar').style.width = (state.progress * 100).toFixed(1) + '%'
        $('status').textContent = prefix + label
        scheduleRender()
      })
      render()
    }
    const secs = Math.round((Date.now() - started) / 1000)
    const found = state.results.filter(r => r.verdict === 'found').length
    $('bar').style.width = '100%'
    $('status').textContent = (state.stop ? 'Stopped. ' : 'Done. ') + `${found} found, ${state.results.filter(r => r.verdict === 'possible').length} possible · ${secs}s` +
      (state.junkHidden ? ` · ${state.junkHidden} fake hits from unreliable sites hidden` : '')
  } catch (err) {
    $('status').textContent = err.hard ? (err.status === 503 ? 'The scanner is not available right now.' : 'Daily scan limit reached. It resets at 03:00 Turkey time.') : err.fatal ? 'The scanner refused this request.' : 'Something went wrong: ' + err.message
  } finally {
    clearInterval(etaTimer)
    $('eta').textContent = ''
    state.running = false
    $('scanBtn').disabled = false; $('stopBtn').hidden = true
    render()
  }
}

async function init () {
  state.junk = loadJunk()
  try {
    const r = await fetch('sites.json')
    const data = await r.json()
    state.sites = data.sites
    state.built = data.built
    state.linkIndex = buildLinkIndex(state.sites)
    $('builtAt').textContent = ` List updated ${new Date(data.built).toLocaleDateString()}.`
  } catch (e) {
    $('progressCard').hidden = false
    $('status').textContent = 'Could not load the site list: ' + e.message
  }
}

$('scanForm').addEventListener('submit', startScan)
$('stopBtn').addEventListener('click', () => { state.stop = true; $('status').textContent = 'Stopping…' })
$('tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { state.tab = b.dataset.tab; state.shown = PAGE; render() } })
$('moreBtn').addEventListener('click', () => { state.shown += PAGE; render() })
$('expMd').addEventListener('click', exportMd)
init()
