import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isWorkflowId, loadWorkflowPayload } from "@/lib/workflow/server";
import { readPayload } from "@/lib/workflow/payload";
import { WorkflowEditor } from "@/components/workflow/workflow-editor";

export async function generateMetadata({ params }: PageProps<"/workflow/[id]">): Promise<Metadata> {
  const { id } = await params;
  const payload = await loadWorkflowPayload(id).catch(() => null);
  return { title: payload?.name ?? "Workflow", robots: { index: false } };
}

/**
 * A plan, for anyone with the link. Its owner and admins change everything; everyone else (signed
 * in or not) may change an unconfirmed length, confirm a timeline and extend, all logged.
 */
export default async function WorkflowPage({ params }: PageProps<"/workflow/[id]">) {
  const { id } = await params;
  if (!isWorkflowId(id)) notFound();

  const user = await getCurrentUser();
  let role: string | null = null;
  let viewerName = "";
  if (user) {
    const supabase = await createClient();
    const [{ data: joined }, { data: profile }] = await Promise.all([
      supabase.rpc("join_workflow", { p_workflow: id }),
      supabase.from("user_profiles").select("display_name").eq("id", user.id).maybeSingle(),
    ]);
    role = typeof joined === "string" ? joined : null;
    viewerName = profile?.display_name?.trim() || "Thành viên"; // what the log shows (never the e-mail)
  }

  const payload = await loadWorkflowPayload(id);
  const initial = payload ? readPayload(payload) : null;
  if (!payload || !initial) notFound();

  return <WorkflowEditor id={id} initial={initial} canEdit={role === "owner" || role === "admin"} isOwner={role === "owner"} signedIn={!!user} viewerName={viewerName} />;
}
