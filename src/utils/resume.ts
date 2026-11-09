// Helpers for the résumé page and Markdown export.
// Source of truth: resume/resume.json (JSON Resume schema).
import data from "../../resume/resume.json";

export const resume = data;

/** Download filename, e.g. Nevin_Zheng_Resume_2026-11.pdf */
export function downloadName(ext: "pdf" | "md"): string {
  const name = data.basics.name.replace(/\s+/g, "_");
  const month = data.meta.lastModified.slice(0, 7);
  return `${name}_Resume_${month}.${ext}`;
}

type Work = (typeof data.work)[number] & {
  "x-groups"?: { title: string; highlights: number[] }[];
};

const LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

/** Plain text for a text field: [label](url) becomes label. */
export function plainText(text: string): string {
  return text.replace(LINK, "$1");
}

/** HTML for a text field, turning Markdown-style [label](url) into links. */
export function richHtml(text: string): string {
  const esc = (t: string) =>
    t
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  let out = "";
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    out += esc(text.slice(last, m.index));
    out += `<a href="${esc(m[2])}">${esc(m[1])}</a>`;
    last = (m.index ?? 0) + m[0].length;
  }
  return out + esc(text.slice(last));
}

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

export function fmtDate(d?: string): string {
  if (!d) return "Present";
  const [y, m] = d.split("-");
  return m ? `${MONTHS[Number(m) - 1]} ${y}` : y;
}

export function dateRange(e: { startDate?: string; endDate?: string }) {
  return `${fmtDate(e.startDate)} – ${fmtDate(e.endDate)}`;
}

/** Highlights grouped under optional subheadings (e.g. Google projects). */
export function workGroups(w: Work): { title?: string; items: string[] }[] {
  const groups = w["x-groups"];
  if (!groups) return [{ items: w.highlights }];
  return groups.map(g => ({
    title: g.title,
    items: g.highlights.map(i => w.highlights[i]),
  }));
}

export function contactParts() {
  const b = data.basics;
  return [
    { text: `${b.location.city}, ${b.location.region}` },
    { text: b.email, href: `mailto:${b.email}` },
    ...b.profiles.map(p => ({
      text: p.url.replace("https://", ""),
      href: p.url,
    })),
  ];
}

export function toMarkdown(): string {
  const b = data.basics;
  const out: string[] = [];
  out.push(`# ${b.name}`, "");
  out.push(
    contactParts()
      .map(c => (c.href ? `[${c.text}](${c.href})` : c.text))
      .join(" | "),
    ""
  );
  out.push("## Summary", "", b.summary, "");
  out.push("## Professional Experience", "");
  for (const w of data.work as Work[]) {
    out.push(
      `**${w.name} | ${w.position}** | ${w.location} | ${dateRange(w)}`,
      ""
    );
    if ("summary" in w && w.summary) out.push(`_${w.summary}_`, "");
    for (const g of workGroups(w)) {
      if (g.title) out.push(`_${g.title}_`, "");
      out.push(...g.items.map(i => `- ${i}`), "");
    }
  }
  out.push("## Projects", "");
  for (const p of data.projects)
    out.push(
      `- ${p.url ? `[${p.name}](${p.url})` : p.name} (${p.keywords.join(", ")}): ${p.description}`
    );
  out.push("", "## Technical Skills", "");
  for (const s of data.skills)
    out.push(`- ${s.name}: ${s.keywords.join(", ")}`);
  out.push("", "## Education", "");
  for (const e of data.education) {
    out.push(
      `${e.institution} | ${e.studyType}, ${e.area} | ${e.startDate} – ${e.endDate}`,
      ""
    );
    if ("x-note" in e && e["x-note"]) out.push(`_${e["x-note"]}_`, "");
  }
  return out.join("\n").trimEnd() + "\n";
}
