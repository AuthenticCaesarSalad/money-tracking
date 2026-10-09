# Pencatatan Keuangan Pribadi (Income & Expense Tracker)

Aplikasi pencatatan keuangan pribadi berbasis Native Web Tech (HTML, CSS, Vanilla
JavaScript) dengan backend **Supabase** (PostgreSQL + Supabase JS Client).

## Fitur

- Dashboard ringkasan: Total Saldo, Total Pemasukan, Total Pengeluaran.
- Form input transaksi (jenis, nominal, kategori, tanggal, keterangan opsional).
- Riwayat transaksi dalam tabel murni dengan nominal rata kanan.
- Hapus transaksi per baris.
- Semua data tersimpan di database Supabase (CRUD: Create, Read, Delete).

## Prasyarat

- Akun Supabase (gratis) di <https://supabase.com>.
- Browser modern. Tidak butuh Node.js, npm, atau build tool apa pun.

## Cara Memulai

### 1. Buat proyek Supabase

1. Login ke <https://supabase.com>, klik **New Project**.
2. Isi nama proyek, pilih region terdekat, set database password.
3. Tunggu hingga status proyek menjadi **Active**.

### 2. Buat tabel `transactions`

1. Buka proyek, masuk ke menu **SQL Editor**.
2. Klik **New query**, salin seluruh isi file `sql/schema.sql` (lihat bagian
   di bawah), lalu jalankan dengan tombol **Run**.
3. Pastikan tabel `transactions` muncul di menu **Table Editor**.

### 3. Salin kredensial API

1. Buka **Project Settings** (ikon gerigi) > **API**.
2. Salin dua nilai berikut:
   - **Project URL**
   - **anon public key**

### 4. Konfigurasi aplikasi

Buka file `app.js`, di bagian paling atas ubah kedua konstanta ini:

```js
const SUPABASE_URL = "https://your-project-ref.supabase.co";
const SUPABASE_ANON_KEY = "your-anon-public-key";
```

Ganti dengan nilai dari langkah 3. Tidak ada perubahan lain yang diperlukan.

### 5. Jalankan aplikasi

Cukup buka file `index.html` di browser:

- Klik dua kali file `index.html`, atau
- Seret file ke jendela browser, atau
- Jalankan server statis sederhana:

  ```bash
  # Python 3
  python -m http.server 8000
  # lalu buka http://localhost:8000
  ```

  ```bash
  # Node.js (npx, tanpa instalasi permanen)
  npx serve .
  ```

Jika kredensial benar, form siap digunakan dan tabel akan memuat data yang ada.

## Troubleshooting

### Form simpan berhasil terlihat, tapi data tidak muncul

Penyebab paling umum: kebijakan **Row Level Security (RLS)** untuk peran
`anon` belum dibuat di tabel `transactions`. Saat RLS aktif tanpa kebijakan,
PostgREST **menolak insert** dengan error, tetapi operasi `select` tetap
berjalan — sehingga aplikasi terlihat terhubung padahal tulisan ditolak.

Cara memastikan: pesan error kini tampil sebagai kotak merah di bawah form.
Jika isinya menyebut *permission* / *row-level security*, lakukan:

1. Buka proyek Supabase > **SQL Editor**.
2. Jalankan ulang seluruh isi `sql/schema.sql` (aman dijalankan berulang).
3. Atau jalankan `sql/diagnose.sql` untuk melihat status RLS dan daftar
   kebijakan yang ada pada tabel.
4. Pastikan muncul 4 kebijakan: `select`, `insert`, `update`, `delete`
   untuk peran `anon`.

Untuk aplikasi pribadi yang hanya butuh akses penuh, alternatif tercepat:
nonaktifkan RLS sepenuhnya (tidak direkomendasikan untuk produksi).

```sql
alter table public.transactions disable row level security;
```

### Tabel menampilkan "Gagal memuat data"

