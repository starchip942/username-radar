import {
  buildRequests, judgeCheck, judgeRule, fakeUsername, variations,
  buildLinkIndex, findLinkedAccounts, VERDICTS
} from './engine.js'

const DEFAULT_WORKER = 'https://username-radar.metesahin10.workers.dev'
const BATCH = 8 // must match MAX_BATCH in the worker
const PARALLEL = 24 // batches running at the same time
const PAGE = 200

const $ = id => document.getElementById(id)
const state = {
  sites: [], built: '', linkIndex: null,
  results: [], // { username, site, verdict, answers, note, info }
  linked: [],
  tab: 'found', shown: PAGE, running: false, stop: false
}

// ---------- settings & usage ----------
const workerUrl = () => (localStorage.getItem('workerUrl') || DEFAULT_WORKER).replace(/\/+$/, '')
function usageToday () {
  const today = new Date().toISOString().slice(0, 10)
  let u = {}
  try { u = JSON.parse(localStorage.getItem('usage') || '{}') } catch {}
  if (u.day !== today) u = { day: today, calls: 0 }
  return u
}
function addUsage (n) {
  const u = usageToday(); u.calls += n
  try { localStorage.setItem('usage', JSON.stringify(u)) } catch {}
  $('usage').textContent = `Worker calls today from this browser: ${u.calls.toLocaleString()} of 100,000 free.`
}

async function testWorker () {
  $('workerStatus').textContent = 'Testing…'
  try {
    const r = await fetch(workerUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [] }) })
    if (r.status === 403) throw new Error('the Worker does not allow this website address (check ALLOWED_ORIGINS)')
    if (!r.ok) throw new Error('HTTP ' + r.status)
    await r.json()
    $('workerStatus').textContent = 'Worker is working ✓'
    return true
  } catch (e) {
    $('workerStatus').textContent = 'Worker not reachable: ' + e.message
    return false
  }
}

// ---------- talking to the worker ----------
async function sendBatch (batch) {
  const items = batch.map(q => ({
    url: q.url, method: q.method, body: q.body, headers: q.headers, noRedirect: q.noRedirect,
    strings: q.strings, lowerStrings: q.lowerStrings, info: q.info
  }))
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(workerUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) })
      addUsage(1)
      if (r.status === 403) throw Object.assign(new Error('origin'), { fatal: true })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const data = await r.json()
      return data.results
    } catch (e) {
      if (e.fatal) throw e
      await new Promise(res => setTimeout(res, 800))
    }
  }
  return batch.map(() => ({ e: 'worker unreachable' }))
}

// Runs all requests through the worker; fills responses map; calls onProgress(done,total)
async function runRequests (requests, responses, onProgress) {
  const batches = []
  for (let i = 0; i < requests.length; i += BATCH) batches.push(requests.slice(i, i + BATCH))
  let next = 0; let done = 0
  async function lane () {
    while (next < batches.length && !state.stop) {
      const b = batches[next++]
      const res = await sendBatch(b)
      b.forEach((q, i) => responses.set(q.key, res[i] || { e: 'no answer' }))
      done += b.length
      onProgress(done, requests.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, batches.length) }, lane))
}

const needsRetry = r => !r || r.e || r.s === 429 || r.s >= 500

// ---------- scanning one username ----------
async function scanUsername (username, opts, report) {
  const { checks, requests } = buildRequests(state.sites, username, { skipAdult: opts.skipAdult })
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
        h.note = liars.size === h.check.rules.length
          ? 'This site says yes to any name, so the result can’t be trusted.'
          : 'Some checks for this site were ignored because they say yes to any name.'
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
      if (r && !r.e) o.info = { title: r.ot || r.t, desc: r.d, image: r.i, links: r.k }
    })
  }

  for (const o of out) {
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
  const base = $('usernames').value.split(/[,\n]+/).map(s => s.trim()).filter(Boolean)
  const list = [...new Set(base)]
  if ($('optVariations').checked) {
    for (const el of $('variationBox').querySelectorAll('input:checked')) if (!list.includes(el.value)) list.push(el.value)
  }
  return list
}

