# FileBrowser

Web-based file manager for server files.

## Features

- Upload/download files
- Create/edit text files
- Share files via links
- Multiple users
- Mobile-friendly

## Access

Web UI: `https://${FILEBROWSER_DOMAIN}` (default `https://files.${DOMAIN}`)

## Configuration

`PATH_MEDIA`, `PATH_VIDEOS`, `PATH_MUSIC`, `PATH_BOOKS`, `PATH_SYNC`,
`PATH_MOVIES`, `PATH_SERIES` and `PATH_OTHER` are host directories
mounted into the container (default `${VOLUMES_PATH}/<name>`). They're
server-level keys — jellyfin declares `PATH_MEDIA`/`PATH_VIDEOS`/
`PATH_MUSIC` too, and both stacks share one value per key.

## Resources

- [FileBrowser Documentation](https://filebrowser.org/)
