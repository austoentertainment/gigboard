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

-- Only the owner may change a role — otherwise a DJ could self-promote via a
-- raw update call. auth.role() = 'service_role' is also allowed through:
-- that's never reachable from the browser (only our own server-side API
-- routes hold the service-role key), and /api/roster already checks
-- requireOwner() before it ever promotes a new account to 'musician' — a
-- service-role request has no auth.uid() at all, so without this the
-- promotion silently fails is_owner() and the account is stuck as 'dj'.
create function public.prevent_role_escalation()
returns trigger
language plpgsql
as $$
begin
  if new.role <> old.role and not public.is_owner() and auth.role() <> 'service_role' then
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
  phone text,
  avatar_url text
);

alter table public.dj_profiles enable row level security;

create policy "dj_profiles_select" on public.dj_profiles
  for select using (user_id = auth.uid() or public.is_owner());

create policy "dj_profiles_update" on public.dj_profiles
  for update using (user_id = auth.uid() or public.is_owner());

create policy "dj_profiles_insert" on public.dj_profiles
  for insert with check (public.is_owner());

-- ============================================================
-- avatars storage bucket — public read (so a plain <img src> works for
-- teammates and the Leaderboard without a signed URL), write restricted
-- to the file's own folder ({user_id}/...) or the owner managing anyone's.
-- ============================================================

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

create policy "avatar_public_read" on storage.objects
  for select using (bucket_id = 'avatars');

create policy "avatar_owner_or_self_write" on storage.objects
  for insert with check (
    bucket_id = 'avatars'
    and (auth.uid()::text = (storage.foldername(name))[1] or public.is_owner())
  );

create policy "avatar_owner_or_self_update" on storage.objects
  for update using (
    bucket_id = 'avatars'
    and (auth.uid()::text = (storage.foldername(name))[1] or public.is_owner())
  );

create policy "avatar_owner_or_self_delete" on storage.objects
  for delete using (
    bucket_id = 'avatars'
    and (auth.uid()::text = (storage.foldername(name))[1] or public.is_owner())
  );

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
  assigned_dj_id uuid references public.users(id) on delete set null,
  honeybook_ref text unique,
  needs_review boolean not null default false,
  created_at timestamptz not null default now(),
  vibo_link text,
  -- The musician add-on pipeline is tracked independently of the DJ-side
  -- status above — a lead can be fully DJ-booked with no musician (or vice
  -- versa), so it needs its own stage rather than being derived from
  -- status. new/pending_booking are set by the owner by hand (they mark
  -- real-world events — the intro call happened, the hold started);
  -- planning/complete/booked_no_musician auto-advance from lead_musicians
  -- and event_date (see trg_advance_musician_stage and the daily cron).
  musician_stage text not null default 'new'
    check (musician_stage in ('new', 'pending_booking', 'planning', 'booked_no_musician', 'archived', 'complete')),
  -- Set when the owner moves a lead to pending_booking — the client holds
  -- the date for 14 days from this meeting, shown as a reference deadline
  -- (no auto-expiry; the owner archives it by hand if it goes cold).
  musician_meeting_date date
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
  deposit_paid boolean not null default false,
  paid_in_full boolean not null default false,
  created_at timestamptz not null default now(),
  unique (lead_id, musician_id)
);

alter table public.lead_musicians enable row level security;

create policy "lead_musicians_owner_all" on public.lead_musicians
  for all using (public.is_owner()) with check (public.is_owner());

create policy "lead_musicians_musician_select" on public.lead_musicians
  for select using (musician_id = auth.uid());

grant select on public.lead_musicians to authenticated;

-- Booking a musician onto a lead is what "Planning" means — advance the
-- stage automatically here rather than relying on every call site (owner
-- UI, the sheet import) to remember to set it separately.
create function public.advance_musician_stage_on_booking()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.leads set musician_stage = 'planning' where id = new.lead_id;
  return new;
end;
$$;

create trigger trg_advance_musician_stage
  after insert on public.lead_musicians
  for each row execute function public.advance_musician_stage_on_booking();

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

