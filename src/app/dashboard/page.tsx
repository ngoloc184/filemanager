import { Suspense } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import FilesClient from "@/components/files/files-client";

function PageSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-6 w-40 rounded bg-muted/60 animate-pulse" />
      <div className="h-9 w-full max-w-md rounded-lg bg-muted/60 animate-pulse" />
      {Array.from({ length: 5 }).map((_, index) => (
        <div key={index} className="h-14 rounded-xl bg-muted/40 animate-pulse" />
      ))}
    </div>
  );
}

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <Suspense fallback={<PageSkeleton />}>
      <FilesClient user={{ id: user.id, email: user.email ?? undefined }} />
    </Suspense>
  );
}
