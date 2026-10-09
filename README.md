# Pencatatan Keuangan Pribadi (Income & Expense Tracker)

Aplikasi pencatatan keuangan pribadi berbasis Native Web Tech (HTML, CSS, Vanilla
JavaScript) dengan backend **Supabase** (PostgreSQL + Supabase JS Client).

## Fitur

- Dashboard ringkasan: Total Saldo, Total Pemasukan, Total Pengeluaran.
- Form input transaksi (jenis, nominal, kategori, tanggal, keterangan opsional).
- Riwayat transaksi dalam tabel murni dengan nominal rata kanan.
- Hapus transaksi per baris.
- Semua data tersimpan di database Supabase (CRUD: Create, Read, Delete).
- Login multi-user dengan **username + password** (tanpa email).
- Setiap user hanya melihat transaksinya sendiri (filter per `user_id`).

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
3. Pastikan tabel `transactions` dan `users` muncul di menu **Table Editor**.

### 3. Buat user pertama

1. Masih di **SQL Editor**, klik **New query**.
2. Jalankan perintah berikut untuk membuat user pertama (ganti nama dan
   kata sandinya):

   ```sql
   select public.create_user('bayu', 'password_rahasia');
   ```

3. Password di-hash otomatis oleh fungsi tersebut (bcrypt, cost 8), jadi
   tidak perlu meng-hash manual. User tambahan dibuat dengan cara yang sama
   (lihat bagian **Pengguna & Login**).

### 4. Salin kredensial API

1. Buka **Project Settings** (ikon gerigi) > **API**.
2. Salin dua nilai berikut:
   - **Project URL**
   - **anon public key**

### 5. Konfigurasi aplikasi

Buka file `auth.js`, di bagian paling atas ubah kedua konstanta ini:

```js
const SUPABASE_URL = "https://your-project-ref.supabase.co";
const SUPABASE_ANON_KEY = "your-anon-public-key";
```

Ganti dengan nilai dari langkah 4. Tidak ada perubahan lain yang diperlukan.

### 6. Jalankan aplikasi

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

Jika kredensial benar, halaman akan mengarahkan ke `login.html`. Masukkan
username + password yang dibuat di langkah 3, lalu Anda dialihkan ke
`index.html` dan tabel akan memuat data yang ada.

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

### Dropdown Kategori kosong / form tidak bereaksi

Artinya `app.js` tidak dieksekusi browser (bukan masalah database). Sekarang
select kategori sudah berisi opsi statis sebagai cadangan, dan setiap error
JavaScript akan langsung tampil di kotak merah di bawah form. Untuk mencari
penyebabnya:

1. Tekan **F12** di browser > tab **Console**. Baca pesan merah yang muncul.
2. Jika muncul `Identifier 'supabase' has already been declared`: variabel
   client di `app.js` pernah dinamai `supabase`, yang bentrok dengan global
   `window.supabase` dari CDN. Sudah diganti menjadi `supabaseClient` —
   pastikan file yang di-deploy adalah versi terbaru.
3. Jika muncul "Kredensial Supabase belum dikonfigurasi" padahal kredensial
   sudah diisi: kemungkinan versi lama `app.js` masih ter-cache, atau teks
   guard anti-placeholder ikut terganti saat find-and-replace. Guard tersebut
   sudah dihapus — deploy ulang `app.js` versi terbaru dan hard-reload.
4. Tab **Network** > muat ulang halaman > cek baris `app.js`:
   - Status **404**: file belum ter-upload atau salah folder di server.
   - Kolom **Type** bukan `javascript`/`text/javascript`: hosting menyajikan
     file dengan MIME type salah. Tambahkan MIME type untuk `.js` di panel
     hosting (IIS: `application/javascript`), atau hubungi provider.
5. Matikan ekstensi pemblokir iklan/script lalu coba lagi.
6. Jika menggunakan Cloudflare, buat *Page Rule* "Bypass Cache" untuk domain
   agar `app.js` selalu diambil dari server.

Catatan: tag script memakai `?v=5` sebagai cache-buster. Naikkan angkanya
setiap kali meng-update file agar browser tidak memakai versi lama.

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
├── index.html          # Struktur UI + CDN Supabase (memuat auth.js + app.js)
├── login.html          # Halaman login username + password (memuat auth.js)
├── style.css           # Desain utilitarian (CSS Variables)
├── app.js              # Logika: fetch, insert, delete (filter per user_id)
├── auth.js             # Config Supabase, session localStorage, login/logout
├── sql/
│   ├── schema.sql      # Tabel users + transactions, fungsi, RLS
│   └── diagnose.sql    # Cek status RLS & kebijakan
└── README.md
```

## Skema Database (`sql/schema.sql`)

```sql
-- Tabel users (login username + password, tanpa email)
create table if not exists public.users (
  id            uuid primary key default gen_random_uuid(),
  username      text not null unique,
  password_hash text not null,
  created_at    timestamptz not null default now()
);

-- Tabel transaksi. user_id nullable: baris lama tetap jalan.
create table if not exists public.transactions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid references public.users(id) on delete set null,
  type             text not null check (type in ('income', 'expense')),
  amount           numeric not null check (amount >= 0),
  category         text not null,
  description      text,
  transaction_date date not null,
  created_at       timestamptz not null default now()
);

-- Indeks (pengurutan riwayat + filter per user)
create index if not exists idx_transactions_user_id
  on public.transactions (user_id);
create index if not exists idx_transactions_transaction_date
  on public.transactions (transaction_date desc);
create index if not exists idx_transactions_created_at
  on public.transactions (created_at desc);

