// Settings page: blocklist chips, focus hours, data export. Changes save immediately. During focus hours, a change
// that weakens the block needs the typed sentence and is logged as a rule break (by the background worker).
import {
  type Settings,
  byId,
  describeStatus,
  exportData,
  favicon,
  getSettings,
  h,
  isBlocking,
  minutesToTime,
  normalizeDomain,
  phraseField,
  saveSettings,
  timeToMinutes,
  toast,
  weakenings,
} from "./shared.js";

const PRESETS: Record<string, string[]> = {
  Social: ["facebook.com", "instagram.com", "x.com", "tiktok.com", "linkedin.com", "threads.net", "bsky.app", "snapchat.com"],
  Video: ["youtube.com", "twitch.tv", "netflix.com", "primevideo.com", "disneyplus.com"],
  News: ["news.ycombinator.com", "reddit.com", "cnn.com", "bbc.com", "theguardian.com"],
  Shopping: ["amazon.com", "ebay.com", "aliexpress.com", "temu.com", "etsy.com"],
};
// Monday first; values are Date.getDay() numbers.
const DAYS: [number, string, string][] = [
  [1, "M", "Monday"], [2, "T", "Tuesday"], [3, "W", "Wednesday"], [4, "T", "Thursday"],
  [5, "F", "Friday"], [6, "S", "Saturday"], [0, "S", "Sunday"],
];

let settings: Settings;
let locked = false;
/** Chips already on screen; only newly added ones animate in. */
let rendered = new Set<string>();

async function load(): Promise<void> {
  settings = await getSettings();
  locked = isBlocking(settings);
  render();
}

/** Saves a change; one that weakens an active block must be confirmed first. Returns whether it was saved. */
async function apply(next: Settings, message = "Saved"): Promise<boolean> {
  const current = await getSettings();
  const candidate = { ...next, pausedUntil: current.pausedUntil };
  const breaks = weakenings(current, candidate);
  if (breaks.length && !(await confirmRuleBreak(breaks.map((b) => b.detail)))) {
    await load(); // put the controls back
    return false;
  }
  await saveSettings(candidate);
  toast(breaks.length ? "Saved · logged as a rule break" : message);
  await load();
  return true;
}

/** Modal asking the user to type the sentence before a rule break. Resolves true if they go ahead. */
function confirmRuleBreak(details: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const proceed = h("button", { className: "btn danger armed", type: "button", disabled: true, textContent: "Do it anyway" });
    const cancel = h("button", { className: "btn primary", type: "button", textContent: "Stay focused" });
    const field = phraseField((complete) => (proceed.disabled = !complete));
    const dialog = h(
      "dialog",
      { className: "confirm" },
      h("h2", { textContent: "This counts as a rule break" }),
      h("p", { className: "muted", textContent: "It's focus time. If you go ahead, this shows up on your dashboard and resets your clean streak:" }),
      h("ul", {}, ...details.map((d) => h("li", { textContent: d }))),
      h("p", { className: "muted", textContent: "To confirm, type:" }),
      field.root,
      h("div", { className: "confirm-actions" }, cancel, proceed),
    );
    const close = (result: boolean) => {
      dialog.close();
      dialog.remove();
      resolve(result);
    };
    cancel.addEventListener("click", () => close(false));
    proceed.addEventListener("click", () => close(true));
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      close(false);
    });
    document.body.append(dialog);
    dialog.showModal();
    field.input.focus();
  });
}

