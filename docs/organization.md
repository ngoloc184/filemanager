# Organization (company)

A **company** (organization) groups the people who run official documents
(văn bản) together: departments, positions, members with roles, invitations,
holidays and offboarding. Everything lives on the **Organization** page
(`/org`, sidebar); **Documents** (`/documents`) needs a company first. See
[documents.md](documents.md) for the documents module and
[operations.md](operations.md) for setup.

## One company per account

* An account belongs to at most one company at a time (active or suspended).
  A person who left a company can be invited to another one, or back.
* Sign-up stays open. Being signed in gives you My Files and chat only;
  company data (documents, directory, registers, dossiers) needs an **active**
  membership, and people join only through an invitation sent to their e-mail.
* Roles are stored on the membership (`org_members.roles`), never in the
  account's metadata.

## Creating a company

**Organization** → **Set up your company**:

* **Company name** (2–200 characters) and optional **Short name**.
* **Company code**: 2–15 capital letters or digits (`Đ` allowed), unique
  across the app. It is the `{org}` token of document notations, e.g. code
  `ABC` → `15/QĐ-ABC`. An admin can change it later (**Overview** →
  **Company details**); numbers already issued keep their old notation.
* **Time zone** (Overview, default `Asia/Ho_Chi_Minh`) decides "today" for the
  company: the document year (registers number from 1 every year), arrival
  and issue dates, deadlines and reminders. It is never UTC.
* **Tax code (Mã số thuế)** and **Address** are optional.

The creator becomes **Admin**, **Leader** and **Records clerk**. Creating a
company also adds the document types of Decree 30/2020 Phụ lục III plus
*Công văn*, the three registers of the current year (*Sổ văn bản đến*,
*Sổ văn bản đi*, *Sổ văn bản nội bộ*) and the default retention codes (VV,
70, 20, 10, 5 years).

## Departments (Phòng ban)

**Departments** tab (admins edit, everyone reads):

* **Name**, **Code** (1–20 capital letters, digits or `-`, unique in the
  company; the `{dept}` token of *công văn* notations, e.g. `05/ABC-HCNS`),
  **Sort order**, optional **Parent department** (departments nest).