-- A DJ can retract their own available/pass response back to "no
-- response yet" — same self-service scope as insert/update above.
create policy "availability_delete" on public.availability_responses
  for delete using (dj_user_id = auth.uid() or public.is_owner());

-- ============================================================
-- events (lightweight audit log)
-- ============================================================

create table public.events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references public.leads(id) on delete cascade,
  actor_user_id uuid references public.users(id) on delete set null,
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
  if tg_op = 'DELETE' then
    insert into public.events (lead_id, actor_user_id, event_type, detail)
    values (old.lead_id, old.dj_user_id, 'availability_retracted', jsonb_build_object('previous_response', old.response));
    return old;
  end if;
  insert into public.events (lead_id, actor_user_id, event_type, detail)
  values (new.lead_id, new.dj_user_id, 'availability_response', jsonb_build_object('response', new.response));
  return new;
end;
$$;

create trigger trg_log_availability_response
  after insert or update or delete on public.availability_responses
  for each row execute function public.log_availability_response();

-- ============================================================
-- email_log — every email the app has attempted to send
-- ============================================================
-- Written from lib/email.ts's sendEmail() — the one function every email
-- type (new-lead, availability, musician hold/release, reminder digests)
-- already routes through, so logging there covers all of them for free.
-- failed=true means Resend rejected the send; the row's still kept so a
-- failure is visible instead of silently vanishing.

create table public.email_log (
  id uuid primary key default gen_random_uuid(),
  to_email text not null,
  subject text not null,
  html text not null,
  failed boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.email_log enable row level security;

create policy "email_log_owner_select" on public.email_log
  for select using (public.is_owner());

-- ============================================================
-- leads_feed — the view every client query goes through
-- ============================================================
-- Owned by the SQL-editor role (bypasses RLS), so it can apply its own
-- visibility + column-hiding rules independent of the leads table policies:
--   - owner: every column, every row
--   - dj: no owner_notes, and no contact info until they're the
--     assigned_dj_id on the lead (client_name is visible regardless).
--     Only rows that are still in date-check, or already assigned to
--     them and in meeting/booked/played
--     (the meeting case is what lets the Pending tab show a lead once
--     they're assigned but not yet marked booked), or at the meeting stage
--     with nobody assigned yet if they'd marked themselves available (the
--     Pending "awaiting DJ selection" bucket — every interested DJ sees it
--     until Austin actually picks one, at which point this clause stops
--     matching for everyone except whoever got picked). Headliner-tier
--     leads are the one exception within date-check: Austin gets first
--     refusal, so a DJ can't see one at all until he's personally passed
--     on it (an availability_responses row from an owner-role user).
--   - musician: visibility runs off musician_stage instead of the DJ-side
--     status — new leads (instrument relevance filtered client-side),
--     any lead they've ever responded to (keeps it visible through
--     Pending/Archive regardless of what stage the owner moves it to
--     next), and any lead they're booked on via lead_musicians (Planning/
--     Complete). Because visibility is anchored to "I responded" rather
--     than a single-winner assignment like the DJ side, one instrument
--     being booked never hides the lead from a musician of a different
--     instrument who's also waiting on it.
-- assigned_dj_name and booked_musicians are read-only convenience
-- columns so a musician's own card can show "who's DJing" and "what else
-- is booked" without needing users/lead_musicians access they don't have.
-- has_available lets a DJ's own card show the same green "ready" cue the
-- owner sees, without exposing which other DJs answered. It's scoped to
-- role in ('dj','owner') — the owner can mark himself available on a
-- Pipeline lead too and counts the same as any DJ, but a musician
-- marking themselves available (an unrelated signal) must not flip
-- that same lead to "ready" for every DJ and the owner.

