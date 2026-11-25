---
name: wanderpage
description: Make a private, curated trip page from travel photos with the Wanderpage MCP tools. With the hosted connector (Claude on the web, desktop, or phone) use create_story, upload_photos (a one-time link that gets photos in from chat), get_story, get_photos and save_curation (you review the photos and write the page text yourself), set_title, download_page (a one-time link to a ZIP of the page), and publish. With the local server on a Mac use inspect_photos, create_draft, get_draft, list_drafts, preview_draft, edit_draft, and publish_site. Use when the user wants to make, review, edit, or publish a trip page or photo story. Keeps the privacy rules - never identifies a person, keeps the chosen location precision, and never publishes when the privacy scan reports findings.
---

# Wanderpage

Wanderpage makes a trip page from travel photos. With the local server, the tools read the photos, select and order them, and build
the page; you explain the result and carry out the user's choices. With the hosted connector, you review the photos and write the page
text yourself, and the server stores the photos and builds the page.

Check which tools you have. The hosted connector (the claude.ai plugin, in Claude on the web, desktop, or phone) has `create_story` and
`upload_photos`: follow [Hosted stories](#hosted-stories), and get the photos in from chat with `upload_photos`. The local server on a
Mac has `inspect_photos`: follow the workflow below. Photos stay on the Mac; every local tool takes a folder path or a draft slug.

## Workflow (local server)

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

## Hosted stories

When the hosted Wanderpage connector is installed (Claude on the web, desktop, or mobile), stories live on the user's Wanderpage
server instead of a folder. Photos attached to the chat do not reach the server, so the user uploads them in a browser:

1. **Create the story.** Ask for the title and the two privacy choices (`peopleMode` and `locationPrivacy`: `broad`, `approximate`,
   or `hidden`), then call `create_story`.
2. **Get an upload link.** Call `upload_photos` with the story id. Give the user the `uploadUrl`: it works once and expires at
   `expiresAt`, 15 minutes later. Only a story in `uploading` status takes photos.
3. **Open the link.** The user opens the link in a browser, presses Continue, and picks 6 to 60 JPEG, PNG, or WebP photos on the
   story's private page. Call `get_story` to check `photoCount` (the stored photos). If the link has expired or was used, call
   `upload_photos` again.
4. **Make the page yourself.** When every photo is stored, call `get_photos` with the story id, then again with each `nextCursor`
   until it is `null`, and look at every preview. Each photo comes with its `photoId`, capture date, and a `place` no finer than city
   level (none in a `hidden` story). Choose and order the photos for the page (the first one is the hero), and write the captions, the
   title, and the intro yourself: describe scenes and places, never who a person is, and name no place more precise than `place` (none
   in a `hidden` story). In a story whose `peopleMode` is `exclude`, leave out every photo that shows a person and send
   `containsPeople: false` for each photo you keep; send it only when you checked. Then call `save_curation` with the story id, the
   chosen photo ids in order with a caption each, the `title`, the `intro`, and `namesNoPerson: true`: your statement that no title,
   intro, or caption names or identifies a person. The server does not check names, so check every text yourself before you send it.
   The draft is ready when the call returns. Show the user the title, intro, and
   captions so they can check the draft before it is published. If the call returns an error (an unknown photo id, a missing
   `namesNoPerson` or `containsPeople`), fix that and call it again. If it says the page is still being built, an earlier call was
   interrupted: call `save_curation` again after the time it names.
5. **Confirm the draft.** After `save_curation`, call `start_generation` with the story id: it builds nothing new and calls no AI
   service, and it returns the story with its status, which is `draft` when your page is saved. If it is refused because the story has
   no saved curation, go back to step 4: call `get_photos`, then `save_curation`, then `start_generation` again. If it returns any
   other error (for example, the photos have expired), report it.
6. **Offer the download.** When the draft is ready, offer `download_page`: it returns a one-time `downloadUrl` that expires at
   `expiresAt`, 15 minutes later. The user opens it in a browser and presses Download to get a ZIP with `index.html` and the page's
   images, which opens from the unzipped folder and can be hosted anywhere. A chat cannot receive the file, so give the link, not
   a file. A story that is published downloads the same way. If the link has expired or was used, call `download_page` again.

Use `set_title`, `publish`, `unpublish`, `delete_story`, and `list_stories` for the other changes the user asks for.

Start each chat with `run_tool` and no arguments: it lists every tool the server has now. A tool in that list but missing from your
tool list was added after the chat started; call it through `run_tool` with its name and arguments instead of asking the user to start
a new chat.

## Privacy rules

- **Never identify a person.** Do not name, guess, or describe who anyone in a photo is, in captions, titles, or chat, even when the
  user asks. Describe scenes and places, not people.
- **Keep the chosen location precision.** Never add a place, coordinate, or address more precise than the draft's `locationPrivacy`
  allows, and never add a location claim the draft does not support. To change the precision, create a new draft with the new mode.
- **Never publish when the scan reports findings.** If `publish_site` returns privacy findings, nothing was published or deployed and
  the draft keeps its earlier state. Report each finding. Do not call `publish_site` again until the cause is fixed, and never try
  another way to put the site online.
- Never change, move, or upload the user's original photos. Published images are resized copies with the metadata removed.
