interface StartupErrorProps {
  message: string;
  onRetry: () => void;
}

export function StartupError({
  message,
  onRetry,
}: StartupErrorProps) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 p-6 text-zinc-100">
      <section className="w-full max-w-lg rounded-xl border border-red-900/70 bg-zinc-900 p-8">
        <h1 className="text-xl font-semibold">
          Could not load the library
        </h1>

        <p className="mt-3 break-words text-sm text-red-300">
          {message}
        </p>

        <button
          type="button"
          onClick={onRetry}
          className="mt-6 rounded-lg bg-zinc-100 px-4 py-2 font-medium text-zinc-950 hover:bg-white"
        >
          Retry
        </button>
      </section>
    </main>
  );
}