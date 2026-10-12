import type { Metadata } from "next";

export const metadata: Metadata = { title: "Quên mật khẩu" };

export default function Layout({ children }: LayoutProps<"/forgot-password">) {
  return children;
}