function render(): void {
  byId("lock-banner").hidden = !locked;
  byId("unlock-at").textContent = describeStatus(settings).text.replace(/^Blocking until /, "");

  byId("site-count").textContent = `${settings.blocklist.length} ${settings.blocklist.length === 1 ? "site" : "sites"}`;
  byId("chips").replaceChildren(
    ...settings.blocklist.map((domain) => {
      const remove = h("button", { type: "button", title: locked ? `Remove ${domain} (counts as a rule break now)` : `Remove ${domain}` });
      remove.setAttribute("aria-label", `Remove ${domain}`);
      remove.innerHTML = '<svg class="icon" viewBox="0 0 24 24" style="width:13px;height:13px"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      remove.addEventListener("click", () => void apply({ ...settings, blocklist: settings.blocklist.filter((d) => d !== domain) }, `Removed ${domain}`));
      return h("span", { className: rendered.has(domain) ? "chip" : "chip new" }, favicon(domain), domain, remove);
    }),
  );
  rendered = new Set(settings.blocklist);

  const presets = byId("presets");
  presets.querySelectorAll("button").forEach((b) => b.remove());
  for (const [name, domains] of Object.entries(PRESETS)) {
    const missing = domains.filter((d) => !settings.blocklist.includes(d));
    const button = h("button", { className: "btn sm", type: "button", disabled: !missing.length, textContent: missing.length ? `+ ${name}` : `✓ ${name}` });
    button.title = domains.join(", ");
    button.addEventListener("click", () => void apply({ ...settings, blocklist: [...settings.blocklist, ...missing] }, `Added ${missing.length} ${name.toLowerCase()} sites`));
    presets.append(button);
  }

  byId<HTMLInputElement>("start").value = minutesToTime(settings.startMin);
  byId<HTMLInputElement>("end").value = minutesToTime(settings.endMin);
  byId("days").replaceChildren(
    ...DAYS.map(([value, letter, name]) => {
      const button = h("button", { className: "day", type: "button", textContent: letter, title: name });
      button.setAttribute("aria-pressed", String(settings.days.includes(value)));
      button.setAttribute("aria-label", name);
      button.addEventListener("click", () => {
        const days = settings.days.includes(value) ? settings.days.filter((d) => d !== value) : [...settings.days, value];
        void apply({ ...settings, days: days.sort() });
      });
      return button;
    }),
  );
  byId("summary").innerHTML = summary(settings);
}

function summary(s: Settings): string {
  if (!s.days.length) return "No days selected — <b>blocking is off</b>.";
  if (s.startMin === s.endMin) return "Start and end are the same — <b>blocking is off</b>.";
  const minutes = (s.endMin - s.startMin + 1440) % 1440;
  const hours = `${+(minutes / 60).toFixed(1)} hours`;
  const days = s.days.length === 7 ? "every day" : s.days.length === 5 && !s.days.includes(0) && !s.days.includes(6) ? "on weekdays" : `${s.days.length} days a week`;
  return `Blocking <b>${minutesToTime(s.startMin)}–${minutesToTime(s.endMin)}</b>, ${days} · <b>${hours}</b> of focus a day.`;
}

function addSites(raw: string): void {
  const parts = raw.split(/[\s,]+/).filter(Boolean);
  const valid = parts.map(normalizeDomain);
  const error = byId("add-error");
  const input = byId<HTMLInputElement>("add-input");
  if (!parts.length) return;
  if (valid.some((d) => !d)) {
    error.textContent = `That doesn't look like a website: ${parts.filter((_, i) => !valid[i]).join(", ")}`;
    input.classList.add("invalid");
    return;
  }
  const fresh = [...new Set(valid as string[])].filter((d) => !settings.blocklist.includes(d));
  error.textContent = fresh.length ? "" : "Already on your list.";
  input.classList.toggle("invalid", !fresh.length);
  if (!fresh.length) return;
  input.value = "";
  void apply({ ...settings, blocklist: [...settings.blocklist, ...fresh] }, fresh.length === 1 ? `Blocking ${fresh[0]}` : `Added ${fresh.length} sites`);
}

byId("add-form").addEventListener("submit", (e) => {
  e.preventDefault();
  addSites(byId<HTMLInputElement>("add-input").value);
});
byId("add-input").addEventListener("input", () => {
  byId("add-error").textContent = "";
  byId("add-input").classList.remove("invalid");
});
for (const id of ["start", "end"] as const) {
  byId<HTMLInputElement>(id).addEventListener("change", (e) => {
    const minutes = timeToMinutes((e.target as HTMLInputElement).value);
    if (minutes !== null) void apply({ ...settings, [id === "start" ? "startMin" : "endMin"]: minutes });
  });
}
byId("weekdays").addEventListener("click", () => void apply({ ...settings, days: [1, 2, 3, 4, 5] }));
byId("everyday").addEventListener("click", () => void apply({ ...settings, days: [0, 1, 2, 3, 4, 5, 6] }));
byId("export").addEventListener("click", () => void exportData());

const clear = byId<HTMLButtonElement>("clear");
clear.addEventListener("click", async () => {
  if (!clear.classList.contains("armed")) {
    clear.classList.add("armed");
    clear.textContent = "Click again to delete";
    setTimeout(() => {
      clear.classList.remove("armed");
      clear.textContent = "Delete all stats";
    }, 4000);
    return;
  }
  const keys = Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith("day:"));
  await chrome.storage.local.remove(keys);
  clear.classList.remove("armed");
  clear.textContent = "Delete all stats";
  toast("All stats deleted");
});

chrome.storage.onChanged.addListener((changes, area) => area === "local" && changes.settings && void load());
setInterval(() => locked !== isBlocking(settings) && void load(), 15_000);
void load();
