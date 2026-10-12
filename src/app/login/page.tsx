import { LoginForm } from "@/components/auth/login-form";
import { loginNotice, firstParam } from "@/lib/auth/notices";
import { safeNextPath } from "@/lib/auth/redirect";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  return (
    <LoginForm
      next={safeNextPath(firstParam(params.next))}
      notice={loginNotice(params)}
    />
  );
}
