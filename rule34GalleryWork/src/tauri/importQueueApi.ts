import { invoke } from "@tauri-apps/api/core";

export interface ImportJob {
  id: number;
  url: string;
  status: "queued" | "fetching" | "downloading" | "completed" | "failed";
  message: string | null;
}

export function listImportQueue() {
  return invoke<ImportJob[]>("list_import_queue");
}
