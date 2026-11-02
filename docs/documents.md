# Documents (Văn bản)

Official documents of a company: incoming documents (văn bản đến) that the
records clerk registers and a leader assigns, and outgoing or internal
documents (văn bản đi / nội bộ) that go through an approval chain, are signed
and issued with a number. The module is at **Documents** (`/documents`) and
needs an active company membership ([organization.md](organization.md)).
Setup is in [operations.md](operations.md).

The design follows eDOCS (typed profile, versions, access rules, saved
filters, retention) and Decree 30/2020 as used by common Vietnamese
e-office products. [Inference] It is a working proposal, not legal advice.

## Concepts

### Directions

| Direction | Flow | Statuses |
| --- | --- | --- |
| **Incoming (Văn bản đến)** | clerk registers → presents to a leader → leader assigns → assignees report → completed | Draft, Registered (Đã vào sổ), Submitted to leader (Đã trình), In progress (Đang xử lý), Completed (Đã xử lý), Cancelled, Archived |
| **Outgoing (Văn bản đi)** | author drafts → approval chain → signer signs → clerk issues to recipients | Draft (Dự thảo), In review (Đang duyệt), Awaiting signature (Chờ ký), Signed – ready to issue (Chờ phát hành), Issued (Đã ban hành), Rejected, Withdrawn, Recalled (Đã thu hồi), Archived |
| **Internal (Nội bộ)** | as outgoing, sent to people or departments of the company | as outgoing |

Every document has a **profile** (type, subject, field, issuing organisation,
dates, signer, pages, urgency, confidentiality, keywords, description), its
**files**, **processing opinions** and an append-only **history** (timeline).
Views, downloads and prints are recorded in an access log.

### Registers (Sổ văn bản) and numbering

* A register belongs to one direction and one **year**. New companies get
  *Sổ văn bản đến*, *Sổ văn bản đi* and *Sổ văn bản nội bộ* for the current
  year. Admins manage registers at **Documents** → **Registers**.
* Numbers start at the register's **start number** (default 1) and count up.
  **Numbering** is either *Per register* (one sequence, nhảy số theo sổ) or
  *Per register and type* (a sequence per document type).
* The year is the company's year in its time zone (default
  Asia/Ho_Chi_Minh), never UTC: a document registered at 00:30 on 1 January
  Vietnam time belongs to the new year. Registering or issuing needs an open
  register of the current year. Near the end of the year (or when the year has
  none) the Registers page offers to **copy the open registers** of the
  previous year, with their settings and people.
* A number once handed out is never reused, also when the document is
  cancelled. A manual number at issue (see the clerk guide) moves the counter
  up so later automatic numbers do not collide with it.
* **Register roles**: *Manager (Quản lý sổ)* and *Follower (Theo dõi)*. They
  can open and print the register and follow its non-confidential documents.
* A **closed** register hands out no more numbers until reopened; a register
  no document uses can be deleted.

### Notation (Ký hiệu)

Outgoing and internal documents get a notation when issued, from the
register's templates:

| Token | Meaning |
| --- | --- |
| `{n}` | the number, at least two digits (01, 02, … 123); required |
| `{type}` | document type abbreviation (QĐ, TB, …); empty for công văn |
| `{org}` | company code |
| `{dept}` | code of the drafting department |
| `{yyyy}` | register year |

* Default template `{n}/{type}-{org}`: number 1 of a *Quyết định* in company
  `ABC` → **01/QĐ-ABC**.
* Default *công văn* template `{n}/{org}-{dept}`: number 5 drafted by
  department `HCNS` → **05/ABC-HCNS**.
* Separators around an empty token are dropped: `{n}/{type}-{org}` with no
  type gives `02/ABC`, not `02/-ABC`.
* The issue dialog previews the number and notation; issuing stores exactly
  what the preview showed. A notation is unique within an outgoing or internal
  register. Incoming documents keep the sender's notation, which need not be
  unique.

### Urgency and default deadlines

| Urgency | Default processing deadline |
| --- | --- |
| Normal | 7 working days |
| Urgent (Khẩn) | 2 working days |
| Very urgent (Thượng khẩn) | 1 working day |
| Immediate (Hỏa tốc) | 0 (the same working day) |

