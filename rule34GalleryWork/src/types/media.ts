export interface MediaRecord {
  id: number;
  hash: string;
  originalFilename: string | null;
  storedFilename: string;
  extension: string;
  mediaType: "image" | "video";
  width: number | null;
  height: number | null;
  filesize: number;
  favorite: boolean;
  addedAt: string;
  filePath: string;
  sourceUrl: string | null;
  isAnimatedGif: boolean;
  collectionId: number | null;
  collectionPageCount: number;
}
export interface MediaPage {
  items: MediaRecord[];
  total: number;
  offset: number;
  limit: number;
}
