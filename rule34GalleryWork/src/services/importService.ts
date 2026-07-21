import { chooseMediaFiles } from "@/tauri/dialogueApi";

import {
  importMediaFiles,
  type ImportMediaResult,
} from "@/tauri/mediaApi";

export async function selectAndImportMedia():
  Promise<ImportMediaResult | null> {
  const paths = await chooseMediaFiles();

  if (paths.length === 0) {
    return null;
  }

  return importMediaFiles(paths);
}