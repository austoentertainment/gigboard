-- Tier release events
-- ===================
-- Austin is the only Headliner. A Headliner lead is hidden from every DJ
-- until he passes on it, at which point it's demoted to Resident and
-- released to the pool (see app/api/notify/availability/route.ts).
--
-- That release is real news for a DJ, but it leaves no trace a DJ can see:
-- the lead's status never changes (it was 'checking' before and after), and
-- its created_at is however old the original inquiry is — so the lead
-- silently appeared at the bottom of their Activity feed, dated weeks ago
-- and already "read". This logs the release so it can be timestamped and
-- surfaced as new.
--
-- A trigger rather than an insert in the route, so a manual tier edit in
-- the lead editor registers the same way an owner's pass does. Guarded on
-- status = 'checking' because retagging an already-booked lead isn't a
-- release. actor_user_id is null when the demotion came from the API route
-- (service role has no auth.uid()) — same as the status_change rows that
-- route already produces, and nothing reads the actor for Activity.
--
-- Idempotent: safe to re-run.

create or replace function public.log_lead_tier_release()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.dj_tier = 'Headliner'
     and new.dj_tier is distinct from 'Headliner'
     and new.status = 'checking' then
    insert into public.events (lead_id, actor_user_id, event_type, detail)
    values (new.id, auth.uid(), 'tier_release',
            jsonb_build_object('from', old.dj_tier, 'to', new.dj_tier));
  end if;
  return new;
end;
$$;

drop trigger if exists trg_log_lead_tier_release on public.leads;
create trigger trg_log_lead_tier_release
  after update on public.leads
  for each row execute function public.log_lead_tier_release();

-- Widen the talent-visible slice of the audit log to include the release.
-- Scoped to leads_feed, so a DJ only ever sees it for a lead they can
-- already see — which, for a just-released lead, is exactly the point.
drop policy if exists "events_talent_select" on public.events;
create policy "events_talent_select" on public.events
  for select using (
    (event_type = 'payment' and detail->>'payee_id' = auth.uid()::text)
    or (
      event_type = 'status_change'
      and detail->>'to' in ('meeting', 'booked')
      and lead_id in (select id from public.leads_feed)
    )
    or (
      event_type = 'tier_release'
      and lead_id in (select id from public.leads_feed)
    )
  );
