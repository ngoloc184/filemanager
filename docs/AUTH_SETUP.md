# Đăng ký / đăng nhập bằng Email và Google — hướng dẫn cấu hình

Tài liệu này mô tả tính năng xác thực mới, những gì cần cấu hình trên
Supabase / Google Cloud / dịch vụ email, và cách đã kiểm thử.

> Không có khóa bí mật nào được ghi trong mã nguồn. Client Secret của Google
> và mật khẩu SMTP chỉ nhập trong **Supabase Dashboard**; khóa service role
> chỉ đặt trong biến môi trường phía server.

---

## 1. Kiến trúc (tận dụng hệ thống sẵn có)

Website đã dùng **Supabase Auth**, nên tính năng mới được xây trên chính
Supabase Auth thay vì tự viết cơ chế xác thực:

| Thành phần | Dùng gì |
|---|---|
| Lưu tài khoản, băm mật khẩu | Supabase Auth (`auth.users`, mật khẩu băm **bcrypt**) |
| Xác minh email, Magic Link, quên mật khẩu, đổi email | Supabase Auth gửi email qua SMTP của bạn |
| Google Sign-In | Google OAuth 2.0 qua Supabase Auth (PKCE). Supabase **xác minh phản hồi của Google ở server** bằng Client Secret |
| Liên kết tài khoản trùng email | Cơ chế identity linking của Supabase (chỉ tự liên kết khi email đã xác minh ở cả hai phía) + liên kết thủ công khi đã đăng nhập |
| Phiên đăng nhập | Cookie `sb-<ref>-auth-token` do `@supabase/ssr` quản lý, **HttpOnly + Secure + SameSite=Lax** |
| Phân quyền file/thư mục | **Không đổi** — vẫn là RLS + các hàm `has_file_access` / `has_folder_access` theo `auth.uid()` |

Luồng dữ liệu:

```
Trình duyệt ──(form)──▶ Server Action / Route Handler (Next.js)
                         │  kiểm tra đầu vào, chống brute-force, chuẩn hóa email
                         ▼
                      Supabase Auth  ──▶ Google (OAuth) / SMTP (email)
                         │
                         ▼  phiên lưu trong cookie HttpOnly
src/proxy.ts  ── mỗi request: xác thực + làm mới phiên (xoay vòng refresh token)
                         │
Trình duyệt ──GET /api/auth/token──▶ access token ngắn hạn (≈1 giờ) cho các
                                      truy vấn dữ liệu trực tiếp tới Supabase (RLS)
```

Vì cookie phiên là HttpOnly, JavaScript không đọc được refresh token. Các
service phía client cũ (`src/lib/services/*`) vẫn hoạt động như trước: client
Supabase trong trình duyệt lấy access token ngắn hạn từ `/api/auth/token`.

### Các trang mới / thay đổi

| Đường dẫn | Mô tả |
|---|---|
| `/login` | Email, mật khẩu, **Ghi nhớ đăng nhập** (30 ngày), **Quên mật khẩu?**, **Tiếp tục với Google**, đăng nhập bằng liên kết email, liên kết sang Đăng ký |
| `/register` | Email (bất kỳ nhà cung cấp nào), mật khẩu + checklist độ mạnh, xác nhận mật khẩu, **Đăng ký với Google**; sau khi gửi: màn hình “Kiểm tra hộp thư” (gửi lại có đếm ngược, nhập mã 6 số) |
| `/forgot-password` | Gửi liên kết đặt lại mật khẩu (thông báo giống nhau dù email có tồn tại hay không) |
| `/reset-password` | Đặt mật khẩu mới — chỉ với phiên mở từ email trong vòng 1 giờ |
| `/magic-link` | Đăng nhập không mật khẩu bằng liên kết/mã gửi tới email **đã đăng ký** |
| `/account` | Tài khoản & bảo mật: phương thức đăng nhập, **liên kết / hủy liên kết Google**, đổi/tạo mật khẩu, đổi email, đăng xuất thiết bị này / mọi thiết bị |
| `/auth/google` | (POST) bắt đầu OAuth Google — đăng nhập hoặc liên kết |
| `/auth/callback` | Đổi mã OAuth/PKCE thành phiên |
| `/auth/confirm` | Xác minh liên kết email dạng `token_hash` (mở được trên thiết bị khác) |
| `/api/auth/token` | Access token ngắn hạn cho client trong trình duyệt |