-- Fungsi SECURITY DEFINER (bypass RLS, pakai pgcrypto).
-- Buat user baru; password di-hash dengan bcrypt (bf, cost 8).
create or replace function public.create_user(p_username text, p_password text)
returns public.users
language plpgsql security definer
as $$
declare v_row public.users;
begin
  insert into users (username, password_hash)
  values (p_username, crypt(p_password, gen_salt('bf', 8)))
  returning * into v_row;
  return v_row;
end;
$$;

-- Login: verifikasi password terhadap hash. Mengembalikan id + username
-- jika cocok, kosong jika tidak.
create or replace function public.login_user(p_username text, p_password text)
returns table(id uuid, username text)
language plpgsql security definer
as $$
begin
  return query
  select u.id, u.username from users u
  where u.username = p_username
    and u.password_hash = crypt(p_password, u.password_hash);
  return;
end;
$$;

-- Privilege: users TIDAK boleh diakses langsung oleh anon.
revoke all on public.users from anon, authenticated;
-- anon hanya boleh memanggil login_user (dari halaman login).
grant execute on function public.login_user(text, text) to anon;
-- create_user hanya untuk admin di dashboard Supabase.
revoke execute on function public.create_user(text, text) from anon, authenticated;

-- Row Level Security.
-- users + RLS tanpa policy = tidak ada akses langsung untuk anon;
-- fungsi SECURITY DEFINER di atas tetap bisa menulis karena melewati RLS.
alter table public.users enable row level security;

-- transactions + RLS. Karena tidak ada JWT/Supabase Auth session, kita
-- tidak bisa memakai auth.uid(); isolasi per user di-enforce di sisi
-- aplikasi dengan memfilter query pada user_id (mis. .eq('user_id', uid)).
alter table public.transactions enable row level security;

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

-- Perbarui statistik tabel
analyze public.transactions;
```

## Kategori yang Tersedia

| Jenis      | Kategori                          |
| ---------- | --------------------------------- |
| Pemasukan  | Gaji, Lainnya                     |
| Pengeluaran| Makanan, Transportasi, Tagihan, Lainnya |

Daftar kategori diatur pada konstanta `CATEGORIES` di `app.js`.

## Pengguna & Login

### Membuat user baru

Aplikasi tidak memiliki halaman registrasi. User hanya bisa dibuat dari
dashboard Supabase. Cara yang direkomendasikan adalah memanggil fungsi
`create_user` di **SQL Editor**:

```sql
select public.create_user('nama_user', 'kata_sandi');
```

Password di-hash otomatis dengan bcrypt oleh fungsi tersebut. Alternatifnya,
tambahkan baris langsung lewat **Table Editor** dengan mengisi `password_hash`
memakai nilai yang sudah di-hash (mis. dari `crypt('kata_sandi', gen_salt('bf', 8))`),
tetapi fungsi di atas tetap cara yang paling mudah dan bebas kesalahan.

### Alur login

1. Buka `index.html`. Jika belum ada session, aplikasi mengalihkan ke
   `login.html`.
2. Masukkan username + password, lalu klik **Masuk**.
3. Klien memanggil `supabase.rpc('login_user', { p_username, p_password })`.
   Jika kredensial cocok, session (id + username) disimpan di `localStorage`
   dan Anda dialihkan kembali ke `index.html`.
4. Untuk keluar, klik tombol **Keluar**; session dihapus dari `localStorage`
   dan Anda kembali ke `login.html`.

### Melihat transaksi per user

Setiap user hanya melihat transaksinya sendiri. Semua query di `app.js`
memfilter pada kolom `user_id` berdasarkan session yang sedang aktif, jadi
data satu user tidak muncul di dashboard user lain.

### Mengaitkan transaksi lama ke seorang user

Transaksi yang dibuat sebelum fitur multi-user memiliki `user_id` kosong.
Untuk mengaitkannya ke seorang user, ambil dulu id user tersebut
(`select * from public.users;`), lalu:

```sql
update public.transactions set user_id = '<uuid user>' where user_id is null;
```

### Ganti kata sandi user

Jalankan langsung di **SQL Editor** ( hashing tetap memakai bcrypt ):

```sql
update public.users
set password_hash = crypt('kata_sandi_baru', gen_salt('bf', 8))
where username = 'nama_user';
```

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

### Catatan jujur soal isolasi multi-user

Aplikasi ini memakai peran `anon` **tanpa** Supabase Auth / JWT. Akibatnya,
isolasi transaksi per user (filter pada `user_id`) di-enforce **di sisi
aplikasi (client-side)**, bukan di level database. Kebijakan RLS pada
`transactions` di atas bersifat permissif untuk `anon`, jadi secara teknis
siapa pun yang memiliki URL proyek masih bisa membaca/mengubah seluruh baris
tabel `transactions` lewat klien lain. Filter per user cukup untuk memisahkan
tampilan antar user secara sehari-hari, tetapi ini **bukan** batas keamanan
yang sesungguhnya. Untuk batas keamanan yang nyata, migrasilah ke Supabase
Auth dan ganti kebijakan RLS menjadi berbasis `auth.uid()` seperti contoh di
atas.

Yang sudah aman: tabel `users` itu sendiri. Peran `anon` tidak memiliki akses
langsung ke tabel tersebut (lihat `revoke all` dan RLS tanpa policy), jadi
password hash tidak pernah meninggalkan database. Satu-satunya jalan masuk
adalah fungsi `login_user` yang berjalan sebagai `SECURITY DEFINER`, dan fungsi
itu hanya memverifikasi username + password serta mengembalikan id + username —
tidak pernah mengembalikan `password_hash`.

## Teknologi

- HTML5, CSS3 (CSS Grid + CSS Variables), Vanilla JavaScript (ES6+)
- Supabase JS Client v2 (`@supabase/supabase-js`) via CDN jsDelivr
- Inter (sans-serif) + JetBrains Mono (angka/nominal)