create view public.leads_feed as
select
  l.id,
  l.client_name,
  case when public.is_owner() or l.assigned_dj_id = auth.uid() then l.contact else null end as contact,
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
    join public.users u on u.id = ar.dj_user_id
    where ar.lead_id = l.id and ar.response = 'available' and u.role in ('dj', 'owner')
  ) as has_available,
  l.meeting_notes,
  l.travel_zone,
  l.travel_rate,
  l.fiance_name,
  case when public.is_owner() or l.assigned_dj_id = auth.uid() then l.deposit_paid else null end as deposit_paid,
  case when public.is_owner() or l.assigned_dj_id = auth.uid() then l.paid_in_full else null end as paid_in_full,
  l.vibo_link,
  l.musician_stage,
  l.musician_meeting_date,
  (select u.display_name from public.users u where u.id = l.assigned_dj_id) as assigned_dj_name,
  -- A musician can only SELECT their own lead_musicians row (RLS), so a
  -- musician viewing their own card can't see whether a *different*
  -- musician is also booked on the same lead without this — computed here
  -- so it's available to every role without loosening lead_musicians RLS.
  -- Includes the name (not just the instrument) so cards can tag each
  -- booked musician by name, colored by instrument.
  (
    select jsonb_agg(jsonb_build_object('name', u.display_name, 'instrument', dp.instrument) order by dp.instrument)
    from public.lead_musicians lm
    join public.dj_profiles dp on dp.user_id = lm.musician_id
    join public.users u on u.id = lm.musician_id
    where lm.lead_id = l.id and dp.instrument is not null
  ) as booked_musicians
from public.leads l
where
  public.is_owner()
  or (
    l.status = 'checking' and public.is_dj()
    and (
      l.dj_tier is distinct from 'Headliner'
      or exists (
        select 1 from public.availability_responses ar
        join public.users u on u.id = ar.dj_user_id
        where ar.lead_id = l.id and ar.response = 'pass' and u.role = 'owner'
      )
    )
  )
  or (l.assigned_dj_id = auth.uid() and l.status in ('meeting', 'booked', 'played'))
  or (
    l.status = 'meeting' and l.assigned_dj_id is null and public.is_dj()
    and exists (
      select 1 from public.availability_responses ar
      where ar.lead_id = l.id and ar.dj_user_id = auth.uid() and ar.response = 'available'
    )
  )
  or (l.musician_stage = 'new' and public.is_musician())
  or (
    public.is_musician()
    and exists (
      select 1 from public.availability_responses ar
      where ar.lead_id = l.id and ar.dj_user_id = auth.uid()
    )
  )
  or exists (
    select 1 from public.lead_musicians lm
    where lm.lead_id = l.id and lm.musician_id = auth.uid()
  );

grant select on public.leads_feed to authenticated;

-- ============================================================
-- dj_leaderboard — aggregate-only, so any DJ can see the team's
-- standings without exposing anyone's individual leads/clients.
-- Split into two mutually-exclusive standings rather than one combined
-- figure: completed (status='played', the event already happened) and
-- booked (status='booked', confirmed but still upcoming). A DJ can be
-- assigned during the meeting stage (visible in their Pending tab)
-- before the owner marks it booked, and that assignment must not count
-- as a won/earned gig yet — same reasoning as before, just applied to
-- both halves of the split. avatar_url comes along for the Leaderboard's
-- photo display; dj_profiles' own RLS would normally block a DJ from
-- reading a teammate's profile row, but this view (like the rest of it)
-- runs with the view-owner's privileges, so the join isn't blocked.
-- ============================================================

create view public.dj_leaderboard as
select
  u.id as dj_id,
  u.display_name,
  u.email,
  dp.avatar_url,
  count(l.id) filter (where l.status = 'played') as completed_count,
  coalesce(sum((coalesce(l.payout, 0) + coalesce(l.travel_rate, 0))) filter (where l.status = 'played'), 0) as completed_total,
  count(l.id) filter (where l.status = 'booked') as booked_count,
  coalesce(sum((coalesce(l.payout, 0) + coalesce(l.travel_rate, 0))) filter (where l.status = 'booked'), 0) as booked_total
from public.users u
left join public.dj_profiles dp on dp.user_id = u.id
left join public.leads l on l.assigned_dj_id = u.id and l.status in ('booked', 'played')
where u.role = 'dj'
group by u.id, u.display_name, u.email, dp.avatar_url;

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
