# Migrate from Radicale to Stalwart (CalDAV/CardDAV)

> **Status:** 📝 Migration plan
> Replaces Radicale on home server with Stalwart's built-in CalDAV on cloud.

## Why

- Remove separate Radicale container
- Unify on Stalwart for mail + calendars + contacts
- Stalwart CalDAV/CardDAV is natively supported via JMAP + WebDAV

## Migration Steps

### 1. Deploy Stalwart CalDAV router

```bash
deno task deploy cloud stalwart
```

This adds the `cal.${DOMAIN}` Traefik router to the existing Stalwart.

### 2. Add DNS record for cal.antonshubin.com

```bash
cd /home/spy4x/.local/share/opencode/worktree/ab533775387fb787458c646c63e07f0dcc0ab6e4/mighty-forest
CF_TOKEN=$(grep CLOUDFLARE_API_TOKEN .env.root | cut -d= -f2)
ZONE_ID=$(curl -s -X GET "https://api.cloudflare.com/client/v4/zones?name=antonshubin.com" \
  -H "Authorization: Bearer $CF_TOKEN" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['result'][0]['id'])")

curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"A","name":"cal","content":"23.88.101.28","ttl":1,"proxied":false}'
```

### 3. Export Radicale data

SSH into home server and export all collections:

```bash
ssh home

# Stop Radicale to ensure clean data
docker stop hl-radicale

# List all Radicale collections
find /home/spy4x/apps/.volumes/radicale/data -mindepth 1 -maxdepth 1 -type d

# For each user directory, tar the data
for user in $(ls /home/spy4x/apps/.volumes/radicale/data/); do
  echo "Exporting user: $user"
  mkdir -p /tmp/radicale-export/$user
  
  # Copy all .ics files (calendars) and .vcf files (contacts)
  find /home/spy4x/apps/.volumes/radicale/data/$user -name "*.ics" -o -name "*.vcf" \
    | tar -cf /tmp/radicale-export/$user/data.tar -T -
done

# Create a single archive
tar -czf /tmp/radicale-export.tar.gz -C /tmp radicale-export
```

### 4. Copy export to cloud server

```bash
scp /tmp/radicale-export.tar.gz cloudlab:/tmp/
```

### 5. Prepare Stalwart accounts

Ensure the Stalwart mailbox account exists for each user (e.g. `anton@antonshubin.com`).
Create via Stalwart admin UI at `https://stalwart.antonshubin.com/admin` if not already present.

### 6. Import data into Stalwart

SSH into cloud server and import:

```bash
ssh cloudlab
tar -xzf /tmp/radicale-export.tar.gz -C /tmp/

cd /tmp/radicale-export

# For each user, import .ics files into Stalwart
for user_dir in */; do
  user="${user_dir%/}"
  echo "Importing data for user: $user"
  
  # Map Radicale user to Stalwart account email
  # If Radicale username is different from email, adjust this
  account="$user@antonshubin.com"
  
  # Extract .ics files
  tar -xf "$user_dir/data.tar" -C "/tmp/radicale-extract-$user/" 2>/dev/null || true
  
  # Import each .ics file via Stalwart JMAP API
  # Uses Stalwart's JMAP Blob/import endpoint
  find "/tmp/radicale-extract-$user" -name "*.ics" | while read ics_file; do
    # Get calendar name from parent directory
    cal_name=$(basename "$(dirname "$ics_file")")
    
    echo "  Importing $cal_name/$(basename $ics_file)..."
    
    # Upload via Stalwart JMAP API
    # Uses curl to POST to Stalwart's JMAP upload endpoint
    # Requires mailbox password
    curl -s -X POST "https://mail.antonshubin.com/jmap/upload/" \
      -H "Authorization: Basic $(echo -n "$account:$MAILBOX_PASSWORD" | base64)" \
      -F "file=@$ics_file" > /dev/null
    
    # Then create calendar event via JMAP
    # (see detailed script below)
  done
done
```

### 7. Verify data

```bash
# Check Stalwart stats
docker exec hl-stalwart stalwart-cli stats --account anton@antonshubin.com

# Access CalDAV
curl -u "anton@antonshubin.com:$MAILBOX_PASSWORD" \
  -X PROPFIND "https://cal.antonshubin.com/" \
  -H "Depth: 0" \
  -H "Content-Type: application/xml"
```

### 8. Reconfigure caldav-mcp

Update `.env` on home server with new Stalwart CalDAV credentials:

```bash
# On home server, decrypt .env
cd /home/spy4x/apps
deno task env:decrypt

# Edit .env — update CalDAV MCP section:
#   CALDAV_SERVER_URL=https://cal.antonshubin.com/
#   CALDAV_USERNAME=anton@antonshubin.com
#   CALDAV_PASSWORD=<stalwart-mailbox-password>

# Re-encrypt
deno task env:encrypt

# Redeploy caldav-mcp
deno task deploy home caldav-mcp
```

### 9. Verify caldav-mcp

```bash
# Check caldav-mcp logs
docker logs hl-caldav-mcp --tail 20
```

### 10. Cleanup Radicale

After confirming everything works:

```bash
ssh home

# Remove Radicale volumes
rm -rf /home/spy4x/apps/.volumes/radicale

# Clean up temp files
rm -rf /tmp/radicale-export*
```

### 11. Deploy final config

```bash
deno task deploy home
deno task deploy cloud stalwart
```

### 12. Update client configurations

Update CalDAV/CardDAV clients to use new credentials:
- **URL**: `https://cal.antonshubin.com/`
- **Username**: `anton@antonshubin.com` (full email)
- **Password**: Stalwart mailbox password
- **Auth**: Basic auth (Stalwart handles it)

## Rollback

If migration fails:
1. Redeploy Radicale: `deno task deploy home radicale`
2. Restore data from backup
3. Remove DNS record for `cal.antonshubin.com`
4. Redeploy caldav-mcp with old credentials