---

## 2. Database

Chạy migration mới trong **SQL Editor** (sau `202608280015`):

```
supabase/migrations/202608280016_auth_accounts.sql
```

Migration này **không xóa dữ liệu** và chạy lại an toàn:

- Đồng bộ `public.user_profiles` (bảng dùng cho chia sẻ / related users) với
  `auth.users` cho mọi cách đăng ký (mật khẩu, Magic Link, Google) **và khi
  đổi email** (trước đây trigger chỉ chạy lúc tạo tài khoản).
- Chuẩn hóa email (trim + chữ thường) và thêm ràng buộc **duy nhất không phân
  biệt hoa/thường** `user_profiles_email_lower_key`. Nếu dữ liệu cũ có 2 email
  chỉ khác hoa/thường, migration bỏ qua bước tạo index và in cảnh báo để bạn
  xử lý thủ công (không tự xóa).
- Trigger đồng bộ không bao giờ làm hỏng việc đăng ký (lỗi trùng chỉ ghi warning).
- Bảng `auth_rate_limits` + hàm `auth_rate_limit_hit` / `auth_rate_limit_reset`
  (chỉ `service_role` gọi được) để chống brute-force dùng chung giữa nhiều server.
  Khóa được băm SHA-256 — không lưu email/IP dạng thô.
- Hàm `current_user_has_password()` cho trang tài khoản.

Supabase Auth đã đảm bảo một email chỉ có một tài khoản (unique index trên
`auth.users.email`).

---

## 3. Biến môi trường

| Biến | Bắt buộc | Ghi chú |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | ✔ | Như cũ |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✔ | Như cũ |
| `SUPABASE_SERVICE_ROLE_KEY` | Khuyến nghị | Đã dùng cho chia sẻ công khai; nay dùng thêm cho bộ đếm chống brute-force. Thiếu biến này app vẫn chạy nhưng bộ đếm chỉ nằm trong bộ nhớ từng instance. **Không** đặt tiền tố `NEXT_PUBLIC_` |
| `SITE_URL` | Khuyến nghị | Ví dụ `https://files.example.com`. Dùng để tạo liên kết trong email và địa chỉ quay về sau Google. Nếu không đặt, lấy từ Host của request |
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | Khi tự host nhiều instance | Khóa cố định chung cho các instance (xem tài liệu Next.js) |

Không có biến môi trường nào cho Google hay SMTP: chúng được cấu hình trong
Supabase.

---

## 4. Cấu hình Supabase Auth (Dashboard)

### 4.1 URL Configuration — *Authentication → URL Configuration*

- **Site URL**: `https://files.example.com` (trùng `SITE_URL`).
- **Redirect URLs** (allow-list), thêm:
  - `https://files.example.com/auth/callback`
  - `https://files.example.com/auth/confirm`
  - khi phát triển: `http://localhost:3000/auth/**`

Supabase từ chối mọi địa chỉ quay về nằm ngoài danh sách này.

### 4.2 Email provider — *Authentication → Sign In / Providers → Email*

- **Enable Email provider**: bật.
- **Confirm email**: **bật** (khuyến nghị). Tài khoản chưa xác minh không đăng
  nhập được bằng mật khẩu; màn hình đăng nhập hiển thị nút “Gửi lại email xác minh”.
  Nếu tắt, đăng ký xong sẽ vào thẳng ứng dụng.
