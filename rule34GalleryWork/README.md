# Rule34 Library prototype

A Tauri 2 + React desktop media library prototype.

## Implemented

- Library setup backed by SQLite.
- Import local images and videos (`jpg`, `jpeg`, `png`, `gif`, `webp`, `bmp`, `mp4`, `webm`, `mov`, `m4v`).
- Add a direct image/video URL. The app downloads it, de-duplicates it by SHA-256, stores source metadata, and applies optional `category:name` tags.
- Responsive gallery with image/video cards.
- Inspector with larger preview, file details, categorized tags, category autocomplete, and category-dependent tag autocomplete.
- Full-screen image/video viewer.
- Tag search. Space-separated terms are combined with AND. Use `category:name` to constrain a term, for example `author:john theme:outdoors`.

## Run

Requirements: Node.js, npm, Rust, and the Tauri system prerequisites for your OS.

```bash
npm install
npm run tauri dev
```

## Prototype ingestion bridge

Use **Add URL** in the top bar with a direct media URL. This is the app-side ingestion contract intended for the Chrome extension. A production extension should pass the extracted direct media URL and Rule34/Danbooru tags to this same command through a native-messaging or localhost bridge.

The current prototype intentionally does not scrape arbitrary post pages inside the desktop app. The future extension should extract the canonical media URL and tags in the page context, where site-specific DOM handling is easier to maintain.
