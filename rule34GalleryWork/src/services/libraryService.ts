export interface LibraryService {
  chooseLibrary(): Promise<void>;

  rescan(): Promise<void>;
}