[Inference] These numbers are a proposal (SQL function
`doc_default_due_days`), not a legal rule. Working days are Monday to Friday
minus the company's holidays. When the clerk registers an incoming document
without a due date, it gets today + the default. The lead's deadline then
becomes the document's deadline; supports default to it. Urgent documents
sort first in the inbox, and the notifications of the incoming workflow
(assigned, presented, completed …) start with `[URGENT]`.

### Confidentiality (Độ mật)

| Level | Who can read |
| --- | --- |
| Normal | the people taking part, plus every admin, leader and clerk of the company |
| Internal only (Lưu hành nội bộ) | same as Normal (a label for print and handling) |
| Return after reading (Xem xong trả lại) | same as Normal (a label) |
| Confidential | only explicit participants: the author, the clerk who registered it, the leader it was presented to, the signer, assignees (and the heads of assigned departments; for an *info* assignment to a department, its active members), approvers, member recipients and people it was shared with |

*Confidential* is an internal company level, not a state secret (MẬT). Keep
state-secret documents out of the system. In a printed register a document
you cannot read shows only its numbers and dates, with the subject
"Restricted document".

"Taking part" means: the author, the person it was presented to, the signer,
assignees (a department assignment counts for its head; an *info* assignment
for every active member of that department), approvers, member recipients,
people it was shared with, register managers and followers, and department
heads for what their department drafts.

### Private drafts

An outgoing or internal draft that was never submitted is private: only its
author, the people it is shared with (**Share draft**) and the people already
put in its approval chain can see it, including its files. Admins, leaders and
clerks see it once it has been submitted. Incoming drafts are
not private: admins, leaders and clerks see them.

### Files

Files are ordinary My Files files. Uploading from a document form puts them in
your **Documents** folder in My Files and links them as **Main file (Tệp
chính)**, **Attachment (Phụ lục)**, **Signed copy (Bản đã ký)** or **Draft**.
Preview, download and versions work as for any file; reading a document gives
view access to its files, editing a draft gives edit access to its unlocked
files.

## Step-by-step guides

### Records clerk (Văn thư)

**Register an incoming document (Vào sổ)**

1. **Documents** → **Register incoming** (`/documents/incoming/new`).
2. Fill in the type, subject, sender (**Issuing organisation**, picked from
   external organisations or typed), number/notation, date of document,
   arrival date and the other details; attach exactly one **main file** (the
   scan) and any attachments.
3. Leave **Register in an incoming register when saving** ticked and pick the
   register. The next arrival number is shown as a preview; the number is
   taken when you save. Untick it to keep a draft and register later with
   **Register (Vào sổ)** on the document page.
4. Registering needs type, subject, issuing organisation, notation and the
   main file. It gives the arrival number (số đến), sets the arrival date and
   default deadline, and **locks the main file and attachments**.

**Duplicate warning.** When a document with the same notation and issuing
organisation (and the same or no document date) is already in the company,
the dialog lists the matches (their subjects only when you can read them).
**Keep as draft** stops; registering anyway needs a reason, which the history
keeps.

**Present to a leader (Trình lãnh đạo).** On a registered document →
**Present to leader**, pick a leader, department head or admin and add a note
(it becomes a proposal opinion). The leader can **Return to clerk** with a
reason. A clerk may also assign a registered document directly. **Cancel (Hủy
văn bản)** works on drafts and registered documents; the arrival number is
not reused.

**Issue a signed document (Phát hành).** Signed documents appear in **Ready
to issue (Chờ phát hành)**.

1. Open it → **Issue**, pick this year's outgoing (or internal) register and
   check the previewed number and notation. Leave the number empty for the
   automatic one, or type a manual number (recorded as an override).
2. Add recipients: members or departments of the company (they get an
   *info* assignment on the same document and a notification; nothing is
   copied), and outside organisations with a delivery method (system, e-mail,
   post, by hand), which are recorded only. Outgoing needs at least one
   recipient; internal at least one person or department. A department
   recipient is notified through its head; its active members can read the
   document.
3. Issuing stores the number, notation and issue date, and locks the files.
4. **Upload signed copy (Bản đã ký)** attaches the scanned or digitally
   signed copy, on a signed or issued document; on an issued one it is locked
   at once.
5. **Recall (Thu hồi)** (clerk or leader) takes an issued document back with
   a reason; recipients are told and lose access to it, also those who
   already marked their info copy as read.