- **Secure email change**: **bật** (đổi email phải xác nhận ở cả email cũ và mới).
- **Secure password change**: tùy chọn (ứng dụng đã yêu cầu mật khẩu hiện tại).
- **Minimum password length**: `8`; **Password requirements**: “Lowercase,
  uppercase letters and digits” — trùng với kiểm tra trong ứng dụng.
- **Leaked password protection** (gói Pro): nên bật.

### 4.3 Liên kết tài khoản — *Authentication → Sign In / Providers*

- **Allow manual linking**: **bật** để dùng nút “Liên kết Google” ở `/account`.

### 4.4 Phiên đăng nhập — *Authentication → Sessions*

- **Detect and revoke potentially compromised refresh tokens**: bật (mặc định),
  reuse interval 10 giây.
- (Pro) *Time-box* / *Inactivity timeout* nếu muốn giới hạn thêm phía server.
- JWT expiry: giữ 3600 giây.

“Ghi nhớ đăng nhập” trong ứng dụng: cookie phiên sống **30 ngày kể từ lần hoạt
động cuối** (gia hạn mỗi lần làm mới phiên). Bỏ chọn → cookie chỉ tồn tại tới
khi đóng trình duyệt.

### 4.5 Rate limits — *Authentication → Rate Limits*

Các lệnh đăng nhập/đăng ký giờ được gọi **từ server Next.js**, nên Supabase thấy
địa chỉ IP của server thay vì của người dùng. Ứng dụng tự giới hạn theo IP người
dùng và theo email (bảng `auth_rate_limits`, mục 7), vì vậy hãy:

- tăng **Sign-ups and sign-ins** / **Token verifications** đủ cao cho tổng lưu
  lượng (ví dụ 300 / 5 phút) để người dùng không chặn lẫn nhau;
- đặt **Rate limit for sending emails** phù hợp với gói SMTP.

Server cũng gửi header `Sb-Forwarded-For` (IP người dùng); khi nền tảng
Supabase của bạn hỗ trợ, giới hạn theo IP của Supabase sẽ lại áp dụng cho
từng người dùng.

---

## 5. Google OAuth (Google Cloud Console)

1. Vào <https://console.cloud.google.com/> → tạo (hoặc chọn) project.
2. **APIs & Services → OAuth consent screen** (Google Auth Platform → Branding):
   - User type **External**, tên ứng dụng, email hỗ trợ, logo (tùy chọn).
   - **Authorized domains**: tên miền của bạn và `supabase.co`.
   - **Scopes (Data access)**: chỉ `openid`, `.../auth/userinfo.email`,
     `.../auth/userinfo.profile`. Đây là quyền tối thiểu, không nhạy cảm nên
     không cần Google thẩm định. Ứng dụng không yêu cầu thêm quyền nào.
   - Khi sẵn sàng, **Publish app** (ở trạng thái *Testing* chỉ tài khoản test
     đăng nhập được).
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - **Authorized JavaScript origins**: `https://files.example.com`
     (và `http://localhost:3000` khi phát triển).
   - **Authorized redirect URIs**: `https://<project-ref>.supabase.co/auth/v1/callback`
     (lấy chính xác từ trang cấu hình Google trong Supabase).
4. Sao chép **Client ID** và **Client Secret**.
5. Supabase Dashboard → **Authentication → Sign In / Providers → Google**:
   bật, dán Client ID và Client Secret, **Save**.

Luồng khi bấm “Tiếp tục với Google”: `/auth/google` (server tạo PKCE, chọn
tài khoản bằng `prompt=select_account`) → trang Google → Supabase nhận và
**xác minh mã của Google bằng Client Secret** → `/auth/callback` đổi mã lấy
phiên → `/dashboard`. Frontend không bao giờ gửi thông tin người dùng lên.

---

## 6. Gửi email (SMTP) và mẫu email

### 6.1 SMTP — *Authentication → Emails → SMTP Settings*

