# Hostile emails

Each `.eml` here tries to fake or confuse the sender-authentication result the
Worker stores (`src/auth.js`). `test/auth.spec.js` runs every one of them, so
every release is checked against them. They use CRLF line endings, like real
mail, so they can also be sent through a mail server as they are.

Cloudflare Email Routing prepends its own block to each message: a `Received`
header, ARC headers, `Received-SPF`, `Authentication-Results:
mx.cloudflare.net` and `X-CF-SpamH-Score`, in that order. Only a result inside
that block counts; a sender can write anything below it.
