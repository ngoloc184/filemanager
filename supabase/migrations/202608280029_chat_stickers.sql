-- Sticker messages: the sticker id (a file in /public/stickers/fluent) is kept
-- in chat_messages.meta as {"sticker": "<id>"}, so listing, Realtime and
-- previews need no new columns.
-- Run after 202608280028_web_push.sql. Idempotent.
-- Rollback: re-run 202608280027_chat_groups.sql (send/delete functions) and
--   alter table public.chat_messages drop constraint chat_messages_has_content,
--     add constraint chat_messages_has_content check (kind = 'system' or deleted_at is not null or body is not null or file_name is not null);

alter table public.chat_messages drop constraint if exists chat_messages_has_content;
alter table public.chat_messages add constraint chat_messages_has_content check (
  kind = 'system' or deleted_at is not null or body is not null or file_name is not null
  or (meta ? 'sticker')
);

alter table public.chat_messages drop constraint if exists chat_messages_sticker_check;
alter table public.chat_messages add constraint chat_messages_sticker_check check (
  not (meta ? 'sticker') or (meta ->> 'sticker') ~ '^[a-z0-9-]{1,80}$'
);

drop function if exists public.send_chat_message(uuid, text, uuid, uuid, uuid[], uuid);
create or replace function public.send_chat_message(
  p_conversation_id uuid,
  p_body text default null,
  p_file_id uuid default null,
  p_reply_to uuid default null,
  p_mentions uuid[] default null,
  -- chosen by the sender's app so it can show the message before the reply
  p_id uuid default null,
  -- a sticker id (public/stickers/fluent/<id>.webp)
  p_sticker text default null
)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_body text := nullif(regexp_replace(coalesce(p_body, ''), '^\s+|\s+$', '', 'g'), '');
  v_file public.files%rowtype;
  v_mentions uuid[];
  v_recent integer;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.is_chat_member(p_conversation_id) then
    raise exception 'You are not a member of this conversation';
  end if;
  if v_body is null and p_file_id is null and p_sticker is null then
    raise exception 'Message is empty';
  end if;
  if length(v_body) > 4000 then
    raise exception 'Message is too long (max 4000 characters)';
  end if;
  if p_sticker is not null and p_sticker !~ '^[a-z0-9-]{1,80}$' then
    raise exception 'Unknown sticker';
  end if;
  if p_reply_to is not null and not exists (
    select 1 from public.chat_messages where id = p_reply_to and conversation_id = p_conversation_id and kind = 'message'
  ) then
    raise exception 'The message you reply to is not in this conversation';
  end if;

  select count(*) into v_recent from public.chat_messages
  where sender_id = auth.uid() and kind = 'message' and created_at > now() - interval '1 minute';
  if v_recent >= 30 then
    raise exception 'You are sending messages too quickly';
  end if;

  -- only members of this conversation can be mentioned
  select coalesce(array_agg(distinct u), '{}') into v_mentions
  from unnest(coalesce(p_mentions, '{}')) u
  where u <> auth.uid()
    and exists (select 1 from public.chat_members m where m.conversation_id = p_conversation_id and m.user_id = u);

  if p_file_id is not null then
    select * into v_file from public.files where id = p_file_id and deleted_at is null;
    if not found or not public.has_file_access(p_file_id, 'admin') then
      raise exception 'You can only send files you own or manage';
    end if;
    -- the other members can open the file; never downgrade an existing share
    insert into public.file_shares (file_id, grantee_id, role, granted_by)
    select p_file_id, m.user_id, 'viewer', auth.uid()
    from public.chat_members m
    where m.conversation_id = p_conversation_id and m.user_id <> auth.uid() and m.user_id <> v_file.owner_id
    on conflict (file_id, grantee_id) do nothing;
  end if;

  insert into public.chat_messages (id, conversation_id, sender_id, body, file_id, file_name, reply_to_id, mentions, meta)
  values (
    coalesce(p_id, gen_random_uuid()), p_conversation_id, auth.uid(), v_body, p_file_id, v_file.name, p_reply_to, v_mentions,
    case when p_sticker is not null then jsonb_build_object('sticker', p_sticker) end
  )
  returning chat_messages.id into v_id;

  update public.chat_conversations set last_message_at = clock_timestamp() where id = p_conversation_id;
  -- my own message: everything up to it is read
  update public.chat_members set last_read_at = clock_timestamp()
  where conversation_id = p_conversation_id and user_id = auth.uid();
  return v_id;
end;
$$;

-- "Thu hồi": also removes its sticker, reactions and pins
create or replace function public.delete_chat_message(p_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  update public.chat_messages
  set deleted_at = clock_timestamp(), body = null, meta = null
  where id = p_id and sender_id = auth.uid() and deleted_at is null and kind = 'message';
  if not found then
    raise exception 'You can only remove your own messages';
  end if;
  update public.chat_reactions set emoji = null where message_id = p_id and emoji is not null;
  delete from public.chat_pins where message_id = p_id;
end;
$$;

revoke all on function public.send_chat_message(uuid, text, uuid, uuid, uuid[], uuid, text) from public, anon;
grant execute on function public.send_chat_message(uuid, text, uuid, uuid, uuid[], uuid, text) to authenticated;
