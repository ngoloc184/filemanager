// Shapes exchanged between the chat API and the chatbox UI.

export type FileAccess = "owner" | "shared" | "public" | "link";

export type AssistantFile = {
  id: string;
  name: string;
  extension: string;
  mimeType: string;
  size: number;
  folderId: string | null;
  folderName: string | null;
  access: FileAccess;
  /** Owner e-mail, only for files shared with the user. */
  sharedBy: string | null;
  updatedAt: string;
  /** Excerpt from the file's text when it matched by content. */
  snippet: string | null;
  openUrl: string;
};

export type AssistantShare = {
  type: "file" | "folder";
  id: string;
  name: string;
  granteeEmail: string;
  role: string;
  sharedAt: string;
  openUrl: string;
};

export type AssistantStats = {
  ownedFiles: number;
  ownedBytes: number;
  ownedFolders: number;
  sharedFiles: number;
  publicFiles: number;
  indexableFiles: number;
  indexedFiles: number;
  lastUpload: string | null;
  topExtensions: { extension: string; count: number }[];
};

export type AssistantSummary = {
  fileId: string;
  fileName: string;
  points: string[];
  keywords: string[];
  engine: "local" | "llm";
  openUrl: string;
};

export type AssistantReply = {
  intent: string;
  text: string;
  files?: AssistantFile[];
  total?: number;
  page?: number;
  hasMore?: boolean;
  shares?: AssistantShare[];
  stats?: AssistantStats;
  summary?: AssistantSummary;
  suggestions?: string[];
  notices?: string[];
  /** "llm" only when an optional language model produced part of the answer. */
  engine: "local" | "llm";
  /** File that "this file" refers to in the next question. */
  contextFileId?: string | null;
  /** Offer to index files whose content is not searchable yet. */
  canIndex?: boolean;
};

export type AssistantRequest = {
  message: string;
  page?: number;
  contextFileId?: string | null;
};
