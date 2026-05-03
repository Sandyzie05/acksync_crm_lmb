# Acksync CRM

Offline touch-first POS and reporting app for a sweet shop, built with Tauri 2, React, and local SQLite storage.

## What is included

- Touch billing flow with large category and item tiles
- Receipt and GST invoice modes
- Category and item management with GST-aware inclusive pricing
- Payment modes for `cash`, `upi`, and `cheque`
- Sale register, GST summary, payment summary, and item-wise summary
- Excel export for reporting
- Local database backup

## Local run

1. Install dependencies:

```bash
npm install
```

This repo includes a project-local [`.npmrc`](/Users/sandgupt/RandomIdeasWithAI/LMB_touch_CRM/.npmrc) that forces the public npm registry, so installs in this folder use `https://registry.npmjs.org/`

2. Start the desktop app:

```bash
source "$HOME/.cargo/env"
npm run tauri dev
```

3. Create a production web bundle:

```bash
npm run build
```

4. Check the Rust/Tauri side:

```bash
source "$HOME/.cargo/env"
cargo check --manifest-path src-tauri/Cargo.toml
```

## Default local behavior

- Data is stored in a local SQLite file named `lmb_touch_crm.db`
- Item prices are treated as customer-facing rates inclusive of GST
- The app starts with no sample categories or items, so the first setup happens in `Admin`

## Feature toggles

- Printing is currently disabled with `PRINTING_ENABLED = false` in [`src/lib/features.ts`](/Users/sandgupt/RandomIdeasWithAI/LMB_touch_CRM/src/lib/features.ts)
- When enabled later, printer discovery, test print, Save & Print, and bill print previews are wired through the existing Tauri and browser print paths

## Testing On A MacBook

You can test most of the app on macOS because Tauri is cross-platform.

Good things to test on your Mac:

- app launch with `npm run tauri dev`
- category and item setup
- billing flow with touch or trackpad
- GST calculations and mixed-rate bills
- sale register and reissue flow
- local SQLite persistence after restart
- Excel export

Things that still need a real Windows test:

- final Windows installer build with `npm run tauri build`
- Windows-specific filesystem and permission behavior

Recommended test flow on your Mac:

1. Run `npm run tauri dev`
2. Create a few categories and items
3. Generate sample receipt and GST bills with `cash`, `upi`, and `cheque`
4. Reissue one completed bill to verify the void/reissue audit flow
5. Export all report types to Excel
6. Restart the app and verify the data is still present
7. Create a local database backup

## Windows packaging

Use a Windows machine or CI runner for final installer packaging:

```bash
source "$HOME/.cargo/env"
npm run tauri build
```
