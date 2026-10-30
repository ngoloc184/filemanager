import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { ConfirmLink } from "@/components/auth/confirm-link";
import { failedOutcome, failurePath, flowOf } from "@/lib/auth-links";

export const metadata: Metadata = { title: "Confirm" };

const TYPES = new Set<EmailOtpType>(["signup", "email", "recovery", "invite", "magiclink", "email_change"]);

/**
 * /auth/confirm — where the links in Supabase e-mails land. Opening the page
 * changes nothing (no sign-in on a plain GET, so another site cannot sign a
 * visitor into someone else's account, and mail scanners cannot use the link
 * up):
 *   ?token_hash=…&type=…   shows a button that confirms with a POST (/auth/verify)
 *   ?code=…                Supabase's default link (PKCE): exchanged by
 *                          /auth/callback — the code only works in the browser
 *                          that asked for the e-mail
 *   ?error_code=…          Supabase could not verify the link: explained on
 *                          /login or /forgot-password
 */
export default async function ConfirmPage({ searchParams }: PageProps<"/auth/confirm">) {
  const params = await searchParams;
  const one = (key: string) => {
    const value = params[key];
    return typeof value === "string" ? value : null;
  };
  const type = one("type");
  const flow = flowOf(one("flow"), type);
  const next = one("next");
  const errorCode = one("error_code") ?? one("error");

  if (errorCode) redirect(failurePath(flow, failedOutcome({ flow, hadCode: false, errorCode }), next));

  const code = one("code");
  if (code) {
    const query = new URLSearchParams({ code, flow: flow ?? "signup" });
    if (next) query.set("next", next);
    const flowId = one("sb_flow_id");
    if (flowId) query.set("sb_flow_id", flowId);
    redirect(`/auth/callback?${query}`);
  }

  const tokenHash = one("token_hash");
  if (!tokenHash || !type || !TYPES.has(type as EmailOtpType)) redirect(failurePath(flow, "invalid", next));

  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return (
    <ConfirmLink
      tokenHash={tokenHash}
      type={type}
      flow={flow ?? "signup"}
      next={next}
      signedInAs={data.user?.email ?? null}
    />
  );
}
