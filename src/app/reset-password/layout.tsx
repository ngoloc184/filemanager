import type { Metadata } from "next";

export const metadata: Metadata = { title: "Đặt mật khẩu mới" };

export default function Layout({ children }: LayoutProps<"/reset-password">) {
  return children;
}
