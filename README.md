# compositor-mcp

An [MCP](https://modelcontextprotocol.io) server that lets Claude and other AI agents read and edit
[Compositor](https://github.com/robbietilton/Compositor) projects, the open-source Photoshop
alternative for Mac.

It works on the documented `.comp` package format (a `manifest.json` plus one PNG per layer), so it
needs no changes to Compositor itself. Edit a project with an agent, then open it in Compositor.
Or the other way round: save in Compositor and let the agent inspect, retouch or render it.

## What the agent can do

| Tool | Purpose |
| --- | --- |
| `inspect_project` | Canvas size, resolution and every layer with folder depth, opacity, blend mode, transform, mask and clipping info |
| `list_layers` | Compact top-to-bottom view like the Layers panel |
| `render_preview` | Flattened PNG preview returned as an image so the model can *see* the composition |
| `export_flattened` | Full-resolution PNG or JPEG export |
| `export_layer` | Copy a layer's source pixels or mask to a file |
| `create_project` | New document, optionally with a solid background layer |
| `add_image_layer` | Import PNG, JPEG, HEIC, TIFF, WebP… as a layer, with fit/fill/stretch placement, opacity, blend mode and folder |
| `add_folder` | Create a layer folder |
| `set_layer` | Rename, show/hide, opacity, blend mode, position, size, rotation, flips, sampling, mask on/off |
| `move_layer` | Reorder layers or move them between folders |
| `remove_layer` | Delete a layer or a whole folder |
| `replace_layer_image` | Swap a layer's pixels (round-trip through another tool or a generated image) |
| `set_layer_mask` | Attach a grayscale mask, invert it, or clear it |
| `resize_canvas` | Change the document size with an anchor, without resampling |
| `open_in_compositor` | Open the project in the Compositor app |

The server also exposes a `compositor://format` resource describing the file format.

## Related

[marcushorndt/compositor-mcp](https://github.com/marcushorndt/compositor-mcp) takes a different route: it drives
Compositor's own document model and renderer headlessly (Swift), so previews match the app exactly. This package is a
plain Node server that works on the documented file format, needs no build of the app, and runs wherever Node runs.
Pick whichever fits your setup; both open the same `.comp` files.

## Install

Requires Node.js 20 or later. Compositor itself is only needed to look at the result.

### Claude Code

```bash
claude mcp add compositor -- npx -y compositor-mcp
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "compositor": {
      "command": "npx",
      "args": ["-y", "compositor-mcp"]
    }
  }
}
```

### From source

```bash
git clone https://github.com/Josusanz/compositor-mcp
cd compositor-mcp
npm install
npm run build
claude mcp add compositor -- node /path/to/compositor-mcp/dist/src/index.js
```

## Example session

> Create a 1920×1080 project at `~/Desktop/poster.comp` with a white background, add `photo.jpg`
> scaled to fill, put `logo.png` in the bottom right corner at 80 % opacity with Multiply, then show
> me a preview and open it in Compositor.

The agent calls `create_project`, `add_image_layer` twice, `set_layer`, `render_preview` and
`open_in_compositor`. Compositor opens the document with the layers ready to keep editing.

## How it maps to the Compositor format

- Layer pixels are stored untouched as 8-bit sRGB PNGs; placement, scale, rotation and flips live
  in the layer transform, so edits stay non-destructive.
- Masks are written as 8-bit grayscale PNGs without alpha, as Compositor requires.
- Manifests are validated against the same rules as `ProjectStore.swift` before writing, written
  with sorted keys and replaced atomically.
- Fields this tool does not understand (adjustments, effects, text, shapes, guides, anything newer)
  are preserved on round trip.
- Projects are saved as format version 9 (what Compositor 1.2.6 writes); a project declaring a newer version keeps its own number and its unknown fields on round trip. Older Compositor builds reject
  newer versions; update the app if a file will not open.

## Limitations

- The preview renderer covers order, folders, visibility, opacity, transforms, raster masks and
  the blend modes sharp supports. Clipping masks, adjustment layers and layer effects are not
  rendered yet; the tool reports what it skipped. Compositor's own export is the reference.
- Compositor does not watch files for changes. After the agent edits a project that is already
  open, close and reopen the document (or call `open_in_compositor`).
- There is no live connection to the running app: selection, undo history and the viewport are
  session-only in Compositor and out of reach here.

## Development

```bash
npm install
npm test        # builds and runs the node:test suite
npm run dev     # runs the server from TypeScript with tsx
```

## License

MIT. Compositor is © Robbie Tilton, also MIT.
