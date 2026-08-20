# refs/ — artefacts embedded in the deck

Everything in here is opened by `../index.html` (slide 02, THE PHOSPHOR PIPELINE).
Cards on that slide show a thumbnail; clicking one opens the real artefact —
a looping `<video>` for the reference clips, a live `<iframe>` for every HTML page.

| Path | What it is |
| --- | --- |
| `experiment-0*.html`, `experiment-11.html` | first UI passes from `/frontend-design` + `/impeccable` |
| `dashboard-0*.html`, `form-0*.html`, `landing-page-0*.html`, `wiki.html` | the eight sample layouts |
| `design-system.html`, `DESIGN-SYSTEM.md` | what `/design-system` extracted from the surviving layouts |
| `design.html`, `DESIGN.md` | the third design-system artefact — a Stitch-style tokens doc (YAML frontmatter + prose); `design.html` fetches `DESIGN.md`, strips the frontmatter, and renders the body with `marked` |
| `video/*.mp4` | Evangelion FUI reference clips (imgur gallery *Evangelion User Interfaces (GIFs)*, `i.imgur.com/<hash>.mp4`) |
| `thumbs/ref-*.jpg` | stills cut from those clips with `ffmpeg -ss <t> -i <clip>.mp4 -frames:v 1 -vf scale=640:-2` |
| `thumbs/*.jpg` (the rest) | Playwright screenshots of each HTML page at 1440×900, downscaled to 720px wide |

## Regenerating the HTML thumbnails

```js
// playwright-core, 1440x900, waitUntil load + 1.2s settle, then `sips -Z 720` + jpeg
for (const f of htmlFiles) {
  await page.goto(pathToFileURL(f).href, { waitUntil: 'load' })
  await page.waitForTimeout(1200)
  await page.screenshot({ path: f.replace(/\.html$/, '.png') })
}
```

The deck works off `file://` in Chrome, but serve the folder if a browser refuses to
frame sibling files:

```
python3 -m http.server 8080 --directory docs/one-shot/slides
```
