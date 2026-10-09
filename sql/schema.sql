-- =========================================================
-- Skema: Pencatatan Keuangan Pribadi (Income & Expense Tracker)
-- Jalankan seluruh isi file ini di Supabase SQL Editor.
-- Jalankan ulang file ini jika form input ditolak database.
-- =========================================================

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

-- Indeks untuk pengurutan riwayat (tanggal terbaru)
create index if not exists idx_transactions_transaction_date
  on public.transactions (transaction_date desc);

create index if not exists idx_transactions_created_at
  on public.transactions (created_at desc);

-- Aktifkan Row Level Security
alter table public.transactions enable row level security;

-- Kebijakan akses untuk peran anon.
-- Aplikasi memakai anon public key di sisi klien.
-- TANPA kebijakan ini, form insert akan ditolak (error 42501 /
-- "row-level security") walau tabel dapat dibaca.
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

-- Pastikan RLS benar-benar aktif setelah kebijakan dibuat
alter table public.transactions enable row level security;

-- Perbarui statistik tabel
analyze public.transactions;

-- =========================================================
-- Data contoh (opsional, hapus jika tidak diperlukan)
-- =========================================================
insert into public.transactions (type, amount, category, description, transaction_date) values
  ('income',  8500000, 'Gaji',        'Gaji bulan ini',         '2026-10-01'),
  ('expense',  150000, 'Makanan',     'Makan siang',            '2026-10-02'),
  ('expense',   60000, 'Transportasi','Bensin motor',           '2026-10-03'),
  ('expense',  450000, 'Tagihan',     'Listrik & internet',     '2026-10-04')
on conflict (id) do nothing;
