
import { chooseFolder } from "@/tauri/dialogueApi";
import { createLibrary } from "@/tauri/libraryApi";


export const settingsService = {
  async getLibraryPath(): Promise<string | null> {
    return null;
  },

  async setLibraryPath(path: string): Promise<void> {
    // Later: invoke("set_library_path")
  },
};

export async function initializeLibrary(): Promise<string | null> {
  const selectedFolder = await chooseFolder();

  if (!selectedFolder) {
    return null;
  }

  return createLibrary(selectedFolder);
}