Máy chủ email có sẵn của Supabase chỉ gửi tới thành viên trong team và giới hạn
vài email/giờ — **bắt buộc cấu hình SMTP riêng khi chạy thật**:

- Nhà cung cấp gợi ý: Resend, Amazon SES, Postmark, SendGrid, Brevo, hoặc
  Google Workspace SMTP.
- Nhập Host, Port (465 SSL hoặc 587 STARTTLS), Username, Password, Sender email
  (ví dụ `no-reply@example.com`) và Sender name.
- Cấu hình **SPF, DKIM, DMARC** cho tên miền gửi để email không vào Spam.

### 6.2 Mẫu email — *Authentication → Emails → Templates*

Thư mục `supabase/templates/` có sẵn mẫu tiếng Việt. Dán nội dung vào:

| Template trong Supabase | File | Gợi ý tiêu đề |
|---|---|---|
| Confirm signup | `confirmation.html` | Xác minh email tài khoản File Manager |
| Magic Link | `magic_link.html` | Liên kết đăng nhập File Manager |
| Reset Password | `recovery.html` | Đặt lại mật khẩu File Manager |
| Change Email Address | `email_change.html` | Xác nhận đổi email File Manager |

Các mẫu này trỏ tới `/auth/confirm?token_hash=...`, nên liên kết **mở được trên
thiết bị/trình duyệt khác** với nơi đã yêu cầu (ví dụ đăng ký trên máy tính,
mở email trên điện thoại). Mẫu xác minh và Magic Link có kèm **mã 6 số**
(`{{ .Token }}`) để nhập trực tiếp ở màn hình “Kiểm tra hộp thư”.

Nếu giữ mẫu mặc định của Supabase, mọi thứ vẫn hoạt động nhưng liên kết chỉ
đăng nhập tự động trên **cùng trình duyệt** đã yêu cầu; ở trình duyệt khác,
email vẫn được xác minh và người dùng được mời đăng nhập lại.

---

## 7. Bảo mật đã áp dụng

- Mật khẩu băm bcrypt bởi Supabase Auth; ứng dụng không lưu mật khẩu.
- Chính sách mật khẩu: ≥ 8 ký tự, có chữ thường, chữ hoa, chữ số, ≤ 72 byte,
  không trùng email — kiểm tra ở cả trình duyệt và server.
- Email được chuẩn hóa (NFC, trim, chữ thường) trước khi lưu/so sánh.
- Chống brute-force (bảng `auth_rate_limits`, dùng chung giữa các instance):

  | Hành động | Giới hạn |
  |---|---|
  | Đăng nhập mật khẩu, mỗi IP | 30 lần / 15 phút |
  | Sai mật khẩu, mỗi tài khoản | 5 lần / 15 phút → tạm khóa đăng nhập mật khẩu |
  | Đăng ký, mỗi IP | 10 / giờ |
  | Gửi email (Magic Link, quên mật khẩu, gửi lại, đổi email) | 10 / giờ mỗi IP, 5 / giờ mỗi địa chỉ |
  | Nhập sai mã OTP, mỗi email | 5 / 15 phút |
  | Đổi mật khẩu/email ở trang tài khoản | 10 / 15 phút mỗi người dùng |

  Khi tài khoản bị tạm khóa mật khẩu, người dùng vẫn có thể dùng Google, Magic
  Link hoặc Quên mật khẩu.
- Cookie phiên: `HttpOnly`, `Secure` (production), `SameSite=Lax`. Refresh token
  không bao giờ lộ cho JavaScript; access token cấp cho trình duyệt chỉ sống ≈1 giờ.
- Đăng xuất: thu hồi phiên trên Supabase (`scope=local`) và xóa cookie; “Đăng
  xuất khỏi tất cả thiết bị” thu hồi mọi phiên. Đổi mật khẩu cũng đăng xuất các
  thiết bị khác.
