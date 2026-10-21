import { Suspense } from "react";
import ChatClient from "@/components/chat/chat-client";
import { requireUser } from "@/lib/auth";

export default async function ChatPage() {
  const user = await requireUser();
  return (
    <Suspense fallback={<div className="h-[60vh] rounded-2xl border bg-muted/30 animate-pulse" />}>
      <ChatClient user={user} />
    </Suspense>
  );
}
