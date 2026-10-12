import type { Metadata } from "next";

export const metadata: Metadata = { title: "Sign in" };

export default function Layout({ children }: LayoutProps<"/login">) {
  return children;
}
