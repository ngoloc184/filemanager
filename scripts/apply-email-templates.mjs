#!/usr/bin/env node
// Applies the link e-mail templates (supabase/email-templates) to the
// Supabase project through the Management API, then reads them back.
//
//   SUPABASE_ACCESS_TOKEN=sbp_… npm run email:templates            # apply
//   SUPABASE_ACCESS_TOKEN=sbp_… npm run email:templates -- --check # only compare
//   npm run email:templates -- --dry-run                           # print, no network
//
// Access token: https://supabase.com/dashboard/account/tokens (keep it secret,
// never commit it). Project ref: SUPABASE_PROJECT_REF, or taken from
// NEXT_PUBLIC_SUPABASE_URL (also read from .env.local); without either, the
// account's projects are listed and a single project is used automatically.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TEMPLATES, buildPayload, projectRefFromUrl } from "./email-templates.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));

function loadEnvLocal() {
  const file = join(root, ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const MANUAL =
  "Without a token: Supabase Dashboard → Authentication → Emails → “Confirm sign up” and “Reset password”: " +
  "paste the HTML from supabase/email-templates/ and the subjects from scripts/email-templates.mjs.";

/** Explains Management API refusals (the API answers 401/403 for bad tokens). */
function refusal(status, what) {
  if (status === 401 || status === 403) {
    return (
      `${what}: access denied (HTTP ${status}). Use a Personal Access Token (starts with "sbp_") from ` +
      "https://supabase.com/dashboard/account/tokens — project API keys (anon, service_role, sb_secret_…) do not work — " +
      "and make sure your account is Owner or Administrator of the project's organization.\n" +
      MANUAL
    );
  }
  return `${what} (HTTP ${status}).`;
}

/** The only project of the account, or null after listing the choices. */
async function pickProject(headers) {
  const res = await fetch("https://api.supabase.com/v1/projects", { headers });
  if (!res.ok) {
    throw new Error(
      `${refusal(res.status, "Could not list your projects")}\nOr pass the project directly: SUPABASE_PROJECT_REF=<ref> (from supabase.com/dashboard/project/<ref>).`
    );
  }
  const projects = (await res.json()).map((p) => ({ ref: p.id ?? p.ref, name: p.name }));
  if (projects.length === 1) {
    console.log(`Using project “${projects[0].name}” (${projects[0].ref}).`);
    return projects[0].ref;
  }
  if (!projects.length) throw new Error("This access token has no projects.");
  console.log("Several projects found — run again with SUPABASE_PROJECT_REF=<ref>:");
  for (const p of projects) console.log(`  ${p.ref}  ${p.name}`);
  process.exitCode = 1;
  return null;
}

async function main() {
  loadEnvLocal();
  const payload = buildPayload(join(root, "supabase", "email-templates"));
  if (args.has("--dry-run")) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) throw new Error(`Set SUPABASE_ACCESS_TOKEN (create one at https://supabase.com/dashboard/account/tokens).\n${MANUAL}`);
  if (!token.startsWith("sbp_")) {
    console.warn('Warning: personal access tokens start with "sbp_"; this looks like a different kind of key.');
  }
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const ref =
    process.env.SUPABASE_PROJECT_REF || projectRefFromUrl(process.env.NEXT_PUBLIC_SUPABASE_URL) || (await pickProject(headers));
  if (!ref) return;

  const url = `https://api.supabase.com/v1/projects/${ref}/config/auth`;

  if (!args.has("--check")) {
    const res = await fetch(url, { method: "PATCH", headers, body: JSON.stringify(payload) });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new Error(`${refusal(res.status, "Supabase rejected the update")}${res.status === 401 || res.status === 403 ? "" : ` ${detail}`}`);
    }
    console.log(`Applied the link templates to project ${ref}.`);
  }

  const current = await fetch(url, { headers });
  if (!current.ok) {
    console.log(`Could not read the settings back (HTTP ${current.status}); check Authentication → Emails in the dashboard.`);
    return;
  }
  const config = await current.json();
  let ok = true;
  for (const t of TEMPLATES) {
    const same = config[t.contentField] === payload[t.contentField] && config[t.subjectField] === payload[t.subjectField];
    console.log(`${same ? "✔" : "✘"} ${t.file}: ${same ? "up to date" : "differs from the repository"}`);
    ok &&= same;
  }
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
