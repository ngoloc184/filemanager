import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/auth";
import { listWorkflowSummaries } from "@/lib/workflow/server";
import { WorkflowHome } from "@/components/workflow/workflow-home";

export const metadata: Metadata = {
  title: "Workflow",
  description: "Vẽ quy trình, giao PIC, tính timeline từng bước và theo dõi gia hạn.",
};

/** The signed-in user's plans (those they created or opened) and every plan in the system, or how to get started. */
export default async function WorkflowListPage() {
  const user = await getCurrentUser();
  if (!user) return <WorkflowHome signedIn={false} mine={[]} all={[]} />;
  const { mine, all } = await listWorkflowSummaries(user.id);
  return <WorkflowHome signedIn mine={mine} all={all} />;
}
