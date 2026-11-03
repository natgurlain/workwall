// Full stats page: KPIs vs the previous period, daily rhythm, top sites, blocked attempts and a weekday × hour heatmap.
import {
  type Column,
  type CountPoint,
  type HeatRow,
  countColumns,
  dataTable,
  escapeHtml,
  heatmap,
  sparkline,
  stackedColumns,
  tooltip,
} from "./charts.js";
import {
  type DayStats,
  type Settings,
  VIOLATION_LABELS,
  type Violation,
  type ViolationKind,
  blockCount,
  blockHours,
  blocksByDomain,
  byId,
  cleanStreak,
  trend,
  describeStatus,
  favicon,
  findBlocked,
  formatDuration,
  getDays,
  getSettings,
  h,
  hourTotals,
  isBlocking,
  isScheduled,
  lastDays,
  sum,
  topHosts,
} from "./shared.js";

const RANGES = [1, 7, 30];
const WEEKDAYS: [number, string][] = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"]];
const SITES_COLLAPSED = 8;

let range = readRange();
let showAllSites = false;

function readRange(): number {
  try {
    const saved = Number(localStorage.getItem("range"));
    return RANGES.includes(saved) ? saved : 7;
  } catch {
    return 7;
  }
}

/** Seconds in scheduled vs unscheduled hours for one day. */
function split(settings: Settings, date: Date, day: DayStats): { focus: number; free: number } {
  const hours = hourTotals(day);
  const focus = sum(hours.filter((_, hour) => isScheduled(settings, atHour(date, hour))));
  return { focus, free: sum(hours) - focus };
}

function atHour(date: Date, hour: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour);
}

function delta(current: number, previous: number, label: string): string {
  if (previous <= 0) return current > 0 ? `none in ${label}` : `same as ${label}`;
  const change = Math.round(((current - previous) / previous) * 100);
  if (change === 0) return `Same as ${label}`;
  return `<span class="delta">${change > 0 ? "▲" : "▼"} ${Math.abs(change)}%</span> vs ${label}`;
}

