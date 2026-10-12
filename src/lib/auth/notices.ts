import { authErrorMessage, isKnownAuthErrorCode } from "./errors.ts";

// Banners shown on the sign-in page after a redirect (`?reason=`, `?error=`,
// `?message=`). Only whitelisted codes are turned into text, so a crafted URL
// cannot display arbitrary content.

export type Notice = { tone: "error" | "success" | "info"; message: string };

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const MESSAGES: Record<string, Notice> = {
  email_confirmed: { tone: "success", message: "Email đã được xác minh. Hãy đăng nhập để tiếp tục." },
  signed_out: { tone: "success", message: "Bạn đã đăng xuất." },
  signed_out_everywhere: {
    tone: "success",
    message: "Bạn đã đăng xuất khỏi tất cả thiết bị.",
  },
};

export function loginNotice(params: SearchParams): Notice | null {
  const error = first(params.error);
  if (error) {
    return {
      tone: "error",
      message: authErrorMessage(isKnownAuthErrorCode(error) ? error : "link_invalid"),
    };
  }
  if (first(params.reason) === "expired") {
    return { tone: "info", message: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại." };
  }
  const message = first(params.message);
  return message && MESSAGES[message] ? MESSAGES[message] : null;
}

export function accountNotice(params: SearchParams): Notice | null {
  const error = first(params.error);
  if (error) {
    return {
      tone: "error",
      message: authErrorMessage(isKnownAuthErrorCode(error) ? error : "oauth_unavailable"),
    };
  }
  if (first(params.linked) === "google") {
    return { tone: "success", message: "Đã liên kết tài khoản Google. Bạn có thể đăng nhập bằng Google từ giờ." };
  }
  const email = first(params.email);
  if (email === "updated") return { tone: "success", message: "Email đăng nhập đã được cập nhật." };
  if (email === "pending") {
    return {
      tone: "info",
      message: "Đã xác nhận một địa chỉ. Hãy mở liên kết xác nhận trong email còn lại để hoàn tất đổi email.",
    };
  }
  return null;
}

export function firstParam(value: string | string[] | undefined): string | undefined {
  return first(value);
}
