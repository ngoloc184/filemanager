import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import OffboardingClient from "@/components/org/offboarding-client";

export const metadata: Metadata = { title: "Offboard a member" };

export default async function OffboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await requireUser();
  const { user: picked } = await searchParams;
  const userId = typeof picked === "string" && picked.length <= 64 ? picked : null;
  return <OffboardingClient me={user} userId={userId} />;
}