**Print registers.** **Registers** → **Print / export** on a register
(`/documents/registers/<id>/print`): filter by date or number range,
**Print** (A4 landscape, with an empty *Ký nhận* column for signatures) or
**Export CSV**. The columns follow the register forms of Decree 30/2020
(Phụ lục IV, as cited in the code). [Unverified] The column set has not been
checked against the decree text by a records specialist.

### Leader (Lãnh đạo)

**Assign (Giao xử lý)** an incoming document presented to you (*Needs me*):

1. **Assign** → add people or departments, each as **Lead (Chủ trì)**,
   **Support (Phối hợp)** or **For information (Để biết)**, with a deadline
   and an optional instruction. Exactly one lead per document.
2. Deadlines cannot be in the past. Lead and support rows without a deadline
   take the lead's (else the document's) deadline. A department goes to its
   head.
3. The document moves to *In progress*; everyone assigned is notified.
   **Take back assignment** works until the person opens it.

**Complete (Hoàn thành xử lý)** closes an incoming document with a result
note. The lead (or the leader it was presented to) completes once the lead has
reported; a leader or admin may complete earlier, which the history records as
an override. **Reopen (Mở lại)** puts a completed document back in progress.

**Approve and sign** outgoing or internal documents: steps waiting for you are
in **Awaiting my approval (Chờ duyệt)**.

* **Approve (Đồng ý)** your step with an optional comment;
  **Return for revision (Trả lại)** with a comment sends the draft back to the
  author; **Reject (Từ chối)** ends the workflow.
