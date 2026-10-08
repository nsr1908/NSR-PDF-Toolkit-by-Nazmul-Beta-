/* PDF ToolKit by Nazmul — client-side only. Libraries: PDF.js (preview/render), pdf-lib (build/save). */
'use strict';
const CONFIG = {
  MAX_BYTES: 100 * 1024 * 1024,      // max upload size
  MAX_RASTER_PAGES: 150,             // safeguard for image-based compression
  MAX_CANVAS_PIXELS: 12e6,           // keep canvases small enough for phones
  LEVELS: { low: [2.0, 0.85], med: [1.4, 0.65], high: [1.0, 0.45] }, // [render scale, JPEG quality]
  EXTRA_STEPS: [[0.8, 0.35], [0.6, 0.28]],
  SIZES_MM: { a4: [210, 297], a5: [148, 210], a3: [297, 420], letter: [215.9, 279.4], legal: [215.9, 355.6], executive: [184.15, 266.7] }
};
const $ = id => document.getElementById(id);
const S = { tool: 'compress', file: null, bytes: null, pdf: null, pages: 0, page: 1, zoom: 1, busy: false, out: null, outName: '', renderId: 0 };
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

/* ---------- helpers ---------- */
const fmt = n => n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : (n / 1024).toFixed(1) + ' KB';
const sanitize = n => n.replace(/\.pdf$/i, '').replace(/[^\w\-. ]+/g, '_').trim().slice(0, 80) || 'document';
const tick = () => new Promise(r => setTimeout(r, 0));
class UserError extends Error {}

function showError(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(showError.t); showError.t = setTimeout(() => t.hidden = true, 7000);
}
function friendly(e) {
  if (e instanceof UserError) return e.message;
  const n = (e && (e.name || '') + ' ' + (e.message || '')).toLowerCase();
  if (n.includes('password') || n.includes('encrypt')) return 'This PDF is password-protected. Remove the password and try again.';
  if (n.includes('invalidpdf') || n.includes('invalid pdf') || n.includes('failed to parse')) return 'This file is not a valid PDF, or it is corrupted.';
  if (n.includes('memory') || n.includes('allocation') || n.includes('range')) return 'Your device ran out of memory. Try a smaller PDF or a lower compression level.';
  return "We couldn't process this PDF. It may be password-protected or contain an unsupported structure.";
}
function setProgress(p, label) {
  $('bar').value = p; $('pct').textContent = Math.round(p) + '%' + (label ? ' — ' + label : '');
}
function showSuccess(orig, out, note, resizeOnly) {
  $('rOrig').textContent = fmt(orig); $('rNew').textContent = fmt(out.length);
  const diff = (1 - out.length / orig) * 100;
  $('rLbl').textContent = resizeOnly ? 'Change' : (diff >= 0 ? 'Saved' : 'Larger by');
  $('rSave').textContent = Math.abs(diff).toFixed(1) + '%';
  $('rNote').textContent = note || ''; $('result').hidden = false;
  $('result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ---------- init ---------- */
function initApp() {
  const saved = localStorage.getItem('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(saved);
  $('themeBtn').onclick = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  const drop = $('drop');
  drop.onclick = () => $('fileInput').click();
  drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); } };
  $('fileInput').onchange = e => { if (e.target.files[0]) handleFileSelection(e.target.files[0]); e.target.value = ''; };
  ['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => { if (e.dataTransfer.files[0]) handleFileSelection(e.dataTransfer.files[0]); });
  document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => setTool(b.dataset.tool));
  $('prev').onclick = () => gotoPage(S.page - 1); $('next').onclick = () => gotoPage(S.page + 1);
  $('zin').onclick = () => { S.zoom = Math.min(3, S.zoom + 0.25); renderPreview(); };
  $('zout').onclick = () => { S.zoom = Math.max(0.5, S.zoom - 0.25); renderPreview(); };
  $('target').onchange = () => $('customWrap').hidden = $('target').value !== 'custom';
  $('size').onchange = () => { $('customSize').hidden = $('size').value !== 'custom'; updateRsPrev(); };
  $('margin').onchange = () => { $('cmWrap').hidden = $('margin').value !== 'custom'; updateRsPrev(); };
  ['orient', 'cw', 'ch', 'unit', 'cm', 'scale'].forEach(id => $(id).addEventListener('change', updateRsPrev));
  $('goCompress').onclick = () => processPDF('compress');
  $('goResize').onclick = () => processPDF('resize');
  $('dl').onclick = downloadPDF; $('resetBtn').onclick = resetApp;
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js').catch(() => {});
}
function applyTheme(t) {
  document.documentElement.dataset.theme = t; localStorage.setItem('theme', t);
  $('themeBtn').textContent = t === 'dark' ? '☀ Light' : '🌙 Dark';
  document.querySelector('meta[name=theme-color]').content = t === 'dark' ? '#161514' : '#b3261e';
}
function setTool(t) {
  S.tool = t; $('result').hidden = true;
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tool === t));
  $('pCompress').hidden = t !== 'compress'; $('pResize').hidden = t !== 'resize';
  if (t === 'resize') updateRsPrev();
}

