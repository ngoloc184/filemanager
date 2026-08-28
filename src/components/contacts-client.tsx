"use client";

import { useState } from "react";
import { UserPlus, UsersRound, Trash2 } from "lucide-react";
import { toast } from "react-hot-toast";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type RelatedUser = { id: string; email: string; created_at?: string };

export default function ContactsClient({ initialUsers }: { initialUsers: RelatedUser[] }) {
  const [relatedUsers, setRelatedUsers] = useState<RelatedUser[]>(initialUsers);
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const supabase = createClient();

  const addUser = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    const { data, error } = await supabase.rpc("add_related_user", { related_email: email });
    setLoading(false);
    if (error) return toast.error(error.message);
    const addedUser = data?.[0] as RelatedUser | undefined;
    if (addedUser && !relatedUsers.some((user) => user.id === addedUser.id)) {
      setRelatedUsers((users) => [...users, addedUser].sort((a, b) => a.email.localeCompare(b.email)));
    }
    setEmail("");
    toast.success("Related user added");
  };

  const removeUser = async (user: RelatedUser) => {
    const { error } = await supabase.rpc("remove_related_user", { user_id: user.id });
    if (error) return toast.error(error.message);
    setRelatedUsers((users) => users.filter((item) => item.id !== user.id));
    toast.success("Related user removed");
  };

  return <div className="max-w-2xl space-y-6">
    <div><h2 className="text-2xl font-bold">Related users</h2><p className="text-muted-foreground mt-1">These users can view your private files. Public files are visible to every signed-in user.</p></div>
    <Card><CardHeader><CardTitle>Add a related user</CardTitle><CardDescription>Enter the email address they used to register.</CardDescription></CardHeader><CardContent>
      <form onSubmit={addUser} className="flex gap-2"><Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="user@example.com" required /><Button disabled={loading}><UserPlus className="h-4 w-4 mr-2" />{loading ? "Adding..." : "Add"}</Button></form>
    </CardContent></Card>
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><UsersRound className="h-5 w-5" />Your related users</CardTitle></CardHeader><CardContent>
      {relatedUsers.length === 0 ? <p className="text-sm text-muted-foreground">No related users yet.</p> : <div className="divide-y">{relatedUsers.map((user) => <div key={user.id} className="flex items-center justify-between py-3 first:pt-0 last:pb-0"><span className="text-sm">{user.email}</span><Button variant="ghost" size="sm" className="text-destructive" onClick={() => removeUser(user)}><Trash2 className="h-4 w-4 mr-2" />Remove</Button></div>)}</div>}
    </CardContent></Card>
  </div>;
}
