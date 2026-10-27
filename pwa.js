/* ============================================================
 *  ระบบรายรับและรายจ่ายตัวเอง — ตัวโหลดแอป PWA (ไม่ต้องแก้ไขไฟล์นี้)
 *
 *  หน้าที่:
 *  1) ลงทะเบียน Service Worker (sw.js) ให้แอปติดตั้งได้และเปิดได้แม้ไม่มีอินเทอร์เน็ต
 *  2) ขอข้อมูลเริ่มต้น + โค้ดหน้าเว็บ (CSS/JS) จาก Apps Script ในคำสั่งเดียว (pwaBoot)
 *     โค้ดถูกเก็บไว้ในเครื่อง และดาวน์โหลดใหม่เฉพาะเมื่อเจ้าของระบบอัปเดตไฟล์ใน Apps Script
 *  3) ให้บริการ window.RR_PWA แก่โค้ดหน้าเว็บ: เรียกเซิร์ฟเวอร์ผ่าน HTTPS (doPost), ที่เก็บข้อมูลในเครื่อง,
 *     การติดตั้งแอป, ไฟล์ที่แชร์เข้ามา และปุ่มลัดของไอคอนแอป
 *  ข้อมูลทั้งหมดยังอยู่ใน Google Sheets / Google Drive ของระบบเดิม ไฟล์ในโฟลเดอร์นี้ไม่มีข้อมูลผู้ใช้หรือรหัสลับใด ๆ
 * ============================================================ */
