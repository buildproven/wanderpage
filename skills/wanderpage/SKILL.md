---
name: wanderpage
description: Turn a folder of travel photos on this Mac into a private, curated static trip page with the Wanderpage MCP tools (inspect_photos, create_draft, get_draft, list_drafts, preview_draft, edit_draft, publish_site). Use when the user wants to make, review, edit, or publish a trip page or photo story from a local photo folder. Keeps the privacy rules - never identifies a person, keeps the chosen location precision, and never publishes when the privacy scan reports findings.
---

# Wanderpage

Wanderpage makes a trip page from a folder of photos on this Mac. The tools do the work: they read the photos, select and order
them, and build the site. You explain the result and carry out the user's choices. Photos stay on the Mac; every tool takes a folder
path or a draft slug.

## Workflow

1. **Inspect the folder.** Ask for the folder path, then call `inspect_photos` with it. Report the photo count and whether GPS data
   and capture dates were found. This call changes nothing.
2. **Ask for the two privacy choices** before you create anything:
   - `people`: `include` keeps photos with people in them; `exclude` drops every photo with a visible person and needs an
     `OPENAI_API_KEY` in the server's environment. If the tool says the key is missing, tell the user and offer `include`.
   - `locationPrivacy`: `hidden` (no locations), `broad` (region only), `approximate` (about 11 km), or `precise` (about 1 km).
     When the user does not choose, use `approximate`, the Wanderpage default.
3. **Create a draft.** Call `create_draft` with the folder, `people`, `locationPrivacy`, and an optional `title` and `maxPhotos`. The
   draft is private (unpublished). Report the slug and the number of photos actually selected; the selection never picks fewer than
   18 photos (or every photo when the folder has fewer), so say so when it is more than the requested maximum.
4. **Preview it.** Call `preview_draft` with the slug and show the contact sheets. Call `get_draft` to see the manifest and why each
   photo was selected, and use those reasons when the user asks why a photo is in the story.
5. **Edit it.** Call `edit_draft` with the slug and only the changes the user asked for: `removePhotoIds`, `heroPhotoId`, `title`,
   or `captions`. Preview again after a change. An edit that fails returns an error and leaves the draft unchanged; report the error.
6. **Publish it** only when the user asks. Call `publish_site` with the slug. It builds the static site in `out/` and runs the privacy
   scan. Report the `out/` path: that folder is the shareable site, and the user can host it anywhere.

Use `list_drafts` to find an earlier draft and its published state.

## Privacy rules

- **Never identify a person.** Do not name, guess, or describe who anyone in a photo is, in captions, titles, or chat, even when the
  user asks. Describe scenes and places, not people.
- **Keep the chosen location precision.** Never add a place, coordinate, or address more precise than the draft's `locationPrivacy`
  allows, and never add a location claim the draft does not support. To change the precision, create a new draft with the new mode.
- **Never publish when the scan reports findings.** If `publish_site` returns privacy findings, nothing was published or deployed and
  the draft keeps its earlier state. Report each finding. Do not call `publish_site` again until the cause is fixed, and never try
  another way to put the site online.
- Never change, move, or upload the user's original photos. Published images are resized copies with the metadata removed.
