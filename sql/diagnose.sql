-- =========================================================
-- DIAGNOSTIK: cek status RLS & kebijakan pada tabel transactions
-- Jalankan di Supabase SQL Editor. Baca hasilnya.
-- =========================================================

-- 1. Apakah RLS aktif pada tabel?
select
  c.relname      as tabel,
  c.relrowsecurity as rls_aktif
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'transactions';

-- 2. Daftar kebijakan yang sudah ada
select
  policyname,
  cmd,
  roles,
  qual,
  with_check
from pg_policies
where schemaname = 'public'
  and tablename = 'transactions'
order by cmd;

-- 3. Jumlah baris data sebenarnya di tabel
select count(*) as total_baris from public.transactions;
