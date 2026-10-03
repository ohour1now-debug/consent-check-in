#!/usr/bin/env bash
# Quick smoke test against an already-running server using curl + jq-free JSON parsing (node -p).
# Usage: BASE=http://localhost:3210 bash test/curl-demo.sh
set -euo pipefail
BASE=${BASE:-http://localhost:3210}
j() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d);console.log($1)})"; }
post() { curl -sf -X POST -H 'Content-Type: application/json' ${3:+-H "X-Session-Token: $3"} -d "${2:-{\}}" "$BASE$1"; }

A=$(post /api/sessions '{"nickname":"Sky"}')
SID=$(echo "$A" | j o.sessionId); TA=$(echo "$A" | j o.token); CODE=$(echo "$A" | j o.code)
echo "1. A created session; join code: $CODE"
B=$(post /api/join "{\"code\":\"$CODE\",\"nickname\":\"River\"}")
TB=$(echo "$B" | j o.token); echo "2. B joined -> status: $(echo "$B" | j o.state.status)"
C='{"adult":true,"sober":true,"agree":true,"boundaries":["kissing","cuddling"]}'
echo "3. A confirms -> status: $(post /api/sessions/$SID/confirm "$C" "$TA" | j o.status)"
echo "4. B confirms -> status: $(post /api/sessions/$SID/confirm "$C" "$TB" | j o.status)"
echo "   overlap seen by A: $(curl -sf -H "X-Session-Token: $TA" $BASE/api/sessions/$SID | j 'o.overlap.activities.join(", ")')"
echo "5. A withdraws -> status: $(post /api/sessions/$SID/withdraw '{}' "$TA" | j o.status)"
echo "   B now sees: $(curl -sf -H "X-Session-Token: $TB" $BASE/api/sessions/$SID | j 'o.status+" (ended by "+o.endedBy+")"')"
CODE_AFTER=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H "X-Session-Token: $TB" -d "$C" $BASE/api/sessions/$SID/confirm)
echo "   B tries to confirm again -> HTTP $CODE_AFTER (409 = cannot be undone)"
echo "6. Stored records (timestamps only):"
curl -sf -H "X-Session-Token: $TA" $BASE/api/sessions/$SID/events | j 'o.events.map(e=>`   ${new Date(e.at).toLocaleString()}  ${e.role||"-"}  ${e.type}`).join("\n")'
echo "7. Delete -> $(curl -sf -X DELETE -H "X-Session-Token: $TA" $BASE/api/sessions/$SID | j o.deleted)"
echo "   GET after delete -> HTTP $(curl -s -o /dev/null -w '%{http_code}' -H "X-Session-Token: $TA" $BASE/api/sessions/$SID)"
