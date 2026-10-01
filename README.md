# File Manager - Upload Management

A modern web application for managing file uploads, built with Next.js, Supabase, and Tailwind CSS.

## Features

- **Upload Management**: Create upload batches with multiple files
- **Drag & Drop**: Upload files by dragging them anywhere on the page
- **Batch Comments**: Add and edit comments for each upload batch
- **File Management**: Download, view, and delete individual files
- **Search**: Search through batches and files
- **Authentication**: Secure login with email/password
- **Responsive Design**: Works on desktop and mobile

## Tech Stack

- **Frontend**: Next.js 16 (App Router), TypeScript, Tailwind CSS
- **UI Components**: shadcn/ui (base-ui)
- **Backend**: Supabase (Auth, Database, Storage)
- **State Management**: React hooks + server components

## Prerequisites

- Node.js 20.9+ (recommended: 22.x)
- npm or yarn
- A Supabase project (free tier works)

## Setup

### 1. Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) and create a free account
2. Create a new project
3. Note your **Project URL** and **Anon Key** from Settings > API

### 2. Set Up the Database

1. In your Supabase dashboard, go to **SQL Editor**
2. Copy and run the contents of `supabase/schema.sql`
3. Run the migrations in `supabase/migrations/` **in filename order**
   (`202608280001...` through `202608280012...`)
4. Migrate existing batch data into the new file system (idempotent, safe to re-run):

   ```sql
   select public.migrate_batches_to_file_system();
   ```

5. Go to **Storage** and create a new bucket named `uploads`
   - Set it as **Private** (not public)
   - File size limit: 50 MB (or your preference)

### 3. Create an Admin Account

1. In Supabase dashboard, go to **Authentication > Users**
2. Click **Add User** > **Create new user**
3. Enter an email and password
4. Or use the `/setup` page in the app to create one

### 4. Configure Environment Variables

```bash
cp .env.example .env.local
```

Edit `.env.local` with your Supabase credentials:

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project-id.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here
```

`SUPABASE_SERVICE_ROLE_KEY` is only read on the server by the public share-link
endpoints (`/api/public-share/*`). Never expose it with a `NEXT_PUBLIC_` prefix.

### 5. Run the Development Server

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Quality checks

```bash
npm run lint       # ESLint
npm run typecheck  # next typegen && tsc --noEmit
npm test           # unit tests (node:test)
npm run build      # production build
```

## SuperApp API (publish files by URL)

Other systems can publish a file with one API call and get back a public
download URL of the form `https://<domain>/superapp/<file-name>`. Opening that
URL downloads the file immediately (no page, no button).

Setup:
1. Run migration `202608280013_superapp_files.sql`.
2. Set `SUPERAPP_API_KEY` (e.g. `openssl rand -hex 32`) and
   `SUPABASE_SERVICE_ROLE_KEY` in the server environment (Vercel: Settings >
   Environment Variables), then redeploy.

Upload (uploading an existing name replaces the file):

```bash
curl -X POST https://<domain>/api/superapp/files \
  -H "Authorization: Bearer $SUPERAPP_API_KEY" \
  -F "file=@./report.pdf" \
  -F "name=report.pdf"        # optional, defaults to the uploaded file name
```

Response `201`:

```json
{ "name": "report.pdf", "size": 12345, "mimeType": "application/pdf",
  "url": "https://<domain>/superapp/report.pdf" }
```

Errors: `401` wrong/missing key, `400` missing file or invalid name
(allowed: letters, digits, `.`, `_`, `-`; max 200 chars), `500/503` storage
or configuration problems. On Vercel, request bodies are limited to about
4.5 MB per upload.

Versioned uploads: add `-F "version=0.2.0"` to store the file as that
version's snapshot (run migration `202608280015_superapp_files_versioned.sql`).
Each (name, version) pair is kept separately, so older versions stay
downloadable; the response `url` then ends with `?v=0.2.0`. Without `version`
the upload behaves as before (one unversioned copy per name).

Download: `GET`/`HEAD /superapp/<name>` returns the file directly (`200`, no
redirect) with `Content-Type` (`.json` -> `application/json`, `.bundle` ->
`application/javascript`, otherwise the uploaded type), `Content-Length` and
`X-SuperApp-Version` (the snapshot served, or `unversioned`).

| Request | Served file | Cache-Control |
|---|---|---|
| `?v=X`, snapshot X exists | snapshot X | `public, max-age=31536000, immutable` (+1 year on Vercel CDN) |
| `?v=X`, no snapshot X | unversioned copy if any, else `404` | short (below) / `no-store` |
| no `v` | most recently uploaded copy | `public, max-age=0, s-maxage=60, stale-while-revalidate=86400` |

Publishing order for a release: upload every file with `version=X`, then
`PUT /api/superapp/versions/<app>` with `X`, so apps only learn about a
version once its files exist.

### Mini-app versions

Run migration `202608280014_superapp_versions.sql`.

```bash
# Public, never cached
curl https://<domain>/api/superapp/versions
# {"miniApps":{"transfer":{"version":"0.2.0","updatedAt":"2026-10-01T02:26:04.000Z"}}}

# Publish a newer version (same key as uploads)
curl -X PUT https://<domain>/api/superapp/versions/transfer \
  -H "Authorization: Bearer $SUPERAPP_API_KEY" \
  -H "Content-Type: application/json" -d '{"version":"0.2.0"}'
```

`PUT` returns `200` `{ name, version, updatedAt }`, `401` without a valid key,
`400` for a bad name (`^[a-z0-9][a-z0-9_-]{0,63}$`) or version (`x.y.z`), and
`409` unless the version is numerically greater than the current one
(`0.10.0` > `0.9.0`).

## Project Structure

```
proxy.ts                   # Session refresh + auth redirect (Next.js proxy)
src/
├── app/
│   ├── (dashboard)/       # Signed-in area sharing one layout + auth check
│   │   ├── dashboard/     # My Files (folders, uploads, versions)
│   │   ├── recent/  search/  shared/  trash/  activity/  contacts/
│   ├── api/public-share/  # Public share-link download + info endpoints
│   ├── share/[token]/     # Public share-link landing page
│   ├── login/  register/  setup/
├── components/
│   ├── ui/                # shadcn/ui (base-ui) primitives
│   ├── files/             # File manager feature components
│   └── dashboard-layout.tsx
├── lib/
│   ├── auth.ts            # Cached server-side user lookup / requireUser()
│   ├── public-share.ts    # Server-only share-link validation
│   ├── storage.ts         # Bucket name + storage path helpers
│   ├── services/          # Client-side data access (Supabase RPC/Storage)
│   ├── supabase/          # Browser, server, proxy and admin clients
│   └── types/
supabase/
├── schema.sql
└── migrations/            # Apply in filename order
```

## Deployment

### Vercel (Recommended)

1. Push your code to GitHub
2. Go to [vercel.com](https://vercel.com) and import your repository
3. Add environment variables in Vercel dashboard
4. Deploy

### Other Platforms

This is a standard Next.js app and can be deployed to any platform that supports Node.js.

## Free Tier Limits

### Supabase (Free Tier)
- **Database**: 500 MB
- **Storage**: 1 GB
- **Bandwidth**: 5 GB/month
- **Auth**: 50,000 monthly active users
- **API Requests**: 500,000/month

### Vercel (Free Tier)
- **Bandwidth**: 100 GB/month
- **Build Time**: 6,000 minutes/month
- **Serverless Function Execution**: 100 GB-hours/month

## License

MIT
