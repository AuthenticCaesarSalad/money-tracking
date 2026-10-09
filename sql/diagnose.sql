-- =========================================================
-- DIAGNOSTIK: cek status RLS, kebijakan, dan data sebenarnya.
-- Jalankan di Supabase SQL Editor. Baca hasilnya.
-- Aman dijalankan berulang-ulang (hanya SELECT).
-- =========================================================

-- 1. Apakah RLS aktif pada public.users dan public.transactions?
select
  n.nspname        as schema,
  c.relname        as tabel,
  c.relrowsecurity as rls_aktif
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('users', 'transactions')
order by c.relname;

-- 2. Daftar kebijakan (policy) pada kedua tabel
select
  policyname,
  tablename,
  cmd,
  roles,
  qual,
  with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('users', 'transactions')
order by tablename, cmd;

-- 3. Jumlah transaksi per user (user_id null = transaksi lama tanpa pemilik)
select user_id, count(*) as jumlah
from public.transactions
group by user_id
order by count(*) desc;

-- 4. Daftar user. Password hash sengaja TIDAK di-select di sini.
select
  id,
  username,
  created_at
from public.users
order by created_at;
