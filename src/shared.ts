// Settings, schedule logic and stats storage shared by the background worker and pages.

export interface Settings {
  /** Domains to block; their subdomains are blocked too. */
  blocklist: string[];
  /** Minutes after local midnight when blocking starts. */
  startMin: number;
  /** Minutes after local midnight when blocking ends (exclusive). Smaller than startMin = overnight. */
  endMin: number;
  /** Days of the week with blocking; 0 = Sunday. */
  days: number[];
  /** Epoch ms until which blocking is paused; 0 = not paused. */
  pausedUntil: number;
}

/** Something that weakened the block during focus hours. */
export type ViolationKind = "break" | "removed" | "schedule" | "disabled";

export interface Violation {
  kind: ViolationKind;
  /** Epoch ms when it happened. */
  at: number;
  detail: string;
}

export const VIOLATION_LABELS: Record<ViolationKind, string> = {
  break: "Breaks taken",
  removed: "Sites removed",
  schedule: "Hours shortened",
  disabled: "Extension turned off",
};

/** One local day, every array indexed by local hour (24 entries). */
export interface DayStats {
  /** Seconds on the active tab per domain. */
  time: Record<string, number[]>;
  /** Attempts to open a blocked site, per blocklist domain. */
  blocks: Record<string, number[]>;
  violations: Violation[];
}

export const DEFAULT_SETTINGS: Settings = {
  blocklist: ["youtube.com", "reddit.com", "x.com", "facebook.com", "instagram.com", "tiktok.com"],
  startMin: 7 * 60,
  endMin: 20 * 60,
  days: [1, 2, 3, 4, 5],
  pausedUntil: 0,
};

export const PAUSE_PHRASE = "I am choosing to procrastinate";
export const PAUSE_MINUTES = 15;

export async function getSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings as Partial<Settings> | undefined) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settings });
}

// ---- Schedule ----

export function isScheduled(s: Settings, d: Date): boolean {
  if (!s.days.includes(d.getDay())) return false;
  const m = d.getHours() * 60 + d.getMinutes();
  return s.startMin <= s.endMin ? m >= s.startMin && m < s.endMin : m >= s.startMin || m < s.endMin;
}

export function isBlocking(s: Settings, now = new Date()): boolean {
  return now.getTime() >= s.pausedUntil && isScheduled(s, now);
}

/** Next minute at which the schedule flips on or off, or null if it never does within a week. */
export function nextTransition(s: Settings, now = new Date()): Date | null {
  const current = isScheduled(s, now);
  const t = new Date(now);
  t.setSeconds(0, 0);
  for (let i = 0; i < 8 * 24 * 60; i++) {
    t.setMinutes(t.getMinutes() + 1);
    if (isScheduled(s, t) !== current) return t;
  }
  return null;
}

/** Start of the current scheduled or unscheduled stretch, or null if it began over a week ago. */
export function previousTransition(s: Settings, now = new Date()): Date | null {
  const current = isScheduled(s, now);
  const t = new Date(now);
  t.setSeconds(0, 0);
  for (let i = 0; i < 8 * 24 * 60; i++) {
    const prev = new Date(t.getTime() - 60_000);
    if (isScheduled(s, prev) !== current) return t;
    t.setTime(prev.getTime());
  }
  return null;
}

/** Scheduled minutes in a week, to tell whether a schedule change shortens focus time. */
export function weeklyMinutes(s: Settings): number {
  let minutes = 0;
  const t = new Date(2024, 0, 1); // a Monday
  for (let i = 0; i < 7 * 24 * 60; i++, t.setMinutes(t.getMinutes() + 1)) if (isScheduled(s, t)) minutes++;
  return minutes;
}

/** The rule breaks a settings change from `before` to `after` would cause at `now` (none outside focus hours). */
export function weakenings(before: Settings, after: Settings, now = new Date()): Violation[] {
  if (!isBlocking(before, now)) return [];
  const at = now.getTime();
  const found: Violation[] = [];
  if (after.pausedUntil > at) {
    found.push({ kind: "break", at, detail: `Took a ${Math.round((after.pausedUntil - at) / 60_000)}-minute break` });
  }
  for (const domain of before.blocklist.filter((d) => !after.blocklist.includes(d))) {
    found.push({ kind: "removed", at, detail: `Removed ${domain}` });
  }
  if (weeklyMinutes(after) < weeklyMinutes(before) || !isScheduled(after, now)) {
    found.push({ kind: "schedule", at, detail: `Changed focus hours to ${scheduleText(after)}` });
  }
  return found;
}

