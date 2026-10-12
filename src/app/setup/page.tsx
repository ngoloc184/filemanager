"use client";

import { useState } from "react";
import { UserPlus, ArrowLeft } from "lucide-react";
import Link from "next/link";
import { createAdminAction } from "@/lib/auth/actions";
import { AuthShell } from "@/components/auth/auth-shell";
import { CheckEmailPanel } from "@/components/auth/check-email-panel";
import {
  Field,
  FormAlert,
  PasswordInput,
  SubmitButton,
  TextInput,
  fieldAria,
} from "@/components/auth/form-parts";
import { PasswordChecklist } from "@/components/auth/password-checklist";
import { useAuthForm } from "@/components/auth/use-auth-form";

export default function SetupPage() {
  const { state, pending, errors, formError, onSubmit, touch } = useAuthForm(createAdminAction);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showSent, setShowSent] = useState(true);

  return (
    <AuthShell
      icon={<UserPlus className="h-5 w-5" />}
      title="Create admin"
      description="Set up the initial admin account"
      footer={
        <Link
          href="/login"
          className="inline-flex items-center gap-1 hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" />
          Back to sign in
        </Link>
      }
    >
      {state.status === "success" && showSent ? (
        <CheckEmailPanel
          email={state.email ?? email}
          purpose="signup"
          message={state.message ?? ""}
          onChangeEmail={() => setShowSent(false)}
        />
      ) : (
        <form
          onSubmit={(event) => {
            setShowSent(true);
            onSubmit(event);
          }}
          className="space-y-4"
          noValidate
        >
          {formError && <FormAlert tone="error">{formError}</FormAlert>}
          <Field id="email" label="Email" error={errors.email}>
            <TextInput
              {...fieldAria("email", errors.email)}
              name="email"
              type="email"
              placeholder="admin@example.com"
              autoComplete="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                touch("email");
              }}
              required
            />
          </Field>
          <Field
            id="password"
            label="Password"
            error={errors.password}
            hint={<PasswordChecklist password={password} email={email} />}
          >
            <PasswordInput
              {...fieldAria("password", errors.password, true)}
              name="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                touch("password");
              }}
              required
            />
          </Field>
          <SubmitButton pending={pending} pendingLabel="Creating...">
            Create admin account
          </SubmitButton>
        </form>
      )}
    </AuthShell>
  );
}
