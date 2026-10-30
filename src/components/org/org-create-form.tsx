"use client";

import { useState } from "react";
import { Building2, Mail } from "lucide-react";
import { toast } from "sonner";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createOrganization, type Organization } from "@/lib/services/org";
import { isValidOrgCode, normalizeCode } from "@/lib/org";
import { validateOrgForm } from "@/lib/org-forms";
import { getErrorMessage } from "@/lib/types/database";
import { cn } from "@/lib/utils";

/** First-run card for someone who belongs to no company yet. */
export function OrgCreateForm({ onCreated }: { onCreated: (org: Organization) => void }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [shortName, setShortName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const codeInvalid = code.length > 0 && !isValidOrgCode(code);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const problem = validateOrgForm({ name, code });
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const org = await createOrganization(name.trim(), code, shortName.trim() || null);
      toast.success(`${org.name} is ready`);
      onCreated(org);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Building2 className="size-5 text-primary" aria-hidden />
            Set up your company
          </CardTitle>
          <CardDescription>
            Create a company to manage departments, people and official documents (văn bản).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor="org-name">Company name</Label>
              <Input
                id="org-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Công ty Cổ phần ABC"
                maxLength={200}
                autoFocus
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="org-code">Company code</Label>
              <Input
                id="org-code"
                value={code}
                onChange={(e) => setCode(normalizeCode(e.target.value))}
                placeholder="ABC"
                maxLength={15}
                autoCapitalize="characters"
                aria-describedby="org-code-hint"
                aria-invalid={codeInvalid || undefined}
                required
              />
              <p
                id="org-code-hint"
                className={cn("text-xs", codeInvalid ? "text-destructive" : "text-muted-foreground")}
              >
                Short code used in document numbers, e.g. ABC → 15/QĐ-ABC
                {codeInvalid && ". Use 2 to 15 letters or digits."}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="org-short-name">
                Short name <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="org-short-name"
                value={shortName}
                onChange={(e) => setShortName(e.target.value)}
                placeholder="e.g. ABC Corp"
                maxLength={50}
              />
            </div>
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={saving || !name.trim() || !code}
              className={cn(buttonVariants({ size: "lg" }), "w-full sm:w-auto")}
            >
              {saving ? "Creating…" : "Create company"}
            </button>
          </form>
        </CardContent>
      </Card>
      <p className="flex items-center justify-center gap-2 text-center text-sm text-muted-foreground">
        <Mail className="size-4 shrink-0" aria-hidden />
        Have an invitation? Open the link your admin sent you.
      </p>
    </div>
  );
}
