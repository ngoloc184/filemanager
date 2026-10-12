import { KeyRound } from "lucide-react";
import { EmailRequestForm } from "@/components/auth/email-request-form";

export default function ForgotPasswordPage() {
  return <EmailRequestForm variant="recovery" icon={<KeyRound className="h-5 w-5" />} />;
}
