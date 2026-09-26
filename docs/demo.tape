# Records docs/screenshots/demo.gif, the README's hero: `rostok stack list`, then the wizard.
#
# Run from the repository root:   vhs docs/demo.tape
#
# Needs vhs (https://github.com/charmbracelet/vhs, or the distro package) and Deno. It runs the CLI
# from this checkout, not from JSR, so the GIF shows the code at this commit. It scaffolds into
# /tmp/homelab and stops if that folder already exists; it deletes the folder when it is done.
# Placeholder data only: jane@example.com, example.com hosts, Europe/Berlin. The SSH probe fails
# fast because home.example.com does not resolve, so nothing leaves the machine.

Output docs/screenshots/demo.gif

Set Shell "bash"
Set FontSize 16
Set Width 1280
Set Height 960
Set Padding 24
Set Theme "Dracula"
Set TypingSpeed 45ms
Set Framerate 20
Set WaitTimeout 60s

Hide
Type `R="$PWD"; rostok() { deno run -A "$R/cli/+main.ts" "$@"; }; export TZ=Europe/Berlin PS1='$ '`
Enter
Type `mkdir /tmp/homelab && cd /tmp/homelab && rostok --version >/dev/null && clear`
Enter
Sleep 5s
Show

Sleep 500ms
Type "rostok stack list"
Sleep 400ms
Enter
Sleep 4s

Type "clear"
Enter
Sleep 300ms
Type "rostok"
Sleep 400ms
Enter
Wait+Screen /generate one now/
Sleep 1s
Enter
Wait+Screen /SERVER_NAME/
Sleep 800ms
Enter
Wait+Screen /SSH_ADDRESS/
Sleep 400ms
Type "jane@home.example.com"
Sleep 300ms
Enter
Wait+Screen /DOMAIN\)/
Sleep 600ms
Type "example.com"
Sleep 300ms
Enter
Wait+Screen /CONTACT_EMAIL/
Sleep 400ms
Type "jane@example.com"
Sleep 300ms
Enter

# PROJECT, DOCKER_GROUP_ID, TIMEZONE, PUID, PGID, VOLUMES_PATH, PATH_APPS: keep the defaults.
Wait+Screen /PROJECT/
Sleep 700ms
Enter
Wait+Screen /DOCKER_GROUP_ID/
Sleep 500ms
Enter
Wait+Screen /TIMEZONE/
Sleep 500ms
Enter
Wait+Screen /PUID/
Sleep 400ms
Enter
Wait+Screen /PGID/
Sleep 400ms
Enter
Wait+Screen /VOLUMES_PATH/
Sleep 400ms
Enter
Wait+Screen /PATH_APPS/
Sleep 400ms
Enter

# Pick librespeed and traefik from the catalog.
Wait+Screen /Pick stacks/
Sleep 1500ms
Down 4
Sleep 400ms
Space
Sleep 400ms
Down
Sleep 400ms
Space
Sleep 1s
Enter
Sleep 700ms
Enter
Wait+Screen /wizard complete/
Sleep 5s

Hide
Type "cd / && rm -rf /tmp/homelab"
Enter
Sleep 500ms
