# PIXIE

This project includes a local frontend for creating fixed-style 9:16 news posts and a simple built-in scraper.

## What you can do

- Upload a main image
- Optionally upload a logo
- Enter a headline
- Download the post as a PNG
- Scrape a page URL and show deduplicated headline links inside the app

## Run the app

```powershell
cmd /c npm run start
```

Then open [http://localhost:3000](http://localhost:3000)

## Scraping

Use the `Web Scraper` section in the app:

- paste a page URL
- click `Start Scraping`
- view deduplicated results in the `Scraped output` panel
- click `Use as headline` to copy any scraped title into the post preview

## Accounts and roles

Pix has its own login — there is no longer any dependency on Shortly Agents.
Two roles:

| Role | Can do |
| --- | --- |
| `writer` | Build posts, save them, re-open and re-save **their own**. Their library shows only their own posts, each marked Pending or Approved. |
| `qa` | Everything a writer can, plus a **Review** page: open, edit, approve and delete **anyone's** posts. |

### The posts page

A third tab next to Poster and Article, which reads two ways:

- **writer → "My posts"** — their own saved posts, each with Open and a
  read-only Pending / Approved pill
- **qa → "Review"** — every writer's posts, filterable by **All / Pending /
  Approved**

The list is scoped by the server, not the browser: a writer's request only
ever returns their own rows. On the QA side each row offers:

- **Open** — loads the post into the editor to fix it, then Save as usual
- **Approve / Unapprove** — records sign-off, stamped with who and when
- **Delete**

Approving is deliberately separate from saving: it writes `approved`,
`approved_at`, `approved_by` and touches no field of the post itself, so
signing off can never nudge a slider on the way past. Writers see the
resulting Pending/Approved state on their own posts but cannot change it —
`POST /api/pix/approve` answers 403 for any role but QA.

Six accounts ship by default — `writer1`…`writer5` and `qa1`:

```bash
npm run users:seed
```

The password is shared per role: `writer@1234` for all five writers, `qa@1234`
for QA. Override without editing the script:

```bash
WRITER_PASSWORD=… QA_PASSWORD=… npm run users:seed -- --reset
```

`npm run users:list` shows who exists (never a password). Only scrypt hashes
are stored. Note that a shared password cannot be traced to a person: the
`user_name` on a post records which *account* saved it, not who was typing —
give each writer their own account and password if you ever need that.

Sessions are opaque random tokens stored in `pix_sessions` and sent to the
browser in an HttpOnly, SameSite=Lax cookie that expires after 7 days. The
cookie carries no claims, so a session is revoked by deleting its row and
nothing the browser holds can be forged. Logins are rate-limited to 10 attempts
per username+IP per 15 minutes, and a wrong username and a wrong password give
the same answer at the same speed.

Roles are enforced on the server, in the SQL itself — the UI hides what a role
cannot do, but hiding is never what stops it.

## Saved posts (Supabase)

Press **Save** in the Live Preview header to write the current post to the
`pix_posts` table in Supabase, and the **My posts** / **Review** tab to open
one again. While the poster differs from what is stored, the button reads
`Save •` in amber — nothing is written until it is pressed. That is the only thing that stores a post —
scraping, generating the article and downloading a PNG write nothing. Pressing
Save again updates the same row (the button says *Updated*); scraping a new
article, or building a poster from hand-written text, starts a new one.

Set up:

1. Supabase dashboard → **Connect** → **Session pooler** → copy the URI into
   `SUPABASE_POOLER_URL` in `.env`. Percent-encode special characters in the
   password (`#` → `%23`). The **Direct connection** string works too
   (`SUPABASE_DIRECT_CONNECTION_URL`) but resolves to IPv6 only, so it fails
   on most laptops and on IPv4-only hosts.
2. Verify the connection and create the table:

```bash
npm run db:init
```

The server also creates the table on first use, so step 2 is only there to
tell you straight away whether the string is right.

What a row holds — everything needed to rebuild the post:

| Group | Columns |
| --- | --- |
| Scrape | `source_url`, `scraped_title`, `article_text`, `detail_text`, `image_query`, `source_image_url` |
| AI writer | `ai_headline`, `ai_bullets`, `ai_tweet`, `ai_flags` |
| Poster | `headline`, `detail_body`, `main_image_url`, `main_image_source`, `aspect_ratio`, `accent_color`, `tag` |
| Editor snapshot | `design` (jsonb: offsets, zoom, filters, logo position, timestamp, video trim) |
| Author | `user_login_id`, `user_name` — taken from the session, never from the request body |
| QA sign-off | `approved`, `approved_at`, `approved_by`, `approved_by_name` |

API:

```
POST   /api/auth/login   { username, password } → sets the session cookie
POST   /api/auth/logout  ends the session
GET    /api/auth/me      the signed-in user, or 401

POST   /api/pix          create, or update when the body carries an `id`
GET    /api/pix          list (newest first; `?limit=`, `?offset=`, `?approved=true|false`)
GET    /api/pix?id=…     one post, every column
POST   /api/pix/approve?id=…   { approved: true|false } (QA only)
DELETE /api/pix?id=…     remove one (QA only)
```

Every `/api/pix` route needs a session: a creator's requests are scoped to
their own rows, and asking for someone else's post returns 404 rather than
403 — the library should not confirm what it holds.

A failed save is always reported: the button turns red and reads *Not saved*,
with the reason in the status line under the preview — including "no database
configured", so an unset connection string never looks like a successful save.
Images are stored as URLs; a locally uploaded or AI-enhanced image has no
address, so the row records `main_image_source = "upload"` and keeps the last
known URL.

## Notes

- The scraper is generic and works best on article listing pages with normal anchor tags.
- Some websites may block scraping or require JavaScript-heavy rendering.
- The dedupe step removes repeated title + URL pairs before showing results.