# The server: keep the name "home", then its SSH address, domain and email.
Show
Sleep 500ms
Enter
Wait+Line /SSH target/
Sleep 700ms
Type "@@SSH@@"
Sleep 800ms
Enter
Wait+Line /Primary domain/
Sleep 700ms
Type "@@DOMAIN@@"
Sleep 800ms
Enter
Wait+Line /certificate notices/
Sleep 700ms
Type "@@EMAIL@@"
Sleep 800ms
Enter
Wait+Line /project identifier/
Sleep 1000ms
