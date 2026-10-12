import Link from "next/link";
import { AuroraBackground } from "@/components/brand/aurora-background";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center px-4 text-center">
      <AuroraBackground />
      <Logo className="mb-10" />
      <p className="text-brand text-7xl font-bold tracking-tighter sm:text-8xl">404</p>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Page not found</h1>
      <p className="mt-2 max-w-sm text-muted-foreground">
        The page you are looking for does not exist or has been moved.
      </p>
      <Button variant="brand" className="mt-8 h-10 px-5" render={<Link href="/" />}>
        Back to home
      </Button>
    </div>
  );
}
