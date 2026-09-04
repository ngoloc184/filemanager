import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import SearchClient from "@/components/files/search-client";

export default async function SearchPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  return <SearchClient user={{ id: user.id, email: user.email ?? undefined }} />;
}
