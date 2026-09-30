import { Suspense } from "react";
import FilesClient from "@/components/files/files-client";
import { requireUser } from "@/lib/auth";

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
  const user = await requireUser();

  return (
    <Suspense fallback={<PageSkeleton />}>
      <FilesClient user={user} />
    </Suspense>
  );
}
