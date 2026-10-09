-- =========================================================
-- SKEMA: Pencatatan Keuangan Pribadi (Income & Expense Tracker)
-- Versi multi-user dengan login username + password (tanpa email).
--
-- Jalankan seluruh isi file ini di Supabase SQL Editor.
-- File ini IDEMPOTEN: aman dijalankan berulang-ulang.
--   - create table if not exists / create index if not exists
--   - create or replace function
--   - drop policy if exists sebelum create policy
--   - revoke/grant dan alter table dapat diulang tanpa error
--
-- Catatan keamanan: aplikasi memakai Supabase JS client dengan
-- peran "anon". Tidak ada JWT / Supabase Auth session, jadi
-- isolasi per user dilakukan di sisi aplikasi dengan memfilter
-- berdasarkan user_id (lihat komentar pada bagian RLS).
-- pgcrypto (crypt / gen_salt) tersedia di Supabase secara default.
-- =========================================================

-- ---------------------------------------------------------
-- 1. Tabel users
-- ---------------------------------------------------------
create table if not exists public.users (
  id            uuid primary key default gen_random_uuid(),
  username      text not null unique,
  password_hash text not null,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------
-- 2. Tabel transactions
--    user_id nullable: baris lama & insert langsung tetap jalan.
-- ---------------------------------------------------------
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

-- Bila tabel transactions sudah ada dari versi sebelumnya,
-- pastikan kolom user_id tetap ditambahkan.
alter table public.transactions
  add column if not exists user_id uuid references public.users(id) on delete set null;

-- ---------------------------------------------------------
-- 3. Indeks
-- ---------------------------------------------------------
create index if not exists idx_transactions_user_id
  on public.transactions (user_id);

create index if not exists idx_transactions_transaction_date
  on public.transactions (transaction_date desc);

create index if not exists idx_transactions_created_at
  on public.transactions (created_at desc);

-- ---------------------------------------------------------
-- 4. Fungsi SECURITY DEFINER (bypass RLS)
--    Tidak ada schema-qualification di dalam fungsi;
--    search_path default Supabase SQL Editor sudah cukup
--    untuk menemukan crypt/gen_salt dari pgcrypto.
-- ---------------------------------------------------------

-- Membuat user baru. Hash password dengan bcrypt (bf, cost 8).
-- Hanya boleh dipanggil dari dashboard (lihat bagian privilege).
create or replace function public.create_user(p_username text, p_password text)
returns public.users
language plpgsql
security definer
as $$
declare
  v_row public.users;
begin
  insert into users (username, password_hash)
  values (p_username, crypt(p_password, gen_salt('bf', 8)))
  returning * into v_row;

  return v_row;
end;
$$;

-- Login: verifikasi password terhadap hash yang tersimpan.
-- Mengembalikan id + username jika cocok, kosong jika tidak.
create or replace function public.login_user(p_username text, p_password text)
returns table(id uuid, username text)
language plpgsql
security definer
as $$
begin
  return query
  select u.id, u.username
  from users u
  where u.username = p_username
    and u.password_hash = crypt(p_password, u.password_hash);

  return;
end;
$$;

-- ---------------------------------------------------------
-- 5. Privilege & Row Level Security
-- ---------------------------------------------------------

-- users: tidak boleh diakses langsung oleh anon/authenticated.
revoke all on public.users from anon, authenticated;

-- login_user boleh dipanggil oleh anon (dari halaman login).
grant execute on function public.login_user(text, text) to anon;

-- create_user HANYA untuk admin di dashboard Supabase.
revoke execute on function public.create_user(text, text) from anon, authenticated;

-- users + RLS: tanpa policy = tidak ada akses langsung untuk anon.
-- Fungsi SECURITY DEFINER di atas tetap bisa memodifikasi tabel
-- karena SECURITY DEFINER melewati RLS.
alter table public.users enable row level security;

-- transactions + RLS.
alter table public.transactions enable row level security;

-- Kebijakan akses untuk peran anon.
-- CATATAN: tanpa JWT / Supabase Auth session, kita tidak bisa
-- memakai auth.uid(). Karena itu tidak ada pembatasan per user
-- di level SQL. Isolasi per user di-enforce di sisi aplikasi
-- dengan memfilter query pada user_id (mis. .eq('user_id', uid)).
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

-- ---------------------------------------------------------
-- 6. Perbarui statistik tabel
-- ---------------------------------------------------------
analyze public.transactions;

-- =========================================================
-- BAGIAN OPSIONAL (hapus komentar untuk menjalankan)
-- =========================================================

-- Membuat user pertama (jalankan sekali di Supabase SQL Editor,
-- atau pakai tool lain dengan peran admin):
-- select public.create_user('bayu', 'password_rahasia');

-- Mengaitkan transaksi lama yang belum punya pemilik ke seorang user.
-- Ganti UUID di bawah dengan id user yang benar (dari select * from public.users;):
-- update public.transactions
-- set user_id = '00000000-0000-0000-0000-000000000000'
-- where user_id is null;
