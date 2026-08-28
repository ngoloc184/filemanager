"use client";

import { useState } from "react";
import { UserPlus, UsersRound, Trash2 } from "lucide-react";
import { toast } from "react-hot-toast";
import { createClient } from "@/lib/supabase/client";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type RelatedUser = { id: string; email: string; created_at?: string };

export default function ContactsClient({ initialUsers }: { initialUsers: RelatedUser[] }) {
  const [relatedUsers, setRelatedUsers] = useState<RelatedUser[]>(initialUsers);
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const supabase = createClient();

  const addUser = async (event?: React.FormEvent | React.MouseEvent) => {
    event?.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) {
      toast.error("Please enter an email address");
      return;
    }
    // basic email validation – let DB do final check but give fast feedback
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      toast.error("Invalid email format");
      return;
    }
    if (loading) return;
    setLoading(true);
    try {
      const { data, error } = await supabase.rpc("add_related_user", { related_email: trimmed });
      if (error) {
        console.error("add_related_user error:", error);
        toast.error(error.message);
        return;
      }
      const addedUser = (data as RelatedUser[] | null)?.[0] as RelatedUser | undefined;
      if (addedUser && !relatedUsers.some((user) => user.id === addedUser.id)) {
        setRelatedUsers((users) => [...users, addedUser].sort((a, b) => a.email.localeCompare(b.email)));
      } else if (!addedUser) {
        // RPC succeeded but returned empty (should not happen) – refresh list
        console.warn("add_related_user returned empty data:", data);
      }
      setEmail("");
      toast.success("Related user added");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to add related user";
      console.error(err);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const removeUser = async (user: RelatedUser) => {
    const { error } = await supabase.rpc("remove_related_user", { user_id: user.id });
    if (error) {
      console.error("remove_related_user error:", error);
      return toast.error(error.message);
    }
    setRelatedUsers((users) => users.filter((item) => item.id !== user.id));
    toast.success("Related user removed");
  };

  return <div className="max-w-2xl space-y-6">
    <div><h2 className="text-2xl font-bold">Related users</h2><p className="text-muted-foreground mt-1">These users can view your private files. Public files are visible to every signed-in user.</p></div>
    <Card><CardHeader><CardTitle>Add a related user</CardTitle><CardDescription>Enter the email address they used to register.</CardDescription></CardHeader><CardContent>
      <form onSubmit={addUser} className="flex gap-2" noValidate>
        <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="user@example.com" required />
        {/* Use native <button> with buttonVariants to guarantee type="submit" is not overridden by Base UI's default type="button" (see src/components/ui/button.tsx:7 and node_modules/@base-ui/react/internals/use-button/useButton.js:183) */}
        <button
          type="submit"
          disabled={loading}
          onClick={addUser}
          className={cn(buttonVariants({}), "shrink-0")}
        >
          <UserPlus className="h-4 w-4 mr-2" />{loading ? "Adding..." : "Add"}
        </button>
      </form>
    </CardContent></Card>
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><UsersRound className="h-5 w-5" />Your related users</CardTitle></CardHeader><CardContent>
      {relatedUsers.length === 0 ? <p className="text-sm text-muted-foreground">No related users yet.</p> : <div className="divide-y">{relatedUsers.map((user) => <div key={user.id} className="flex items-center justify-between py-3 first:pt-0 last:pb-0"><span className="text-sm">{user.email}</span><Button variant="ghost" size="sm" className="text-destructive" onClick={() => removeUser(user)}><Trash2 className="h-4 w-4 mr-2" />Remove</Button></div>)}</div>}
    </CardContent></Card>
  </div>;
}
