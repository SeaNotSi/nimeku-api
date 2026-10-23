# nimeku — static API anime · manga · manhwa · doujin

API JSON statis yang di-scrape terjadwal oleh GitHub Actions dari empat sumber, plus web kecil buat nonton dan baca langsung dari data itu.

Hasil scrape di-commit otomatis ke repo ini dan disajikan lewat GitHub Pages.

## Sumber data

| Sumber | Isi | Catatan |
|---|---|---|
| **gomunime.top** | series, episode, server streaming (xtwap B-TUBE/CEPAT, mp4upload, mega, dll) | stream xtwap di-resolve per scrape |
| **v2.samehadaku.how** | katalog anime, episode, server embed via `player_ajax`, link download | REST WP + halaman episode |
| **MangaDex** | manga (JP) & manhwa (KR), daftar chapter, halaman chapter | manifest halaman di-cache; chapter lain di-resolve live lewat mirror JSON |
| **nhentai** | galeri doujin + halaman gambar | gambar bisa hotlink langsung |

## Struktur API

Semua di bawah `data/`. Format list memakai chunk 500 item + `index.json` per folder:

```
data/
  meta.json                      # ringkasan + statistik per sumber
  state.json                     # state incremental scraper
  gomunime/
    list/000.json … index.json         # katalog series
    series/<bucket>.json               # detail series (episode list, genre, rating)
    episodes/list/…, episodes/<bucket>.json   # episode + players[{label,kind,embed,file,hls}]
  samehadaku/
    anime/list/…, anime/<bucket>.json  # katalog + detail anime
    taxonomy.json                      # genre/season/studio id → nama
    episodes/list/…, episodes/<bucket>.json   # episode + servers[{server,embedUrl}]
    series/<bucket>.json               # episode per series (urut)
  mangadex/
    list/manga/…, list/manhwa/…        # katalog
    items/<bucket>.json                # detail + chapter list (flag `baked`)
    chapters/<bucket>.json             # manifest chapter: {hash, files} → uploads.mangadex.org
    index.json
  nhentai/
    list/…, items/<bucket>.json        # katalog + detail + pages
```

`<bucket>` = `fnv1a(id) % 256` dalam 2 digit hex — sama seperti `bucketOf()` di `web/app.js` dan `scraper/lib/util.mjs`.

### Cara pakai dari luar

- **GitHub Pages** (web + data, same-origin): `https://seanotsi.github.io/nimeku-api/`
- **raw.githubusercontent.com**: `https://raw.githubusercontent.com/SeaNotSi/nimeku-api/main/data/meta.json` — ada `Access-Control-Allow-Origin: *`
- **jsDelivr** (CDN + cache): `https://cdn.jsdelivr.net/gh/SeaNotSi/nimeku-api@main/data/meta.json` — ada CORS juga

Contoh: list manga populer → `data/mangadex/list/manga/000.json`, detail → `data/mangadex/items/<bucket>.json`.

### Endpoint universal (privat)

Satu file berisi seluruh katalog: anime (dua sumber + player/server), manga, manhwa, doujin, semua URL gambar, semua rating, dan jumlah chapter.

```
https://seanotsi.github.io/nimeku-api/data/api.enc.json
```

Cuma ada di Pages — file ini tidak di-commit, jadi jsDelivr/raw tidak menyediakannya.

Isinya ciphertext AES-256-GCM (gzip di dalam), jadi URL-nya boleh publik tapi tanpa passphrase tidak ada yang bisa dibaca. Passphrase ada di repo secret `NIMEKU_API_PASSPHRASE`. Bundle dibangun saat job deploy Pages (`scraper/seal-bundle.mjs`), bukan di-commit — file 6 MB yang berubah tiap 6 jam akan membengkakkan repo.

Bentuk data setelah dibuka:

```
{
  v, generatedAt, sources[], counts{anime, animeEpisodes, manga, manhwa, chapters, doujin, doujinPages, images},
  meta: { state },
  anime: { gomunime: [...], samehadaku: [...] },   // tiap item punya episodes[]
  manga: [...], manhwa: [...], doujin: [...],
  images: { posters: { "<prefix:id>": "<url>" } }
}
```

## Scraper

```
cd scraper
node scrape.mjs --source=all            # semua sumber, incremental
node scrape.mjs --source=mangadex --pagebudget=600 --chapters=40
node scrape.mjs --source=gomunime --limit=300
node scrape.mjs --mode=full             # walk penuh (hati-hati waktu)
```

