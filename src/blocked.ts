// The page blocked sites are redirected to: a countdown ring to the end of focus hours and today's numbers.
import {
  type DayStats,
  blockCount,
  byId,
  cleanStreak,
  describeStatus,
  favicon,
  findBlocked,
  formatClock,
  getDays,
  getSettings,
  isBlocking,
  isScheduled,
  lastDays,
  nextTransition,
  previousTransition,
  sum,
} from "./shared.js";

const domain = new URLSearchParams(location.search).get("d") ?? "";
const RADIUS = 104;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const HEADLINES = [
  "Back to what matters.",
  "Not now. Future you says thanks.",
  "Deep work beats doom-scrolling.",
  "Stay with the hard thing.",
  "One focused hour is worth three distracted ones.",
];

function setup(): void {
  const chip = byId("chip");
  chip.replaceChildren(favicon(domain, 16), domain || "This site", lockIcon());
  byId("headline").textContent = HEADLINES[Math.floor(Math.random() * HEADLINES.length)]!;
  byId("stat-today-label").textContent = `Tries to open ${domain} today`;

  const ticks = byId("ticks");
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * 2 * Math.PI;
    const inner = i % 5 === 0 ? 86 : 90;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("class", "tick");
    line.setAttribute("x1", String(120 + Math.cos(a) * inner));
    line.setAttribute("y1", String(120 + Math.sin(a) * inner));
    line.setAttribute("x2", String(120 + Math.cos(a) * 92));
    line.setAttribute("y2", String(120 + Math.sin(a) * 92));
    if (i % 5) line.style.opacity = "0.5";
    ticks.append(line);
  }
  const progress = byId("progress") as unknown as SVGCircleElement;
  progress.style.strokeDasharray = String(CIRCUMFERENCE);

  byId("primary").addEventListener("click", primaryAction);
}

let blocking = true;

async function primaryAction(): Promise<void> {
  if (!blocking) {
    location.href = `https://${domain}`;
  } else if (history.length > 1) {
    history.back();
  } else {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id !== undefined) await chrome.tabs.remove(tab.id);
  }
}

async function render(): Promise<void> {
  const settings = await getSettings();
  const now = new Date();
  blocking = isBlocking(settings, now) && !!findBlocked(domain, settings.blocklist);
  const status = describeStatus(settings, now);
  const next = nextTransition(settings, now);
  const paused = !blocking && isScheduled(settings, now);

  document.body.classList.toggle("free", !blocking);
  const pill = byId("pill");
  pill.className = `pill ${blocking ? "on" : paused ? "paused" : ""}`;
  pill.textContent = blocking ? "Focus on" : paused ? "On a break" : "Focus off";

  const progress = byId("progress") as unknown as SVGCircleElement;
  if (blocking && next) {
    const start = previousTransition(settings, now) ?? now;
    const total = next.getTime() - start.getTime();
    const fraction = total > 0 ? (now.getTime() - start.getTime()) / total : 1;
    progress.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - fraction));
    byId("countdown").innerHTML = countdown(next.getTime() - now.getTime());
    byId("until").textContent = `until ${formatClock(next)}`;
    byId("lede").textContent = `${domain} is on your blocklist during focus hours. You'll get it back at ${formatClock(next)}.`;
    byId("primary").textContent = history.length > 1 ? "Go back" : "Close tab";
  } else {
    progress.style.strokeDashoffset = "0";
    byId("countdown").textContent = "Free";
    byId("until").textContent = status.text;
    byId("headline").textContent = paused ? "You're on a break." : "Focus hours are over.";
    byId("lede").textContent = paused ? "Enjoy it — blocking resumes automatically." : "Nice work today. The web is all yours.";
    byId("primary").textContent = `Continue to ${domain}`;
  }
}

/** "2:05:09" with dimmed seconds, or "4:09" under an hour. */
function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = String(s % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}<small>:${seconds}</small>`
    : `${minutes}<small>:${seconds}</small>`;
}

async function renderStats(): Promise<void> {
  const days = await getDays(lastDays(90));
  const count = (list: DayStats[]) => sum(list.map((d) => blockCount(d, domain)));
  byId("stat-today").textContent = String(blockCount(days.at(-1)!, domain));
  const week = count(days.slice(-7));
  const lastWeek = count(days.slice(-14, -7));
  byId("stat-week").textContent = String(week);
  byId("stat-week-label").textContent =
    lastWeek === 0 ? "Attempts in 7 days" : week <= lastWeek ? `Attempts in 7 days · ▼ ${lastWeek - week} vs last week` : `Attempts in 7 days · ▲ ${week - lastWeek} vs last week`;
  const streak = cleanStreak(days);
  byId("stat-streak").textContent = `${streak} ${streak === 1 ? "day" : "days"}`;
}

function lockIcon(): SVGSVGElement {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("class", "icon lock");
  icon.innerHTML = '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>';
  return icon;
}

setup();
void render();
setInterval(render, 1000);
// Report the attempt (the background counts it), then show the updated numbers. Reloads, back/forward visits and
// tabs WorkWall redirected itself when focus hours began are not new attempts.
const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
const isAttempt = !new URLSearchParams(location.search).has("auto") && navigation?.type !== "reload" && navigation?.type !== "back_forward";
void (isAttempt ? chrome.runtime.sendMessage({ type: "blocked", domain }) : Promise.resolve())
  .catch(() => undefined)
  .finally(() => void renderStats());
