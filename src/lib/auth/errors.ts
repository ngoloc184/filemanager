// Maps Supabase Auth failures to short, user-facing Vietnamese messages.
// Raw provider messages are never shown: they can leak details (or be in
// English), and URLs can carry attacker-chosen `error_description` text.

const MESSAGES: Record<string, string> = {
  invalid_credentials: "Email hoặc mật khẩu không đúng.",
  email_not_confirmed:
    "Email chưa được xác minh. Hãy mở liên kết trong email hoặc gửi lại email xác minh.",
  user_already_exists:
    "Email này đã được đăng ký. Hãy đăng nhập, hoặc dùng “Quên mật khẩu” nếu bạn không nhớ mật khẩu.",
  email_exists:
    "Email này đã được đăng ký. Hãy đăng nhập, hoặc dùng “Quên mật khẩu” nếu bạn không nhớ mật khẩu.",
  weak_password:
    "Mật khẩu chưa đủ mạnh. Hãy dùng ít nhất 8 ký tự gồm chữ thường, chữ hoa và chữ số.",
  same_password: "Mật khẩu mới phải khác mật khẩu hiện tại.",
  over_request_rate_limit: "Bạn thao tác quá nhanh. Vui lòng đợi một lát rồi thử lại.",
  over_email_send_rate_limit:
    "Đã gửi quá nhiều email. Vui lòng đợi một lát trước khi yêu cầu email mới.",
  signup_disabled: "Đăng ký tài khoản mới đang tạm tắt.",
  email_provider_disabled: "Đăng nhập bằng email đang tạm tắt.",
  otp_expired: "Mã hoặc liên kết không đúng hoặc đã hết hạn. Hãy yêu cầu mã mới.",
  link_invalid:
    "Liên kết đã hết hạn, đã được dùng, hoặc được mở trên trình duyệt khác. Nếu bạn vừa xác minh email, hãy đăng nhập.",
  flow_state_not_found:
    "Liên kết đã hết hạn, đã được dùng, hoặc được mở trên trình duyệt khác. Nếu bạn vừa xác minh email, hãy đăng nhập.",
  flow_state_expired:
    "Liên kết đã hết hạn, đã được dùng, hoặc được mở trên trình duyệt khác. Nếu bạn vừa xác minh email, hãy đăng nhập.",
  bad_code_verifier:
    "Liên kết đã hết hạn, đã được dùng, hoặc được mở trên trình duyệt khác. Nếu bạn vừa xác minh email, hãy đăng nhập.",
  access_denied: "Bạn đã hủy đăng nhập với Google.",
  bad_oauth_state: "Phiên đăng nhập Google không hợp lệ. Vui lòng thử lại.",
  bad_oauth_callback: "Phiên đăng nhập Google không hợp lệ. Vui lòng thử lại.",
  oauth_unavailable: "Không thể kết nối tới Google lúc này. Vui lòng thử lại.",
  provider_disabled: "Đăng nhập bằng Google chưa được bật.",
  oauth_provider_not_supported: "Đăng nhập bằng Google chưa được bật.",
  provider_email_needs_verification:
    "Email của tài khoản Google chưa được xác minh. Hãy kiểm tra hộp thư để xác nhận rồi thử lại.",
  identity_already_exists: "Tài khoản Google này đã được liên kết với một tài khoản khác.",
  manual_linking_disabled:
    "Liên kết tài khoản chưa được bật trên máy chủ xác thực. Vui lòng liên hệ quản trị viên.",
  single_identity_not_deletable:
    "Không thể hủy liên kết phương thức đăng nhập duy nhất của tài khoản.",
  email_conflict_identity_not_deletable:
    "Không thể hủy liên kết vì email của tài khoản đang gắn với phương thức này.",
  identity_not_found: "Không tìm thấy phương thức đăng nhập này.",
  reauthentication_needed:
    "Vì lý do bảo mật, hãy đăng xuất rồi đăng nhập lại trước khi đổi mật khẩu.",
  reauthentication_not_valid:
    "Vì lý do bảo mật, hãy đăng xuất rồi đăng nhập lại trước khi đổi mật khẩu.",
  recovery_required:
    "Liên kết đặt lại mật khẩu đã hết hạn hoặc không hợp lệ. Hãy yêu cầu liên kết mới, hoặc đổi mật khẩu trong trang Tài khoản (cần mật khẩu hiện tại).",
  user_banned: "Tài khoản đã bị khóa. Vui lòng liên hệ quản trị viên.",
  user_not_found: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
  session_not_found: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
  session_expired: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
  refresh_token_not_found: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
  refresh_token_already_used: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
  not_authenticated: "Bạn cần đăng nhập để tiếp tục.",
  email_address_invalid: "Địa chỉ email không hợp lệ.",
  email_address_not_authorized:
    "Máy chủ chưa được cấu hình để gửi email tới địa chỉ này. Vui lòng liên hệ quản trị viên.",
  captcha_failed: "Xác minh chống spam thất bại. Vui lòng thử lại.",
  validation_failed: "Thông tin chưa hợp lệ. Vui lòng kiểm tra lại.",
  rate_limited: "Bạn đã thử quá nhiều lần. Vui lòng thử lại sau.",
  network: "Không kết nối được máy chủ xác thực. Vui lòng thử lại.",
};

export const GENERIC_AUTH_ERROR = "Đã có lỗi xảy ra. Vui lòng thử lại.";

/** Older Supabase Auth responses carry no `code`; recognise them by message. */
const LEGACY_MESSAGES: [RegExp, string][] = [
  [/invalid login credentials/i, "invalid_credentials"],
  [/email not confirmed/i, "email_not_confirmed"],
  [/user already registered/i, "user_already_exists"],
  [/rate limit/i, "over_request_rate_limit"],
  [/signups not allowed/i, "signup_disabled"],
];

/** Extracts a stable code from a Supabase AuthError (or similar) value. */
export function authErrorCode(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error !== "object" || error === null) return "unknown";

  const { code, status, message, name } = error as {
    code?: unknown;
    status?: unknown;
    message?: unknown;
    name?: unknown;
  };
  if (typeof code === "string" && code) return code;
  if (name === "AuthRetryableFetchError" || status === 0) return "network";
  if (typeof message === "string") {
    for (const [pattern, mapped] of LEGACY_MESSAGES) {
      if (pattern.test(message)) return mapped;
    }
  }
  if (status === 429) return "over_request_rate_limit";
  return "unknown";
}

/** Whether `code` has a dedicated message (used to whitelist `?error=` values). */
export function isKnownAuthErrorCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(MESSAGES, code);
}

export function authErrorMessage(errorOrCode: unknown, fallback = GENERIC_AUTH_ERROR): string {
  const code = authErrorCode(errorOrCode);
  return isKnownAuthErrorCode(code) ? MESSAGES[code] : fallback;
}

/** "Thử lại sau N phút/giây" for throttled requests. */
export function retryAfterMessage(seconds: number): string {
  if (seconds >= 90) {
    return `Bạn đã thử quá nhiều lần. Vui lòng thử lại sau ${Math.ceil(seconds / 60)} phút.`;
  }
  return `Bạn đã thử quá nhiều lần. Vui lòng thử lại sau ${Math.max(1, Math.ceil(seconds))} giây.`;
}
