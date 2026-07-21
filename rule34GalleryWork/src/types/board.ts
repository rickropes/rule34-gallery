export type BoardItem = {
  id: string;
  kind: "media" | "text";
  mediaId?: number;
  collectionId?: number;
  pageIndex?: number;
  text?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  aspectRatio?: number;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  backgroundColor?: string;
};

export type BoardViewport = { x: number; y: number; zoom: number };

export type BoardRecord = {
  id: string;
  name: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  items: BoardItem[];
  viewport?: BoardViewport;
};
