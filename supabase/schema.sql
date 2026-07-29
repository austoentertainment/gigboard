-- Austo Gig Board — Phase 1 schema
-- Run this once in the Supabase SQL editor (Database > SQL Editor > New query).

-- ============================================================
-- users (mirrors auth.users, adds app role)
-- ============================================================

create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  role text not null default 'dj' check (role in ('owner', 'dj', 'musician')),
  created_at timestamptz not null default now()
);

create function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users where id = auth.uid() and role = 'owner'
  );
$$;

create function public.is_dj()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users where id = auth.uid() and role = 'dj'
  );
$$;

create function public.is_musician()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users where id = auth.uid() and role = 'musician'
  );
$$;

-- New Supabase Auth signups get a matching public.users + dj_profiles row.
-- austin@djausto.com is bootstrapped straight to 'owner'; everyone else starts
-- as 'dj' — the /api/roster route immediately promotes a new account to
-- 'musician' right after creation when the owner adds one, since there's no
-- self-signup path a musician could pick their own role through.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, display_name, role)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'display_name',
    case when new.email = 'austin@djausto.com' then 'owner' else 'dj' end
  );
  insert into public.dj_profiles (user_id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Only the owner may change a role — otherwise a DJ could self-promote via a raw update call.
create function public.prevent_role_escalation()
returns trigger
language plpgsql
as $$
begin
  if new.role <> old.role and not public.is_owner() then
    raise exception 'only the owner can change roles';
  end if;
  return new;
end;
$$;

create trigger trg_prevent_role_escalation
  before update on public.users
  for each row execute function public.prevent_role_escalation();

alter table public.users enable row level security;

create policy "users_select" on public.users
  for select using (id = auth.uid() or public.is_owner());

create policy "users_update" on public.users
  for update using (id = auth.uid() or public.is_owner());

-- ============================================================
-- dj_profiles
-- ============================================================

-- Despite the name, this table now holds the roster profile for both DJs
-- and musicians (instrument only applies to musicians) — reusing it avoids
-- a second per-user profile table and a second insert trigger branch.
create table public.dj_profiles (
  user_id uuid primary key references public.users(id) on delete cascade,
  dj_tier_visibility text[] not null default '{}',
  instrument text check (instrument in ('Saxophone', 'Violin')),
  notify_email boolean not null default true,
  notify_sms boolean not null default false,
  phone text
);

alter table public.dj_profiles enable row level security;

create policy "dj_profiles_select" on public.dj_profiles
  for select using (user_id = auth.uid() or public.is_owner());

create policy "dj_profiles_update" on public.dj_profiles
  for update using (user_id = auth.uid() or public.is_owner());

create policy "dj_profiles_insert" on public.dj_profiles
  for insert with check (public.is_owner());

-- ============================================================
-- leads
-- ============================================================

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  client_name text,
  fiance_name text,
  contact text,
  event_date date,
  location text,
  dj_tier text check (dj_tier in ('Headliner', 'Resident', 'Associate')),
  prod_tier text check (prod_tier in ('Marquee', 'Modern', 'Essential')),
  upgrades text,
  client_vision text,
  source text not null default 'manual' check (source in ('honeybook', 'manual')),
  owner_notes text,
  dj_notes text,
  meeting_notes text,
  payout numeric,
  travel_zone text check (travel_zone in ('Local', 'Extended Local', 'Regional', 'Central CA')),
  travel_rate numeric,
  deposit_paid boolean not null default false,
  paid_in_full boolean not null default false,
  status text not null default 'checking' check (status in ('checking', 'meeting', 'booked', 'played', 'lost')),
  assigned_dj_id uuid references public.users(id),
  honeybook_ref text unique,
  needs_review boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.leads enable row level security;

-- DJs never query this table directly (the app only ever reads leads_feed
-- for them) and this policy blocks them at the row level regardless — so
-- granting table-level SELECT to authenticated below doesn't expose
-- anything; RLS is what actually enforces the boundary here.
create policy "leads_owner_select" on public.leads
  for select using (public.is_owner());

create policy "leads_owner_write" on public.leads
  for insert with check (public.is_owner());

create policy "leads_owner_update" on public.leads
  for update using (public.is_owner());

create policy "leads_owner_delete" on public.leads
  for delete using (public.is_owner());

-- Postgres requires SELECT privilege to evaluate a WHERE clause on
-- UPDATE/DELETE, even when the RLS policy alone would allow it — without
-- this grant, every owner update/delete on leads fails with "permission
-- denied for table leads".
grant select on public.leads to authenticated;

-- ============================================================
-- lead_musicians — a lead can book zero, one, or both musicians
-- (e.g. a saxophonist for cocktail hour AND a violinist for the
-- ceremony), each with their own services and payout. Row-level
-- granularity means a musician's own row can just be read directly —
-- no extra privacy view needed, since they can never see another
-- musician's row.
-- ============================================================

create table public.lead_musicians (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  musician_id uuid not null references public.users(id) on delete cascade,
  services text[] not null default '{}',
  payout numeric,
  created_at timestamptz not null default now(),
  unique (lead_id, musician_id)
);

alter table public.lead_musicians enable row level security;

create policy "lead_musicians_owner_all" on public.lead_musicians
  for all using (public.is_owner()) with check (public.is_owner());

create policy "lead_musicians_musician_select" on public.lead_musicians
  for select using (musician_id = auth.uid());

grant select on public.lead_musicians to authenticated;

-- ============================================================
-- availability_responses
-- ============================================================

create table public.availability_responses (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  dj_user_id uuid not null references public.users(id) on delete cascade,
  response text not null check (response in ('available', 'pass')),
  responded_at timestamptz not null default now(),
  unique (lead_id, dj_user_id)
);

alter table public.availability_responses enable row level security;

create policy "availability_select" on public.availability_responses
  for select using (dj_user_id = auth.uid() or public.is_owner());

create policy "availability_insert" on public.availability_responses
  for insert with check (dj_user_id = auth.uid() or public.is_owner());

create policy "availability_update" on public.availability_responses
  for update using (dj_user_id = auth.uid() or public.is_owner());

create policy "availability_delete" on public.availability_responses
  for delete using (public.is_owner());

-- ============================================================
-- events (lightweight audit log)
-- ============================================================

create table public.events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references public.leads(id) on delete cascade,
  actor_user_id uuid references public.users(id),
  event_type text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);

