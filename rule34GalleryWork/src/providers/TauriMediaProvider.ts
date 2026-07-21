import { listMedia } from "@/tauri/mediaApi";
import type { MediaPage } from "@/types/media";
import type { MediaProvider } from "./mediaProvider";

export class TauriMediaProvider implements MediaProvider {
  async listMedia(search="", addedFrom="", addedTo="", offset=0, limit=80): Promise<MediaPage> {
    return listMedia(search, addedFrom, addedTo, offset, limit);
  }
}
