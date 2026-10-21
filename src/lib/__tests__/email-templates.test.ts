import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildPayload, projectRefFromUrl, templateProblems } from "../../../scripts/email-templates.mjs";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../supabase/email-templates");

describe("e-mail templates", () => {
  it("the repository's templates link to /auth/confirm with a token hash", () => {
    const payload = buildPayload(dir) as Record<string, string>;
    assert.match(payload.mailer_templates_confirmation_content, /\/auth\/confirm\?token_hash=\{\{ \.TokenHash \}\}&type=email&flow=signup&next=\/dashboard/);
    assert.match(
      payload.mailer_templates_recovery_content,
      /\/auth\/confirm\?token_hash=\{\{ \.TokenHash \}\}&type=recovery&flow=recovery&next=%2Fforgot-password%3Fstep%3Dpassword/
    );
    for (const field of ["mailer_templates_confirmation_content", "mailer_templates_recovery_content"]) {
      assert.doesNotMatch(payload[field], /ConfirmationURL|\{\{ \.Token \}\}/);
    }
  });

  it("rejects templates without the right link", () => {
    const good = '<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/dashboard">x</a>';
    assert.deepEqual(templateProblems(good, "email"), []);
    assert.equal(templateProblems(good, "recovery").length, 1);
    assert.ok(templateProblems('<a href="{{ .ConfirmationURL }}">Confirm</a>', "email").length >= 2);
    assert.equal(templateProblems("<p>{{ .Token }}</p>", "email").length, 1);
  });

  it("finds the project ref in the Supabase URL", () => {
    assert.equal(projectRefFromUrl("https://abcdefghijklmnop.supabase.co"), "abcdefghijklmnop");
    assert.equal(projectRefFromUrl("https://evil.example"), null);
  });
});
