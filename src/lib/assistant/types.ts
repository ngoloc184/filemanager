// Shapes exchanged between the chat API and the chatbox UI.

import type { ConversationContext } from "./context.ts";
import type { Comparison } from "./compare.ts";
import type { PendingAction } from "./actions.ts";
import type { MemoryItem, MemoryInput } from "./memory.ts";
import type { Confidence } from "./retrieval.ts";

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

export type AssistantCitation = {
  n: number;
  fileId: string;
  fileName: string;
  page: number | null;
  heading: string | null;
  text: string;
  openUrl: string;
  suspicious: boolean;
};

export type AssistantAnswer = {
  /** "answer": a question; "topic": what the documents say about a topic */
  mode: "answer" | "topic";
  question: string;
  /** Local answer: only quotes and values copied from the sources. */
  text: string;
  citations: AssistantCitation[];
  confidence: Confidence;
  conflicts: { topic: string; values: { raw: string; citation: number; fileName: string }[] }[];
  /** Optional model synthesis, clearly separated from the quoted facts. */
  inference: string | null;
  scope: "context" | "all";
};

export type AssistantChoice = { fileId: string; label: string };

export type AssistantStep = { label: string; detail?: string };

export type AssistantMeta = {
  method: string;
  resultCount: number;
  grounded: boolean | null;
  confidence: Confidence | null;
  llmCalls: number;
  tokensEst: number;
  tuningVersion: string;
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
  answer?: AssistantAnswer;
  comparison?: Comparison;
  /** A write operation waiting for the user's confirmation. */
  action?: PendingAction | null;
  /** Something worth remembering; saved only if the user confirms. */
  memoryProposal?: (MemoryInput & { label: string }) | null;
  memories?: MemoryItem[];
  /** Ask the user which file they meant. */
  choices?: AssistantChoice[];
  steps?: AssistantStep[];
  /** Conversation state to send back with the next question. */
  context?: ConversationContext;
  meta?: AssistantMeta;
  /** Id of the logged event, used for feedback. */
  replyId?: string | null;
};

export type AssistantRequest = {
  message: string;
  page?: number;
  /** Explicit file chosen in the UI ("Tóm tắt" on a result card). */
  contextFileId?: string | null;
  /** Conversation state returned with the previous answer (re-validated). */
  context?: unknown;
};