function updateVariations () {
  const box = $('variationBox')
  if (!$('optVariations').checked) { box.hidden = true; updateEstimate(); return }
  const base = $('usernames').value.split(/[,\n]+/).map(s => s.trim()).filter(Boolean)
  const vars = [...new Set(base.flatMap(variations))].filter(v => !base.includes(v))
  box.innerHTML = ''
  for (const v of vars) {
    const l = document.createElement('label')
    l.innerHTML = '<input type="checkbox" checked>'
    l.firstChild.value = v
    l.append(' ' + v)
    l.firstChild.addEventListener('change', updateEstimate)
    box.append(l)
  }
  box.hidden = vars.length === 0
  updateEstimate()
}

function updateEstimate () {
  const n = selectedUsernames().length
  if (!n || !state.sites.length) { $('estimate').textContent = ''; return }
  const sites = $('optAdult').checked ? state.sites.filter(s => !s.x).length : state.sites.length
  const calls = Math.ceil(sites * 1.13 / BATCH) * n
  $('estimate').textContent = `${n} username${n > 1 ? 's' : ''} × ${sites.toLocaleString()} sites ≈ ${calls.toLocaleString()} Worker calls (free plan: 100,000 a day).`
}

let renderTimer = 0
function scheduleRender () { if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = 0; render() }, 250) }

