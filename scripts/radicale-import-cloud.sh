#!/bin/bash
# Run on cloudlab server. Imports Radicale .ics exports into Stalwart.
# Usage: MAILBOX_PASSWORD=<pass> bash radicale-import-cloud.sh
set -euo pipefail

MAILBOX_PASSWORD="${MAILBOX_PASSWORD:?Set MAILBOX_PASSWORD env var}"
STALWART_URL="http://127.0.0.1:8080"
ACCOUNT="anton@antonshubin.com"

cd /tmp/radicale-import/radicale-export/collections

jmap() {
  docker exec hl-stalwart curl -s "$STALWART_URL/jmap/" \
    -u "$ACCOUNT:$MAILBOX_PASSWORD" \
    -H 'Content-Type: application/json' \
    -d "$1"
}

jmap_upload() {
  docker exec -i hl-stalwart curl -s "$STALWART_URL/jmap/upload/c/" \
    -u "$ACCOUNT:$MAILBOX_PASSWORD" \
    -H 'Content-Type: text/calendar' \
    --data-binary @- < "$1"
}

echo "=== Existing calendars ==="
jmap '{"using":["urn:ietf:params:jmap:core","urn:ietf:params:jmap:calendars"],"methods":[{"name":"Calendar/get","args":{"accountId":"c","ids":null}}]}' | \
  python3 -c "import sys,json; r=json.load(sys.stdin); [print(f'  {c[\"name\"]} ({c[\"id\"]})') for c in r['methods'][0]['args']['list']]"

echo ""
echo "=== Importing ==="

for coll_dir in */; do
  coll_name=$(basename "$coll_dir")
  props_file="$coll_dir/.Radicale.props"
  
  displayname=$(python3 -c "import json; p=json.load(open('$props_file')); print(p.get('D:displayname','$coll_name'))" 2>/dev/null || echo "$coll_name")
  color=$(python3 -c "import json; p=json.load(open('$props_file')); c=p.get('CS:calendar-color',p.get('ICAL:calendar-color','#3788d8')); print(c.replace('#','').replace('FF','')[:6])" 2>/dev/null || echo "3788d8")
  
  echo ""
  echo "--- $displayname ---"
  
  CAL_RESP=$(jmap "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:ietf:params:jmap:calendars\"],\"methods\":[{\"name\":\"Calendar/set\",\"args\":{\"accountId\":\"c\",\"create\":{\"new-cal\":{\"name\":\"$displayname\",\"color\":\"#$color\",\"sortOrder\":1}}}}]}")
  
  CAL_ID=$(echo "$CAL_RESP" | python3 -c "import sys,json; r=json.load(sys.stdin); m=r['methods'][0]['args']; print(m.get('created',{}).get('new-cal',{}).get('id',''))" 2>/dev/null || true)
  
  if [ -z "$CAL_ID" ]; then
    CAL_ID=$(jmap '{"using":["urn:ietf:params:jmap:core","urn:ietf:params:jmap:calendars"],"methods":[{"name":"Calendar/get","args":{"accountId":"c","ids":null}}]}' | \
      python3 -c "import sys,json; r=json.load(sys.stdin); [print(c['id']) for c in r['methods'][0]['args']['list'] if c['name']=='$displayname']" 2>/dev/null | head -1)
    echo "  Exists (ID: $CAL_ID)"
  else
    echo "  Created (ID: $CAL_ID)"
  fi
  
  count=0; imported=0
  for ics_file in "$coll_dir"*.ics; do
    [ -f "$ics_file" ] || continue; [[ "$ics_file" == *".Radicale.cache"* ]] && continue
    count=$((count + 1))
  done
  
  for ics_file in "$coll_dir"*.ics; do
    [ -f "$ics_file" ] || continue; [[ "$ics_file" == *".Radicale.cache"* ]] && continue
    
    UPLOAD=$(jmap_upload "$ics_file")
    BLOB_ID=$(echo "$UPLOAD" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get('blobId',''))" 2>/dev/null || true)
    
    if [ -n "$BLOB_ID" ] && [ "$BLOB_ID" != "None" ]; then
      docker exec hl-stalwart curl -s "$STALWART_URL/jmap/" \
        -u "$ACCOUNT:$MAILBOX_PASSWORD" \
        -H 'Content-Type: application/json' \
        -d "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:ietf:params:jmap:calendars\",\"urn:ietf:params:jmap:calendars:parse\"],\"methods\":[{\"name\":\"CalendarEvent/parse\",\"args\":{\"accountId\":\"c\",\"blobIds\":[\"$BLOB_ID\"]}}]}" > /dev/null
      imported=$((imported + 1))
    fi
  done
  echo "  ✅ $imported/$count imported"
done

echo ""
echo "=== Verification ==="
jmap '{"using":["urn:ietf:params:jmap:core","urn:ietf:params:jmap:calendars"],"methods":[{"name":"Calendar/get","args":{"accountId":"c","ids":null}}]}' | \
  python3 -c "import sys,json; r=json.load(sys.stdin); [print(f'  📅 {c[\"name\"]}') for c in r['methods'][0]['args']['list']]"

echo ""
echo "✅ Done"
