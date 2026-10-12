import { Sparkles } from "lucide-react";
import { EmailRequestForm } from "@/components/auth/email-request-form";
import { firstParam } from "@/lib/auth/notices";
import { safeNextPath } from "@/lib/auth/redirect";

export default async function MagicLinkPage({ searchParams }: PageProps<"/magic-link">) {
  const next = safeNextPath(firstParam((await searchParams).next));
  return (
    <EmailRequestForm variant="magiclink" icon={<Sparkles className="h-5 w-5" />} next={next} />
  );
}
