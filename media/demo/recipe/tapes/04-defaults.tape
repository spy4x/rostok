# PROJECT, DOCKER_GROUP_ID, TIMEZONE, PUID, PGID, VOLUMES_PATH, PATH_APPS: keep the defaults.
Show
Sleep 500ms
Enter
Wait+Line /Docker group ID/
Sleep 700ms
Enter
Wait+Line /Time zone/
Sleep 700ms
Enter
Wait+Line /Container user ID/
Sleep 700ms
Enter
Wait+Line /Container group ID/
Sleep 700ms
Enter
Wait+Line /app data is stored/
Sleep 700ms
Enter
Wait+Line /puts your apps/
Sleep 700ms
Enter
# The stack picker hides the cursor, and vhs cannot wait on a screen without one: sleep instead.
Sleep 2500ms