/* ---------- file loading & preview ---------- */
async function handleFileSelection(file) {
  if (!(file.type === 'application/pdf' || /\.pdf$/i.test(file.name))) return showError('Please choose a PDF file.');
  if (file.size > CONFIG.MAX_BYTES) return showError(`File is too large. Please choose a PDF under ${CONFIG.MAX_BYTES / 1048576} MB.`);
  if (file.size === 0) return showError('This file is empty.');
  try {
    resetApp(true);
    S.file = file; S.bytes = await file.arrayBuffer();
    await loadPDF();
  } catch (e) { resetApp(); showError(friendly(e)); }
}
async function loadPDF() {
  // PDF.js transfers its buffer to the worker, so give it a copy and keep the original bytes.
  S.pdf = await pdfjsLib.getDocument({ data: new Uint8Array(S.bytes.slice(0)) }).promise;
  S.pages = S.pdf.numPages; S.page = 1; S.zoom = 1;
  $('fName').textContent = S.file.name; $('fSize').textContent = fmt(S.file.size); $('fPages').textContent = S.pages;
  $('drop').hidden = true; $('work').hidden = false; setTool(S.tool);
  await renderPreview();
}
function gotoPage(n) { if (n < 1 || n > S.pages) return; S.page = n; renderPreview(); }
async function renderPreview() {
  if (!S.pdf) return;
  const id = ++S.renderId; $('pgInfo').textContent = `${S.page} / ${S.pages}`;
  $('prev').disabled = S.page <= 1; $('next').disabled = S.page >= S.pages;
  try {
    const page = await S.pdf.getPage(S.page);
    const base = page.getViewport({ scale: 1 });
    const fit = Math.min(600, document.body.clientWidth - 64) / base.width;
    const vp = page.getViewport({ scale: fit * S.zoom * (devicePixelRatio > 1 ? 1.5 : 1) });
    const c = $('pv'); if (id !== S.renderId) return;
    c.width = vp.width; c.height = vp.height; c.style.width = (vp.width / (devicePixelRatio > 1 ? 1.5 : 1)) + 'px';
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    page.cleanup();
  } catch (e) { if (id === S.renderId) showError('Preview failed for this page.'); }
}

/* ---------- processing ---------- */
async function processPDF(kind) {
  if (S.busy || !S.pdf) return;
  S.busy = true; $('result').hidden = true; $('modal').hidden = false; setProgress(0);
  ['goCompress', 'goResize'].forEach(i => $(i).disabled = true);
  try {
    const r = kind === 'compress' ? await compressPDF() : await resizePDF();
    S.out = r.bytes; S.outName = sanitize(S.file.name) + (kind === 'compress' ? '_compressed.pdf' : '_resized.pdf');
    $('rTitle').textContent = 'PDF processed successfully!';
    showSuccess(S.file.size, r.bytes, r.note, kind === 'resize');
  } catch (e) { console.error(e); showError(friendly(e)); }
  finally { S.busy = false; $('modal').hidden = true; ['goCompress', 'goResize'].forEach(i => $(i).disabled = false); }
}

async function losslessSave() {
  const doc = await PDFLib.PDFDocument.load(S.bytes.slice(0)); // throws on encrypted files
  return doc.save({ useObjectStreams: true });
}
function targetBytes() {
  const v = $('target').value;
  if (v === 'custom') return Math.max(20, Number($('customKb').value) || 0) * 1024;
  return Number(v);
}
async function rasterize(scale, quality, progressFrom, progressSpan) {
  const out = await PDFLib.PDFDocument.create();
  const canvas = document.createElement('canvas');
  for (let i = 1; i <= S.pages; i++) {
    const page = await S.pdf.getPage(i);
    const pt = page.getViewport({ scale: 1 });
    let s = scale; if (pt.width * pt.height * s * s > CONFIG.MAX_CANVAS_PIXELS) s = Math.sqrt(CONFIG.MAX_CANVAS_PIXELS / (pt.width * pt.height));
    const vp = page.getViewport({ scale: s });
    canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise; page.cleanup();
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
    if (!blob) throw new Error('memory');
    const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    out.addPage([pt.width, pt.height]).drawImage(img, { x: 0, y: 0, width: pt.width, height: pt.height });
    setProgress(progressFrom + progressSpan * i / S.pages, `page ${i} of ${S.pages}`); await tick();
  }
  canvas.width = canvas.height = 0;
  return out.save({ useObjectStreams: true });
}
async function compressPDF() {
  const lvl = document.querySelector('input[name=lvl]:checked').value, target = targetBytes();
  setProgress(5, 'optimizing structure');
  let best = await losslessSave(), note = '', done = false;
  const needMore = lvl !== 'low' || (target && best.length > target);
  if (!needMore) { note = 'Low compression keeps text and vectors intact, so savings are small. Choose Medium or High for more reduction.'; }
  else if (S.pages > CONFIG.MAX_RASTER_PAGES) {
    note = `This PDF has more than ${CONFIG.MAX_RASTER_PAGES} pages, so image compression was skipped to protect your device's memory. Only lossless optimization was applied.`;
  } else {
    const order = ['low', 'med', 'high'], steps = order.slice(order.indexOf(lvl)).map(k => CONFIG.LEVELS[k]);
    if (target || lvl === 'high') steps.push(...CONFIG.EXTRA_STEPS);
    const tries = target ? steps : [steps[0]];
    for (let t = 0; t < tries.length; t++) {
      const bytes = await rasterize(tries[t][0], tries[t][1], 10 + 85 * t / tries.length, 85 / tries.length);
      if (bytes.length < best.length) best = bytes;
      if (!target || bytes.length <= target) { done = true; break; }
    }
    note = 'Pages were converted to compressed images, so text is no longer selectable.';
    if (target && !done) note += ` The ${fmt(target)} target could not be reached without making the PDF unreadable; this is the smallest result.`;
    if (best.length >= S.file.size) { best = new Uint8Array(S.bytes.slice(0)); note = 'This PDF is already well optimized, so no smaller version was possible. The original file is returned unchanged.'; }
  }
  if (best.length >= S.file.size && !note.includes('already')) note += ' The result is not smaller than the original; this PDF is likely already optimized.';
  setProgress(100); return { bytes: best, note };
}

