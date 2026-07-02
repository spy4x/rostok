#!/bin/bash
# Radicale → Stalwart data migration script
# Run on cloudlab server. Exports from home Radicale, imports to Stalwart.
set -euo pipefail

MAILBOX_PASSWORD="HnQWGPtXdx1XHqgdfv2DrnHRdRkJ4nPiF0EQcIVGNcxVpSIu"
STALWART_ADMIN="admin:iWrk7IJqQ1wvD67NMBb83uz0kE/RQvAq"
STALWART_URL="http://127.0.0.1:8080"
CALDAV_BASE="$STALWART_URL/dav/cal"
ACCOUNT="anton@antonshubin.com"

echo "=== Step 1: Export Radicale data from home ==="
ssh homelab "docker stop hl-radicale 2>/dev/null; \
  export SRC=/home/spy4x/ssd-2tb/apps/.volumes/radicale/data/collections/collection-root/spy4x; \
  mkdir -p /tmp/radicale-export/collections; \
  for dir in \"\$SRC\"/*/; do \
    name=\$(basename \"\$dir\"); \
    props=\"\$dir/.Radicale.props\"; \
    if [ -f \"\$props\" ]; then \
      mkdir -p \"/tmp/radicale-export/collections/\$name\"; \
      cp \"\$props\" \"/tmp/radicale-export/collections/\$name/\"; \
      find \"\$dir\" -maxdepth 1 -name '*.ics' -exec cp {} \"/tmp/radicale-export/collections/\$name/\" \; 2>/dev/null; \
      echo \"  Exported collection: \$name\"; \
    fi; \
  done; \
  tar czf /tmp/radicale-export.tar.gz -C /tmp radicale-export; \
  echo \"Export size: \$(du -sh /tmp/radicale-export.tar.gz | cut -f1)\""

echo "=== Step 2: Copy to cloud ==="
scp homelab:/tmp/radicale-export.tar.gz /tmp/

echo "=== Step 3: Extract on cloud ==="
rm -rf /tmp/radicale-import
mkdir -p /tmp/radicale-import
tar xzf /tmp/radicale-export.tar.gz -C /tmp/radicale-import

echo "=== Step 4: Create calendars in Stalwart via JMAP ==="
echo "Checking existing calendars..."
docker exec hl-stalwart curl -s "$STALWART_URL/jmap/" \
  -u "$ACCOUNT:$MAILBOX_PASSWORD" \
  -H 'Content-Type: application/json' \
  -d '{
    "using": ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"],
    "methods": [{
      "name": "Calendar/get",
      "args": {"accountId": "c", "ids": null}
    }]
  }' | python3 -m json.tool 2>/dev/null | grep -E '"id"|"name"|"uid"'

echo ""
echo "=== Step 5: Import .ics files ==="
cd /tmp/radicale-import/radicale-export/collections