- Chống open redirect: tham số `next` chỉ nhận đường dẫn nội bộ.
- CSRF: Server Actions được Next.js kiểm tra Origin; `/auth/google` tự kiểm tra
  Origin; OAuth dùng PKCE + `state`.
- Không liệt kê tài khoản qua Magic Link / Quên mật khẩu (luôn cùng một thông
  báo; Magic Link không tạo tài khoản mới). Riêng màn hình đăng ký báo “email đã
  được đăng ký” theo yêu cầu nghiệp vụ.
- Thông báo lỗi chỉ lấy từ danh sách mã đã biết; không hiển thị nội dung lỗi thô
  từ URL hay từ Supabase. Log không chứa email/mật khẩu.
- `/reset-password` chỉ đặt mật khẩu khi phiên được mở từ email (liên kết khôi
  phục, mã OTP) trong vòng 1 giờ; tài khoản chỉ có Google muốn tạo mật khẩu cần
  đã đăng nhập trong 24 giờ.
- HTTPS: bắt buộc khi triển khai (cookie `Secure`). Vercel bật sẵn.
- Phân quyền file/thư mục không đổi.

### Chính sách liên kết tài khoản / trùng email

| Tình huống | Kết quả |
|---|---|
| Email chưa tồn tại, đăng ký mật khẩu | Tạo tài khoản, chờ xác minh email |
| Email chưa tồn tại, Google | Tạo tài khoản mới, không cần mật khẩu |
| Tài khoản mật khẩu **đã xác minh** + đăng nhập Google cùng email (Google đã xác minh) | Supabase gắn Google vào **cùng tài khoản** (cả hai phía đã chứng minh sở hữu email) |
| Tài khoản mật khẩu **chưa xác minh** + chủ email đăng nhập Google | Gắn vào tài khoản đó và **xóa mật khẩu chưa xác minh** (chống chiếm đoạt trước) |
| Email Google **chưa xác minh** | Không bao giờ gắn vào tài khoản sẵn có |
| Đăng ký mật khẩu với email đã dùng Google | Báo “đã được đăng ký”; muốn thêm mật khẩu: đăng nhập Google → `/account` → Tạo mật khẩu, hoặc dùng Quên mật khẩu |
| Liên kết Google có email khác | Chỉ khi đang đăng nhập, từ `/account` → “Liên kết Google” |
| Google đã thuộc tài khoản khác | Từ chối (“đã được liên kết với một tài khoản khác”) |

Không có thao tác liên kết nào dựa trên email do trình duyệt gửi lên.

### Khôi phục tài khoản

- **Quên mật khẩu**: `/forgot-password` → liên kết qua email → `/reset-password`.
- **Đổi email** (còn truy cập email cũ): `/account` → Đổi email (xác nhận cả hai địa chỉ).
- **Mất quyền truy cập email**: nếu còn đăng nhập được (Google đã liên kết, hoặc
  phiên còn hiệu lực) thì vẫn vào được ứng dụng. Nếu không, quản trị viên:
  1. xác minh danh tính người dùng qua kênh khác (ví dụ thông tin hợp đồng/nhân sự);
  2. Supabase Dashboard → Authentication → Users → chọn người dùng → cập nhật
     email sang địa chỉ mới (trigger tự đồng bộ `user_profiles`, quyền chia sẻ giữ nguyên
     vì gắn với user id);
  3. người dùng dùng “Quên mật khẩu” với email mới;
  4. ghi lại thao tác vào nhật ký nội bộ.

---

## 8. Kiểm thử

### Tự động trong repo

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

`src/lib/__tests__/auth.test.ts` kiểm tra: chuẩn hóa/kiểm tra email, chính sách
mật khẩu, chống open redirect, thuộc tính cookie, ánh xạ lỗi, rate limiter, thông
báo sau chuyển hướng, kiểm tra `amr`.

