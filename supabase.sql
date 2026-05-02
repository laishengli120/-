-- Q-Bank cloud schema for Supabase
-- Run this in Supabase SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.qbanks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.qbank_questions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  bank_id uuid not null references public.qbanks(id) on delete cascade,
  type text not null default 'standard',
  stem text not null default '',
  answer text not null default '',
  analysis text not null default '',
  tags text[] not null default '{}',
  review_status text not null default 'new',
  sm_ef real not null default 2.5,
  sm_reps integer not null default 0,
  sm_interval integer not null default 0,
  sm_next_review timestamptz,
  sm_last_review timestamptz,
  options jsonb,
  sub_questions jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_qbanks_user_id on public.qbanks(user_id);
create index if not exists idx_qbanks_updated_at on public.qbanks(updated_at);
create index if not exists idx_qbank_questions_user_id on public.qbank_questions(user_id);
create index if not exists idx_qbank_questions_bank_id on public.qbank_questions(bank_id);
create index if not exists idx_qbank_questions_updated_at on public.qbank_questions(updated_at);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_qbanks_updated_at on public.qbanks;
create trigger trg_qbanks_updated_at
before update on public.qbanks
for each row execute function public.set_updated_at();

drop trigger if exists trg_qbank_questions_updated_at on public.qbank_questions;
create trigger trg_qbank_questions_updated_at
before update on public.qbank_questions
for each row execute function public.set_updated_at();

alter table public.qbanks enable row level security;
alter table public.qbank_questions enable row level security;

-- qbanks policies
drop policy if exists "qbanks_select_own" on public.qbanks;
create policy "qbanks_select_own"
on public.qbanks
for select
using (auth.uid() = user_id);

drop policy if exists "qbanks_insert_own" on public.qbanks;
create policy "qbanks_insert_own"
on public.qbanks
for insert
with check (auth.uid() = user_id);

drop policy if exists "qbanks_update_own" on public.qbanks;
create policy "qbanks_update_own"
on public.qbanks
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "qbanks_delete_own" on public.qbanks;
create policy "qbanks_delete_own"
on public.qbanks
for delete
using (auth.uid() = user_id);

-- qbank_questions policies
drop policy if exists "qbank_questions_select_own" on public.qbank_questions;
create policy "qbank_questions_select_own"
on public.qbank_questions
for select
using (auth.uid() = user_id);

drop policy if exists "qbank_questions_insert_own" on public.qbank_questions;
create policy "qbank_questions_insert_own"
on public.qbank_questions
for insert
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.qbanks b
    where b.id = bank_id and b.user_id = auth.uid()
  )
);

drop policy if exists "qbank_questions_update_own" on public.qbank_questions;
create policy "qbank_questions_update_own"
on public.qbank_questions
for update
using (auth.uid() = user_id)
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.qbanks b
    where b.id = bank_id and b.user_id = auth.uid()
  )
);

drop policy if exists "qbank_questions_delete_own" on public.qbank_questions;
create policy "qbank_questions_delete_own"
on public.qbank_questions
for delete
using (auth.uid() = user_id);
