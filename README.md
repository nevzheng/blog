# blog

Personal dev blog. Built with [Astro](https://astro.build/) + [AstroPaper](https://github.com/satnaing/astro-paper). Deployed to GitHub Pages.

**Live:** https://nevzheng.github.io/blog/

## Development

```bash
npm install
npm run dev        # local dev server
npm run build      # production build (includes type check + pagefind)
npm run preview    # preview the production build
```

## Writing a new post

Create a `.md` file in `src/data/blog/`:

```md
---
title: "Building a B-Tree from Scratch"
description: "Notes on implementing a B-Tree storage engine in Rust."
pubDatetime: 2026-02-27T00:00:00Z
tags:
  - databases
  - rust
  - storage-engines
---

Your markdown content here. Supports all standard markdown plus:

- Code blocks with syntax highlighting
- LaTeX equations
- Images
- Tables
```

### Frontmatter fields

| Field | Required | Description |
|---|---|---|
| `title` | Yes | Post title |
| `description` | Yes | Short description (shows in cards and SEO) |
| `pubDatetime` | Yes | Publish date in ISO 8601 format |
| `tags` | No | Array of tags (defaults to `["others"]`) |
| `draft` | No | Set `true` to hide from production |
| `featured` | No | Set `true` to pin to homepage |
| `modDatetime` | No | Last modified date |
| `ogImage` | No | Custom OG image (auto-generated if omitted) |
| `canonicalURL` | No | Canonical URL if cross-posting |
| `author` | No | Defaults to site author |

### Organizing posts

- Posts live in `src/data/blog/`
- Subdirectories are supported (e.g. `src/data/blog/projects/my-post.md`)
- Prefix directories with `_` to exclude them (e.g. `_drafts/`)
- File name becomes the URL slug

### Draft posts

Set `draft: true` in frontmatter. Drafts are excluded from production builds but visible in dev.

## Deploying

Push to `main`. GitHub Actions builds and deploys automatically.

## Theme

Based on [AstroPaper v5](https://github.com/satnaing/astro-paper). See their [docs](https://astro-paper.pages.dev/) for customizing colors, fonts, and layout.

## License

- Blog content: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- Site code: MIT