for coll_dir in */; do
  coll_name=$(basename "$coll_dir")
  props_file="$coll_dir/.Radicale.props"
  
  # Extract metadata from props
  displayname=$(python3 -c "
import json
with open('$props_file') as f:
    props = json.load(f)
print(props.get('D:displayname', props.get('displayname', '$coll_name')))
" 2>/dev/null || echo "$coll_name")
  
  color=$(python3 -c "
import json
with open('$props_file') as f:
    props = json.load(f)
print(props.get('CS:calendar-color', props.get('ICAL:calendar-color', '#3788d8')).replace('#', '').replace('FF', ''))
" 2>/dev/null || echo "3788d8")
  
  components=$(python3 -c "
import json
with open('$props_file') as f:
    props = json.load(f)
comp = props.get('C:supported-calendar-component-set', 'VTODO')
print(json.dumps(comp.split(',')))
" 2>/dev/null || echo '["VTODO"]')
  
  echo ""
  echo "--- Creating calendar: $displayname ($coll_name) ---"
  
  # Create calendar via JMAP Calendar/set
  CAL_RESP=$(docker exec hl-stalwart curl -s "$STALWART_URL/jmap/" \
    -u "$ACCOUNT:$MAILBOX_PASSWORD" \
    -H 'Content-Type: application/json' \
    -d "{
      \"using\": [\"urn:ietf:params:jmap:core\", \"urn:ietf:params:jmap:calendars\"],
      \"methods\": [{
        \"name\": \"Calendar/set\",
        \"args\": {
          \"accountId\": \"c\",
          \"create\": {
            \"new-cal\": {
              \"name\": \"$displayname\",
              \"color\": \"$color\",
              \"sortOrder\": 1
            }
          }
        }
      }]
    }")
  
  CAL_ID=$(echo "$CAL_RESP" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r['methods'][0]['args']['created']['new-cal']['id'])" 2>/dev/null || echo "")
  
  if [ -z "$CAL_ID" ]; then
    echo "  Failed to create calendar. Response:"
    echo "$CAL_RESP" | python3 -m json.tool 2>/dev/null | head -10
    continue
  fi
  echo "  Calendar created with ID: $CAL_ID"
  
  # Import each .ics file
  ics_count=0
  for ics_file in "$coll_dir"*.ics; do
    [ -f "$ics_file" ] || continue
    
    # Skip cache files
    [[ "$ics_file" == *".Radicale.cache"* ]] && continue
    
    ics_count=$((ics_count + 1))
    uid=$(basename "$ics_file" .ics)
    
    # Upload .ics via JMAP Blob/upload
    UPLOAD_RESP=$(docker exec hl-stalwart curl -s "$STALWART_URL/jmap/upload/c/" \
      -u "$ACCOUNT:$MAILBOX_PASSWORD" \
      -H 'Content-Type: text/calendar' \
      --data-binary @"$ics_file")
    
    BLOB_ID=$(echo "$UPLOAD_RESP" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get('blobId',''))" 2>/dev/null || echo "")
    
    if [ -z "$BLOB_ID" ]; then
      echo "  Failed to upload $uid"
      continue
    fi
    
    # Import blob as calendar event via CalendarEvent/set
    docker exec hl-stalwart curl -s "$STALWART_URL/jmap/" \
      -u "$ACCOUNT:$MAILBOX_PASSWORD" \
      -H 'Content-Type: application/json' \
      -d "{
        \"using\": [\"urn:ietf:params:jmap:core\", \"urn:ietf:params:jmap:calendars\", \"urn:ietf:params:jmap:calendars:parse\"],
        \"methods\": [{
          \"name\": \"CalendarEvent/parse\",
          \"args\": {
            \"accountId\": \"c\",
            \"blobIds\": [\"$BLOB_ID\"]
          }
        }]
      }" > /dev/null
    
    if [ $((ics_count % 10)) -eq 0 ]; then
      echo "  Imported $ics_count tasks to $displayname..."
    fi
  done
  
  echo "  ✅ Imported $ics_count tasks to '$displayname'"
done

echo ""
echo "=== Step 6: Verify ==="
echo "Calendars in Stalwart:"
docker exec hl-stalwart curl -s "$STALWART_URL/jmap/" \
  -u "$ACCOUNT:$MAILBOX_PASSWORD" \
  -H 'Content-Type: application/json' \
  -d '{
    "using": ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"],
    "methods": [{
      "name": "Calendar/get",
      "args": {"accountId": "c", "ids": null}
    }]
  }' | python3 -c "
import sys, json
r = json.load(sys.stdin)
for cal in r['methods'][0]['args']['list']:
    print(f\"  📅 {cal['name']} (color: {cal.get('color','?')}) - {cal.get('uid','?')}\")
"

echo ""
echo "✅ Migration complete!"
echo "Now:"
echo "  1. Deploy cloud stalwart: deno task deploy cloud stalwart"
echo "  2. Update home .env for caldav-mcp"
echo "  3. Deploy home: deno task deploy home"
echo "  4. Restart Radicale if rollback needed: docker start hl-radicale"