function render () {
  if (!state.results.length) { $('resultsCard').hidden = true; return }
  $('resultsCard').hidden = false
  const counts = Object.fromEntries(VERDICTS.map(v => [v, 0]))
  for (const r of state.results) counts[r.verdict]++
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
  const text = $('filterText').value.trim().toLowerCase()
  const cat = $('filterCat').value
  const multi = new Set(state.results.map(r => r.username)).size > 1
  const list = state.results.filter(r => r.verdict === state.tab &&
    (!text || r.site.n.toLowerCase().includes(text) || r.site.u.toLowerCase().includes(text)) &&
    (!cat || r.site.c.includes(cat)))
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
    btn.onclick = () => { $('usernames').value = l.username; updateVariations(); $('scanForm').requestSubmit() }
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
const fileBase = () => 'username-radar-' + [...new Set(state.results.map(r => r.username))].slice(0, 3).join('_').replace(/[^\w.-]+/g, '') + '-' + new Date().toISOString().slice(0, 10)
function exportJson () {
  download(fileBase() + '.json', JSON.stringify({ scanned: new Date().toISOString(), results: rows(), linked: state.linked }, null, 2), 'application/json')
}
function exportCsv () {
  const r = rows()
  const cols = Object.keys(r[0] || { username: '' })
  const esc = v => '"' + String(v).replace(/"/g, '""') + '"'
  download(fileBase() + '.csv', [cols.join(','), ...r.map(x => cols.map(c => esc(x[c])).join(','))].join('\n'), 'text/csv')
}
function exportReport () {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const r = rows().filter(x => x.result === 'found' || x.result === 'possible')
  const names = [...new Set(state.results.map(x => x.username))]
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Username Radar report</title>
<style>body{font:14px/1.45 system-ui,sans-serif;margin:32px;color:#111}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left;vertical-align:top}th{background:#f3f3f3}a{color:#2f5d50;word-break:break-all}.p{color:#a46a00}</style></head><body>
<h1>Username Radar report</h1><p>Usernames: ${esc(names.join(', '))}<br>Date: ${esc(new Date().toLocaleString())}<br>
Sites checked: ${state.results.length.toLocaleString()} · Found: ${r.filter(x => x.result === 'found').length} · Possible: ${r.filter(x => x.result === 'possible').length}</p>
<table><tr><th>Site</th><th>Username</th><th>Result</th><th>Link / details</th></tr>
${r.map(x => `<tr><td>${esc(x.site)}</td><td>${esc(x.username)}</td><td class="${x.result === 'possible' ? 'p' : ''}">${esc(x.result)}</td><td><a href="${esc(x.url)}">${esc(x.url)}</a><br>${esc([x.title, x.description].filter(Boolean).join(' — '))}${x.note ? '<br><i>' + esc(x.note) + '</i>' : ''}</td></tr>`).join('')}
</table>${state.linked.length ? `<h2>Linked accounts</h2><ul>${state.linked.map(l => `<li>${esc(l.site)}: ${esc(l.username)} — <a href="${esc(l.link)}">${esc(l.link)}</a> (seen on ${esc(l.from)})</li>`).join('')}</ul>` : ''}
<script>setTimeout(()=>print(),400)<\/script></body></html>`
  const w = window.open('', '_blank')
  if (w) { w.document.write(html); w.document.close() } else download(fileBase() + '.html', html, 'text/html')
}

// ---------- start ----------
async function startScan (e) {
  e.preventDefault()
  if (state.running) return
  const names = selectedUsernames()
  if (!names.length) return
  if (!(await testWorker())) { $('settings').open = true; return }
  state.running = true; state.stop = false
  state.results = []; state.linked = []; state.shown = PAGE; state.tab = 'found'
  $('scanBtn').disabled = true; $('stopBtn').hidden = false; $('progressCard').hidden = false
  const opts = { skipAdult: $('optAdult').checked, doubleCheck: $('optDouble').checked }
  const started = Date.now()
  try {
    for (let i = 0; i < names.length && !state.stop; i++) {
      const prefix = names.length > 1 ? `[${i + 1}/${names.length}] ` : ''
      let label = ''
      await scanUsername(names[i], opts, (msg, frac) => {
        if (msg) label = msg
        $('bar').style.width = (((i + frac) / names.length) * 100).toFixed(1) + '%'
        $('status').textContent = prefix + label
        scheduleRender()
      })
      render()
    }
    const secs = Math.round((Date.now() - started) / 1000)
    const found = state.results.filter(r => r.verdict === 'found').length
    $('bar').style.width = '100%'
    $('status').textContent = (state.stop ? 'Stopped. ' : 'Done. ') + `${found} found, ${state.results.filter(r => r.verdict === 'possible').length} possible · ${secs}s`
  } catch (err) {
    $('status').textContent = err.fatal ? 'The Worker refused this website. Add this site’s address to ALLOWED_ORIGINS in the Worker.' : 'Something went wrong: ' + err.message
  } finally {
    state.running = false
    $('scanBtn').disabled = false; $('stopBtn').hidden = true
    render()
  }
}

async function init () {
  $('workerUrl').value = workerUrl()
  addUsage(0)
  try {
    const r = await fetch('sites.json')
    const data = await r.json()
    state.sites = data.sites
    state.built = data.built
    state.linkIndex = buildLinkIndex(state.sites)
    $('siteCount').textContent = `Checks ${state.sites.length.toLocaleString()} websites — the combined lists of Sherlock, Maigret, WhatsMyName and Social Analyzer.`
    $('builtAt').textContent = ` List updated ${new Date(data.built).toLocaleDateString()}.`
    const cats = new Map()
    for (const s of state.sites) for (const c of s.c) cats.set(c, (cats.get(c) || 0) + 1)
    for (const [c] of [...cats].filter(([, n]) => n >= 10).sort((a, b) => a[0].localeCompare(b[0]))) {
      const o = document.createElement('option'); o.value = c; o.textContent = c; $('filterCat').append(o)
    }
  } catch (e) {
    $('siteCount').textContent = 'Could not load the site list: ' + e.message
  }
  updateEstimate()
}

$('scanForm').addEventListener('submit', startScan)
$('stopBtn').addEventListener('click', () => { state.stop = true; $('status').textContent = 'Stopping…' })
$('usernames').addEventListener('input', updateVariations)
$('optVariations').addEventListener('change', updateVariations)
$('optAdult').addEventListener('change', updateEstimate)
$('tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { state.tab = b.dataset.tab; state.shown = PAGE; render() } })
$('filterText').addEventListener('input', () => { state.shown = PAGE; scheduleRender() })
$('filterCat').addEventListener('change', () => { state.shown = PAGE; render() })
$('moreBtn').addEventListener('click', () => { state.shown += PAGE; render() })
$('saveWorker').addEventListener('click', () => { localStorage.setItem('workerUrl', $('workerUrl').value.trim() || DEFAULT_WORKER); testWorker() })
$('expJson').addEventListener('click', exportJson)
$('expCsv').addEventListener('click', exportCsv)
$('expReport').addEventListener('click', exportReport)
init()
