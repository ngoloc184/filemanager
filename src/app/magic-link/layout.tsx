import type { Metadata } from "next";

export const metadata: Metadata = { title: "Đăng nhập bằng liên kết email" };

export default function Layout({ children }: LayoutProps<"/magic-link">) {
  return children;
}
