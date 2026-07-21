import { MockMediaProvider } from "../providers/mockMediaProvider";
import { getMediaAssetUrl } from "@/tauri/mediaApi";

const provider = new MockMediaProvider();


export function getMediaUrl(filePath: string): string {
  return getMediaAssetUrl(filePath);
}