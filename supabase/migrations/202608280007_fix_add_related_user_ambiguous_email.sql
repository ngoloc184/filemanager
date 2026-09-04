-- Fix: add_related_user raised "column reference 'email' is ambiguous".
-- The RETURNS TABLE output column "email" collided with user_profiles.email
-- inside the PL/pgSQL body. Qualify the column with a table alias.
-- Idempotent.

create or replace function public.add_related_user(related_email text)
returns table (id uuid, email text)
language plpgsql
security definer
set search_path = public
as $$
declare
  matched_user public.user_profiles%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into matched_user
  from public.user_profiles p
  where lower(p.email) = lower(trim(related_email));

  if not found then
    raise exception 'No registered user found for this email address';
  end if;

  if matched_user.id = auth.uid() then
    raise exception 'You cannot add yourself';
  end if;

  insert into public.user_connections (owner_id, related_user_id)
  values (auth.uid(), matched_user.id)
  on conflict (owner_id, related_user_id) do nothing;

  return query select matched_user.id, matched_user.email;
end;
$$;

grant execute on function public.add_related_user(text) to authenticated;
