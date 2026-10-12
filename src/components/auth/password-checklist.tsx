"use client";

import { Check, X } from "lucide-react";
import { PASSWORD_RULES, passwordProblems } from "@/lib/auth/validation";
import { cn } from "@/lib/utils";

/** Live list of the password rules (same rules the server enforces). */
export function PasswordChecklist({ password, email }: { password: string; email?: string }) {
  const problems = passwordProblems(password, email);
  const met = PASSWORD_RULES.filter((rule) => !problems.includes(rule.id)).length;
  const strength = password ? met / PASSWORD_RULES.length : 0;

  return (
    <div className="space-y-2" aria-live="polite">
      <div className="flex gap-1" aria-hidden="true">
        {PASSWORD_RULES.map((rule, index) => (
          <span
            key={rule.id}
            className={cn(
              "h-1 flex-1 rounded-full bg-muted transition-colors duration-300",
              index < met && password && (strength < 0.75 ? "bg-warning" : strength < 1 ? "bg-primary" : "bg-success")
            )}
          />
        ))}
      </div>
      <ul className="grid grid-cols-1 gap-x-3 gap-y-1 text-[13px] sm:grid-cols-2">
        {PASSWORD_RULES.map((rule) => {
          const ok = Boolean(password) && !problems.includes(rule.id);
          return (
            <li
              key={rule.id}
              className={cn("flex items-center gap-1.5", ok ? "text-success" : "text-muted-foreground")}
            >
              {ok ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5 opacity-60" />}
              <span>{rule.label}</span>
              <span className="sr-only">{ok ? "(đạt)" : "(chưa đạt)"}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
