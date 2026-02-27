# blog

Personal dev blog. Built with [Astro](https://astro.build/) + [AstroPaper](https://github.com/satnaing/astro-paper). Deployed to GitHub Pages.

## Development

```bash
npm install
npm run dev
```

## Writing a new post

Add a markdown file to `src/data/blog/`:

```md
---
title: "Post Title"
description: "Short description."
pubDatetime: 2026-02-27T00:00:00Z
tags:
  - databases
  - rust
---

Content here.
```

Push to `main` and it deploys automatically.
