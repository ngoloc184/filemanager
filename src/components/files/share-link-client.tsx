"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "react-hot-toast";
import { Download, Eye, FileText, Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  accessShareLink,
  inspectShareLink,
  type SharedFileAccess,
} from "@/lib/services/sharing";
import { downloadFile } from "@/lib/services/files";
import { getErrorMessage } from "@/lib/types/database";
import { formatBytes } from "@/lib/utils";
import { PreviewDialog } from "@/components/files/file-dialogs";

type Stage = "loading" | "password" | "ready" | "error";

export default function ShareLinkClient({ token }: { token: string }) {
  const [stage, setStage] = useState<Stage>("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [access, setAccess] = useState<SharedFileAccess | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const unlock = useCallback(
    async (pw?: string) => {
      const result = await accessShareLink(token, pw);
      setAccess(result);
      setStage("ready");
    },
    [token]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await inspectShareLink(token);
        if (cancelled) return;
        if (!info) {
          setErrorMessage("This share link is no longer available.");
          setStage("error");
          return;
        }
        if (!info.active) {
          setErrorMessage("This share link has been disabled or expired.");
          setStage("error");
          return;
        }
        if (info.requires_password) {
          setStage("password");
          return;
        }
        try {
          await unlock();
        } catch (err) {
          if (!cancelled) {
            setErrorMessage(getErrorMessage(err));
            setStage("error");
          }
        }
      } catch (err) {
        if (!cancelled) {
          setErrorMessage(getErrorMessage(err));
          setStage("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, unlock]);

  const submitPassword = async () => {
    if (!password || submitting) return;
    setSubmitting(true);
    try {
      await unlock(password);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDownload = async () => {
    if (!access) return;
    try {
      await downloadFile({
        id: access.file_id,
        name: access.name,
        current_version_id: access.current_version_id,
      });
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100 px-4">
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="text-center space-y-2">
          <div className="mx-auto w-12 h-12 bg-primary rounded-xl flex items-center justify-center">
            {stage === "password" ? (
              <Lock className="h-6 w-6 text-primary-foreground" />
            ) : (
              <FileText className="h-6 w-6 text-primary-foreground" />
            )}
          </div>
          <CardTitle className="text-xl font-bold">Shared file</CardTitle>
          <CardDescription>
            {stage === "ready" && access
              ? `${access.name} • ${formatBytes(access.size)}`
              : "This file has been shared with you"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {stage === "loading" && (
            <div className="flex justify-center py-6">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}

          {stage === "error" && (
            <p className="text-sm text-destructive text-center py-4">{errorMessage}</p>
          )}

          {stage === "password" && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground text-center">
                This link is protected with a password.
              </p>
              <Input
                type="password"
                placeholder="Enter password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitPassword();
                }}
                autoFocus
              />
              <Button
                className="w-full"
                onClick={() => void submitPassword()}
                disabled={!password || submitting}
              >
                {submitting ? "Unlocking..." : "Unlock"}
              </Button>
            </div>
          )}

          {stage === "ready" && access && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground text-center">
                {access.mime_type}
                {!access.allow_download && " • view only"}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => setPreviewOpen(true)}>
                  <Eye className="h-4 w-4 mr-2" />
                  Preview
                </Button>
                {access.allow_download && (
                  <Button className="flex-1" onClick={() => void handleDownload()}>
                    <Download className="h-4 w-4 mr-2" />
                    Download
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground text-center">
                Access is granted for 15 minutes.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {access && (
        <PreviewDialog
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          file={{
            id: access.file_id,
            name: access.name,
            current_version_id: access.current_version_id,
            mime_type: access.mime_type,
            size: access.size,
          }}
        />
      )}
    </div>
  );
}
