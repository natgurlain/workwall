// Service worker: turns blocking rules on/off by schedule, tracks active-tab time, keeps the toolbar icon in sync.
import {
  DEFAULT_SETTINGS,
  type DayStats,
  type Settings,
  type Violation,
  dayKey,
  describeStatus,
  findBlocked,
  formatDuration,
  getDay,
  getSettings,
  hostOf,
  isBlocking,
  isScheduled,
  normalizeDomain,
  weakenings,
} from "./shared.js";

const TICK_ALARM = "tick";
/** No keyboard/mouse input for this long counts as away; tracking stops. */
const IDLE_SECONDS = 300;
/** A longer gap between tracking updates means the machine slept or the worker died; that time is dropped. */
const MAX_GAP_MS = 5 * 60_000;
const RETENTION_DAYS = 90;

/** The tab being timed right now, kept in session storage because the worker can be suspended at any time. */
interface Visit {
  host: string;
  start: number;
}

// Every storage read-modify-write goes through this queue so concurrent events can't lose updates.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  queue = run.catch((error) => console.error("WorkWall:", error));
  return run;
}

// ---- Time tracking ----

/** Adds [start, end) to the host's per-hour totals, splitting across hour and day boundaries. */
async function addTime(host: string, start: number, end: number): Promise<void> {
  const days: Record<string, DayStats> = {};
  for (let t = start; t < end; ) {
    const d = new Date(t);
    const nextHour = new Date(d);
    nextHour.setMinutes(60, 0, 0);
    const segmentEnd = Math.min(end, nextHour.getTime());
    const key = dayKey(d);
    const day = (days[key] ??= await getDay(key));
    const hours = (day.time[host] ??= new Array<number>(24).fill(0));
    hours[d.getHours()] += (segmentEnd - t) / 1000;
    t = segmentEnd;
  }
  await chrome.storage.local.set(days);
}

/** Host of the active tab in the focused browser window, or null when away or unfocused. */
async function activeHost(): Promise<string | null> {
  if ((await chrome.idle.queryState(IDLE_SECONDS)) !== "active") return null;
  try {
    const win = await chrome.windows.getLastFocused({ populate: true, windowTypes: ["normal"] });
    return win.focused ? hostOf(win.tabs?.find((t) => t.active)?.url) : null;
  } catch {
    return null; // no windows open
  }
}

async function updateVisit(): Promise<void> {
  const now = Date.now();
  const { visit } = (await chrome.storage.session.get("visit")) as { visit?: Visit };
  if (visit && now > visit.start && now - visit.start <= MAX_GAP_MS) await addTime(visit.host, visit.start, now);
  const host = await activeHost();
  if (host) await chrome.storage.session.set({ visit: { host, start: now } satisfies Visit });
  else await chrome.storage.session.remove("visit");
}

async function recordBlock(domain: string): Promise<void> {
  const now = new Date();
  const key = dayKey(now);
  const day = await getDay(key);
  (day.blocks[domain] ??= new Array<number>(24).fill(0))[now.getHours()]! += 1;
  await chrome.storage.local.set({ [key]: day });
}

async function recordViolation(violation: Violation): Promise<void> {
  const key = dayKey(new Date(violation.at));
  const day = await getDay(key);
  day.violations.push(violation);
  await chrome.storage.local.set({ [key]: day });
}

// ---- Detecting the extension being switched off ----
// Session storage survives sleep and worker restarts but is wiped when the extension is disabled. A worker that finds it
// empty, without a browser start or install/update event, was just re-enabled; the time since the last heartbeat that
// fell in focus hours is logged as a rule break. (While disabled nothing can run, so it's recorded on re-enable.)

let startedBy: "startup" | "install" | null = null;

async function checkReenabled(): Promise<void> {
  const { alive } = await chrome.storage.session.get("alive");
  if (alive) return;
  await chrome.storage.session.set({ alive: true });
  await new Promise((resolve) => setTimeout(resolve, 2000)); // let onStartup/onInstalled fire first
  if (startedBy) return;
  await serial(async () => {
    const { lastSeen } = await chrome.storage.local.get("lastSeen");
    if (typeof lastSeen !== "number") return;
    const settings = await getSettings();
    let missed = 0;
    for (let t = lastSeen; t < Date.now() && missed < 7 * 24 * 60; t += 60_000) if (isScheduled(settings, new Date(t))) missed++;
    if (missed >= 2) {
      await recordViolation({ kind: "disabled", at: lastSeen, detail: `Blocking was off for ${formatDuration(missed * 60)} of focus time` });
    }
  });
}

