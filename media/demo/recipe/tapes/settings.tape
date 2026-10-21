# Shared by every shot: record.sh puts it in front of each tape and fills the @@...@@ placeholders.
# 1280x716 leaves the bottom 84 px of the 1280x800 video to the caption band.
Output "@@OUT@@"
Set Shell "bash"
Set FontFamily "Noto Sans Mono"
Set FontSize 22
Set LineHeight 1.15
Set Width 1280
Set Height 716
Set Padding 32
Set Margin 0
Set WindowBar ""
Set BorderRadius 0
Set Theme { "name": "ink", "black": "#15120f", "red": "#f87e77", "green": "#83d494", "yellow": "#e9c46a", "blue": "#8ec5ec", "magenta": "#d6a2e8", "cyan": "#8fd3c7", "white": "#efebe2", "brightBlack": "#857f79", "brightRed": "#f87e77", "brightGreen": "#83d494", "brightYellow": "#e9c46a", "brightBlue": "#8ec5ec", "brightMagenta": "#d6a2e8", "brightCyan": "#8fd3c7", "brightWhite": "#ffffff", "background": "#15120f", "foreground": "#efebe2", "selection": "#2f2a26", "cursor": "#f97316" }
Set TypingSpeed 60ms
Set Framerate 30
Set WaitTimeout 600s
Set CursorBlink false

# Attach to the shell record.sh keeps running in tmux, off the record.
Hide
Type "@@ATTACH@@"
Enter
Sleep 1s
