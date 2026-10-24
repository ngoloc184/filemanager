"use client";

// "Your profile": display name and profile picture, shown in chats.

import { useEffect, useRef, useState } from "react";
import { Camera, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { UserAvatar } from "@/components/chat/user-avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  removePublicImage,
  setMyProfileLocal,
  updateMyProfile,
  uploadPublicImage,
  useMyProfile,
} from "@/lib/services/profile";
import { getErrorMessage } from "@/lib/types/database";

export function ProfileDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const profile = useMyProfile();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* remount per opening: the form starts from the saved profile */}
        {open && profile ? (
          <ProfileForm key={`${profile.display_name}|${profile.avatar_path}`} onDone={() => onOpenChange(false)} />
        ) : (
          <div className="flex h-40 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ProfileForm({ onDone }: { onDone: () => void }) {
  const profile = useMyProfile()!;
  const [name, setName] = useState(profile.display_name ?? "");
  const [avatar, setAvatar] = useState<string | null>(profile.avatar_path);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  // pictures uploaded in this dialog but not kept
  const uploaded = useRef<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  // closed without saving: remove the pictures uploaded meanwhile
  useEffect(
    () => () => {
      for (const path of uploaded.current) void removePublicImage(path);
    },
    []
  );

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const path = await uploadPublicImage(`users/${profile.id}`, file, 512);
      uploaded.current.push(path);
      setAvatar(path);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const displayName = name.trim() || null;
      await updateMyProfile(displayName, avatar);
      // clean up pictures that are no longer used, before the form remounts
      // (its unmount cleanup removes unsaved uploads)
      for (const path of [profile.avatar_path, ...uploaded.current]) if (path && path !== avatar) void removePublicImage(path);
      uploaded.current = [];
      setMyProfileLocal({ ...profile, display_name: displayName, avatar_path: avatar });
      toast.success("Profile saved");
      onDone();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} className="space-y-5">
      <DialogHeader>
        <DialogTitle>Your profile</DialogTitle>
        <DialogDescription>Your name and picture are shown to the people you chat with.</DialogDescription>
      </DialogHeader>

      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="group relative rounded-full focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          aria-label="Change profile picture"
        >
          <UserAvatar name={name || profile.email} path={avatar} size="lg" />
          <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            {uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Camera className="h-5 w-5" />}
          </span>
        </button>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
              <Camera className="h-3.5 w-3.5" />
              {avatar ? "Change picture" : "Add a picture"}
            </Button>
            {avatar && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setAvatar(null)} disabled={uploading}>
                <Trash2 className="h-3.5 w-3.5" />
                Remove
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">JPG, PNG, WebP or GIF, up to 5 MB.</p>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            void pick(file);
          }}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="display-name">Display name</Label>
        <Input id="display-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={profile.email} className="h-10" />
        <p className="text-xs text-muted-foreground">Leave empty to show your e-mail address ({profile.email}).</p>
      </div>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="brand" disabled={saving || uploading}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
