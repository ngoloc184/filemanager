export type ShareRole = "viewer" | "editor" | "admin" | "owner";

export type Folder = {
  id: string;
  parent_id: string | null;
  owner_id: string;
  name: string;
  comment: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
  legacy_batch_id: string | null;
};

export type FileRow = {
  id: string;
  folder_id: string | null;
  owner_id: string;
  name: string;
  original_name: string;
  extension: string;
  mime_type: string;
  size: number;
  checksum: string | null;
  current_version_id: string | null;
  is_public: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
  legacy_file_id: string | null;
};

export type FileVersion = {
  id: string;
  file_id: string;
  version_no: number;
  storage_path: string;
  size: number;
  mime_type: string;
  checksum: string | null;
  uploaded_by: string;
  created_at: string;
};

export type FolderAncestor = {
  id: string;
  name: string;
  parent_id: string | null;
};

export function getErrorMessage(err: unknown): string {
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return "Something went wrong";
}