- Cek apakah `SUPABASE_URL` dan `SUPABASE_ANON_KEY` sudah benar di `app.js`.
- Cek koneksi internet (Supabase JS Client dimuat dari CDN).
- Buka DevTools browser (F12) > tab **Console** untuk pesan error lengkap.

### Tampilan tidak diperbarui setelah deploy

Browser mungkin menggunakan versi `app.js` / `style.css` yang di-cache.
Lakukan hard reload (`Ctrl + Shift + R` atau `Cmd + Shift + R`), atau
buka DevTools > **Network** > centang **Disable cache**.

## Struktur Proyek

```
.
├── index.html          # Struktur UI + CDN Supabase
├── style.css           # Desain utilitarian (CSS Variables)
├── app.js              # Logika: inisialisasi Supabase, fetch, insert, delete
├── sql/
│   ├── schema.sql      # Skema tabel + kebijakan Row Level Security
│   └── diagnose.sql    # Cek status RLS & kebijakan
└── README.md
```

## Skema Database (`sql/schema.sql`)

```sql
-- Tabel transaksi
create table if not exists public.transactions (
  id               uuid primary key default gen_random_uuid(),
  type             text not null check (type in ('income', 'expense')),
  amount           numeric not null check (amount >= 0),
  category         text not null,
  description      text,
  transaction_date date not null,
  created_at       timestamptz not null default now()
);

-- Indeks untuk pengurutan riwayat
create index if not exists idx_transactions_transaction_date
  on public.transactions (transaction_date desc);

create index if not exists idx_transactions_created_at
  on public.transactions (created_at desc);

-- Aktifkan Row Level Security
alter table public.transactions enable row level security;

-- Kebijakan akses anon (aplikasi pribadi, klien memakai anon key).
-- Tanpa kebijakan ini, insert dari form akan ditolak database.
drop policy if exists "transactions_select_anon" on public.transactions;
create policy "transactions_select_anon"
  on public.transactions for select
  to anon using (true);

drop policy if exists "transactions_insert_anon" on public.transactions;
create policy "transactions_insert_anon"
  on public.transactions for insert
  to anon with check (true);

drop policy if exists "transactions_update_anon" on public.transactions;
create policy "transactions_update_anon"
  on public.transactions for update
  to anon using (true) with check (true);

drop policy if exists "transactions_delete_anon" on public.transactions;
create policy "transactions_delete_anon"
  on public.transactions for delete
  to anon using (true);

-- Pastikan RLS aktif setelah kebijakan dibuat
alter table public.transactions enable row level security;

-- Perbarui statistik tabel
analyze public.transactions;
```

## Kategori yang Tersedia

| Jenis      | Kategori                          |
| ---------- | --------------------------------- |
| Pemasukan  | Gaji, Lainnya                     |
| Pengeluaran| Makanan, Transportasi, Tagihan, Lainnya |

Daftar kategori diatur pada konstanta `CATEGORIES` di `app.js`.

## Catatan Keamanan

Aplikasi ini memakai **anon public key**, yang sengaja dirancang aman untuk
diekspos di sisi klien. Karena kebijakan RLS di atas mengizinkan semua operasi
untuk peran `anon`, siapa pun yang memiliki URL dapat membaca, menambah, dan
menghapus data. Cocok untuk penggunaan pribadi/lokal.

Untuk produksi, ganti kebijakan tersebut dengan aturan berbasis
`auth.uid()` dan aktifkan otentikasi Supabase Auth, misalnya:

```sql
create policy "transactions_select_own"
  on public.transactions for select
  to authenticated using ((select auth.uid()) = user_id);
```

Pastikan juga aplikasi mengirimkan `session` dari Supabase Auth, dan tambahkan
kolom `user_id uuid references auth.users` pada tabel.

## Teknologi

- HTML5, CSS3 (CSS Grid + CSS Variables), Vanilla JavaScript (ES6+)
- Supabase JS Client v2 (`@supabase/supabase-js`) via CDN jsDelivr
- Inter (sans-serif) + JetBrains Mono (angka/nominal)
