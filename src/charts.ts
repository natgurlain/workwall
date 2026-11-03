// Dependency-free SVG charts and a shared hover tooltip. Colors come from CSS classes in styles.css / page CSS.
import { formatDuration, h, trend } from "./shared.js";

const NS = "http://www.w3.org/2000/svg";
type Attrs = Record<string, string | number>;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, parent?: Element): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.appendChild(node);
  return node;
}

function text(parent: Element, x: number, y: number, value: string, attrs: Attrs = {}): SVGTextElement {
  const node = svg("text", { x, y, ...attrs }, parent);
  node.textContent = value;
  return node;
}

/** Rect path with only the top corners rounded (data end), flat on the baseline. */
function topRounded(x: number, y: number, w: number, hgt: number, r = 4): string {
  const rr = Math.min(r, w / 2, hgt);
  return `M${x},${y + hgt}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + hgt}Z`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ---- Tooltip ----

let tip: HTMLDivElement | null = null;

/** Shows `content()` (HTML) next to the pointer while hovering or focusing `target`. */
export function tooltip(target: Element, content: () => string): void {
  const show = (x: number, y: number) => {
    tip ??= document.body.appendChild(h("div", { className: "tip", role: "tooltip" }));
    tip.innerHTML = content();
    const { width, height } = tip.getBoundingClientRect();
    const left = x + 14 + width > innerWidth - 8 ? x - 14 - width : x + 14;
    const top = y + 16 + height > innerHeight - 8 ? y - 12 - height : y + 16;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${Math.max(8, top)}px`;
    tip.classList.add("show");
  };
  const hide = () => tip?.classList.remove("show");
  target.addEventListener("pointermove", (e) => show((e as PointerEvent).clientX, (e as PointerEvent).clientY));
  target.addEventListener("pointerleave", hide);
  target.addEventListener("focus", () => {
    const r = target.getBoundingClientRect();
    show(r.left + r.width / 2, r.bottom);
  });
  target.addEventListener("blur", hide);
}

export function swatch(cls: string): string {
  return `<span class="swatch ${cls}"></span>`;
}

// ---- Axis helper ----

const STEPS = [60, 300, 600, 900, 1800, 3600, 7200, 10800, 14400, 21600, 28800, 43200];

/** A "nice" duration step giving at most `count` gridlines up to `max` seconds. */
function niceStep(max: number, count = 3): number {
  return STEPS.find((s) => s * count >= max) ?? Math.ceil(max / count / 3600) * 3600;
}

// ---- Hour strip (popup) ----

/** 24 small columns for one day; focus hours in blue, others in orange; a marker at the current hour. */
export function hourStrip(container: HTMLElement, hours: number[], focus: boolean[], currentHour: number): void {
  const W = 312, H = 64, AXIS = 14, GAP = 2;
  const col = W / 24;
  const max = Math.max(...hours, 60);
  const root = svg("svg", { viewBox: `0 0 ${W} ${H + AXIS}`, class: "chart", role: "img", "aria-label": "Today by hour" });
  bands(root, focus, col, 0, H);
  hours.forEach((v, hour) => {
    const g = svg("g", { class: "hit" }, root);
    svg("rect", { x: hour * col, y: 0, width: col, height: H, fill: "transparent" }, g);
    if (v > 0) {
      const barH = Math.max(3, (v / max) * (H - 6));
      svg("path", { d: topRounded(hour * col + GAP / 2, H - barH, col - GAP, barH, 3), class: focus[hour] ? "fill-focus" : "fill-free" }, g);
    }
    tooltip(g, () => `<b>${pad(hour)}:00–${pad(hour + 1)}:00</b><br>${swatch(focus[hour] ? "fill-focus" : "fill-free")}${formatDuration(v)} · ${focus[hour] ? "focus hours" : "free time"}`);
  });
  svg("line", { x1: 0, x2: W, y1: H + 0.5, y2: H + 0.5, class: "baseline" }, root);
  svg("circle", { cx: currentHour * col + col / 2, cy: H + 5, r: 2, class: "now-dot" }, root);
  for (const hour of [0, 6, 12, 18]) text(root, hour * col + 1, H + AXIS, pad(hour), { class: "axis" });
  text(root, W - 1, H + AXIS, "24", { class: "axis", "text-anchor": "end" });
  container.replaceChildren(root);
}

/** Soft background bands behind scheduled (focus) hours. */
function bands(root: SVGSVGElement, focus: boolean[], col: number, y: number, height: number): void {
  let start = -1;
  focus.concat(false).forEach((on, hour) => {
    if (on && start < 0) start = hour;
    if (!on && start >= 0) {
      svg("rect", { x: start * col, y, width: (hour - start) * col, height, rx: 6, class: "focus-band" }, root);
      start = -1;
    }
  });
}

// ---- Stacked columns (dashboard) ----

export interface Column {
  label: string;
  title: string;
  focus: number;
  free: number;
}

/** Columns with focus time at the base and free time stacked on top, plus recessive duration gridlines. */
export function stackedColumns(container: HTMLElement, columns: Column[], labelEvery = 1): void {
  const W = 680, H = 230, LEFT = 44, TOP = 12, BOTTOM = 26;
  const plotH = H - TOP - BOTTOM;
  const totals = columns.map((c) => c.focus + c.free);
  const step = niceStep(Math.max(...totals, 60));
  const max = Math.max(step, Math.ceil(Math.max(...totals) / step) * step);
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "Time per period, focus hours vs free time" });

  for (let v = 0; v <= max; v += step) {
    const y = TOP + plotH - (v / max) * plotH;
    svg("line", { x1: LEFT, x2: W, y1: y, y2: y, class: v === 0 ? "baseline" : "grid" }, root);
    text(root, LEFT - 8, y + 4, v === 0 ? "0" : shortDuration(v), { class: "axis", "text-anchor": "end" });
  }

  const slot = (W - LEFT) / columns.length;
  const barW = Math.min(36, slot * 0.62);
  const groups: SVGGElement[] = [];
  columns.forEach((c, i) => {
    const g = svg("g", { class: "col" }, root);
    groups.push(g);
    const x = LEFT + i * slot + (slot - barW) / 2;
    const base = TOP + plotH;
    const focusH = (c.focus / max) * plotH;
    const freeH = (c.free / max) * plotH;
    const gap = c.focus > 0 && c.free > 0 ? 2 : 0;
    if (c.focus > 0) {
      const d = c.free > 0 ? `M${x},${base}h${barW}v${-focusH}h${-barW}Z` : topRounded(x, base - focusH, barW, focusH);
      svg("path", { d, class: "fill-focus" }, g);
    }
    if (c.free > 0) svg("path", { d: topRounded(x, base - focusH - gap - freeH, barW, freeH), class: "fill-free" }, g);
    if (i % labelEvery === 0) text(root, x + barW / 2, H - 6, c.label, { class: "axis", "text-anchor": "middle" });
    const hit = svg("rect", { x: LEFT + i * slot, y: TOP, width: slot, height: plotH, fill: "transparent" }, g);
    hit.addEventListener("pointerenter", () => groups.forEach((other) => other.classList.toggle("dim", other !== g)));
    hit.addEventListener("pointerleave", () => groups.forEach((other) => other.classList.remove("dim")));
    tooltip(hit, () =>
      `<b>${escapeHtml(c.title)}</b> · ${formatDuration(c.focus + c.free)}<br>` +
      `${swatch("fill-focus")}Focus hours ${formatDuration(c.focus)}<br>${swatch("fill-free")}Free time ${formatDuration(c.free)}`,
    );
  });
  container.replaceChildren(root);
}

// ---- Attempts with trend line (dashboard) ----

export interface CountPoint {
  label: string;
  title: string;
  value: number;
}

/**
 * Single-series count columns with a dashed least-squares trend line. `inTrend` marks the points the line is fitted
 * to (e.g. only days with focus hours, since nothing can be blocked on the others).
 */
export function countColumns(container: HTMLElement, points: CountPoint[], labelEvery = 1, inTrend?: boolean[], unit = "attempt"): void {
  const W = 680, H = 200, LEFT = 44, TOP = 12, BOTTOM = 26;
  const plotH = H - TOP - BOTTOM;
  const peak = Math.max(...points.map((p) => p.value), 1);
  const step = [1, 2, 5, 10, 20, 50, 100].find((s) => s * 4 >= peak) ?? Math.ceil(peak / 4);
  const max = Math.ceil(peak / step) * step;
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": `${unit}s per period with trend line` });
  const y = (v: number) => TOP + plotH - (v / max) * plotH;

  for (let v = 0; v <= max; v += step) {
    svg("line", { x1: LEFT, x2: W, y1: y(v), y2: y(v), class: v === 0 ? "baseline" : "grid" }, root);
    text(root, LEFT - 8, y(v) + 4, String(v), { class: "axis", "text-anchor": "end" });
  }

  const slot = (W - LEFT) / points.length;
  const barW = Math.min(36, slot * 0.62);
  const groups: SVGGElement[] = [];
  points.forEach((p, i) => {
    const g = svg("g", { class: "col" }, root);
    groups.push(g);
    const x = LEFT + i * slot + (slot - barW) / 2;
    if (p.value > 0) svg("path", { d: topRounded(x, y(p.value), barW, TOP + plotH - y(p.value)), class: "fill-attempt" }, g);
    if (i % labelEvery === 0) text(root, x + barW / 2, H - 6, p.label, { class: "axis", "text-anchor": "middle" });
    const hit = svg("rect", { x: LEFT + i * slot, y: TOP, width: slot, height: plotH, fill: "transparent" }, g);
    hit.addEventListener("pointerenter", () => groups.forEach((other) => other.classList.toggle("dim", other !== g)));
    hit.addEventListener("pointerleave", () => groups.forEach((other) => other.classList.remove("dim")));
    tooltip(hit, () => `<b>${escapeHtml(p.title)}</b><br>${p.value} ${p.value === 1 ? unit : `${unit}s`}`);
  });

  const fitted = points.filter((_, i) => inTrend?.[i] !== false);
  const line = fitted.length >= 3 && fitted.some((p) => p.value > 0) ? trend(points.map((p) => p.value), inTrend) : null;
  if (line) {
    const first = points.findIndex((_, i) => inTrend?.[i] !== false);
    const last = points.length - 1 - [...points].reverse().findIndex((_, i) => inTrend?.[points.length - 1 - i] !== false);
    const at = (i: number) => Math.max(0, Math.min(max, line.at(i)));
    const cx = (i: number) => LEFT + i * slot + slot / 2;
    svg("line", { x1: cx(first), y1: y(at(first)), x2: cx(last), y2: y(at(last)), class: "trend" }, root);
  }
  container.replaceChildren(root);
}

/** Tiny column sparkline for a table row. */
export function sparkline(values: number[], label: string): SVGSVGElement {
  const W = 96, H = 22;
  const max = Math.max(...values, 1);
  const slot = W / values.length;
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "spark", role: "img", "aria-label": label, preserveAspectRatio: "none" });
  values.forEach((v, i) => {
    const barH = v > 0 ? Math.max(2, (v / max) * H) : 1;
    svg("rect", { x: i * slot + 0.5, y: H - barH, width: Math.max(1, slot - 1.5), height: barH, rx: Math.min(1.5, slot / 3), class: v > 0 ? "fill-attempt" : "spark-zero" }, root);
  });
  return root;
}

// ---- Heatmap (dashboard) ----

export interface HeatRow {
  label: string;
  values: number[];
  focus: boolean[];
}

/** Weekday × hour grid in a single-hue ramp, with the scheduled focus window outlined per row. */
export function heatmap(container: HTMLElement, rows: HeatRow[]): void {
  const LEFT = 40, TOP = 18, CELL = 24, GAP = 3;
  const W = LEFT + 24 * CELL, H = TOP + rows.length * CELL;
  const max = Math.max(...rows.flatMap((r) => r.values), 1);
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "When you browse, by weekday and hour" });

  for (let hour = 0; hour < 24; hour += 3) text(root, LEFT + hour * CELL + CELL / 2, 11, pad(hour), { class: "axis", "text-anchor": "middle" });
  rows.forEach((row, r) => {
    const y = TOP + r * CELL;
    text(root, 0, y + CELL / 2 + 4, row.label, { class: "axis label" });
    row.values.forEach((v, hour) => {
      const level = v <= 0 ? 0 : Math.min(6, Math.ceil((v / max) * 6));
      const cell = svg("rect", { x: LEFT + hour * CELL + GAP / 2, y: y + GAP / 2, width: CELL - GAP, height: CELL - GAP, rx: 4, class: `heat heat-${level}` }, root);
      tooltip(cell, () => `<b>${escapeHtml(row.label)} ${pad(hour)}:00–${pad(hour + 1)}:00</b><br>${formatDuration(v)}${row.focus[hour] ? " · focus hours" : ""}`);
    });
    let start = -1;
    row.focus.concat(false).forEach((on, hour) => {
      if (on && start < 0) start = hour;
      if (!on && start >= 0) {
        svg("rect", { x: LEFT + start * CELL + 0.5, y: y + 0.5, width: (hour - start) * CELL - 1, height: CELL - 1, rx: 6, class: "focus-outline" }, root);
        start = -1;
      }
    });
  });
  container.replaceChildren(root);
}

// ---- Helpers ----

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function shortDuration(seconds: number): string {
  return seconds >= 3600 ? `${+(seconds / 3600).toFixed(1)}h` : `${Math.round(seconds / 60)}m`;
}

/** Accessible table fallback for a chart. */
export function dataTable(headers: string[], rows: (string | number)[][]): HTMLTableElement {
  return h(
    "table",
    { className: "data-table" },
    h("thead", {}, h("tr", {}, ...headers.map((t) => h("th", { textContent: t })))),
    h("tbody", {}, ...rows.map((r) => h("tr", {}, ...r.map((v) => h("td", { textContent: String(v) }))))),
  );
}
