# immich-local-app

## Map Theme Configuration (Info Panel)

The fullscreen info panel map uses MapTiler `dataviz-v4-dark` when a MapTiler API key is configured.

### 1. Add environment variable

Create or update `.env` at the project root with:

```env
VITE_MAPTILER_API_KEY=your_maptiler_api_key
```

### 2. Restart the app

After changing env values, restart the Vite/Tauri dev process so the new variable is loaded.

### 3. Fallback behavior

If `VITE_MAPTILER_API_KEY` is missing, the app falls back to an OpenStreetMap embed in the info panel.
