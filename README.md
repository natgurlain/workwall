# WorkWall

A small, dependency-free browser extension for **Brave** (and any Chromium browser) that blocks distracting sites
during your focus hours and shows where your time actually goes.

- **Blocks by schedule.** For example, 07:00–20:00 on weekdays. Blocked sites go to a calm focus screen with a
  countdown. Tabs already open on a blocked site are redirected when focus hours start.
- **One-click blocking.** On any site, open the popup and click **Block this site**. During focus hours the tab is
  blocked right away.
- **Tracks your time.** Only the active tab of a focused window counts, and only while you're at the computer
  (idle after 5 minutes without input).
- **Measures the reflex.** Every attempt to open a blocked site is counted per site and per hour. The dashboard shows
  whether attempts are falling day over day and week over week, with a trend line.
- **Logs rule breaks.** Anything that weakens the block during focus hours is logged and resets your clean streak:
  taking a break, removing a site, shortening focus hours, or turning the extension off. Each of the first three
  needs a typed confirmation sentence first.
- **Charts.** Today / 7 / 30-day dashboard: browsing time, focus vs free time, top sites, attempt trends per site,
  rule breaks, and a weekday × hour heatmap. Every chart has hover tooltips and a table view.
- **Private.** Everything stays in the browser's local storage, kept for 90 days. No accounts, servers or analytics.

## Build

You need [Node.js](https://nodejs.org) 18 or newer. The only packages are TypeScript and the Chrome API type
definitions, used at build time. The extension itself ships plain JavaScript with no runtime dependencies.

```bash
npm install
```

```bash
npm run build
```

This writes the ready-to-load extension to `dist/`.

While developing, `npm run watch` recompiles TypeScript on save. After changing a file in `static/`, run
`npm run build` again.

## Install in Brave

1. Open `brave://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `dist` folder.
4. Pin WorkWall: click the puzzle-piece icon in the toolbar, then the pin next to WorkWall.
5. Click the WorkWall icon → **Settings** (gear) to set your sites and focus hours. To block the site you're on,
   open the popup and click **Block this site**.

The same steps work in **Chrome** (`chrome://extensions`), **Edge** (`edge://extensions`) and other Chromium
browsers.

After rebuilding, click the **reload** arrow on WorkWall's card in the extensions page. Your settings and stats are
kept.

> Brave may show a "developer mode extensions" notice on startup. That's expected for unpacked extensions.

## How it works

| File | Role |
|---|---|
| `src/background.ts` | Service worker. A one-minute alarm switches `declarativeNetRequest` redirect rules on and off by schedule, records active-tab time per domain and hour, counts blocked attempts, logs rule breaks, and colors the toolbar icon (blue blocking, orange break, gray off). |
| `src/shared.ts` | Settings, schedule maths, rule-break detection, storage helpers, formatting. |
| `src/blocked.ts` | The focus screen shown instead of a blocked site. |
| `src/popup.ts` | Toolbar popup: today at a glance, top sites, the break flow. |
| `src/dashboard.ts` | Full stats page. |
| `src/options.ts` | Settings: blocklist, focus hours, export and delete data. |
| `src/charts.ts` | Hand-written SVG charts and tooltips. |
| `static/` | HTML, CSS, manifest and icons, copied to `dist/` as they are. |
| `scripts/make-icons.mjs` | Regenerates the toolbar icons (`node scripts/make-icons.mjs`). |

Data lives in `chrome.storage.local`: `settings`, plus one `day:YYYY-MM-DD` entry per day holding seconds per domain
per hour, blocked attempts per domain per hour, and that day's rule breaks.

### Limits worth knowing

- Turning the extension off can't be prevented, only logged. WorkWall notices when it's switched back on and records
  how much focus time was unprotected. If it's never switched back on, nothing is recorded.
- Watching a video without touching the keyboard or mouse for over 5 minutes counts as idle.
- Private windows aren't blocked unless you enable **Allow in Private** for WorkWall on the extensions page.
