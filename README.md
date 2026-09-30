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
npm run build      # production build
```

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
