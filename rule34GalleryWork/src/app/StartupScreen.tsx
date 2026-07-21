export function StartupScreen() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-400">
      <div className="text-center">
        <div className="mb-3 text-sm">Loading media library…</div>

        <div className="mx-auto h-1 w-40 overflow-hidden rounded bg-zinc-800">
          <div className="h-full w-1/2 animate-pulse bg-zinc-500" />
        </div>
      </div>
    </main>
  );
}