# Username Radar

Username Radar checks one or more usernames across about 8,600 websites. Russian sites (.ru, .su and .рф) are left out on purpose. It runs in your browser and is hosted on GitHub Pages at https://starchip942.github.io/username-radar/

The site list is a combined, de-duplicated rule set from four open-source tools: Sherlock, Maigret, WhatsMyName and Social Analyzer. The list is rebuilt every Monday by a GitHub Action (`.github/workflows/update-sites.yml`).

## What it does

- Runs the checks from all four tools for each site and combines their answers into one result per site.
- Sorts results into four tabs: Found, Possible, Not found, and Couldn't check.
- Filters out fake hits. A site is never shown as found if its profile page returns 404 or 410, or redirects to the home page.
- Hides small sites that say yes to a made-up name or show fake hits. Hidden sites are remembered in the browser and skipped in later scans. The "Check skipped sites again" button in Settings resets this.
- Never hides important sites (the top 10,000 by traffic, sites in Sherlock or WhatsMyName, or sites known to two or more tools). Those are shown as "Possible" instead.
- Retries sites that timed out or returned errors.
- Reads the matching profile pages and shows the title, description and picture.
- Finds linked accounts: links to other known sites on found profiles, with a "Scan this name" button for each one.
- Accepts several usernames at once (comma separated).
- Can also try spelling variations of each name (for example reversed names, joined or dotted names, and names with "_", "1" or "official" added). You pick which variations to use.
- Can skip adult sites.
- Filters results by site name or by category.
- Downloads results as "Output.markdown" (a simple list of found, possible and linked results), as JSON or CSV, or opens a printable report.
- Keeps a count of Worker calls used today. Settings shows the count for this browser and "Whole site today: X of 60,000" for all users of the site.

## How it works

Browsers are not allowed to read other websites' pages. So a small private Cloudflare Worker does the fetching (its code is kept out of this repository). The website sends it batches of 20 profile addresses. The Worker opens each one and sends back only:

- the status code and final address,
- which check-words were found,
- the page title, description and picture,
- links to other websites.

The website then makes the decision and shows the result.

## Setup (plain steps)

1. Create the Worker. Log in to the Cloudflare dashboard, go to Workers & Pages, click Create, choose Worker, and name it `username-radar`. Click Deploy. Then click Edit code, delete everything in the editor, paste the Worker code (kept privately, not in this repository), and click Deploy again. Its address will look like `https://username-radar.<your-subdomain>.workers.dev`.
2. Add the usage counter. Go to Cloudflare dashboard → Storage & Databases → D1 → Create database, and name it `radar-usage`. Then open the Worker → Settings → Bindings → Add → D1 database. Set Variable name to `DB`, pick `radar-usage`, and click Deploy or Save. Without this step the Worker refuses to scan. This is on purpose.
3. Connect the website to the Worker. If your Worker address is different from `https://username-radar.metesahin10.workers.dev`, open the website, go to Settings, paste the Worker address, and click Save & test. You should see "Worker is working".
4. Turn on the website. In this repository go to Settings, then Pages, choose Deploy from a branch, select `main`, and folder `/ (root)`.

The Worker only accepts requests from the website addresses listed in `ALLOWED_ORIGINS` at the top of the Worker code. If you host the website at a different address, add it to that list.

## Limits

- The free Cloudflare plan allows 100,000 Worker calls per day.
- The Worker itself refuses work after 60,000 calls per day (60% of the free limit). Other Workers on the same Cloudflare account always keep at least 40%. The count is kept in a free Cloudflare D1 database (see Setup).
- Each Worker call checks 20 links. One full scan of one username uses roughly 500 to 700 Worker calls. That means about 85 or more full scans per day within the 60,000 cap.
- There is also a per-browser cap. It defaults to 60,000 and can be changed in Settings.
- Limits reset at 00:00 UTC (03:00 Turkey time).
- Big sites such as Instagram, TikTok and Facebook often block Cloudflare. Their results may land in "Couldn't check" or "Possible".
- Results are only as good as the site's own pages. Open the link to confirm any Found or Possible result.

## Rebuilding the site list by hand

Run this in a terminal with Node.js installed, using the data files from the four tools:

```
node tools/build-sites.mjs <sherlock data.json> <maigret data.json> <wmn-data.json> <social-analyzer sites.json> [out]
```

The output defaults to `sites.json`, which the website loads.

## Files

- `index.html` - the page and its layout
- `style.css` - the styling
- `js/app.js` - the screen, scanning flow and exports
- `js/engine.js` - the checking rules, the verdicts and the spelling variations
- `tools/build-sites.mjs` - builds `sites.json` from the four tools' lists
- `sites.json` - the combined site list (created by the build tool)

## Credits and licenses

- Sherlock, MIT: https://github.com/sherlock-project/sherlock
- Maigret, MIT: https://github.com/soxoj/maigret
- WhatsMyName, CC BY-SA 4.0: https://github.com/WebBreacher/WhatsMyName
- Social Analyzer, AGPL-3.0: https://github.com/qeeqbox/social-analyzer

This project is licensed under AGPL-3.0.

## Responsible use

Only search usernames you have a legitimate reason to look up, and respect the terms of the websites you check.
