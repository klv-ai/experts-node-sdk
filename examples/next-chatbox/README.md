# Chatbox on a public page

A widget on a site anyone can visit. The visitor is anonymous, so there is no
user of yours to authenticate — which is exactly the case browser session
tokens exist for.

## How it fits together

```
visitor's browser          your server                    the install
      │                         │                              │
      │ GET /api/chat/session   │                              │
      ├────────────────────────►│  sessions.create()           │
      │                         ├─────────────────────────────►│
      │      { token }          │      short-lived token       │
      │◄────────────────────────┤◄─────────────────────────────┤
      │                                                        │
      │  chat, directly, with the session token                │
      ├───────────────────────────────────────────────────────►│
```

Your server is involved once, to mint. After that the browser talks to the
install directly, so you are not proxying every token through your own
infrastructure.

## Before it works

1. **Register the origin** against your API key in the install's admin
   (`https://acme.com`, exactly as the browser sends it). This is also what
   supplies CORS for the surface.
2. **Make the expert guest-visible** — minimum role Guest, not private. A
   session token is a guest, and an expert above that floor resolves to
   nothing server-side: the chat would answer on the site's default model with
   no persona and no knowledge, silently. `sessions.create()` refuses such an
   expert and says so.

## Files

- `app/api/chat/session/route.ts` — mints a token. The only place the key appears.
- `app/components/Chatbox.tsx` — the widget.