alter table public.events enable row level security;

create policy "events_owner_select" on public.events
  for select using (public.is_owner());

-- Deleting a lead cascades into deleting its events rows. Without a delete
-- policy here, RLS blocks that cascade (default deny) and the whole lead
-- delete fails.
create policy "events_owner_delete" on public.events
  for delete using (public.is_owner());

create function public.log_lead_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status <> old.status then
    insert into public.events (lead_id, actor_user_id, event_type, detail)
    values (new.id, auth.uid(), 'status_change', jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  return new;
end;
$$;

create trigger trg_log_lead_status_change
  after update on public.leads
  for each row execute function public.log_lead_status_change();

create function public.log_availability_response()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.events (lead_id, actor_user_id, event_type, detail)
  values (new.lead_id, new.dj_user_id, 'availability_response', jsonb_build_object('response', new.response));
  return new;
end;
$$;

create trigger trg_log_availability_response
  after insert or update on public.availability_responses
  for each row execute function public.log_availability_response();

-- ============================================================
-- leads_feed — the view every client query goes through
-- ============================================================
-- Owned by the SQL-editor role (bypasses RLS), so it can apply its own
-- visibility + column-hiding rules independent of the leads table policies:
--   - owner: every column, every row
--   - dj: no client_name/contact/owner_notes, and only rows that are still
--     in date-check, or already assigned to them and booked/played
-- has_available lets a DJ's own card show the same green "ready" cue the
-- owner sees, without exposing which other DJs answered.

create view public.leads_feed as
select
  l.id,
  l.client_name,
  case when public.is_owner() then l.contact else null end as contact,
  l.event_date,
  l.location,
  l.dj_tier,
  l.prod_tier,
  l.upgrades,
  l.client_vision,
  case when public.is_owner() then l.owner_notes else null end as owner_notes,
  l.dj_notes,
  l.payout,
  l.status,
  l.assigned_dj_id,
  l.source,
  l.honeybook_ref,
  l.needs_review,
  l.created_at,
  exists (
    select 1 from public.availability_responses ar
    where ar.lead_id = l.id and ar.response = 'available'
  ) as has_available,
  l.meeting_notes,
  l.travel_zone,
  l.travel_rate,
  l.fiance_name,
  case when public.is_owner() or l.assigned_dj_id = auth.uid() then l.deposit_paid else null end as deposit_paid,
  case when public.is_owner() or l.assigned_dj_id = auth.uid() then l.paid_in_full else null end as paid_in_full
from public.leads l
where
  public.is_owner()
  or (l.status = 'checking' and public.is_dj())
  or (l.assigned_dj_id = auth.uid() and l.status in ('booked', 'played'))
  or exists (
    select 1 from public.lead_musicians lm
    where lm.lead_id = l.id and lm.musician_id = auth.uid()
  );

grant select on public.leads_feed to authenticated;

-- ============================================================
-- dj_leaderboard — aggregate-only, so any DJ can see the team's
-- standings without exposing anyone's individual leads/clients.
-- Same count/total semantics as the owner's Roster view (all leads
-- ever assigned, any status).
-- ============================================================

create view public.dj_leaderboard as
select
  u.id as dj_id,
  u.display_name,
  u.email,
  count(l.id) as booking_count,
  coalesce(sum(coalesce(l.payout, 0) + coalesce(l.travel_rate, 0)), 0) as booking_total
from public.users u
left join public.leads l on l.assigned_dj_id = u.id
where u.role = 'dj'
group by u.id, u.display_name, u.email;

grant select on public.dj_leaderboard to authenticated;

-- ============================================================
-- company_settings (singleton — tier rate table)
-- ============================================================

create table public.company_settings (
  id int primary key default 1 check (id = 1),
  headliner_rate numeric not null default 3000,
  resident_rate numeric not null default 2000,
  associate_rate numeric not null default 1000,
  marquee_rate numeric not null default 1500,
  modern_rate numeric not null default 500,
  essential_rate numeric not null default 0,
  travel_local_rate numeric not null default 0,
  travel_extended_local_rate numeric not null default 100,
  travel_regional_rate numeric not null default 300,
  travel_central_ca_rate numeric not null default 400
);

insert into public.company_settings (id) values (1);

alter table public.company_settings enable row level security;

create policy "company_settings_select" on public.company_settings
  for select using (true);

create policy "company_settings_update" on public.company_settings
  for update using (public.is_owner());