async function render(): Promise<void> {
  const settings = await getSettings();
  const now = new Date();
  const allDates = lastDays(range * 2, now);
  const allDays = await getDays(allDates);
  const dates = allDates.slice(range);
  const days = allDays.slice(range);
  const previous = allDays.slice(0, range);

  for (const button of byId("range").querySelectorAll<HTMLButtonElement>("button")) {
    button.setAttribute("aria-pressed", String(Number(button.dataset.days) === range));
  }
  const fmt = (d: Date) => d.toLocaleDateString([], { day: "numeric", month: "short" });
  byId("range-label").textContent =
    range === 1 ? `Today · ${now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}` : `Last ${range} days · ${fmt(dates[0]!)} – ${fmt(now)}`;
  const status = byId("status");
  status.className = `pill ${isBlocking(settings, now) ? "on" : isScheduled(settings, now) ? "paused" : ""}`;
  status.textContent = describeStatus(settings, now).text;

  const history = await getDays(lastDays(90, now));
  const hasAnyData = history.some((d) => Object.keys(d.time).length || Object.keys(d.blocks).length || d.violations.length);
  byId("onboarding").hidden = hasAnyData;
  byId("content").hidden = !hasAnyData;
  if (!hasAnyData) return;

  const prevLabel = range === 1 ? "yesterday" : `previous ${range} days`;
  const splits = days.map((d, i) => split(settings, dates[i]!, d));
  const prevSplits = previous.map((d, i) => split(settings, allDates[i]!, d));
  const total = sum(splits.map((s) => s.focus + s.free));
  const focus = sum(splits.map((s) => s.focus));
  const blockTotal = sum(days.map((d) => blockCount(d)));
  const prevBlockTotal = sum(previous.map((d) => blockCount(d)));
  const breaks = days.flatMap((d) => d.violations);
  const sites = topHosts(days);

  // KPIs
  byId("kpi-total").textContent = formatDuration(total);
  byId("kpi-total-meta").innerHTML =
    (range > 1 ? `${formatDuration(total / range)} a day · ` : "") + delta(total, sum(prevSplits.map((s) => s.focus + s.free)), prevLabel);
  byId("kpi-focus").textContent = formatDuration(focus);
  byId("kpi-focus-meta").innerHTML = `${total ? Math.round((focus / total) * 100) : 0}% of browsing · ${delta(focus, sum(prevSplits.map((s) => s.focus)), prevLabel)}`;
  byId("kpi-blocks").textContent = String(blockTotal);
  byId("kpi-blocks-meta").innerHTML = delta(blockTotal, prevBlockTotal, prevLabel);
  byId("kpi-breaks").textContent = String(breaks.length);
  const streak = cleanStreak(history);
  byId("kpi-breaks-meta").innerHTML = `${streak}-day clean streak · ${delta(breaks.length, sum(previous.map((d) => d.violations.length)), prevLabel)}`;

  // Daily rhythm: hourly for today, daily otherwise.
  let columns: Column[];
  if (range === 1) {
    const hours = hourTotals(days[0]!);
    columns = hours.map((v, hour) => {
      const inFocus = isScheduled(settings, atHour(now, hour));
      return { label: String(hour).padStart(2, "0"), title: `${String(hour).padStart(2, "0")}:00`, focus: inFocus ? v : 0, free: inFocus ? 0 : v };
    });
    byId("rhythm-sub").textContent = "Today, hour by hour.";
  } else {
    columns = dates.map((date, i) => ({
      label: range === 7 ? date.toLocaleDateString([], { weekday: "short" }) : String(date.getDate()),
      title: date.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" }),
      ...splits[i]!,
    }));
    byId("rhythm-sub").textContent = `Browsing per day, split by your focus hours.`;
  }
  stackedColumns(byId("rhythm"), columns, range === 1 ? 3 : range === 30 ? 3 : 1);
  byId("rhythm-table").replaceChildren(
    dataTable([range === 1 ? "Hour" : "Day", "Focus hours", "Free time", "Total"], columns.map((c) => [c.title, formatDuration(c.focus), formatDuration(c.free), formatDuration(c.focus + c.free)])),
  );

  renderUrges(settings, dates, days, previous, blockTotal, prevBlockTotal, prevLabel);
  renderSites(sites, total, settings);
  renderBreaks(breaks);

  // Heatmap by weekday (Jan 1 2024 was a Monday, used to evaluate the schedule per weekday).
  const rows: HeatRow[] = WEEKDAYS.map(([weekday, label]) => {
    const values = new Array<number>(24).fill(0);
    days.forEach((day, i) => dates[i]!.getDay() === weekday && hourTotals(day).forEach((v, hour) => (values[hour] += v)));
    const sample = new Date(2024, 0, 1 + ((weekday + 6) % 7));
    return { label, values, focus: values.map((_, hour) => isScheduled(settings, atHour(sample, hour))) };
  });
  heatmap(byId("heatmap"), rows);
  byId("heatmap-table").replaceChildren(
    dataTable(["Day", ...Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0"))], rows.map((r) => [r.label, ...r.values.map((v) => (v ? Math.round(v / 60) : ""))])),
  );
}

function renderSites(sites: [string, number][], total: number, settings: Settings): void {
  const list = byId("sites");
  const more = byId<HTMLButtonElement>("more");
  if (!sites.length) {
    list.replaceChildren(h("li", { className: "note" }, "No browsing tracked in this range."));
    more.hidden = true;
    return;
  }
  const shown = showAllSites ? sites.slice(0, 50) : sites.slice(0, SITES_COLLAPSED);
  const max = sites[0]![1];
  list.replaceChildren(
    ...shown.map(([host, seconds], i) => {
      const blocked = !!findBlocked(host, settings.blocklist);
      const bar = h("div", { className: "row-bar" });
      bar.style.width = `${(seconds / max) * 100}%`;
      bar.style.animationDelay = `${i * 30}ms`;
      const share = total ? (seconds / total) * 100 : 0;
      const row = h(
        "li",
        { className: "row", tabIndex: 0 },
        favicon(host),
        h("div", { className: "row-name" }, h("span", { textContent: host }), blocked ? lockIcon() : null),
        h("div", {}, bar),
        h("span", { className: "row-time", textContent: formatDuration(seconds) }),
        h("span", { className: "row-share", textContent: `${share < 1 ? "<1" : Math.round(share)}%` }),
      );
      tooltip(row, () =>
        `<b>${escapeHtml(host)}</b><br>${formatDuration(seconds)} · ${share.toFixed(1)}% of browsing` +
        (range > 1 ? `<br>${formatDuration(seconds / range)} a day on average` : "") +
        (blocked ? "<br>Blocked during focus hours" : ""),
      );
      return row;
    }),
  );
  more.hidden = sites.length <= SITES_COLLAPSED;
  more.textContent = showAllSites ? "Show less" : `Show all ${sites.length} sites`;
}

/** Blocked attempts over time: are fewer reflex visits happening? Per site with sparklines. */
function renderUrges(settings: Settings, dates: Date[], days: DayStats[], previous: DayStats[], current: number, before: number, prevLabel: string): void {
  // One value per column: hours for today, days otherwise.
  const series = (domain?: string): number[] => (range === 1 ? blockHours(days[0]!, domain) : days.map((d) => blockCount(d, domain)));
  const totals = series();
  const points: CountPoint[] = totals.map((value, i) =>
    range === 1
      ? { label: String(i).padStart(2, "0"), title: `${String(i).padStart(2, "0")}:00–${String(i + 1).padStart(2, "0")}:00`, value }
      : {
          label: range === 7 ? dates[i]!.toLocaleDateString([], { weekday: "short" }) : String(dates[i]!.getDate()),
          title: dates[i]!.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" }),
          value,
        },
  );
  // Fit the trend only where blocking could happen: focus hours today, or days with focus hours.
  const inTrend =
    range === 1
      ? totals.map((_, hour) => isScheduled(settings, atHour(dates[0]!, hour)))
      : dates.map((date) => Array.from({ length: 24 }, (_, hour) => isScheduled(settings, atHour(date, hour))).some(Boolean));
  countColumns(byId("urge"), points, range === 1 || range === 30 ? 3 : 1, inTrend);

  let verdict: string;
  if (!current && !before) verdict = "No blocked attempts in this range or the one before.";
  else if (!before) verdict = `${current} attempts, none in ${prevLabel} to compare with.`;
  else if (current < before) verdict = `Down ${Math.round(((before - current) / before) * 100)}% vs ${prevLabel} (${before} → ${current}).`;
  else if (current > before) verdict = `Up ${Math.round(((current - before) / before) * 100)}% vs ${prevLabel} (${before} → ${current}). The pull got stronger.`;
  else verdict = `Same as ${prevLabel} (${current}).`;
  const line = range > 1 && current ? trend(totals, inTrend) : null;
  if (line && Math.abs(line.slope * 7) >= 0.5) {
    const perWeek = line.slope * 7;
    verdict += ` Trend: ${perWeek < 0 ? "−" : "+"}${Math.abs(perWeek).toFixed(1)} attempts per week${perWeek < 0 ? ", the reflex is fading" : ""}.`;
  }
  byId("urge-sub").textContent = verdict;

  byId("spark-label").textContent = range === 1 ? "By hour" : "By day";
  const before_ = new Map(blocksByDomain(previous));
  const sites = blocksByDomain(days);
  const list = byId("urge-sites");
  if (!sites.length) {
    list.replaceChildren(h("li", { className: "note" }, "Nothing blocked in this range. Either you were focused — or it was a day off."));
  } else {
    list.replaceChildren(
      ...sites.slice(0, 8).map(([domain, count]) => {
        const prev = before_.get(domain) ?? 0;
        const diff = count - prev;
        const change = h("span", {
          // Only color real comparisons; a site with no earlier attempts isn't "worse".
          className: `change num-cell ${!prev ? "" : diff < 0 ? "down" : diff > 0 ? "up" : ""}`,
          textContent: !prev ? "new" : diff === 0 ? "same" : diff < 0 ? `▼ ${-diff} fewer` : `▲ ${diff} more`,
        });
        const values = series(domain);
        const row = h(
          "li",
          { className: "row", tabIndex: 0 },
          favicon(domain),
          h("div", { className: "row-name" }, h("span", { textContent: domain })),
          h("div", { className: "spark-cell" }, sparkline(values, `${domain} attempts ${range === 1 ? "by hour" : "by day"}`)),
          h("span", { className: "row-time num-cell", textContent: String(count) }),
          change,
        );
        tooltip(row, () => `<b>${escapeHtml(domain)}</b><br>${count} attempts · ${prev} ${prevLabel}${range > 1 ? `<br>Busiest day: ${Math.max(...values)}` : ""}`);
        return row;
      }),
    );
  }
  byId("urge-table").replaceChildren(
    dataTable(["Site", "Attempts", prevLabel], sites.map(([domain, count]) => [domain, count, before_.get(domain) ?? 0])),
  );
}

function renderBreaks(breaks: Violation[]): void {
  byId("break-kinds").replaceChildren(
    ...(Object.keys(VIOLATION_LABELS) as ViolationKind[]).map((kind) => {
      const n = breaks.filter((b) => b.kind === kind).length;
      return h("div", { className: `kind${n ? "" : " zero"}` }, h("b", { textContent: String(n) }), h("span", { textContent: VIOLATION_LABELS[kind] }));
    }),
  );
  const recent = [...breaks].sort((a, b) => b.at - a.at).slice(0, 6);
  byId("events").replaceChildren(
    ...(recent.length
      ? recent.map((b) =>
          h(
            "li",
            { className: "event" },
            h("span", { textContent: b.detail }),
            h("time", {
              dateTime: new Date(b.at).toISOString(),
              textContent: new Date(b.at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }),
            }),
          ),
        )
      : [h("li", { className: "clean" }, "No rule breaks in this range. That's real discipline.")]),
  );
}

function lockIcon(): SVGSVGElement {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("class", "icon");
  icon.innerHTML = '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>';
  return icon;
}

byId("range").addEventListener("click", (e) => {
  const days = Number((e.target as HTMLElement).closest("button")?.dataset.days);
  if (!RANGES.includes(days) || days === range) return;
  range = days;
  showAllSites = false;
  try {
    localStorage.setItem("range", String(range));
  } catch {
    // Remembering the range is a convenience only.
  }
  void render();
});
byId("more").addEventListener("click", () => {
  showAllSites = !showAllSites;
  void render();
});
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void render());
void render();
