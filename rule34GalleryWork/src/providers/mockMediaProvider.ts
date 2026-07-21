import { mockMedia } from "@/lib/mockMedia";
import type { MediaPage } from "@/types/media";
import type { MediaProvider } from "./mediaProvider";

export class MockMediaProvider implements MediaProvider {
  async listMedia(_search="", _addedFrom="", _addedTo="", offset=0, limit=80): Promise<MediaPage> {
    return { items: mockMedia.slice(offset, offset + limit), total: mockMedia.length, offset, limit };
  }
}
