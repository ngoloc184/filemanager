import type { Metadata } from "next";

export const metadata: Metadata = { title: "Đăng nhập" };

export default function Layout({ children }: LayoutProps<"/login">) {
  return children;
}