* **Sign (Ký duyệt)** on the last step: pick the signing authority (direct,
  KT., TL., TUQ., TM., Q.) and an optional comment. See
  [E-approval is not a digital signature](#e-approval-is-not-a-digital-signature).
  The author and the clerks are told the document is ready to issue.

### Department head (Trưởng phòng)

Work assigned to your department comes to you (the department's **Head**).
**Sub-assign (Giao xử lý tiếp)** passes your assignment on: add people (at
most one lead under your assignment), supports or info recipients, with
deadlines no later than yours. Sub-assigning marks your assignment as seen, so
it can no longer be taken back from you. You still report the result of your
own assignment.

### Staff (Chuyên viên)

**Report results.** Open the document (opening it marks your assignments as
seen) → **Report result (Báo cáo kết quả)**: **Start work** (tells the
assigner you are on it), **done** with the result (Kết quả xử lý; required for
lead and support), or **return** it with a reason. Info copies are just marked
as read.

**Draft an outgoing or internal document.**

1. **Documents** → **New document** (outgoing) or the arrow → **Internal
   document** (`/documents/new?direction=outgoing|internal`).
2. Fill in the profile (type is needed before submitting) and the drafting
   department, and upload the **main file** (needed before submitting) and
   attachments.
3. **Approval chain (Luồng trình ký)**: up to 10 rows, each a person and a
   kind: **Review**, **Format check (Kiểm tra thể thức)**, **Consult (Xin ý
   kiến)** or **Sign (Ký duyệt)**. Exactly one signer, last; the signer must
   be a leader or hold a position with *Can sign*. A row can run **in
   parallel** with the one before it; consult rows are optional unless marked
   required (a step moves on once its required rows approve).
4. **Submit for approval (Trình ký)**: the first step is notified and **the
   files are locked** so approvers see exactly what was submitted.
5. Returned for revision: the draft comes back to you as a new revision with
   the same chain and **the files unlock**; edit and submit again.
   **Withdraw (Rút lại)** stops a document that is not signed yet (it cannot
   be resubmitted).

**Share a draft (Chia sẻ dự thảo).** On your draft → **Share draft**: give
active members of the company *read* or *edit* access. Edit lets them change
the draft and its unlocked files. Admins can share any draft.

**Follow-ups.** From an incoming document you take part in, or any issued
document: **Reply (Văn bản trả lời)** starts an outgoing draft "V/v trả lời
…". From an issued outgoing or internal document: **Replacement (Văn bản thay
thế)** and **Correction (Văn bản đính chính)**. The documents are linked both
ways under *Related*.

## Inbox views

The **Documents** page shows count cards and tabs; each view lists only
documents of your company that you can read.

| View | Contains |
| --- | --- |
| **Needs me (Cần xử lý)** | presented to you; your open lead or support assignments (also those of a department you head); your drafts returned to you; your pending approval steps; for clerks, signed documents to issue |
| **Awaiting my approval (Chờ duyệt)** | your pending approval or signing steps |
| **Due soon (Sắp đến hạn)** | *Needs me* items due today up to 2 working days ahead |
| **Overdue (Quá hạn)** | your lead or support assignments, assignments you gave, and documents presented to you, past the deadline |
| **For information (Để biết)** | info assignments to you or your department |
| **To register (Chờ vào sổ)** | clerks: incoming drafts |
| **Ready to issue (Chờ phát hành)** | clerks: signed documents |
| **Following (Theo dõi)** | documents in registers you manage or follow, and your unfinished documents |
| **Created by me** | documents you created |
| **Done (Đã xử lý)** | work you finished, steps you acted on, documents you registered, issued or completed, and work you assigned once it is done |
| **All documents** | everything you can read |

Overdue is computed from today's date in the company's time zone; nothing is
stored. Rows sort by urgency, then your nearest deadline.

## Search and filters

* The search box matches the subject, notation, issuing organisation,
  keywords and description **without accents and case**: `quyet dinh` finds
  *Quyết định*, `cong van so 12` finds *Công văn số 12*. `%` and `_` are
  literal characters.
* It also matches words inside attached files whose text has been extracted
  for search (the same index as My Files search).
* Filters: direction, status, register, year, type, field, urgency,
  confidentiality, date range (issue or arrival date), department (drafting or
  assigned) and external organisation. They are kept in the address, so a
  filtered view can be bookmarked or shared.
* **Export CSV** saves the current list (up to 2,000 rows).
* **Reports** (`/documents/reports`): incoming processing by department and
  person (received, done on time, done late, open on time, open overdue) for
  leaders, clerks and admins (whole company) and department heads (their
  departments); outgoing and internal documents issued per month and type,
  with the average approval time, for leaders, clerks and admins.

## Deadlines and reminders

A scheduled job (`/api/cron/document-reminders`, once a day, see
[operations.md](operations.md#scheduled-jobs-vercel-cron)) notifies the person
on each open **lead** or **support** assignment (for a department, its head):

* **Due tomorrow**: one working day before the deadline;
* **Due today**;
* **Overdue since …**: every run while it stays overdue.

Each reminder is sent at most once per assignment, kind and day, so a re-run
sends nothing twice. When an assignment is 2 or more working days late, the
person who assigned it is told as well. Reminders appear in the bell and as
device push when enabled. Info assignments get no reminders.

## Notifications

The bell in the header lists your notifications (assigned, presented,
approval requested, signed, ready to issue, issued, returned, completed,
recalled, reminders, shares, comments, invitations, handovers) and updates
live; **Mark all as read** clears the badge. **Push notifications for
activity** in the bell turns device push on or off; push needs the browser
permission and the VAPID keys of [chat.md](chat.md#notifications). Nobody is
notified about their own action.

## Dossiers (Hồ sơ)

**Documents** → **Dossiers** (`/documents/dossiers`).

* **New dossier**: year, code (Ký hiệu hồ sơ, suggested from the department,
  e.g. `01.HCNS`), title, department, retention (Thời hạn bảo quản: VV =
  permanent, 70, 20, 10, 5 years by default) and a description. Any active
  member can create one; the creator is its owner. **Edit** (owner, clerk or
  admin, open dossiers) also marks a capital construction dossier (Hồ sơ xây
  dựng cơ bản).
* A dossier is visible to its owner, the members and head of its department,
  and the company's admins, leaders and clerks. Its documents keep their own
  access rules.
* **Add to dossier** on a document page files it in an open dossier (one you
  own, or any dossier for clerks and admins). A document can be in several
  dossiers.
* **Close dossier** (owner, clerk or admin) sets the end date and the
  **transfer due date**: end date + 1 year, or + 3 months for capital
  construction. [Unverified] These periods are configurable defaults, not
  legal advice. An admin can **Reopen** a closed dossier.
* **Transfer to archive (nộp lưu)** (clerk or admin, closed dossiers): the
  completed incoming and issued documents in it become *Archived*. The list
  can show only dossiers due for transfer.
* **Legal hold** (admins): documents in a held dossier cannot be deleted or
  lose files, and their files cannot get new versions, lose versions, be
  trashed or be deleted (also by the trash auto-purge). Releasing the hold
  lifts it.
* **Export ZIP** builds, in the browser, a ZIP with `manifest.json`,
  `index.csv` and each readable document's main file (else its first file) as
  `001_<name>`; files over 200 MB are skipped and listed. Each file is logged
  as a download.

The retention catalog is seeded per company; there is no page to edit it yet.

## When files lock and unlock

Locked (frozen) files cannot get new versions, switch back to an older
version, be renamed, moved, trashed or deleted, and cannot be detached.

| Event | Files |
| --- | --- |
| Incoming **registered** | main file and attachments lock, for good (also if the document is later cancelled) |
| Outgoing/internal **submitted for approval** | all files lock |
| **Returned for revision** | all files unlock (an editable draft again) |
| **Signed**, **issued** | all files lock (and stay locked) |
| Rejected, recalled, or withdrawn after submission | files stay locked |
| **Signed copy** uploaded after issue | locks at once |
| Main file or attachment added to a registered incoming document | locks at once |

On a signed document the clerk may still correct the profile and add the
signed copy; nothing else changes.

## E-approval is not a digital signature

**Sign (Ký duyệt)** is an authenticated in-app approval. It records who
signed, when, the authority prefix (KT., TL., TUQ., TM., Q.) and a checksum of
the main file at that moment. It is **not** a digital signature (chữ ký số)
under Decree 30/2020, Article 5. Where a legally valid signed original is
needed, sign it with a CA digital signature or on paper outside the app and
attach it with **Upload signed copy**.

## Decree 30/2020 coverage

[Inference] The mapping below is the project's reading of Decree 30/2020
(the Phụ lục references follow the comments in the migrations). [Unverified]
It has not been reviewed by a records specialist or lawyer.

| Feature | Status |
| --- | --- |
| Document types and abbreviations (Phụ lục III) | Covered: seeded per company, editable in **Settings** |
| Incoming register book, arrival numbers, register print (Phụ lục IV) | Covered |
| Outgoing/internal register book, yearly numbering, number and notation | Covered |
| Duplicate check on registration | Covered |
| Presenting to a leader, assignment (chủ trì / phối hợp / để biết), sub-assignment, result reports, completion | Covered |
| Drafting, review, format check, consultation, signing chain, return and revision | Covered |
| Issuing with distribution records (internal and external) | Covered; external delivery is recorded, not sent |
| Freezing registered and issued files (Phụ lục VI III.5.d) | Covered |
| Recall, reply, replacement, correction | Covered |
| Processing opinions, audit history, view/download/print log | Covered |
| Deadlines in working days, reminders, overdue tracking | Covered |
| Dossiers, retention codes, closing, transfer to archive; one document in many dossiers (Phụ lục VI III.4.e) | Covered (basic) |
| Digital signature (chữ ký số, Art. 5) | **Not covered**: in-app e-approval only |
| Inter-agency exchange (liên thông, VDXP) | **Not covered** (deferred) |
| OCR of scanned documents | **Not covered** (deferred) |
| Deadline extension requests (xin gia hạn) | **Not covered** (deferred) |
| State secrets (văn bản mật) | **Out of scope**: keep them out of the system |

## FAQ

**I cannot find a document someone mentioned.** You only see documents you
take part in, plus (for admins, leaders and clerks) non-confidential ones.
Confidential documents, and outgoing drafts that were never submitted, stay
hidden until you are added to them. A suspended membership hides all
documents.

**Can I replace the scan after registering?** No: the main file and
attachments are locked once registered. Add a corrected document or ask the
clerk to cancel and register again (the number is not reused).

**The register says it is for last year.** The year follows the company time
zone. An admin opens this year's registers on the Registers page (copy last
year's).

**Why did a number skip?** Numbers are never reused, also for cancelled
documents, and a manual number moves the counter up.

**Can I ask for more time on a deadline?** Not in the app yet (deferred).
Return the assignment with a reason; the person who assigned it can then
assign it again with a new deadline.

**Who gets the reminder for a department?** Its head.

**Is "Sign" legally a signature?** No. See
[E-approval is not a digital signature](#e-approval-is-not-a-digital-signature).

**What happens to my documents when I leave?** An admin offboards you: your
open tasks, approval steps, drafts, register roles and dossiers go to a
successor ([organization.md](organization.md#offboarding-handover)).

Tests: `supabase/tests/9936_documents_core.sql`, `9939_document_registers.sql`,
`9940_documents_incoming.sql`, `9941_documents_outgoing.sql`,
`9942_document_search_reports.sql`, `9943_dossiers_retention.sql`, and the
`src/lib/__tests__/documents-*.test.ts` unit tests.