Opsi: `--source=gomunime|samehadaku|mangadex|nhentai|all`, `--mode=full|incremental`, `--limit=N` (batas detail), `--chapters=N` (chapter per judul, mangadex), `--pagebudget=N` (fetch halaman chapter, mangadex), `--offset=N`.

Khusus samehadaku transport-nya `curl` (Cloudflare menolak TLS fingerprint undici). Jadi `curl` harus ada di runner.

### GitHub Actions

- `scrape.yml` — jalan tiap 6 jam + manual dispatch; commit otomatis ke `data/`.
- `pages.yml` — build & deploy `web/` + `data/` ke Pages setiap push ke `main`.

Stream xtwap punya masa berlaku terbatas, dan halaman player bisa 404 kalau berkasnya sudah dihapus di sumber. Scraper menandai `players[].live`, halaman nonton menyembunyikan server `live: false`, dan episode lama bisa di-backfill dari root repo:

```
node scraper/tools/probe-xtwap.mjs           # isi flag live yang belum ada
node scraper/tools/probe-xtwap.mjs --force   # probe ulang semua
```

Untuk samehadaku hanya embed Blogger yang bisa diputar dari origin lain: mega/wibufile sudah mati dan filedon mengunci referer ke samehadaku.how, jadi server itu ditampilkan sebagai tautan ke halaman sumber.

## Web

`web/` adalah SPA tanpa build step, gerbang privat dengan tema editorial bersih:

- **Gerbang** — passphrase API diminta sekali, disimpan di `localStorage` (30 hari). `web/config.js` bisa mengisi default.
- `#/` beranda — hero rating tertinggi, rail rekomendasi (interleave rating semua jenis), statistik.
- `#/browse/{anime|manga|manhwa|doujin}` — katalog dengan filter genre + sortir (rating / terpopuler / judul / episode-chapter terbanyak).
- `#/genres`, `#/genre/{jenis}/{nama}` — indeks genre per jenis (anime, manga, manhwa, doujin dipisah panel).
- `#/item/...` — detail + poster + sinopsis + chip genre + daftar episode/chapter 1→terbaru + blok "Serupa" (skor irisan genre × rating).
- `#/watch/...` — pemutar multi-sumber: gomunime (GDPLAYER, HLS, file) dan samehadaku (Server 1/3/4/5 blogger), pilihan tersimpan per episode, navigasi prev/next.
- `#/read/...` — pembaca manga/manhwa (manifest bucket → mirror r.jina.ai, cache 7 hari) dan doujin (halaman langsung), dropdown bab + prev/next.
- `#/favorites`, `#/settings` — favorit lokal, tema terang/gelap, reset cache, tukar passphrase.
- `#/search` — pencarian lintas 4 katalog.

### Papan keamanan

- CSP ketat: `script-src 'self'`, `object-src none`, `form-action none`, `base-uri none`, teks berpola Trusted-Types (level single-source).
- Semua render via `createElement`/`textContent`, tidak ada `innerHTML`; URL masuk disaring `safeUrl()` (hanya https, host nyata).
- iframe player ber-`sandbox`, `referrerpolicy=no-referrer`; jendela atas tidak bisa dinavigasi oleh embed (tanpa redirect keluar).
- `window.open` dinonaktifkan, klik-kanan/drag/copy/select/Ctrl+S/U/P + F12 diblokir, tab tersembunyi → cover penanda, event print juga tercover, API `getDisplayMedia` diblokir.
- Tidak ada iklan, analitik, atau teks pihak ketiga.

Deploy: otomatis via `pages.yml`, atau copy isi `web/` + folder `data/` ke hosting statis mana pun.

### Cara chapter dibaca

1. `chapters/<bucket>.json` menyimpan `{hash, files}` dari MangaDex@Home; `web/app.js` merangkai sendiri URL `https://uploads.mangadex.org/data/<hash>/<file>`.
2. Kalau chapter belum punya manifest, reader memanggil `https://r.jina.ai/https://api.mangadex.org/at-home/server/<chapterId>` (MangaDex API tidak mengirim header CORS; mirror ini mengirim `data.content` berisi JSON yang sama) lalu menyimpannya di `localStorage`.
3. `--pagebudget` mengatur berapa manifest baru yang diambil per run (default 800 incremental / 25000 full), urut judul paling populer, chapter terbaru dulu.

## Catatan

- Konten doujin 18+; sumber data menentukan rating kontennya masing-masing.
- ukuran `data/` bertumbuh tiap refresh; chunk 500 item menjaga file tetap kecil.