* **Head (Trưởng phòng)**: an active member. The head matters for routing:
  * a document assigned to a **department** goes to its head, who sees it in
    *Needs me*, gets the notifications and reminders, and can sub-assign it;
  * a department without a head cannot be assigned work ("Department … has
    no head");
  * people with the *Department head* role see what their department drafts
    and the processing report of the departments they head.
* **Archive** hides a department. Move its members elsewhere and archive its
  sub-departments first.

## Positions (Chức vụ) and Can sign

**Positions & holidays** tab (admins):

* A position has a **name** and a **rank** (higher rank sorts first).
* **Can sign** marks positions that may sign outgoing documents. A person can
  be the signer of an approval chain when they have the *Leader* role **or** a
  position with *Can sign*. The signer's position name (else their title) is
  printed with the signature data.
* Deleting a position clears it from the people holding it.

## Roles

A member has one or more roles (at least one). Admins set them in
**People** → ⋯ → **Edit** or when inviting.

| Role | Can do |
| --- | --- |
| **Admin** (`org_admin`) | Edit the company, departments, positions and holidays; invite, edit, suspend, reactivate and offboard members; manage registers, document types, fields and external organisations; read every non-confidential document that is not a private draft; assign, complete and reopen incoming documents like a leader; share any draft; put dossiers on legal hold and reopen closed dossiers. A company always keeps at least one active admin; you cannot remove your own admin role or suspend yourself. |
| **Records clerk (Văn thư)** (`clerk`) | Register incoming documents (arrival numbers, duplicate warning), present them to a leader, cancel unprocessed ones; issue signed documents (number, notation, recipients), upload the signed copy, recall issued documents; print registers; manage external organisations; close and transfer dossiers to the archive; see reports for the whole company; read every non-confidential document that is not a private draft. |
| **Leader (Lãnh đạo)** (`leader`) | Assign incoming documents to a lead, supports and info recipients; complete and reopen them; sign outgoing documents; recall issued ones; see reports for the whole company; read every non-confidential document that is not a private draft. |
| **Department head (Trưởng phòng)** (`dept_head`) | Receive incoming documents presented by the clerk and assign them; read documents drafted by the departments they head; see the processing report of those departments. Work assigned to a department reaches its head through *Head* above, whatever their roles. |
| **Staff (Chuyên viên)** (`staff`) | The default. Report results on assignments, draft outgoing and internal documents, build their approval chain and share drafts; read what they take part in. |

Everyone can approve or sign the steps of an approval chain they are put in,
sub-assign work assigned to them, and create dossiers.

## Inviting people

**Invitations** tab (admins):

1. Enter the **Email**, optionally a **Department** and **Position**, and the
   roles, then **Send invitation**.
2. Invitations are **not e-mailed**: copy the link (`/invite/<token>`) and send
   it yourself. If the address already has an account, that person also gets
   an in-app notification with the link.
3. The person opens the link and presses **Accept invitation**. The account's
   e-mail must match the invited address; otherwise the page says so and
   offers **Sign in with another account**.
4. Someone who is signed out is sent to sign in (or register) first and comes
   back to the invitation afterwards, also through the e-mail confirmation of
   a new account.

A link is valid for 14 days and works once. Inviting the same address again
revokes the previous pending link. **Pending invitations** lists them;
**Revoke** cancels one. The invitation page tells the invitee that company
admins can reassign the files and tasks they own when they leave.

## People directory

**People** tab: active members with department, position, roles and status;
search by name, e-mail or department (accents optional); **Show former
members** adds suspended and left people. The person pickers in the app
(department head, assignees, approvers, recipients) search active members of
your company only.

## Suspending

**People** → ⋯ → **Suspend**: the person keeps their account, My Files and
chat, but loses everything that needs an active membership (documents,
registers, dossiers, the directory), immediately. **Reactivate** gives it
back. Nothing is handed over; for a person who is leaving, offboard instead.

## Offboarding (handover)

**People** → ⋯ → **Offboard…** (`/org/offboarding`, admins only). Pick the
**Leaving member** and the **Successor (người tiếp nhận)**, an active member.
Step 2 lists what will move, as counts; step 3 confirms. Nothing is deleted.

What moves to the successor:

* **Files and folders**: every file and folder the leaver owns (also personal
  ones and those in the trash). Storage paths stay; the size counts toward the
  successor's quota (the page warns). A folder whose name would clash with one
  of the successor's is renamed `<name> (from <leaver>)`. Shares to the
  successor on what they now own, and every share to the leaver, are removed.
* **Chat groups** the leaver owns: to the successor when they are in the
  group, else the longest-standing admin, else the oldest member; the leaver
  stays a plain member.
* **Open document tasks** (lead, support and info assignments not done yet).
* **Approval steps** that are waiting or pending (a step the successor already
  has on the same document is marked skipped).
* Documents **presented to** the leader that are not finished, and the
  leaver's **drafts**.
* **Department head** posts, **register roles** (manager / follower) and
  **dossiers** they own.

Each moved assignment or step is recorded as *reassigned* in the document's
history, and the successor gets one *handover* notification. The leaver's
membership becomes **left**, their push subscriptions are removed and at least
one admin must remain.

**Block sign-in for this account** (checked by default) also bans the account
and ends its sessions. The account is global: the ban blocks the whole app,
not only this company (My Files, chat, any later company). Untick it when the
person should keep using the app privately. Lifting a ban is done in Supabase
(see [operations.md](operations.md#offboarding-runbook)).

[Unverified] Sessions already open may last until their access token expires
when the server cannot delete them; the result page then says so.

## Holidays and working days

**Positions & holidays** → **Holidays (Ngày nghỉ)** (admins): add a day and a
name, per year. Deadlines count **working days**: Monday to Friday, minus
these days. They are used for default deadlines, *Due soon*, *Overdue* and the
reminders (see [documents.md](documents.md#deadlines-and-reminders)).
Holidays are not repeated automatically; add each year's days (Tết, 30/4,
1/5, 2/9 …) yourself.

Tests: `supabase/tests/9934_organizations.sql`, `9938_offboarding.sql`.
