// Toolbar popup: status, today's time with an hourly strip, top sites, and the break flow.
import { hourStrip } from "./charts.js";
import {
  PAUSE_MINUTES,
  phraseField,
  blockCount,
  byId,
  cleanStreak,
  dayKey,
  getDays,
  lastDays,
  describeStatus,
  favicon,
  findBlocked,
  formatDuration,
  hostOf,
  normalizeDomain,
  getDay,
  getSettings,
  h,
  hourTotals,
  isBlocking,
  isScheduled,
  saveSettings,
  sum,
  topHosts,
} from "./shared.js";

async function renderStatus(): Promise<void> {
  const settings = await getSettings();
  const now = new Date();
  const status = describeStatus(settings, now);
  const blocking = isBlocking(settings, now);
  const paused = !blocking && isScheduled(settings, now);
  const pill = byId("status");
  pill.className = `pill ${blocking ? "on" : paused ? "paused" : ""}`;
  pill.textContent = status.text;
  byId("take-break").hidden = !blocking;
  byId("paused-banner").hidden = !paused;
  if (paused) {
    const s = Math.max(0, Math.ceil((settings.pausedUntil - now.getTime()) / 1000));
    byId("break-left").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
}

async function renderData(): Promise<void> {
  const settings = await getSettings();
  const now = new Date();
  const day = await getDay(dayKey(now));
  const hours = hourTotals(day);
  const focus = hours.map((_, hour) => isScheduled(settings, new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour)));
  const focusTime = sum(hours.filter((_, hour) => focus[hour]));
  const total = sum(hours);

  byId("total").textContent = formatDuration(total);
  byId("focus-time").textContent = formatDuration(focusTime);
  byId("free-time").textContent = formatDuration(total - focusTime);
  hourStrip(byId("strip"), hours, focus, now.getHours());

  const recent = await getDays(lastDays(90, now));
  const attempts = blockCount(day);
  const yesterday = blockCount(recent.at(-2)!);
  byId("attempts").textContent = String(attempts);
  byId("attempts-meta").textContent = attempts === 1 ? "blocked attempt today" : "blocked attempts today";
  byId("attempts").parentElement!.title = `${yesterday} yesterday`;
  byId("breaks").textContent = String(day.violations.length);
  byId("breaks-meta").textContent = day.violations.length === 1 ? "rule break today" : "rule breaks today";
  const streak = cleanStreak(recent);
  byId("streak").textContent = String(streak);
  byId("streak-meta").textContent = streak === 1 ? "day clean streak" : "days clean streak";

  const top = topHosts([day]).slice(0, 5);
  const list = byId("sites");
  if (!top.length) {
    list.replaceChildren(h("li", { className: "empty" }, "Nothing tracked yet today. Sites appear here within a minute of browsing."));
    return;
  }
  const max = top[0]![1];
  list.replaceChildren(
    ...top.map(([host, seconds], i) => {
      const bar = h("div");
      bar.style.width = `${(seconds / max) * 100}%`;
      bar.style.animationDelay = `${i * 40}ms`;
      return h(
        "li",
        { className: "site", title: `${host} · ${formatDuration(seconds)}` },
        favicon(host),
        h("div", { className: "site-name" }, h("span", { textContent: host }), findBlocked(host, settings.blocklist) ? lockIcon() : null),
        h("span", { className: "site-time num", textContent: formatDuration(seconds) }),
        h("div", { className: "track" }, bar),
      );
    }),
  );
}

// ---- Block the current tab's site ----

/** The active tab's site as a blocklist entry, or null for pages that can't be blocked (new tab, settings, files). */
async function currentSite(): Promise<string | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return normalizeDomain(hostOf(tab?.url) ?? "");
}

async function renderCurrent(): Promise<void> {
  const host = await currentSite();
  byId("current").hidden = !host;
  if (!host) return;
  const covered = findBlocked(host, (await getSettings()).blocklist);
  byId("current-site").replaceChildren(favicon(host), h("span", { textContent: host }));
  const button = byId<HTMLButtonElement>("block-current");
  button.disabled = !!covered;
  button.textContent = !covered ? "Block this site" : covered === host ? "✓ Blocked" : `✓ Blocked via ${covered}`;
}

async function blockCurrent(): Promise<void> {
  const host = await currentSite();
  const settings = await getSettings();
  // Adding never weakens the block, so it isn't a rule break. During focus hours the background
  // redirects the tab right away when it sees the settings change.
  if (host && !findBlocked(host, settings.blocklist)) await saveSettings({ ...settings, blocklist: [...settings.blocklist, host] });
  await Promise.all([renderCurrent(), renderData()]);
}

// ---- Break flow ----

function showBreak(open: boolean): void {
  byId("main").hidden = open;
  byId("break").hidden = !open;
  if (open) {
    const start = byId<HTMLButtonElement>("start-break");
    const field = phraseField((complete) => (start.disabled = !complete));
    field.input.addEventListener("keydown", (e) => e.key === "Enter" && !start.disabled && void startBreak());
    byId("phrase-slot").replaceChildren(field.root);
    field.input.focus();
  }
}

async function startBreak(): Promise<void> {
  const settings = await getSettings();
  await saveSettings({ ...settings, pausedUntil: Date.now() + PAUSE_MINUTES * 60_000 });
  showBreak(false);
  void renderStatus();
}

async function endBreak(): Promise<void> {
  await saveSettings({ ...(await getSettings()), pausedUntil: 0 });
  void renderStatus();
}

function lockIcon(): SVGSVGElement {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("class", "icon");
  icon.setAttribute("aria-label", "Blocked during focus hours");
  icon.innerHTML = '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>';
  return icon;
}

byId("break-minutes").textContent = String(PAUSE_MINUTES);
byId("open-dashboard").addEventListener("click", () => void chrome.tabs.create({ url: "dashboard.html" }));
byId("open-settings").addEventListener("click", () => void chrome.runtime.openOptionsPage());
byId("take-break").addEventListener("click", () => showBreak(true));
byId("cancel-break").addEventListener("click", () => showBreak(false));
byId("start-break").addEventListener("click", () => void startBreak());
byId("end-break").addEventListener("click", () => void endBreak());
byId("block-current").addEventListener("click", () => void blockCurrent());

void renderStatus();
void renderData();
void renderCurrent();
setInterval(renderStatus, 1000);
