import { open } from "@tauri-apps/plugin-dialog";

export async function chooseFolder(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Choose Library Folder",
  });

  if (!selected) {
    return null;
  }

  return selected as string;
}

export async function chooseMediaFiles(): Promise<string[]> {
  const selected = await open({
    directory: false,
    multiple: true,
    title: "Import Media",
    filters: [
      {
        name: "Images and videos",
        extensions: [
          "jpg",
          "jpeg",
          "png",
          "gif",
          "webp",
          "bmp",
          "mp4",
          "webm",
          "mov",
          "mkv",
        ],
      },
    ],
  });

  if (!selected) {
    return [];
  }

  return Array.isArray(selected)
    ? selected
    : [selected];
}