# Ads Operations Integrity — Cloudflare-native rebuild

Start with `ARCHITECTURE.md` and `REBUILD_STATUS.md`.

This directory is intentionally parallel to the current production frontend. It is the target runtime for Cloudflare Workers Static Assets + Access + same-origin BFF + private Warehouse Service Binding.

Do not copy legacy backend secrets, CORS workarounds, shared-password authentication, or Warehouse data-loading code into this directory.
