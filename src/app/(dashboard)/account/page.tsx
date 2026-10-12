import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AccountClient, type AccountIdentity } from "@/components/auth/account-client";
import { getCurrentUser } from "@/lib/auth";
import { accountNotice } from "@/lib/auth/notices";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Tài khoản & bảo mật" };

export default async function AccountPage({ searchParams }: PageProps<"/account">) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/account");

  const identities: AccountIdentity[] = (user.identities ?? []).map((identity) => ({
    id: identity.identity_id ?? identity.id,
    provider: identity.provider,
    email:
      typeof identity.identity_data?.email === "string" ? identity.identity_data.email : undefined,
    lastSignInAt: identity.last_sign_in_at ?? undefined,
  }));

  const supabase = await createClient();
  const { data: hasPassword } = await supabase.rpc("current_user_has_password");

  return (
    <AccountClient
      email={user.email ?? ""}
      pendingEmail={user.new_email ?? undefined}
      emailConfirmed={Boolean(user.email_confirmed_at)}
      createdAt={user.created_at}
      lastSignInAt={user.last_sign_in_at ?? undefined}
      identities={identities}
      // Before migration 202608280016 the RPC is missing: fall back to the
      // e-mail identity, which every password sign-up has.
      hasPassword={
        typeof hasPassword === "boolean"
          ? hasPassword
          : identities.some((identity) => identity.provider === "email")
      }
      notice={accountNotice(await searchParams)}
    />
  );
}
