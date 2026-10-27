/* ============================================================
 *  ระบบรายรับและรายจ่ายตัวเอง — Service Worker ของแอป PWA (ไม่ต้องแก้ไขไฟล์นี้)
 *  - เก็บเปลือกแอปไว้ในเครื่อง: เปิดแอปได้ทันทีแม้ไม่มีอินเทอร์เน็ต
 *  - ไฟล์ของแอปใช้ "เครือข่ายก่อน" จึงได้ไฟล์ล่าสุดเสมอเมื่อออนไลน์ (แก้ config.js แล้วมีผลทันที)
 *  - ฟอนต์และไลบรารีกราฟ / QR เก็บไว้หลังใช้ครั้งแรก
 *  - รับไฟล์ที่แชร์เข้ามาจากแอปอื่น (Android: แชร์สลิป → เลือกแอปนี้)
 *  - ไม่แตะคำขอไปยัง Apps Script (ข้อมูลผู้ใช้ไม่ถูกเก็บโดยไฟล์นี้)
 * ============================================================ */
const VERSION = '2.7.0';
const SHELL_CACHE = 'rr-shell-' + VERSION;
const RUNTIME_CACHE = 'rr-runtime-v1';
const SHELL_FILES = [
  './', './index.html', './config.js', './pwa.js', './manifest.webmanifest', './favicon.ico',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-192.png', './icons/maskable-512.png',
  './icons/apple-touch-icon.png', './icons/favicon-32.png',
  './icons/sc-expense.png', './icons/sc-income.png', './icons/sc-scan.png', './icons/sc-summary.png'
];
const NET_TIMEOUT = 4000;   // เครือข่ายช้าเกิน 4 วินาที ใช้ไฟล์ในเครื่องแทน

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const c = await caches.open(SHELL_CACHE);
    // ไฟล์ใดโหลดไม่ได้ก็ติดตั้งต่อได้ (เช่น ยังไม่ได้อัปโหลดไอคอนบางไฟล์)
    await Promise.all(SHELL_FILES.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('rr-shell-') && k !== SHELL_CACHE).map(k => caches.delete(k)));
    if (self.registration.navigationPreload) { try { await self.registration.navigationPreload.enable(); } catch (e) { /* ข้าม */ } }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  const same = url.origin === self.location.origin;

  // ไฟล์ที่แชร์เข้ามาจากแอปอื่น (Web Share Target)
  if (same && req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== 'GET') return;
  // คำขอไปยัง Apps Script / Google API: ปล่อยผ่านเสมอ
  if (/(^|\.)script\.google(usercontent)?\.com$/.test(url.hostname)) return;
  if (/(^|\.)googleapis\.com$/.test(url.hostname) && url.hostname !== 'fonts.googleapis.com') return;

  if (same) {
    if (req.mode === 'navigate') { event.respondWith(navigate(event)); return; }
    if (url.pathname.includes('/icons/')) { event.respondWith(staleWhileRevalidate(req, SHELL_CACHE)); return; }
    event.respondWith(networkFirst(req, SHELL_CACHE));
    return;
  }
  if (url.hostname === 'fonts.googleapis.com') { event.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE)); return; }
  if (url.hostname === 'fonts.gstatic.com' || url.hostname === 'cdn.jsdelivr.net') { event.respondWith(cacheFirst(req, RUNTIME_CACHE)); return; }
});

function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)); }

/** เปิดหน้าแอป: เครือข่ายก่อน ถ้าไม่มีอินเทอร์เน็ตใช้หน้าแอปที่เก็บไว้ (พารามิเตอร์ปุ่มลัดยังอยู่ใน URL) */
async function navigate(event) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const pre = event.preloadResponse ? await event.preloadResponse : null;
    const res = pre || await Promise.race([fetch(event.request), timeout(NET_TIMEOUT)]);
    if (res && res.ok && res.type === 'basic' && !res.redirected) cache.put('./index.html', res.clone()).catch(() => { });
    if (res) return res;
  } catch (e) { /* ใช้ไฟล์ในเครื่อง */ }
  return (await cache.match('./index.html')) || (await cache.match('./')) ||
    new Response('<!doctype html><meta charset="utf-8"><title>ออฟไลน์</title><p style="font-family:sans-serif;padding:24px">ยังไม่มีอินเทอร์เน็ต กรุณาเชื่อมต่อแล้วเปิดแอปอีกครั้ง</p>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
async function networkFirst(req, name) {
  const cache = await caches.open(name);
  try {
    const res = await Promise.race([fetch(req), timeout(NET_TIMEOUT)]);
    if (res && res.ok) cache.put(req, res.clone()).catch(() => { });
    return res;
  } catch (e) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw e;
  }
}
async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()).catch(() => { });
  return res;
}
async function staleWhileRevalidate(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  const net = fetch(req).then(res => { if (res && res.ok) cache.put(req, res.clone()).catch(() => { }); return res; }).catch(() => null);
  return hit || (await net) || new Response('', { status: 504 });
}

/* ---------- รับไฟล์ที่แชร์เข้ามา: เก็บใน IndexedDB (ฐานข้อมูลเดียวกับ pwa.js) แล้วเปิดแอป ---------- */
function idb() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open('rr-pwa', 1);
    rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains('kv')) rq.result.createObjectStore('kv'); };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
async function idbSet(k, v) {
  const d = await idb();
  await new Promise((res, rej) => {
    const t = d.transaction('kv', 'readwrite');
    t.objectStore('kv').put(v, k);
    t.oncomplete = res;
    t.onerror = t.onabort = () => rej(t.error);
  });
}
async function receiveShare(req) {
  try {
    const fd = await req.formData();
    const ok = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/i;
    const files = fd.getAll('files').filter(f => f && typeof f === 'object' && f.size > 0 && (ok.test(f.type || '') || /\.(jpe?g|png|webp|heic|heif|pdf)$/i.test(f.name || ''))).slice(0, 5);
    if (files.length) await idbSet('share:files', { at: Date.now(), files: files.map(f => ({ name: f.name || 'shared', type: f.type || '', blob: f })) });
  } catch (e) { /* เปิดแอปตามปกติ */ }
  return Response.redirect(new URL('./?share=1', self.registration.scope).href, 303);
}
