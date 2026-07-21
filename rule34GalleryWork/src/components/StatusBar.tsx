import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "@/store/appStore";
import { getMediaCount } from "@/tauri/libraryApi";
import { listImportQueue, type ImportJob } from "@/tauri/importQueueApi";

export default function StatusBar() {
  const libraryPath = useAppStore((state) => state.libraryPath);
  const libraryStatus = useAppStore((state) => state.libraryStatus);
  const libraryVersion = useAppStore((state) => state.libraryVersion);
  const [mediaCount, setMediaCount] = useState<number | null>(null);
  const [countError, setCountError] = useState<string | null>(null);
  const [latestImport, setLatestImport] = useState<ImportJob | null>(null);

  const refreshQueue = useCallback(() => {
    void listImportQueue().then((jobs) => setLatestImport(jobs[0] ?? null)).catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshQueue();
    let unlisten: (() => void) | undefined;
    void listen("import-queue-updated", refreshQueue).then((dispose) => { unlisten = dispose; });
    return () => unlisten?.();
  }, [refreshQueue]);

  useEffect(() => {
    if (libraryStatus !== "ready") { setMediaCount(null); setCountError(null); return; }
    setCountError(null);
    void getMediaCount().then(setMediaCount).catch((error: unknown) => {
      setCountError(error instanceof Error ? error.message : String(error));
    });
  }, [libraryStatus, libraryVersion]);

  const countLabel = countError ? `Database error: ${countError}` : mediaCount === null ? "Loading…" : `${mediaCount} ${mediaCount === 1 ? "File" : "Files"}`;
  const queueLabel = latestImport
    ? latestImport.status === "failed"
      ? `Import failed: ${latestImport.message ?? "Unknown error"}`
      : `Import: ${latestImport.status}${latestImport.message ? ` · ${latestImport.message}` : ""}`
    : "Importer listening on 127.0.0.1:37891";

  return (
    <footer className="flex h-8 items-center justify-between gap-4 border-t border-zinc-800 bg-zinc-900 px-4 text-xs text-zinc-400">
      <span className="min-w-0 flex-1 truncate text-center" title={queueLabel}>{queueLabel}</span>
      <span title={countError ?? undefined}>{countLabel}</span>
      <span className="max-w-72 truncate" title={libraryPath ?? undefined}>{libraryPath ?? "No library"}</span>
    </footer>
  );
}
