import { createClient } from "@/lib/supabase/client";
import { getErrorMessage } from "@/lib/types/database";
import { flushNotificationPush } from "@/lib/services/notifications";

export const COMMENT_MAX_LENGTH = 5000;

export type CommentTarget = { kind: "file" | "folder"; id: string };

export type ItemComment = {
  id: string;
  author_id: string | null;
  author_email: string | null;
  body: string;
  created_at: string;
  updated_at: string;
};

/** Explains a missing migration instead of showing PostgREST's raw error. */
function commentsError(error: unknown): Error {
  const code = (error as { code?: string } | null)?.code;
  const message = getErrorMessage(error);
  if (code === "PGRST202" || /could not find the function/i.test(message)) {
    return new Error(
      "Comments are not set up yet. Run migration 202608280020_item_comments.sql."
    );
  }
  return new Error(message);
}

function targetArgs(target: CommentTarget) {
  return {
    p_file_id: target.kind === "file" ? target.id : null,
    p_folder_id: target.kind === "folder" ? target.id : null,
  };
}

export async function listComments(target: CommentTarget): Promise<ItemComment[]> {
  const { data, error } = await createClient().rpc(
    "list_item_comments",
    targetArgs(target)
  );
  if (error) throw commentsError(error);
  return (data ?? []) as ItemComment[];
}

export async function addComment(
  target: CommentTarget,
  body: string
): Promise<ItemComment> {
  const { data, error } = await createClient()
    .rpc("add_item_comment", { ...targetArgs(target), p_body: body })
    .single();
  if (error) throw commentsError(error);
  // the item's owner is notified (bell + device push)
  flushNotificationPush();
  return data as ItemComment;
}

export async function updateComment(id: string, body: string): Promise<void> {
  const { error } = await createClient().rpc("update_item_comment", {
    p_id: id,
    p_body: body,
  });
  if (error) throw commentsError(error);
}

export async function deleteComment(id: string): Promise<void> {
  const { error } = await createClient().rpc("delete_item_comment", { p_id: id });
  if (error) throw commentsError(error);
}

/** Comment counts keyed by file/folder id; empty when comments are unavailable. */
export async function countComments(
  fileIds: string[],
  folderIds: string[]
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (fileIds.length === 0 && folderIds.length === 0) return counts;
  const { data, error } = await createClient().rpc("count_item_comments", {
    p_file_ids: fileIds,
    p_folder_ids: folderIds,
  });
  if (error) return counts;
  for (const row of (data ?? []) as { item_id: string; comment_count: number }[]) {
    counts.set(row.item_id, row.comment_count);
  }
  return counts;
}
