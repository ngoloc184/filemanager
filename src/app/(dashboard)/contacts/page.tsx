import { createClient } from "@/lib/supabase/server";
import ContactsClient from "@/components/contacts-client";

export default async function ContactsPage() {
  const supabase = await createClient();
  const { data } = await supabase.rpc("list_related_users");

  return <ContactsClient initialUsers={data ?? []} />;
}
