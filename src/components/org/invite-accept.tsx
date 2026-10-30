"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { Building2, CircleAlert, Clock, Info, Loader2, LogOut, MailX } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { clearAssistantHistory } from "@/components/assistant/assistant-widget";
import { acceptInvitation, getInvitation, type InvitationInfo } from "@/lib/services/org";
import { roleLabels } from "@/lib/org";
import { removePushSubscription } from "@/lib/push-client";
import { createClient } from "@/lib/supabase/client";
import { getErrorMessage } from "@/lib/types/database";

type State =
  | { kind: "loading" }
  | { kind: "ready"; invitation: InvitationInfo }
  | { kind: "error"; email: string | null };

/** /invite/<token>: shows the invitation sent to the signed-in e-mail and accepts it. */
export default function InviteAccept({ token }: { token: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getInvitation(token)
      .then((invitation) => {
        if (!cancelled) setState({ kind: "ready", invitation });
      })
      .catch(async () => {
        // wrong account or unknown token: show who is signed in
        const { data } = await createClient().auth.getUser();
        if (!cancelled) setState({ kind: "error", email: data.user?.email ?? null });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const accept = async () => {
    if (accepting) return;
    setAccepting(true);
    setAcceptError(null);
    try {
      await acceptInvitation(token);
      toast.success("Welcome aboard");
      router.push("/org");
      router.refresh();
    } catch (err) {
      setAcceptError(getErrorMessage(err));
      setAccepting(false);
    }
  };

  const switchAccount = async () => {
    if (signingOut) return;
    setSigningOut(true);
    clearAssistantHistory();
    // this browser must not keep receiving the old account's messages
    await removePushSubscription();
    await createClient().auth.signOut();
    router.push(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);
    router.refresh();
  };

  if (state.kind === "loading") {
    return (
      <Shell>
        <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Opening invitation…
        </div>
      </Shell>
    );
  }

  if (state.kind === "error") {
    return (
      <Shell>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MailX className="size-5 text-destructive" aria-hidden />
              Invitation not available
            </CardTitle>
            <CardDescription>
              This invitation is for a different email address or does not exist.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm">
              You are signed in as{" "}
              <span className="font-medium [overflow-wrap:anywhere]">{state.email ?? "an unknown account"}</span>.
            </p>
          </CardContent>
          <CardFooter className="flex-wrap gap-2">
            <Button onClick={() => void switchAccount()} disabled={signingOut}>
              {signingOut ? <Loader2 className="animate-spin" aria-hidden /> : <LogOut aria-hidden />}
              Sign in with another account
            </Button>
            <Link href="/dashboard" className={buttonVariants({ variant: "ghost" })}>
              Go to My Files
            </Link>
          </CardFooter>
        </Card>
      </Shell>
    );
  }

  const { invitation } = state;

  if (invitation.status !== "pending") {
    const message = {
      expired: {
        icon: Clock,
        title: "Invitation expired",
        text: "This invitation has expired. Ask your admin for a new link.",
      },
      accepted: {
        icon: Building2,
        title: "Invitation already accepted",
        text: `This invitation to ${invitation.org_name} was already accepted.`,
      },
      revoked: {
        icon: CircleAlert,
        title: "Invitation revoked",
        text: "This invitation was revoked by a company admin. Ask your admin for a new link.",
      },
    }[invitation.status];
    const Icon = message.icon;
    return (
      <Shell>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Icon className="size-5 text-muted-foreground" aria-hidden />
              {message.title}
            </CardTitle>
            <CardDescription>{message.text}</CardDescription>
          </CardHeader>
          <CardFooter>
            <Link
              href={invitation.status === "accepted" ? "/org" : "/dashboard"}
              className={buttonVariants({ variant: "outline" })}
            >
              {invitation.status === "accepted" ? "Open company" : "Go to My Files"}
            </Link>
          </CardFooter>
        </Card>
      </Shell>
    );
  }

  const roles = roleLabels(invitation.roles);

  return (
    <Shell>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Building2 className="size-5 text-primary" aria-hidden />
            <span className="[overflow-wrap:anywhere]">Join {invitation.org_name}</span>
          </CardTitle>
          <CardDescription>
            Invitation for <span className="font-medium text-foreground">{invitation.email}</span>, expires{" "}
            <time dateTime={invitation.expires_at} title={new Date(invitation.expires_at).toLocaleString()}>
              {formatDistanceToNow(new Date(invitation.expires_at), { addSuffix: true })}
            </time>
            .
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <dt className="text-xs text-muted-foreground">Roles</dt>
              <dd className="mt-1 flex flex-wrap gap-1.5">
                {roles.length > 0 ? (
                  roles.map((label) => (
                    <Badge key={label} variant="outline">
                      {label}
                    </Badge>
                  ))
                ) : (
                  <span className="text-sm">—</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Department</dt>
              <dd className="text-sm">{invitation.department_name ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Position</dt>
              <dd className="text-sm">{invitation.position_name ?? "—"}</dd>
            </div>
          </dl>
          <p className="flex gap-2 rounded-lg border bg-muted/50 p-3 text-sm text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
            Company admins can reassign the files and tasks you own to a colleague when you leave the company.
          </p>
          {acceptError && (
            <p className="text-sm text-destructive" role="alert">
              {acceptError}
            </p>
          )}
        </CardContent>
        <CardFooter>
          <Button size="lg" onClick={() => void accept()} disabled={accepting} className="w-full sm:w-auto">
            {accepting && <Loader2 className="animate-spin" aria-hidden />}
            Accept invitation
          </Button>
        </CardFooter>
      </Card>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-lg py-4 sm:py-10">{children}</div>;
}