### End-to-end (đã chạy khi phát triển)

Chạy trên Chromium thật với **Supabase Auth (GoTrue v2.180) thật**, PostgREST,
PostgreSQL 16 đã áp dụng toàn bộ migration của repo, SMTP giả lập và một máy chủ
OAuth giả lập thay cho Google. Toàn bộ 34 kịch bản đạt ở cả hai chế độ mẫu email
(mặc định PKCE và `token_hash`):

| # | Kịch bản |
|---|---|
| 1 | Đăng ký bằng Gmail (email viết hoa/khoảng trắng được chuẩn hóa), xác minh qua liên kết |
| 2 | Đăng ký bằng email không phải Gmail, xác minh bằng mã 6 số |
| 3 | Đăng ký email đã tồn tại → báo lỗi, không tạo trùng, không gửi email; kiểm tra định dạng / độ mạnh / xác nhận mật khẩu |
| 4 | Đăng nhập email + mật khẩu; cookie HttpOnly/Secure/SameSite=Lax, 30 ngày; JS không đọc được phiên |
| 5 | Google lần đầu (tạo tài khoản, chỉ scope `openid email profile`), các lần sau (cùng tài khoản), hủy ở Google |
| 6 | Ghi nhớ đăng nhập → mở lại trình duyệt vẫn vào thẳng; không ghi nhớ → cookie phiên; access token hết hạn → proxy làm mới, xoay vòng refresh token |
| 7 | Đăng xuất → xóa cookie, phiên bị xóa trên Supabase, phát lại cookie cũ không vào được |
| 8 | Quên mật khẩu → đặt lại; email chưa đăng ký nhận cùng thông báo và không có email; Magic Link; Magic Link với email lạ không tạo tài khoản; phiên thường không vào được `/reset-password` |
| 9 | Trùng email mật khẩu + Google → cùng tài khoản; chống chiếm đoạt trước; đăng ký mật khẩu với email Google bị từ chối; Google chưa xác minh không được gắn; liên kết / hủy liên kết thủ công; Google của người khác bị từ chối; tài khoản Google tạo mật khẩu |
| 10 | Người dùng B không xem / ghi / chia sẻ được thư mục riêng của A; A chia sẻ (bằng email) → B xem được nhưng vẫn không ghi được; người chưa đăng nhập không thấy gì |
| 11 | 5 lần sai mật khẩu → khóa tạm thời, khóa đếm được băm |
| 12 | `next=https://evil...` / `//evil` bị bỏ qua |
| 13 | Đổi mật khẩu ở `/account` (sai mật khẩu hiện tại bị từ chối) → thiết bị khác bị đăng xuất; đăng xuất mọi thiết bị |
| 14 | Đổi email (xác nhận hai chiều) → `user_profiles` đồng bộ |
| 15–18 | `/setup` vẫn hoạt động; trang Related users cũ hoạt động với client mới; liên kết mở trên trình duyệt khác; phiên bị thu hồi khi đang mở trang → về đăng nhập với thông báo hết hạn |

Ngoài ra migration đã được chạy trên database có dữ liệu “lệch” (email đổi
nhưng profile cũ, thiếu profile, email viết hoa) và trên database trống; chạy
lại lần hai không lỗi.

Danh sách kiểm tra thủ công khi triển khai thật (cần Google/SMTP thật):

1. Đăng ký bằng Gmail và một email khác (ví dụ Outlook / email công ty) → nhận email, xác minh.
2. “Tiếp tục với Google” lần đầu và lần sau; thử với email đã đăng ký bằng mật khẩu.
3. Đóng/mở lại trình duyệt khi có và không có “Ghi nhớ đăng nhập”.
4. Đăng xuất, bấm Back → không xem lại được dữ liệu.
5. Quên mật khẩu, Magic Link, mở liên kết trên điện thoại.
6. Đăng nhập tài khoản B, thử mở link thư mục của tài khoản A.
