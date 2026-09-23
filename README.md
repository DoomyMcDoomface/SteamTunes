# Steam Music Player (Millennium plugin)

A recreation of Steam's original 2014 Music Player: a local MP3/OGG/FLAC/WAV/AAC
library with albums/artists/playlists, a persistent player that lives as long
as Steam is running, and a mini-player embedded directly in the real in-game
overlay (Shift+Tab) of every running game - not a separate app window.

This is a **plugin** (has a Lua backend for filesystem access). The neutral
dark theme is a separate repo, SteamSkin.

Baseline version: **1.4.0**. The number in `plugin.json` and the About
screen are the same number. When it moves, and the log of each build, is
`CHANGELOG.md`.

## Install

Local development, from this repo:

```powershell
.\scripts\deploy.ps1
```

Then fully restart Steam and enable **Steam Music Player** under
**Settings -> Interface -> Millennium -> Plugins**.

Players who install from Millennium's plugin list update from
**Settings -> Updates** once a production release has been merged into the
Plugin Database. That update copies the new package over the installed
plugin and leaves `backend/data` (the library, queue, and settings) in place.

## Shipping

`production` is the branch Millennium receives. `main` and `dev` are where
work lands first. A release is a merge to `production` whose `plugin.json`
version, About `PLUGIN_VERSION`, and `CHANGELOG.md` heading all moved
together.

Pushing that merge runs **Publish production to Millennium**. The workflow
opens or updates a pull request on
[SteamClientHomebrew/PluginDatabase](https://github.com/SteamClientHomebrew/PluginDatabase)
that pins `plugins/SteamTunes` to the new `production` commit and records
`branch = production`. Millennium's update check compares the commit a
player has installed with that pin. When the pull request is merged, the
Updates tab shows the patch.

The workflow opens that pull request when the `plugin.json` version on
`production` changes, and when SteamTunes is not listed yet. Run it by hand
from the Actions tab to retry the current production commit.

It needs a repository secret named `PLUGIN_DATABASE_TOKEN`: a classic
personal access token with the `public_repo` scope, so it can fork the
Plugin Database and open the pull request.

Plugin Database's own build runs `pnpm run build`, which creates the
`.millennium` directory their packager requires. The player UI is the
Lua-injected frontend.

## How it works

- The Lua backend (`backend/main.lua`) owns the library index, queue, current
  track, and settings for as long as Steam is running - independent of which
  game's overlay is open or which game you switch to.
- On startup it copies the plain JS/CSS in `backend/assets/frontend/` into
  `Steam/steamui/steam-music-player/` (the only place Millennium's
  `add_browser_js`/`add_browser_css` can load modules from) and injects them
  into every Steam-owned browser context: the main client window *and* every
  in-game overlay tab.
- One script runs in both places and detects its role from `document.title`
  (`Steam` / `SteamBrowser_Find` -> main client; `OverlayTab<N>_Find` /
  `SP Overlay: ...` -> in-game overlay). The main context owns the actual
  `AudioContext` and decodes/plays audio; overlay widgets are thin remote
  controls that mirror state and forward button presses back over IPC. This
  is why switching games or toggling the overlay never interrupts playback.
- Audio bytes have no way to be served over HTTP from the Lua sandbox (no
  socket module), so tracks are fetched as base64 chunks over Millennium's
  IPC and decoded client-side via the Web Audio API.

## Toggleable features (Settings tab inside the player panel)

- OS media-key support (via the standard `navigator.mediaSession` API)
- Library search/filter
- Remembering queue + playback position across Steam restarts
- Gapless/crossfade playback
- Discord Rich Presence ("Listening to ...")

Discord Rich Presence needs a free Application Client ID from
[discord.com/developers](https://discord.com/developers/applications) pasted
into the settings field once the toggle is enabled - Discord requires this
for any app that wants to set a custom activity name/art. The bridge itself
is a small PowerShell script (`backend/assets/discord-bridge.ps1`) that talks
to Discord's local IPC pipe directly, since the Lua sandbox has no socket
access to do so itself.

## Known limitations (by design, see the project plan)

- No Steam Soundtrack DLC auto-detection - local folders only.
- The player is its own self-contained floating panel/button rather than a
  native entry in Steam's real Library sidebar, because that sidebar's DOM
  classes are hashed and break on Steam updates. Owning a
  single root element keeps this plugin resilient to Steam UI changes.
- Whole tracks are pulled into memory (in bounded chunks) rather than true
  HTTP range-streamed, since the backend can't run a local web server.
  Fine for compressed formats; very large lossless files will be slower.

## Manual verification checklist

Automated testing can't reach into Steam's actual UI, so after deploying:

1. Restart Steam, confirm the plugin loads without errors (Millennium ->
   Plugins -> Steam Music Player -> View Logs).
2. Click the floating note button in the bottom-right of the Steam client,
   add a music folder, rescan, and play an album.
3. Launch any game, press Shift+Tab, and confirm the mini-player appears and
   its transport buttons control the same playback.
4. Switch to a second game's overlay and confirm playback continued
   uninterrupted and the mini-player still reflects the live state.
