import SearchClient from "@/components/files/search-client";
import { requireUser } from "@/lib/auth";

export default async function SearchPage() {
  const user = await requireUser();
  return <SearchClient user={user} />;
}
