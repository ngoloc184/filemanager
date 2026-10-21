"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthShell } from "@/components/auth/auth-shell";
import { toast } from "sonner";
import { UserPlus, ArrowLeft } from "lucide-react";
import Link from "next/link";

export default function SetupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleCreateAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    const { data, error } = await createClient().auth.signUp({
      email,
      password,
      options: {
        data: {
          role: "admin",
        },
      },
    });

    if (error) {
      toast.error(error.message);
      setLoading(false);
      return;
    }

    if (data.session) {
      // e-mail confirmation is off on the server: already signed in
      toast.success("Admin account created!");
      router.push("/dashboard");
      router.refresh();
      return;
    }
    toast.success("Admin account created! Enter the code we e-mailed to confirm it.");
    // confirm the address with the e-mailed code
    router.push(`/register?verify=${encodeURIComponent(email.trim())}`);
  };

  return (
    <AuthShell
      icon={<UserPlus className="h-5 w-5" />}
      title="Create admin"
      description="Set up the initial admin account"
      footer={
        <Link
          href="/login"
          className="inline-flex items-center gap-1 hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" />
          Back to sign in
        </Link>
      }
    >
      <form onSubmit={handleCreateAdmin} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            placeholder="admin@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="h-10"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            className="h-10"
          />
        </div>
        <Button type="submit" variant="brand" className="h-10 w-full" disabled={loading}>
          {loading ? "Creating..." : "Create admin account"}
        </Button>
      </form>
    </AuthShell>
  );
}
