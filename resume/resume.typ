// Résumé PDF, rendered from resume.json (JSON Resume schema).
// Edit content in resume.json; tune layout in the settings block below.
// Build: npm run resume:pdf  (writes public/resume.pdf)

// ---------- Layout settings ----------
#let cfg = (
  font: "Roboto",           // Google's sans-serif
  body-size: 11pt,
  name-size: 23pt,
  heading-size: 13pt,
  margin: 0.5in,
  rule-color: luma(160),
  link-color: rgb("#1155cc"),
  line-gap: 0.45em,         // leading inside a paragraph
  bullet-gap: 0.75em,       // space between bullets
  job-gap: 1.0em,           // space above each job
  section-gap: 1.0em,       // space above each section rule
  break-before-projects: true,
)
// --------------------------------------

#let r = json("resume.json")
#let b = r.basics

#set document(title: b.name + " - Résumé", author: b.name)
#set page(paper: "us-letter", margin: cfg.margin)
#set text(font: cfg.font, size: cfg.body-size, stretch: 100%, lang: "en")
#set par(leading: cfg.line-gap, spacing: 0.75em, justify: false)
#set list(indent: 0.3in, body-indent: 0.15in, spacing: cfg.bullet-gap)
#show link: it => text(fill: cfg.link-color, underline(it))

#let months = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
#let fmt-date(d) = {
  if d == none { return "Present" }
  let p = d.split("-")
  if p.len() >= 2 { months.at(int(p.at(1)) - 1) + " " + p.at(0) } else { p.at(0) }
}
#let dates(e) = fmt-date(e.at("startDate", default: none)) + " – " + fmt-date(e.at("endDate", default: none))

#let section(title) = {
  v(cfg.section-gap, weak: true)
  line(length: 100%, stroke: 0.5pt + cfg.rule-color)
  v(0.5em)
  text(size: cfg.heading-size, title)
  v(0.15em)
}

#let bullets(items) = list(..items.map(i => [#i]))

// ---------- Header ----------
#text(size: cfg.name-size, b.name)
#v(-0.3em)
#{
  let parts = (b.location.city + ", " + b.location.region,)
  if "phone" in b { parts.push(b.phone) }
  parts.push(b.email)
  for p in b.profiles { parts.push(link(p.url, p.url.replace("https://", ""))) }
  text(size: 0.95em, parts.join(" | "))
}

// ---------- Summary ----------
#section("Summary")
#b.summary

// ---------- Experience ----------
#section("Professional Experience")
#for w in r.work {
  v(cfg.job-gap, weak: true)
  [*#w.name | #w.position* | #w.location | #dates(w)]
  parbreak()
  if "summary" in w { emph(w.summary); parbreak() }
  if "x-groups" in w {
    for g in w.at("x-groups") {
      emph(g.title)
      bullets(g.highlights.map(i => w.highlights.at(i)))
    }
  } else {
    bullets(w.highlights)
  }
}

#if cfg.break-before-projects { pagebreak(weak: true) }

// ---------- Projects ----------
#section("Projects")
#bullets(r.projects.map(p => p.name + " (" + p.keywords.join(", ") + "): " + p.description))

// ---------- Skills ----------
#section("Technical Skills")
#bullets(r.skills.map(s => s.name + ": " + s.keywords.join(", ")))

// ---------- Education ----------
#section("Education")
#for e in r.education {
  [#e.institution | #e.studyType, #e.area | #e.startDate – #e.endDate]
  parbreak()
  if "x-note" in e { emph(e.at("x-note")); parbreak() }
}
