import { invoke } from "@tauri-apps/api/core";

export async function createLibrary(path: string): Promise<string> {
  return invoke<string>("initialize_library", { path });
}

export interface LibraryValidation {
  valid: boolean;
  path: string | null;
  reason: string | null;
}

export async function openConfiguredLibrary(): Promise<LibraryValidation> {
  return invoke<LibraryValidation>(
    "open_configured_library",
  );
}

export async function getMediaCount(): Promise<number> {
  return invoke<number>("get_media_count");
}