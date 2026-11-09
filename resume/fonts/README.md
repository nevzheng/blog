IBM Plex Sans, by IBM, licensed under the SIL Open Font License 1.1 (OFL.txt;
https://github.com/IBM/plex).

The font files are not committed. `npm run fonts` (scripts/fetch-fonts.mjs)
downloads a pinned release, checks each file's SHA-256, and writes:

- static TTFs here, for the Typst PDF
  (`typst compile --ignore-system-fonts --font-path resume/fonts ...`)
- WOFF2 files to public/fonts/, for the /resume web page

`npm run resume:pdf` and `npm run build` run it first; files already present
are reused, and CI caches both folders.
