# SteamTunes versions

The player version is `MAJOR.MINOR.PATCH`. Two copies must always match:

- `plugin.json` → `version` (what Millennium lists)
- `PLUGIN_VERSION` in `backend/assets/frontend/steam-music-player.js` (the About line)

The SteamSkin theme keeps its own version number.

**1.3.6** is the baseline for this repo. Later changes start from here.

## When to bump

One shipped change, one bump. Do it in the same edit as the fix, and add a line under the new version below. Merging that bump to `production` is what gets offered to Steam. The publish workflow opens a Plugin Database pull request, and after that request is merged Millennium shows the update.

- **Patch** (`1.0.1` → `1.0.2`): a bug fix, or several fixes shipped together. This is the bump after every significant fix.
- **Minor** (`1.0.2` → `1.1.0`): a new capability, or a behavior people will notice as new. Patch goes back to `0`. A feature and a fix in the same ship is a minor bump, not both.
- **Major** (`1.4.2` → `2.0.0`): saved settings, the library, or the queue from the previous major cannot be used unchanged. Minor and patch go back to `0`.

## 1.4.0

- Playlist files inside a music folder show up under Playlists. M3U, M3U8, and PLS are read when the library is scanned. The player queues the tracks from those files that are already in the library.
- Library search runs only when you press Enter. Typing, including typing quickly, does not look anything up and does not refresh the list.
- A one-letter search matches names that start with that letter. It no longer matches filler words such as "of" or "the" later in the name.

## 1.3.6

- The More From This Artist button is gone. The artist name in Now Playing, on album cards, and on genre song rows opens that artist's albums.

## 1.3.5

- On the tall Now Playing layout, More From This Artist sits just above the queue divider, on the left. Shuffle and repeat stay centered.

## 1.3.4

- On the tall Now Playing layout, More From This Artist sits just left of shuffle and repeat. The short layout still centers it on the cover.

## 1.3.3

- Startup restores the last track and the queue from that session. An older genre All Songs list no longer replaces a newer album, playlist, or artist queue.

## 1.3.2

- More From This Artist is centered on the cover, in both the tall and the compact Now Playing layouts.

## 1.3.1

- More From This Artist sits above the cover, on the left.

## 1.3.0

- Now Playing has a More From This Artist button in the top right. It follows the current track, including inside a playlist or a long queue.

## 1.2.0

- Spatial Audio gains Large Hall, Bass Cut. It is the same hall, with the low end taken out of the reverb so the tail does not boom.

## 1.1.11

- Track-row icon buttons are square again. The shared text-button padding was clipping Play Next and Add To Queue.

## 1.1.10

- The first folder scan keeps reading tracks from an album until it saves a cover the browser can show. A file that is not a real picture no longer counts as finished.

## 1.1.9

- Album covers stored in AAC files show up even when that picture was not on a 4-byte boundary. A failed read tries another track from the same album.

## 1.1.8

- Album covers that are already in the music files get written for display again if that background job had stopped.

## 1.1.7

- Set Cover remembers the picture's filepath and shows that file. It no longer keeps a second copy of the image.

## 1.1.6

- Text buttons share one height, type size, and padding in every tab. Icon buttons in a row share one square size.

## 1.1.5

- Set Cover's helper stays fully visible. Play Album matches the height of the buttons beside it.

## 1.1.4

- A cover you set is written into the player art cache, so it is still there the next time Steam starts. The music file is still not changed.

## 1.1.3

- Duck Music is now Audio Ducking, with a one-line definition of ducking.
- Set Cover paints the chosen image immediately on the album block, Now Playing, and the song display. The image is stored in the player cache only.

## 1.1.2

- Button labels capitalize each word, including Play Album, Set Cover, Add To Queue, and the queue move buttons.

## 1.1.1

- Settings labels use a capital on each word. The long mix and playback checkboxes are shorter: Match Loudness, Duck Music, Narrow Stereo, Center Bass, Gapless / Crossfade, and Media Keys.

## 1.1.0

- Set a JPEG or PNG as an album's cover in the player. It is stored in the art cache only and is not written into the music file.
- Redraw Library View reloads those covers. Regenerate Artwork clears them and reads artwork from the files again.

## 1.0.2

- Every settings heading collapses: Music folders, Playback, Loudness, Equalizer, Misc Features, About, Appearance, and Troubleshooting.

## 1.0.1

First tracked build. Before this, the About screen said `1.0` and Millennium said `0.1.0`.

- Mix uses collapsible Loudness and Equalizer sections.
- Spatial Audio holds the room, the space amount, and keep-bass-centered.
- Settings checkboxes stay in the state you set.

## 1.0.0

Not a separate build. This is the untracked player that only displayed `1.0`.
