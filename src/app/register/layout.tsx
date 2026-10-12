import type { Metadata } from "next";

export const metadata: Metadata = { title: "Tạo tài khoản" };

export default function Layout({ children }: LayoutProps<"/register">) {
  return children;
}
