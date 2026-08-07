// ZO AI Service Worker
// -----------------------------------------------------------------------
// Ada 2 cache terpisah:
// 1. SHELL_CACHE   -- halaman app + aset kecil. Di-versioning & dibersihin
//                      tiap ada update baru (biar user selalu dapet versi terbaru
//                      begitu online, tapi tetep ada fallback pas offline).
// 2. MODEL_CACHE    -- library transformers.js + file model AI on-device
//                      (~300-400MB dari Hugging Face). SENGAJA gak dibersihin
//                      pas update biar user gak perlu download ulang model
//                      raksasa itu tiap kali app-nya di-update -- persis kayak
//                      cara kerja PocketPal/app LLM on-device lainnya: app-nya
//                      cuma "wadah", modelnya nempel permanen di penyimpanan HP.
// -----------------------------------------------------------------------
const SHELL_CACHE = 'zo-ai-shell-v2';
const MODEL_CACHE = 'zo-ai-model-v1';

// Halaman & aset inti yang WAJIB bisa dibuka walau HP lagi 100% offline.
// Sesuaikan daftar ini kalau ada halaman baru (misal subscribe.html, dll).
const SHELL_URLS = [
  '/',
  '/index.html',
  '/landing.html',
  '/chat.html',
  '/manifest.json',
  '/assets/logo2-96.png',
  '/assets/logo2-192.png',
  '/assets/logo2-512.png',
];

// Domain CDN yang dipakai buat model AI on-device & library-nya -- ini yang
// perlu di-cache permanen (cache-first) biar gak didownload ulang tiap sesi.
const MODEL_HOSTS = ['huggingface.co', 'cdn-lfs.huggingface.co', 'cdn-lfs-us-1.huggingface.co', 'jsdelivr.net'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(async (cache) => {
      // Cache satu-satu (bukan cache.addAll) -- kalau salah satu URL gagal
      // (misal halaman belum ke-deploy), yang lain tetap ke-cache, bukannya
      // gagal total kayak cache.addAll yang all-or-nothing.
      await Promise.all(
        SHELL_URLS.map((url) =>
          cache.add(url).catch((err) => console.warn('[SW] Gagal cache', url, err))
        )
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          // Hapus cache shell versi lama, TAPI jangan pernah hapus MODEL_CACHE
          // (model AI-nya harus tetap awet lintas update aplikasi).
          .filter((key) => key !== SHELL_CACHE && key !== MODEL_CACHE)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Panggilan ke API kita sendiri (Supabase RPC, /api/chat, dll) -- selalu
  // langsung ke jaringan, jangan pernah di-cache (datanya dinamis/personal).
  if (url.pathname.startsWith('/api/')) return;

  // ---- Strategi 1: file model AI & library on-device (Hugging Face/jsdelivr) ----
  // Cache-first: file-file ini gede & praktis nggak pernah berubah (immutable
  // per versi), jadi begitu ada di cache, langsung pakai itu -- hemat kuota,
  // dan yang penting TETAP BISA DIPAKAI walau lagi offline total.
  if (MODEL_HOSTS.some((h) => url.hostname.includes(h))) {
    event.respondWith(
      caches.open(MODEL_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const res = await fetch(req);
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        } catch (err) {
          // Belum pernah kedownload & lagi offline -- gak ada yang bisa dikasih.
          return cached || Response.error();
        }
      })
    );
    return;
  }

  // ---- Strategi 2: navigasi antar halaman (buka app.html, landing.html, dll) ----
  // Network-first: kalau online, selalu ambil versi terbaru dari server (biar
  // gak stuck di versi lama). Kalau gagal (offline), baru pakai cache. Kalau
  // halaman yang diminta juga belum sempat ke-cache, fallback ke chat.html
  // (tempat mode "Gratis Offline" berada) daripada nampilin error browser polos.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const resClone = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(req, resClone));
          return res;
        })
        .catch(async () => {
          const cache = await caches.open(SHELL_CACHE);
          return (await cache.match(req)) || (await cache.match('/chat.html')) || Response.error();
        })
    );
    return;
  }

  // ---- Strategi 3: aset lain (JS/CSS/gambar/dll) ----
  // Network-first juga, cache sebagai fallback -- sama seperti versi sebelumnya,
  // cuma sekarang hasil sukses ikut disimpen ke cache biar makin lengkap seiring
  // pemakaian (bukan cuma seed awal SHELL_URLS).
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const resClone = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(req, resClone));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