/* ---------- resize ---------- */
function targetDims() {
  let w, h; const k = $('size').value;
  if (k === 'custom') {
    const f = { mm: 72 / 25.4, inch: 72, pt: 1 }[$('unit').value];
    w = Number($('cw').value) * f; h = Number($('ch').value) * f;
  } else { w = CONFIG.SIZES_MM[k][0] * 72 / 25.4; h = CONFIG.SIZES_MM[k][1] * 72 / 25.4; }
  if (!(w > 10 && h > 10)) throw new UserError('Enter a valid page width and height.');
  const land = $('orient').value === 'l'; if ((w > h) !== land) [w, h] = [h, w];
  const m = ($('margin').value === 'custom' ? Number($('cm').value) || 0 : Number($('margin').value)) * 72 / 25.4;
  if (m * 2 >= Math.min(w, h)) throw new UserError('Margins are too large for this page size.');
  return { w, h, m };
}
function updateRsPrev() {
  try { const d = targetDims(); $('rsPrev').textContent = `Output: ${(d.w / 72 * 25.4).toFixed(0)} × ${(d.h / 72 * 25.4).toFixed(0)} mm, margin ${(d.m / 72 * 25.4).toFixed(0)} mm, ${S.pages || '–'} page(s).`; }
  catch (e) { $('rsPrev').textContent = e.message; }
}
async function resizePDF() {
  const { w, h, m } = targetDims(), mode = $('scale').value;
  const src = await PDFLib.PDFDocument.load(S.bytes.slice(0)), out = await PDFLib.PDFDocument.create();
  const aw = w - 2 * m, ah = h - 2 * m, n = src.getPageCount();
  for (let i = 0; i < n; i++) {
    const sp = src.getPage(i), rot = ((sp.getRotation().angle % 360) + 360) % 360;
    let { width: pw, height: ph } = sp.getSize(); if (rot === 90 || rot === 270) [pw, ph] = [ph, pw];
    const emb = await out.embedPage(sp);
    const s = mode === 'fit' ? Math.min(aw / pw, ah / ph) : mode === 'fill' ? Math.max(aw / pw, ah / ph) : 1;
    const page = out.addPage([w, h]);
    if (rot) { // pages with /Rotate: keep them upright by rotating the embedded content
      const rad = rot * Math.PI / 180, cx = w / 2, cy = h / 2, ew = emb.width * s, eh = emb.height * s;
      const ox = cx - (ew / 2) * Math.cos(rad) + (eh / 2) * Math.sin(rad), oy = cy - (ew / 2) * Math.sin(rad) - (eh / 2) * Math.cos(rad);
      page.drawPage(emb, { x: ox, y: oy, xScale: s, yScale: s, rotate: PDFLib.degrees(rot) });
    } else page.drawPage(emb, { x: (w - pw * s) / 2, y: (h - ph * s) / 2, xScale: s, yScale: s });
    setProgress(5 + 90 * (i + 1) / n, `page ${i + 1} of ${n}`); await tick();
  }
  const bytes = await out.save({ useObjectStreams: true });
  setProgress(100);
  return { bytes, note: 'Resizing keeps text and vectors. File size may change slightly.' };
}

/* ---------- download & reset ---------- */
function downloadPDF() {
  if (!S.out) return showError('Nothing to download yet.');
  try {
    const url = URL.createObjectURL(new Blob([S.out], { type: 'application/pdf' }));
    const a = document.createElement('a'); a.href = url; a.download = S.outName; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (e) { showError('Download failed. Please try again.'); }
}
function resetApp(keepUI) {
  S.renderId++; if (S.pdf) { S.pdf.destroy(); }
  Object.assign(S, { file: null, bytes: null, pdf: null, pages: 0, page: 1, zoom: 1, out: null });
  const c = $('pv'); c.width = c.height = 0;
  $('result').hidden = true; $('work').hidden = true; $('drop').hidden = false;
}
document.addEventListener('DOMContentLoaded', initApp);
