// Downloads IBM Plex Sans (OFL 1.1) from IBM's GitHub release, pinned by tag
// and checked by SHA-256. Files already on disk with the right hash are kept,
// so this is a no-op after the first run (and CI caches the folders).
//   TTF   -> resume/fonts/  (Typst PDF)
//   WOFF2 -> public/fonts/  (/resume web page)
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const TAG = "@ibm/plex-sans@1.1.0";
const BASE = `https://raw.githubusercontent.com/IBM/plex/${encodeURIComponent(TAG)}/packages/plex-sans/fonts/complete`;

const FILES = {
  "ttf/IBMPlexSans-Regular.ttf": "975dcda37d80f038dcd143c22e33ca2d97a0cc5a929aace1c749153b0fe1afa5",
  "ttf/IBMPlexSans-Italic.ttf": "a9c6ef9942c49e49d11e11a6dacc0b3a087978757e9b22a06b8ac22a6400fb15",
  "ttf/IBMPlexSans-SemiBold.ttf": "a20caf8286023a6a7a85e40b1d2a4ae9fc3e3b1f9eda8f4c542dd4986af67bb1",
  "ttf/IBMPlexSans-SemiBoldItalic.ttf": "147106b619423a82b40f6d64bace074ad5b786e59f48023bda69d63b1755fb82",
  "ttf/IBMPlexSans-Bold.ttf": "9e6c74a889a700d707613d24548fe4ffa6bc59559a0689d2cf9e133bdcdafb2f",
  "ttf/IBMPlexSans-BoldItalic.ttf": "0e3142ba2ef31fe5c02f0c6c36424f251609cd6b73880076e21c2e81931ba2b9",
  "woff2/IBMPlexSans-Regular.woff2": "ba711a3085ff9f27440b6b9c4550cfc47c97bf36591d5da958b975bb3add8c1a",
  "woff2/IBMPlexSans-Italic.woff2": "13284fab1821ba6e3652c1580fcf2bbfd8c9309520c69b3d1224dab40b37c597",
  "woff2/IBMPlexSans-SemiBold.woff2": "f78048030eab62e860efa39a0df79e2e5581bf122eb95b9bc42c0b8a4988d205",
  "woff2/IBMPlexSans-SemiBoldItalic.woff2": "d875a0705b4596532250beeb66d9a2b8866a25f78b5b249b3d3293b5f922e50e",
  "woff2/IBMPlexSans-Bold.woff2": "fa7130d854a660b39a7fc9e6e0f2dc23dba5f1346e2adea3e1fe37b6d884133d",
  "woff2/IBMPlexSans-BoldItalic.woff2": "73d57000ee0fa7d6e1dd3a9fe5901c2d7c71904af9a935dbbc1d44abc9574c1f",
};

const DEST = { ttf: "resume/fonts", woff2: "public/fonts" };
const sha256 = buf => createHash("sha256").update(buf).digest("hex");

let fetched = 0;
for (const [src, want] of Object.entries(FILES)) {
  const [kind, name] = src.split("/");
  const out = `${DEST[kind]}/${name}`;
  try {
    if (sha256(await readFile(out)) === want) continue;
  } catch {
    // not downloaded yet
  }
  const res = await fetch(`${BASE}/${src}`);
  if (!res.ok) throw new Error(`${src}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha256(buf) !== want) throw new Error(`${src}: checksum mismatch`);
  await mkdir(DEST[kind], { recursive: true });
  await writeFile(out, buf);
  fetched++;
}
// eslint-disable-next-line no-console
console.log(`IBM Plex Sans ${TAG}: ${fetched} downloaded, ${Object.keys(FILES).length - fetched} cached`);
