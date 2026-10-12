"use client";

import { startTransition, useActionState, useState, type FormEvent } from "react";
import { INITIAL_AUTH_STATE, type AuthField, type AuthFormState } from "@/lib/auth/form-state";

export type FieldErrors = Partial<Record<AuthField, string>>;

type Action = (previous: AuthFormState, formData: FormData) => Promise<AuthFormState>;

/**
 * Wires a form to an auth Server Action: instant client-side checks first,
 * then the server's verdict. Errors from the last submission disappear as
 * soon as the user edits a field. Submitting through onSubmit (instead of
 * <form action>) keeps the typed values when the server rejects them.
 */
export function useAuthForm(action: Action, validate: (formData: FormData) => FieldErrors = () => ({})) {
  const [state, formAction, pending] = useActionState(action, INITIAL_AUTH_STATE);
  const [localErrors, setLocalErrors] = useState<FieldErrors>({});
  const [stale, setStale] = useState(false);

  const showServer = !stale && !pending;
  const errors: FieldErrors = { ...(showServer ? state.fieldErrors : undefined), ...localErrors };
  const formError = showServer && state.status === "error" ? state.message : undefined;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const found = validate(formData);
    setLocalErrors(found);
    if (Object.keys(found).length > 0) return;
    setStale(false);
    startTransition(() => formAction(formData));
  };

  /** Call from a field's onChange: clears that field's error. */
  const touch = (field: AuthField) => {
    setStale(true);
    setLocalErrors((current) => {
      if (!(field in current)) return current;
      const rest = { ...current };
      delete rest[field];
      return rest;
    });
  };

  return { state, pending, errors, formError, onSubmit, touch, showServer };
}
