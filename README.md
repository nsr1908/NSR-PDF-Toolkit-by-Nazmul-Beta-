# PDF ToolKit by Nazmul
Client-side PDF compressor, resizer and previewer. No backend, no analytics, no uploads.

## Run
- Locally: `python3 -m http.server 8000` in this folder, open http://localhost:8000 (service workers need http(s) or localhost).
- Host: upload the folder to GitHub Pages / Netlify / Vercel (HTTPS). On Android Chrome, open the URL → ⋮ → *Install app*.

## How it works
- **Preview**: PDF.js renders one page at a time (memory friendly).
- **Compress**: Low = lossless re-save with pdf-lib (text/vectors kept). Medium/High = render each page with PDF.js, JPEG-encode, rebuild with pdf-lib (text becomes an image). With a target size, quality steps down until the target is met or the minimum is reached. Already-optimized PDFs may not shrink; the original is then returned.
- **Resize**: pages are embedded with pdf-lib onto new pages of the chosen size (fit / fill / original scale, centered, with margins).

## Offline
The service worker caches the app and the three CDN files (PDF.js 3.11.174, its worker, pdf-lib 1.17.1) on first online visit. To self-host: download those files into `lib/`, change the `<script>` tags in `index.html`, the `workerSrc` in `app.js`, and the CDN list in `service-worker.js`.

## Icons
`icons/icon-192.png` and `icon-512.png` are simple placeholders; replace them with your own icons of the same names/sizes.

## Config
Edit `CONFIG` at the top of `app.js` (max file size, raster page limit, quality presets).

## Known limits
Page-specific resizing is not implemented (the "Apply to all pages" box is fixed on). Password-protected PDFs are rejected. Processing runs on the main thread with yields between pages, not in a Web Worker.