(function () {
  'use strict';
  var SHELL_VERSION = '2.7.0';
  var CFG = window.RR_CONFIG || {};
  var API = String(CFG.API_URL || '').trim();
  var HERE = location.href.split('#')[0].split('?')[0];          // ลิงก์ของแอปนี้ (ไม่รวมพารามิเตอร์)
  var CHECK_EVERY = 30 * 60 * 1000;                              // ตรวจเวอร์ชันใหม่ระหว่างใช้งานทุก 30 นาที
  var started = false;

  /* ---------- ที่เก็บข้อมูลในเครื่อง (IndexedDB) ใช้ร่วมกับ sw.js ---------- */
  var mem = {};
  var dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      if (!('indexedDB' in window)) { rej(new Error('no-idb')); return; }
      var rq = indexedDB.open('rr-pwa', 1);
      rq.onupgradeneeded = function () { if (!rq.result.objectStoreNames.contains('kv')) rq.result.createObjectStore('kv'); };
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { rej(rq.error); };
      rq.onblocked = function () { rej(new Error('idb-blocked')); };
    });
    dbp.catch(function () { /* ใช้หน่วยความจำแทน (เช่น โหมดส่วนตัวบางเบราว์เซอร์) */ });
    return dbp;
  }
  function tx(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction('kv', mode), st = t.objectStore('kv'), out;
        var r = fn(st);
        if (r) r.onsuccess = function () { out = r.result; };
        t.oncomplete = function () { res(out); };
        t.onerror = t.onabort = function () { rej(t.error || new Error('idb')); };
      });
    });
  }
  var kv = {
    get: function (k) {
      return tx('readonly', function (st) { return st.get(k); }).then(function (v) { return v === undefined ? null : v; })
        .catch(function () { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; });
    },
    set: function (k, v) {
      if (v === null || v === undefined) return kv.del(k);
      return tx('readwrite', function (st) { st.put(v, k); }).then(function () { return true; })
        .catch(function () { mem[k] = v; return true; });
    },
    del: function (k) {
      delete mem[k];
      return tx('readwrite', function (st) { st.delete(k); }).then(function () { return true; }).catch(function () { return false; });
    },
    clear: function (prefix) {
      Object.keys(mem).forEach(function (k) { if (k.indexOf(prefix) === 0) delete mem[k]; });
      return tx('readwrite', function (st) { st.delete(IDBKeyRange.bound(prefix, prefix + '￿')); })
        .then(function () { return true; }).catch(function () { return false; });
    }
  };

  /* ---------- เรียกฟังก์ชันใน Apps Script ผ่าน HTTPS (doPost) ---------- */
  function call(name, args, ms) {
    if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(API)) {
      return Promise.reject(new Error('CONFIG: ยังไม่ได้ตั้งค่า API_URL ในไฟล์ config.js ให้เป็นลิงก์ Web app ของ Apps Script (ลงท้ายด้วย /exec)'));
    }
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, (ms || 60000) + 5000) : 0;
    return fetch(API, {
      method: 'POST',
      // text/plain = ไม่ต้องขออนุญาต CORS ล่วงหน้า (Apps Script ไม่รองรับ OPTIONS)
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ fn: name, args: args || [] }),
      redirect: 'follow', credentials: 'omit', cache: 'no-store', mode: 'cors',
      signal: ctl ? ctl.signal : undefined
    }).then(function (res) {
      clearTimeout(timer);
      return res.text().then(function (text) {
        var j = null;
        try { j = JSON.parse(text); } catch (e) { j = null; }
        if (!j || typeof j !== 'object' || !('ok' in j)) throw new Error(badResponse(res.status, text));
        if (!j.ok) throw new Error(String(j.error || 'เกิดข้อผิดพลาด'));
        return j.data;
      });
    }, function (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') { var t = new Error('TIMEOUT'); t.timeout = true; throw t; }
      throw new Error('NetworkError: ' + ((e && e.message) || 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'));
    });
  }
  /** อธิบายคำตอบที่ไม่ใช่ข้อมูลของระบบ (ตั้งค่า Deploy ผิด / ยังไม่ได้อัปเดต Code.gs) */
  function badResponse(status, text) {
    var t = String(text || '');
    if (/Script function not found: doPost|doPost/i.test(t)) return 'CONFIG: Apps Script ยังเป็นเวอร์ชันเก่า (ไม่มี doPost) ให้วาง Code.gs เวอร์ชัน 2.7.0 แล้ว Deploy → แก้ deployment เดิม → New version';
    if (/accounts\.google\.com|ServiceLogin|signin/i.test(t)) return 'CONFIG: Web app ยังไม่เปิดให้ทุกคนใช้ ให้ Deploy โดยตั้ง Who has access เป็น "Anyone" (ทุกคน)';
    if (status === 404) return 'CONFIG: ไม่พบ Web app ตาม API_URL ใน config.js (HTTP 404) ตรวจว่าคัดลอกลิงก์ /exec มาครบ และ deployment ยังไม่ถูกลบ';
    if (status === 403 || status === 401) return 'CONFIG: Web app ไม่อนุญาตให้เข้าถึง (HTTP ' + status + ') ให้ Deploy โดยตั้ง Execute as = Me และ Who has access = Anyone';
    if (status >= 500) return 'เซิร์ฟเวอร์ Google ขัดข้องชั่วคราว (HTTP ' + status + ') กรุณาลองใหม่อีกครั้ง';
    return 'CONFIG: เซิร์ฟเวอร์ตอบกลับในรูปแบบที่ไม่รู้จัก (HTTP ' + status + ') ตรวจ API_URL ใน config.js และการ Deploy ของ Apps Script';
  }

  /* ---------- การติดตั้งแอป ---------- */
  var deferred = null;
  var ua = navigator.userAgent || '';
  var ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function standalone() {
    try {
      return window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: minimal-ui)').matches ||
        window.navigator.standalone === true || document.referrer.indexOf('android-app://') === 0;
    } catch (e) { return false; }
  }
  function emit(type) { try { window.dispatchEvent(new CustomEvent('rr-pwa', { detail: { type: type } })); } catch (e) { /* ข้าม */ } }
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferred = e; emit('installable'); });
  window.addEventListener('appinstalled', function () { deferred = null; emit('installed'); });

  /* ---------- Service Worker ---------- */
  var swReg = null;
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js', { scope: './' }).then(function (r) { swReg = r; }).catch(function () { /* เปิดใช้ได้โดยไม่มี SW */ });
  }

  /* ---------- พารามิเตอร์ตอนเปิดแอป: ปุ่มลัด / แชร์ไฟล์ / ผลเข้าสู่ระบบด้วย Google ---------- */
  var q = new URLSearchParams(location.search);
  var launch = { action: q.get('action') || '', shared: q.get('share') === '1', source: q.get('source') || '' };
  var oauth = null;
  if (q.get('code') || q.get('error')) oauth = { code: q.get('code') || '', state: q.get('state') || '', error: q.get('error') || '' };
  if (location.search) { try { history.replaceState(null, '', HERE); } catch (e) { /* ข้าม */ } }

  /* ---------- บริการให้โค้ดหน้าเว็บ (window.RR_PWA) ---------- */
  window.RR_PWA = {
    version: SHELL_VERSION,
    apiUrl: API,
    call: call,
    kv: kv,
    launch: launch,
    installState: function () { return { standalone: standalone(), canPrompt: !!deferred, ios: ios }; },
    promptInstall: function () {
      if (!deferred) return Promise.resolve('unavailable');
      var d = deferred;
      deferred = null;
      d.prompt();
      return d.userChoice.then(function (c) { return (c && c.outcome) || 'dismissed'; }, function () { return 'dismissed'; });
    },
    /** ไฟล์ที่แชร์เข้ามาจากแอปอื่น (sw.js เก็บไว้) — คืนครั้งเดียวแล้วลบ */
    takeShared: function () {
      return kv.get('share:files').then(function (v) {
        kv.del('share:files');
        if (!v || !v.files || Date.now() - (v.at || 0) > 3600e3) return [];
        return v.files.map(function (f) {
          try { return new File([f.blob], f.name || 'shared', { type: f.type || (f.blob && f.blob.type) || '' }); } catch (e) { return f.blob; }
        }).filter(Boolean);
      });
    },
    applyUpdate: function () { location.reload(); }
  };

  /* ---------- หน้าจอของเปลือกแอป (ก่อนโค้ดหน้าเว็บหลักทำงาน) ---------- */
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function msg(t) { var p = document.getElementById('shellMsg'); if (p) p.textContent = t; }
  function screen(kind, detail) {
    var sp = document.getElementById('splash');
    if (!sp) return;
    sp.classList.remove('hidden');
    var off = kind === 'offline';
    var cfg = /^CONFIG: /.test(detail || '');
    var text = String(detail || '').replace(/^CONFIG: /, '');
    sp.innerHTML = '<div class="shell-card" role="alert">' +
      '<img class="splash-logo" src="icons/icon-192.png" alt="" width="72" height="72" style="width:72px;height:72px">' +
      '<div class="big">' + (off ? '📴' : '⚠️') + '</div>' +
      '<h2>' + (off ? 'ยังไม่มีอินเทอร์เน็ต' : cfg ? 'แอปยังตั้งค่าไม่ครบ' : 'เปิดแอปไม่สำเร็จ') + '</h2>' +
      '<p>' + (off ? 'เปิดแอปครั้งแรกต้องเชื่อมต่ออินเทอร์เน็ต เมื่อสัญญาณกลับมา แอปจะเปิดให้เอง' : esc(text)) + '</p>' +
      '<button type="button" class="sbtn" id="shellRetry">🔄 ลองใหม่</button>' +
      (off ? '' : '<details><summary>สำหรับเจ้าของระบบ: ตรวจการตั้งค่า</summary><ol>' +
        '<li>ไฟล์ <code>config.js</code>: API_URL = ลิงก์ Web app ที่ลงท้ายด้วย <code>/exec</code> (ตอนนี้: <code>' + esc(API || 'ว่าง') + '</code>)</li>' +
        '<li>Apps Script: วาง Code.gs, Index, CSS, JS เวอร์ชัน 2.7.0 ครบ 4 ไฟล์ แล้วกดบันทึก</li>' +
        '<li>Deploy → Manage deployments → ✏️ แก้ deployment เดิม → Version: New version → Execute as: Me · Who has access: Anyone → Deploy</li>' +
        '<li>ทดสอบเปิดลิงก์ Web app โดยตรงในเบราว์เซอร์ ต้องเห็นหน้าเข้าสู่ระบบของระบบ</li></ol>' +
        (detail ? '<p style="margin-top:8px">รายละเอียด: ' + esc(detail) + '</p>' : '') + '</details>') +
      '</div>';
    document.getElementById('shellRetry').onclick = function () { location.reload(); };
  }

  /* ---------- เริ่มแอป ---------- */
  function run(bundle, boot) {
    if (started) return true;
    started = true;
    document.documentElement.setAttribute('data-build', boot.version || bundle.version || '');
    if (boot.branding && boot.branding.appTitle) document.title = boot.branding.appTitle;
    var st = document.getElementById('rr-css');
    if (!st) { st = document.createElement('style'); st.id = 'rr-css'; document.head.appendChild(st); }
    st.textContent = bundle.css || '';
    document.getElementById('boot').textContent = JSON.stringify(boot);
    var s = document.createElement('script');
    s.text = bundle.js + '\n//# sourceURL=rr-app.js';
    document.body.appendChild(s);
    if (!window.__rrBooted) {
      kv.del('app:bundle');   // โค้ดที่เก็บไว้เสีย ครั้งหน้าดาวน์โหลดใหม่
      screen('error', 'โค้ดหน้าเว็บทำงานไม่ได้ ให้เจ้าของระบบตรวจไฟล์ JS ใน Apps Script (เปิดลิงก์ Web app ต่อท้ายด้วย ?check=1)');
      return false;
    }
    return true;
  }
  /** รูปโลโก้ / พื้นหลัง: ใช้รูปที่เก็บไว้ถ้าเซิร์ฟเวอร์บอกว่าเหมือนเดิม และเก็บรูปใหม่ไว้ใช้ครั้งหน้า */
  function fillImages(b, cache) {
    if (!b || !b.imgKeys) return;
    ['logo', 'bg'].forEach(function (k) {
      var c = cache[k];
      if (b.imgCached && b.imgCached[k]) b[k] = c && c.key === b.imgKeys[k] ? c.data : '';
      else if (b[k] && b.imgKeys[k]) kv.set('pub:' + k, { key: b.imgKeys[k], data: b[k] });
    });
  }
  function saveBoot(boot) {
    var b = JSON.parse(JSON.stringify(boot));
    b.oauth = null;
    if (b.branding) { b.branding.logo = ''; b.branding.bg = ''; if (b.branding.imgKeys) b.branding.imgCached = { logo: !!b.branding.imgKeys.logo, bg: !!b.branding.imgKeys.bg }; }
    kv.set('app:boot', { at: Date.now(), boot: b });
  }

  var lastCheck = Date.now();
  function have(bundle, logo, bg) { return { sig: (bundle && bundle.sig) || '', logo: (logo && logo.key) || '', bg: (bg && bg.key) || '' }; }

  function start() {
    registerSW();
    Promise.all([kv.get('app:bundle'), kv.get('app:boot'), kv.get('pub:logo'), kv.get('pub:bg')]).then(function (r) {
      var bundle = r[0], saved = r[1], cache = { logo: r[2], bg: r[3] };
      var slow = setTimeout(function () { msg('กำลังเชื่อมต่อเซิร์ฟเวอร์ ใช้เวลานานกว่าปกติเล็กน้อย…'); }, 6000);
      var ask = function (h, o) { return call('pwaBoot', [{ have: h, oauth: o }], 45000); };
      ask(have(bundle, cache.logo, cache.bg), oauth).then(function (res) {
        if (res.bundle || (bundle && bundle.sig === res.sig)) return res;
        // โค้ดที่เก็บในเครื่องไม่ตรงกับที่เซิร์ฟเวอร์คิด: ขอโค้ดใหม่อีกครั้ง (ผลเข้าสู่ระบบด้วย Google ใช้ของรอบแรก)
        return ask(have(null, cache.logo, cache.bg), null).then(function (r2) { r2.boot.oauth = res.boot.oauth; return r2; });
      }).then(function (res) {
        clearTimeout(slow);
        if (res.bundle) { bundle = res.bundle; kv.set('app:bundle', res.bundle); }
        var boot = res.boot;
        fillImages(boot.branding, cache);
        boot.appUrl = HERE;
        saveBoot(boot);
        lastCheck = Date.now();
        run(bundle, boot);
      }).catch(function (e) {
        clearTimeout(slow);
        var m = String((e && e.message) || e || '');
        var net = !navigator.onLine || /^NetworkError|TIMEOUT/.test(m) || (e && e.timeout);
        // ออฟไลน์ / เซิร์ฟเวอร์ไม่ตอบ: เปิดด้วยโค้ดและข้อมูลที่เก็บไว้ในเครื่อง
        if (net && bundle && saved && saved.boot && !oauth) {
          var boot = saved.boot;
          boot.offline = true;
          boot.oauth = null;
          boot.appUrl = HERE;
          fillImages(boot.branding, cache);
          run(bundle, boot);
          return;
        }
        if (net && !navigator.onLine) {
          screen('offline');
          window.addEventListener('online', function () { location.reload(); }, { once: true });
          return;
        }
        screen('error', net ? 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ (' + m.replace(/^NetworkError: /, '') + ') ตรวจอินเทอร์เน็ต แล้วกดลองใหม่' : m);
      });
    });
  }

  /* ---------- ระหว่างใช้งาน: ตรวจเวอร์ชันใหม่เมื่อกลับมาที่แอป ---------- */
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible' || !started || !navigator.onLine || Date.now() - lastCheck < CHECK_EVERY) return;
    lastCheck = Date.now();
    if (swReg) { try { swReg.update(); } catch (e) { /* ข้าม */ } }
    Promise.all([kv.get('app:bundle'), kv.get('pub:logo'), kv.get('pub:bg')]).then(function (r) {
      return call('pwaBoot', [{ have: have(r[0], r[1], r[2]) }], 45000).then(function (res) {
        if (!res.bundle) return;
        kv.set('app:bundle', res.bundle);
        emit('update');
      });
    }).catch(function () { /* ลองใหม่รอบถัดไป */ });
  });

  // ขอให้เบราว์เซอร์ไม่ลบข้อมูลในเครื่องของแอปที่ติดตั้งแล้ว
  if (standalone() && navigator.storage && navigator.storage.persist) { navigator.storage.persist().catch(function () { /* ข้าม */ }); }

  start();
})();