async function pruneOldDays(): Promise<void> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const oldest = dayKey(cutoff);
  const stale = Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith("day:") && k < oldest);
  if (stale.length) await chrome.storage.local.remove(stale);
}

// ---- Blocking ----

function blockedPage(domain: string): string {
  return `/blocked.html?d=${encodeURIComponent(domain)}`;
}

function blockRule(id: number, domain: string): chrome.declarativeNetRequest.Rule {
  return {
    id,
    priority: 1,
    action: {
      type: chrome.declarativeNetRequest.RuleActionType.REDIRECT,
      redirect: { extensionPath: blockedPage(domain) },
    },
    condition: { requestDomains: [domain], resourceTypes: [chrome.declarativeNetRequest.ResourceType.MAIN_FRAME] },
  };
}

let lastIconState = "";

async function syncBlocking(): Promise<void> {
  const settings = await getSettings();
  const active = isBlocking(settings);
  const wanted = active ? settings.blocklist : [];
  const rules = (await chrome.declarativeNetRequest.getDynamicRules()).sort((a, b) => a.id - b.id);
  if (rules.map((r) => r.condition.requestDomains?.[0]).join() !== wanted.join()) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: rules.map((r) => r.id),
      addRules: wanted.map((domain, i) => blockRule(i + 1, domain)),
    });
  }

  const iconState = active ? "on" : isScheduled(settings, new Date()) ? "paused" : "off";
  if (iconState !== lastIconState) {
    lastIconState = iconState;
    await chrome.action.setIcon({
      path: Object.fromEntries([16, 32, 48].map((size) => [size, `icons/${iconState}-${size}.png`])),
    });
  }
  await chrome.action.setTitle({ title: `WorkWall · ${describeStatus(settings).text}` });

  await chrome.storage.local.set({ lastSeen: Date.now() });

  if (!active) return;
  // Rules only catch new navigations; send tabs already open on a blocked site to the block page.
  // These weren't attempts by the user, so the page is told not to count them.
  for (const tab of await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] })) {
    const host = hostOf(tab.url);
    const domain = host && findBlocked(host, settings.blocklist);
    if (tab.id !== undefined && domain) await chrome.tabs.update(tab.id, { url: `${blockedPage(domain)}&auto=1` });
  }
}

// ---- Wiring ----

function tick(): void {
  void serial(updateVisit);
  void serial(syncBlocking);
}

chrome.runtime.onInstalled.addListener(() => {
  startedBy = "install";
  void serial(pruneOldDays);
});
chrome.runtime.onStartup.addListener(() => {
  startedBy = "startup";
  void serial(pruneOldDays);
});
chrome.alarms.onAlarm.addListener((alarm) => alarm.name === TICK_ALARM && tick());
chrome.tabs.onActivated.addListener(() => void serial(updateVisit));
chrome.tabs.onUpdated.addListener((_id, change, tab) => tab.active && change.url && void serial(updateVisit));
chrome.windows.onFocusChanged.addListener(() => void serial(updateVisit));
chrome.idle.onStateChanged.addListener(() => void serial(updateVisit));
// Any settings change that weakens an active block (from any page) is logged as a rule break.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  const before = { ...DEFAULT_SETTINGS, ...(changes.settings.oldValue as Partial<Settings> | undefined) };
  const after = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue as Partial<Settings> | undefined) };
  void serial(async () => {
    for (const violation of weakenings(before, after)) await recordViolation(violation);
  });
  void serial(syncBlocking);
});

// The block page reports each blocked visit. It is web-accessible, so validate the domain against the blocklist.
chrome.runtime.onMessage.addListener((message: { type?: string; domain?: string }, _sender, sendResponse) => {
  if (message.type !== "blocked" || typeof message.domain !== "string") return false;
  const domain = normalizeDomain(message.domain);
  serial(async () => {
    if (domain && (await getSettings()).blocklist.includes(domain)) await recordBlock(domain);
  }).then(
    () => sendResponse(true),
    () => sendResponse(false),
  );
  return true;
});

// Runs every time the worker starts (install, browser start, or wake-up from suspension).
chrome.idle.setDetectionInterval(IDLE_SECONDS);
void chrome.alarms.get(TICK_ALARM).then((alarm) => {
  if (!alarm) void chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
});
void checkReenabled().finally(tick);