export function scheduleText(s: Settings): string {
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days = [1, 2, 3, 4, 5, 6, 0].filter((d) => s.days.includes(d)).map((d) => names[d]);
  return `${minutesToTime(s.startMin)}–${minutesToTime(s.endMin)} ${days.length ? days.join(", ") : "no days"}`;
}

export function describeStatus(s: Settings, now = new Date()): { blocking: boolean; text: string } {
  const next = nextTransition(s, now);
  if (isBlocking(s, now)) {
    return { blocking: true, text: next ? `Blocking until ${whenText(next, now)}` : "Blocking" };
  }
  if (isScheduled(s, now)) {
    const resume = new Date(next ? Math.min(s.pausedUntil, next.getTime()) : s.pausedUntil);
    return { blocking: false, text: `Paused until ${whenText(resume, now)}` };
  }
  return { blocking: false, text: next ? `Free until ${whenText(next, now)}` : "No blocking scheduled" };
}

function whenText(d: Date, now: Date): string {
  const days = Math.round((startOfDay(d) - startOfDay(now)) / 86_400_000);
  if (days === 0) return formatClock(d);
  if (days === 1) return `tomorrow ${formatClock(d)}`;
  return `${d.toLocaleDateString([], { weekday: "short" })} ${formatClock(d)}`;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// ---- Domains ----

/** Hostname of an http(s) URL without a leading "www.", or null for other URLs. */
export function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Turns user input like "https://www.YouTube.com/feed" into "youtube.com"; null if invalid. */
export function normalizeDomain(input: string): string | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  const host = hostOf(s.includes("://") ? s : `https://${s}`);
  return host && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

/** The blocklist entry covering this host (exact or subdomain match). */
export function findBlocked(host: string, blocklist: string[]): string | undefined {
  return blocklist.find((d) => host === d || host.endsWith(`.${d}`));
}

// ---- Stats ----

export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `day:${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function emptyDay(): DayStats {
  return { time: {}, blocks: {}, violations: [] };
}

export async function getDay(key: string): Promise<DayStats> {
  const got = await chrome.storage.local.get(key);
  return { ...emptyDay(), ...(got[key] as Partial<DayStats> | undefined) };
}

/** The last n local days, oldest first, ending today. */
export function lastDays(n: number, now = new Date()): Date[] {
  return Array.from({ length: n }, (_, i) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - (n - 1 - i)));
}

export async function getDays(dates: Date[]): Promise<DayStats[]> {
  const keys = dates.map(dayKey);
  const got = await chrome.storage.local.get(keys);
  return keys.map((k) => ({ ...emptyDay(), ...(got[k] as Partial<DayStats> | undefined) }));
}

/** Blocked attempts per hour for one day, all domains (or just `domain` and its subdomains' entry). */
export function blockHours(day: DayStats, domain?: string): number[] {
  const totals = new Array<number>(24).fill(0);
  for (const [d, hours] of Object.entries(day.blocks)) if (!domain || d === domain) hours.forEach((v, hour) => (totals[hour] += v));
  return totals;
}

export function blockCount(day: DayStats, domain?: string): number {
  return sum(blockHours(day, domain));
}

/** [domain, attempts] across days, most attempts first. */
export function blocksByDomain(days: DayStats[]): [string, number][] {
  const totals = new Map<string, number>();
  for (const day of days) for (const [d, hours] of Object.entries(day.blocks)) totals.set(d, (totals.get(d) ?? 0) + sum(hours));
  return [...totals].sort((a, b) => b[1] - a[1]);
}

/** Days in a row, ending today, without a rule break (days newest last; stops at days with no activity at all). */
export function cleanStreak(days: DayStats[]): number {
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    const day = days[i]!;
    if (day.violations.length) break;
    if (i < days.length - 1 && !Object.keys(day.time).length && !Object.keys(day.blocks).length) break;
    streak++;
  }
  return streak;
}

/** Least-squares line through a series (change per step), using only points where `include[x]` isn't false. */
export function trend(values: number[], include?: boolean[]): { slope: number; at: (x: number) => number } | null {
  const xs = values.map((_, x) => x).filter((x) => include?.[x] !== false);
  if (xs.length < 2) return null;
  const meanX = sum(xs) / xs.length;
  const meanY = sum(xs.map((x) => values[x]!)) / xs.length;
  let num = 0, den = 0;
  for (const x of xs) {
    num += (x - meanX) * (values[x]! - meanY);
    den += (x - meanX) ** 2;
  }
  const slope = num / den;
  return { slope, at: (x) => meanY + slope * (x - meanX) };
}

export const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

/** [host, seconds] pairs across the given days, largest first. */
export function topHosts(days: DayStats[]): [string, number][] {
  const totals = new Map<string, number>();
  for (const day of days) {
    for (const [host, hours] of Object.entries(day.time)) totals.set(host, (totals.get(host) ?? 0) + sum(hours));
  }
  return [...totals].sort((a, b) => b[1] - a[1]);
}

/** Seconds per hour of the day, all domains together. */
export function hourTotals(day: DayStats): number[] {
  const totals = new Array<number>(24).fill(0);
  for (const hours of Object.values(day.time)) hours.forEach((v, h) => (totals[h] += v));
  return totals;
}

/** Downloads settings and every stored day as a JSON file. */
export async function exportData(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const blob = new Blob([JSON.stringify(all, null, 2)], { type: "application/json" });
  const link = h("a", { href: URL.createObjectURL(blob), download: `workwall-${dayKey(new Date()).slice(4)}.json` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

/**
 * The "type this sentence to confirm" friction: shows PAUSE_PHRASE with the typed prefix highlighted and the first
 * mistake marked; paste is blocked. `onChange` gets whether the sentence is complete.
 */
export function phraseField(onChange: (complete: boolean) => void): { root: HTMLElement; input: HTMLInputElement } {
  const phrase = h("div", { className: "phrase" });
  phrase.setAttribute("aria-hidden", "true");
  const input = h("input", { className: "input", autocomplete: "off", spellcheck: false });
  input.setAttribute("aria-label", `Type: ${PAUSE_PHRASE}`);
  const render = () => {
    const typed = input.value;
    let ok = 0;
    while (ok < typed.length && ok < PAUSE_PHRASE.length && typed[ok]!.toLowerCase() === PAUSE_PHRASE[ok]!.toLowerCase()) ok++;
    const wrong = typed.length > ok ? 1 : 0;
    phrase.replaceChildren(
      h("span", { className: "ok", textContent: PAUSE_PHRASE.slice(0, ok) }),
      h("span", { className: "bad", textContent: PAUSE_PHRASE.slice(ok, ok + wrong) }),
      PAUSE_PHRASE.slice(ok + wrong),
    );
    onChange(typed.trim().toLowerCase() === PAUSE_PHRASE.toLowerCase());
  };
  input.addEventListener("input", render);
  input.addEventListener("paste", (e) => e.preventDefault());
  render();
  return { root: h("div", { className: "phrase-field" }, phrase, input), input };
}

/** Brief confirmation message at the bottom of the page. */
export function toast(message: string): void {
  const node = (document.querySelector(".toast") as HTMLElement | null) ?? document.body.appendChild(h("div", { className: "toast", role: "status" }));
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(Number(node.dataset.timer));
  node.dataset.timer = String(setTimeout(() => node.classList.remove("show"), 2200));
}

// ---- Formatting ----

export function formatDuration(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 1) return seconds > 0 ? "<1m" : "0m";
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

export function formatClock(d: Date): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function minutesToTime(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

export function timeToMinutes(value: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Browser-cached favicon for a domain (needs the "favicon" permission). */
export function faviconUrl(host: string, size = 32): string {
  return chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(`https://${host}`)}&size=${size}`);
}

/** <img> with the site's favicon. */
export function favicon(host: string, size = 16): HTMLImageElement {
  const img = document.createElement("img");
  img.className = "favicon";
  img.src = faviconUrl(host, size * 2);
  img.width = img.height = size;
  img.alt = "";
  img.loading = "lazy";
  return img;
}

/** Small element factory: h("div", { className: "x" }, "text", child). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const { dataset, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (dataset) Object.assign(node.dataset, dataset);
  for (const child of children) if (child) node.append(child);
  return node;
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}
