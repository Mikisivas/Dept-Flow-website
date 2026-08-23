---
name: dept-flow-design
description: The design system and frontend workflow for Dept-Flow. Use when building or reviewing any UI in this project — pages, components, dashboards, forms, status indicators — or when choosing colors, typography, or layout, adding shadcn/ui components, or auditing a screen before shipping. Encodes the technology stack, the SAMACOSS-derived palette (orange/white/black), the attendance-strip visual signature, per-role screen patterns, and the accessibility rules this project must not break. Triggers on "design this page", "build this component", "what color should this be", "review this UI", "add a shadcn component".
---

# Dept-Flow design system

Product logic and state definitions live in `docs/system-operation-and-logic.md` —
read it before designing any screen that touches attendance, payment, or compliance
state.

---

## 1. Technology stack

**Dept-Flow is a website, not an installed application.** Every role — student,
lecturer, HOD, admin — reaches it through a mobile or desktop browser at a URL. There
is no app store, no native build, no installation step. Design accordingly: the first
visit must work immediately on a phone browser with nothing downloaded beforehand.

| Layer | Choice | Notes |
|---|---|---|
| Frontend | **Next.js / React (TypeScript)** | Responsive website, mobile-first; must load on Nigerian cellular data inside lecture halls |
| Styling | **Tailwind CSS** | Utility-first; no separate CSS framework |
| Components | **shadcn/ui** | Source copied into the repo, not a black-box dependency |
| Primitives | **Radix UI** | Unstyled accessible primitives under shadcn — focus trapping, keyboard nav, ARIA roles |
| Backend API | **FastAPI (Python)** | |
| Database | **Supabase (PostgreSQL)** | Auth, realtime, row-level security |
| Cache | ~~Redis~~ | Dropped — the compliance lookup it was for no longer happens during a submission |
| Payments | **Paystack** | Card + Pay with Transfer, webhook-verified |
| ML | **scikit-learn** | Advisory regression only |

**Why Tailwind + shadcn + Radix:** Tailwind keeps styling utility-first with no second
CSS framework and no unused-rule bloat, which matters on metered data. shadcn ships
**Radix** primitives, which supply keyboard navigation, focus trapping, and ARIA roles
for free — most of the accessibility checklist in §9 is satisfied by using them instead
of hand-rolled markup. Radix is unstyled, so it takes the palette in §3 without
fighting it. Bundles stay small.

**Why Redis was dropped:** it was there for a bursty load pattern — hundreds of
students submitting inside the same few-minute code window across parallel classes —
caching the "is this student cleared / locked" lookup to keep a round-trip off the hot
path. Payment no longer gates attendance, so a submission does not consult compliance
at all, and the hot path Redis existed for does not exist. The remaining per-submission
reads are the code and the registration, both indexed single-row lookups.

Keep the burst *argument* for Chapter 3 — it is still the right analysis of the load —
but do not list a cache the system does not have.

For Chapter 3 (Research Instruments/Tools), list all of these **with versions** —
that section is graded on reproducibility.

---

## 2. The design thesis

Dept-Flow is an **institutional instrument**, not a consumer product. It decides whether
a student sits an exam. It should read as precise, legible, and trustworthy —
tabular, high-contrast, low-decoration. When in doubt, choose the version that looks
like a well-made register rather than a startup landing page.

**The signature element: the attendance strip.** Every lecture renders as one cell:

```
▮  Present (1)      ▯  Absent (0)
```

Orange fills a lecture attended; an outline marks a missed one. It scales from a
single list row to a full semester strip, and it comes from the system's own logic
rather than a template. Spend the design's boldness here and keep everything around
it quiet.

*(Until August 2026 this was a pair of cells, because a lecture was scored 0 / 0.5 /
1.0 from two checkpoints. The supervisor's revision removed the second checkpoint, so
the motif is one cell and scoring is binary.)*

**The other signature element, and the one that is actually the product: the gap
between two numbers.** A student on 76.92% today, projected to finish at 66%, is the
whole argument for this system existing. Wherever a percentage appears, ask whether
the projection belongs beside it — and design the pair so the eye reads *where this is
going*, not just *where this is*.

---

## 3. Palette — derived from the SAMACOSS crest

Departmental colors are **orange, white, black**, taken from the SAMACOSS crest
(Student Association of Mathematics, Computer Science & Statistics). The crest's
orange is a **golden orange, hue ≈32°** — warmer and lighter than a generic "web
orange." The whole UI scale is generated from that hue so interface and logo read as
one system.

> **Confirm the exact value before launch.** `#F0952B` is a close visual read of the
> supplied crest, not a sample from the source file. Eyedrop the shield fill in the
> original; if it differs, update `--brand` and regenerate the scale — every ratio
> below shifts with it.

**The logo already tells us the correct text treatment.** "SAMACOSS" is set in
**black on orange**, not white. Follow that: orange is a *fill that carries black
text*. This is not a compromise — it measures better than the alternative.

### Verified contrast ratios

WCAG 2.1 relative-luminance formula. AA requires **4.5:1** for normal text, **3:1**
for large text (≥18.66px bold / ≥24px) and UI component boundaries.

| Pair | Ratio | Verdict |
|---|---|---|
| **Black `#0A0A0A` on Brand Orange** | **8.52:1** | ✓ AAA — *the primary pattern* |
| Brand Orange `#F0952B` on white | **2.32:1** | ✗ fails — never as text |
| White on Brand Orange | **2.32:1** | ✗ fails — never do this |
| Black on Hover `#D67A0F` | **6.27:1** | ✓ AA |
| Black on Pressed `#BF6D0D` | **5.10:1** | ✓ AA |
| Orange Text `#A75F0C` on white | **4.90:1** | ✓ AA — the only orange safe as text |
| Ink `#0A0A0A` on white | **19.80:1** | ✓ AAA |
| Slate `#525252` on white | **7.81:1** | ✓ AAA — secondary text |
| Muted `#737373` on white | **4.74:1** | ✓ AA — tertiary text, captions |
| White on Green `#15803D` | **5.02:1** | ✓ AA |
| White on Red `#B91C1C` | **6.47:1** | ✓ AA |
| White on Blue `#1D4ED8` | **6.70:1** | ✓ AA |
| Brand Orange on Ink (dark mode) | **8.52:1** | ✓ AAA — unchanged on dark |

**The trap:** the instinct is a white-text-on-orange button. At **2.32:1** that is
among the worst contrast failures possible. Orange surfaces carry **black** text. If
orange must be *text* on white, it darkens all the way to `#A75F0C`.

### Tokens

```css
:root {
  /* Brand — hue 32°, generated from the SAMACOSS crest */
  --brand:            #F0952B;  /* crest orange — fills, motif, primary button. BLACK text. */
  --brand-hover:      #D67A0F;  /* button hover (black text: 6.27:1) */
  --brand-pressed:    #BF6D0D;  /* button pressed (black text: 5.10:1) */
  --brand-text:       #A75F0C;  /* the ONLY orange usable as text on white (4.90:1) */
  --brand-tint:       #FDF3E7;  /* barely-orange surface for grouped panels */
  --brand-tint-2:     #FCE7CF;  /* selected rows, subtle emphasis */

  /* Neutrals */
  --ink:              #0A0A0A;  /* primary text */
  --slate:            #525252;  /* secondary text */
  --muted:            #737373;  /* tertiary text, captions, timestamps */
  --line:             #E5E5E5;  /* borders, dividers */
  --surface:          #FFFFFF;
  --surface-sunken:   #FAFAFA;  /* table stripes, page background */

  /* Status — deliberately clear of the brand */
  --ok:               #15803D;  /* confirmed, cleared, paid */
  --ok-tint:          #DCFCE7;
  --info:             #1D4ED8;  /* pending verification */
  --info-tint:        #DBEAFE;
  --danger:           #B91C1C;  /* locked */
  --danger-tint:      #FEE2E2;
  /* Watch has no colour of its own — see below */
}

@media (prefers-color-scheme: dark) {
  :root {
    --brand:          #F0952B;  /* already 8.52:1 on ink — keep it */
    --brand-text:     #F2A040;  /* lighten only the text variant */
    --ink:            #FAFAFA;
    --slate:          #A3A3A3;
    --muted:          #737373;
    --line:           #262626;
    --surface:        #0A0A0A;
    --surface-sunken: #171717;
    --ok:             #4ADE80;
    --info:           #60A5FA;
    --danger:         #F87171;
  }
}
```

Set `color-scheme: dark` on `<html>` in dark mode and match
`<meta name="theme-color">` to the surface color.

### Orange is the brand, not a warning

Because the departmental color is orange, it cannot also mean "caution" — a risk
alert in orange would vanish into the brand furniture. Status gets its own scale,
kept clear of hue 32°. **Never use amber or yellow for any status.**

| State | Treatment |
|---|---|
| Confirmed / Cleared | Green `--ok` |
| Watch (forecast) | **Neutral, no fill** — not a warning, just *no room left* |
| Pending verification | Blue `--info` — system is working, student need do nothing |
| Locked | Red `--danger`, filled |
| At risk (advisory) | Red **outlined**, not filled — lower emphasis than Locked |

Never encode a state by color alone: every status carries an icon or text label too,
so it survives color-blindness and a bad phone screen in bright daylight.

### Why Watch has no colour

*(This section used to be "Why provisional has no colour". Provisional attendance no
longer exists — payment stopped deciding whether a lecture counts — but the reasoning
transferred intact to the state that replaced it as the hard one to colour.)*

Watch is the forecast tier for a student projected to finish between 75% and 80%:
above the line, with nothing spare. It is not a warning and not an error. Giving it an
alarm colour implies a judgment the number does not support, and worse, it spends the
loudest colour in the palette on the students who are not failing — leaving nothing
louder for the ones who are.

So: **neutral border, `--slate` text, no fill**, and a falling-trend icon rather than
an alert triangle. Safe is green, Critical is the at-risk outline, and Watch sits
visually between them by being quieter than both.

Always paired with the sentence that makes it actionable: "You can miss 4 more — after
that there is no room left."

### Budgeting orange

Orange is loud. A screen where everything is orange loses hierarchy and stops looking
institutional.

- **~10% of the screen maximum** — primary action, attendance strip, active nav item.
  Nothing else.
- Structure comes from **black type on white with thin gray rules**, not orange panels.
- Never use orange for large background washes behind text.
- Never use orange for a status.

---

## 4. Logo and required assets

The crest is an orange shield holding a monitor-and-tower glyph, the SAMACOSS
wordmark, and a book, wrapped in two white ribbon banners.

**It is a detailed crest, and detail does not survive small sizes.** The ribbon
outlines are hairlines and the banner text is tiny; below ~200px it turns to mud, and
at favicon size it is unreadable noise. Use the crest at size, and a simplified mark
everywhere small.

| Asset | Source | Where used |
|---|---|---|
| **Full crest** | supplied logo | login/landing page, printed reports, About |
| **Site mark** | shield silhouette + monitor glyph only — **no ribbons, no banner text** | site header, favicon, browser tab, bookmark icon |
| **Monochrome mark** | site mark, single-color | dark mode, watermarks, over orange |

Required files, all derived from the one crest:
- `favicon.ico` — 32×32, site mark only (browser tab)
- `apple-touch-icon.png` — 180×180 (what iOS shows if a student bookmarks the site
  to their home screen — worth having even though this is not an installed app)
- `logo-full.svg` — the crest, for the login/landing page
- `logo-mark.svg` — the simplified site mark, for the header
- `og-image` — generated at build time from the logo and text, for link previews when
  the URL is shared in a class WhatsApp group

No `icon-192`/`icon-512` and no web manifest are needed — those exist to make a site
installable, which is explicitly not the model here.

**Get the source file.** The crest as supplied is a raster on an opaque white
background; that white box will show against `--brand-tint` panels and break in dark
mode. Obtain the original **SVG or transparent PNG**. If only a raster exists, redraw
the mark as SVG rather than scaling up.

**Never** recolor the crest, stretch it, place the full crest on an orange fill (the
shield disappears), or add effects.

**No other imagery.** No stock photos, no generic illustrations. Icons come from
`lucide-react` (ships with shadcn — vector, near-zero weight, inherits current color).
Empty states are typographic plus a single icon. The attendance strip is CSS/SVG. The
social/OG preview image is generated at build time from the logo and text.

---

## 5. Typography

A single well-set family beats a mismatched pairing here — this is an instrument, and
legibility on cheap Android screens outranks personality.

- **Body / UI:** `Inter` (or the system stack) — 16px base, never below 14px for
  anything a student must read. Weights 400/500/600.
- **Data / numbers:** same family with `font-variant-numeric: tabular-nums` —
  mandatory anywhere numbers stack (attendance %, amounts, matric numbers, session
  counts) so columns align and digits don't jitter as values update.
- **Display:** same family at 600/700 with tight tracking. If you want one
  characterful accent face, confine it to the site wordmark — not headings.

Load one variable font subset with `font-display: swap` and preload it. Every extra
font file is real money on a student's data bundle.

Scale: `12 / 14 / 16 / 20 / 24 / 32`. Use `text-wrap: balance` on headings.

---

## 6. Copy tone

Plain, second person, active voice, no apology. The system enforces rules and should
say so without sounding punitive.

- "Your dues aren't cleared yet. 12 sessions are waiting to be counted." — not
  "Payment compliance violation detected."
- "Pay dues" — not "Proceed to payment portal."
- "Attendance closed for this session." — not "Oops! Something went wrong."
- Errors always state the fix. Empty states always state the next action.
- An action keeps its name through the flow: a button that says "Pay dues" produces
  a result that says "Dues paid," not "Transaction processed."
- Name things by what people control, not how the system is built — a student manages
  *their attendance*, not a `session_score` record.

---

## 7. Component conventions — shadcn/ui

shadcn/ui is not a black-box npm library — the CLI **copies source into this repo**
(`components/ui/`), so the project owns and edits every component. Underneath,
**Radix** primitives supply accessible behavior (focus trapping, keyboard navigation,
ARIA roles) for dialogs, dropdowns, popovers, and sheets.

```bash
npx shadcn@latest init                       # tailwind config, cn() util, CSS variables
npx shadcn@latest add button dialog form sheet badge table
```

Add only what a screen needs; don't bulk-install the catalog.

- **`cn()`** (`clsx` + `tailwind-merge`) for conditional classes — never manual string
  concatenation.
- **`cva`** for variants. `StatusBadge` (`counted | pending | locked |
  atRisk`) is the obvious case — declare variants, don't branch JSX.
- **Theme through the CSS variables in §3**, mapped onto shadcn's token names. Never
  hardcode hex inside components; dark mode and any palette change depend on this.
- **Own the code.** Once a component is in `components/ui/`, edit it directly rather
  than wrapping it in another abstraction.
- **Compose from primitives:** `AttendanceStrip`, `StatusBadge`, `AttendanceMeter`,
  `TokenEntrySheet`, `GraceOverrideDialog` all build on shadcn/Radix rather than raw
  HTML with hand-written ARIA.

### Mapping the palette onto shadcn tokens

```css
/* globals.css */
:root {
  --primary:                var(--brand);      /* #F0952B — crest orange */
  --primary-foreground:     var(--ink);        /* BLACK on orange — 8.52:1 */
  --accent:                 var(--brand-tint-2);
  --accent-foreground:      var(--ink);
  --destructive:            var(--danger);
  --destructive-foreground: #FFFFFF;
  --muted-foreground:       var(--muted);
  --border:                 var(--line);
}
```

**`--primary-foreground` must be black, not white.** shadcn's default button puts
`--primary-foreground` on `--primary`; left as white that renders white text on
`#F0952B` at **2.32:1** — a severe failure. Override during `init` and verify the
first button you build.

---

## 8. Screen and component patterns

### AttendanceStrip — the signature component

```
Semester strip:   ▮ ▮ ▮ ▮ ▯ ▮ ▮ ▮ ▯ ▯ ▯ …
```

- Filled cell = present (`--brand`); hollow = absent (1px `--line`)
- Manual/paper batch carries a small corner mark; tapping reveals "Recorded from
  paper register"
- Each cell needs an accessible label (`aria-label="Week 4, present"`) — the motif
  must not be the only carrier of meaning

The strip earns its place by carrying what a percentage cannot. The example above is a
student who attended eight straight and then stopped; a student who missed the first
three and has been perfect since has the same percentage and a completely different
future. That is the difference the whole forecast rests on, and the strip is where a
person can see it without doing arithmetic.

### StatusBadge
Icon + label + color, never color alone: "Counted" / "Absent" /
"Checking payment…" / "Attendance locked" / "At risk".

### AttendanceMeter
The 75% threshold is the whole point — the meter must show the line, not just the
value. A bare percentage with no threshold marker is a failed design here.
- Horizontal bar, orange fill, hard tick at 75% with a label
- Below the number, the actionable sentence: "You need 4 more lectures to reach 75%"
- `tabular-nums` on the percentage

### ForecastPanel
The projection for one course, and the screen that justifies the product. Three rules:
- **Every sentence names the course and a count.** Never "your attendance is low" — a
  student cannot act on that, and learns to stop reading.
- **The good case gets a sentence too.** A panel that only ever appears when something
  is wrong is one students dread and then avoid. "You could miss 3 and still be
  eligible" is the number a student on track actually wants.
- **When the threshold is out of reach, say so.** Asking a student to attend
  everything when everything is not enough is the one failure they cannot detect
  until it is far too late to matter.

The what-if control is a slider, not a form: "what if I miss the next two?" is a
question asked by dragging, not by typing a number and pressing a button.

### Student

**Dashboard** — the most-used screen. Priority top to bottom:
1. **Registration state** — if the deadline has passed unconfirmed, first thing on
   screen with the fix attached. It is the one thing that stops attendance working.
2. **ForecastPanel** per course — where they are headed, and the number that fixes it.
   Above the meter, because the meter answers a question the student can no longer
   change and the panel answers the one they can.
3. **AttendanceMeter** per course, with the 75% line.
4. **AttendanceStrip** for the semester.

**Code entry** — highest-frequency, most time-pressured interaction, in a noisy hall
with a few minutes on the clock.
- Big numeric input, `inputmode="numeric"`; **not** `autocomplete="one-time-code"` —
  this is not an SMS code and offering one surfaces the wrong keyboard suggestion
- **Never block paste**; auto-advance between digits but allow pasting the whole code
- Show the expiry countdown
- **No location step and no permission prompt.** The screen asks for one thing.
- One clear result: accepted, or rejected **with the reason** — "This code expired,"
  "That code isn't right," "You aren't registered for this course." A generic failure
  here generates disputes.
- On a bad connection: retry, then hold. The held state must not read as success —
  no tick, no green, and the words "you are not recorded yet". **Never** optimistic
  local state that says recorded.

**Payment** — Card and Pay with Transfer. Show the amount, the **balance** (instalments
are normal), the deadline, and what paying is actually for: the exam permit, never the
attendance. After paying, never leave an ambiguous screen: show "Checking payment…"
until the webhook confirms.

### Lecturer

**Session control** — one primary action at a time, large tap targets; operated while
standing in front of a class.
- Start Session → a single prominent **"Issue the code"** button
- Display the 4-digit code **very large** (it gets written on a whiteboard) with the
  expiry countdown
- Live count of submissions arriving
- One code per lecture. No "checkpoint 1 of 2", no confirm-on-end about pairs.

**Manual/paper batch** — reached only from a closed session. One checkbox per student
mirroring a sign-in sheet, mandatory justification note, explicit warning that the
entry is recorded as manually entered and is reviewable. Should feel heavier than the
normal flow — it is the one path with no code behind it.

**Schedule** — makeup / reschedule / cancel for own courses only. Cancelling states
its consequence: "This session won't count toward anyone's total."

### HOD
Academic governance; individual students visible.
- **At-risk list** — students projected below 75%, sorted by severity, each row
  showing the AttendanceStrip so the pattern is legible at a glance, the number of
  lectures that would fix it, and **a link to the student's record**. A row here
  starts a conversation; it does not end one.
- **Registration exceptions** — the highest-consequence control on the site. Show
  exactly who it affects and how many, require a reason, confirm before applying,
  state the expiry in plain language. Writes to the audit log.
- **Messaging** — one message, three audiences. The audience count is fetched live and
  repeated in the confirmation, because "message 412 students" is a different decision
  from "message 12".
- **Payment compliance** — by level, as a balance rather than a flag.
- **Waivers, disputes, final eligibility list** — the eligibility list is an
  authorization action, not an export; the confirm step is serious.
- HOD does **not** see dues configuration or the register.

### Admin
Operations only. Aggregate signals — **no individual student risk data of any kind**
(that is HOD scope; showing it here breaks separation of duties, and the data is
unreadable as this role rather than merely hidden).
- Register upload with a preview/diff before committing
- Registration disputes: revoke + reclaim, with reason, audit-logged
- Deactivation (Expelled / Withdrawn / Graduated / Other) — soft delete, confirm,
  reason required
- Level rollover — one bulk action with a strong confirmation showing how many students
  move and to what level; irreversible in practice
- The semester registration window — the control that decides who can record
  attendance at all
- System health: reconciliation failures, payment-integrity anomalies, aggregate
  compliance

### Layout rules
- **Mobile-first, always.** Students only ever use phones. Desktop is the HOD/admin
  secondary case.
- Tables collapse to stacked cards below `md` — never horizontal-scroll a data table
  as the primary mobile experience.
- Sticky primary action on mobile (pay, submit code) so it survives a long scroll.
- Bottom-sheet pattern for code entry and confirmations; `overscroll-behavior: contain`.
- Respect `env(safe-area-inset-*)`.

---

## 9. Pre-ship checklist

Adapted from Vercel's web-interface-guidelines, reweighted for this project: cellular
data, burst traffic in a 3–5 minute window, and legally-relevant state.

### Highest priority here

**Slow and failing networks**
- Every submission (token, payment, manual batch) survives a dropped connection:
  optimistic local state + retry, honest pending indicator.
- **Know the limit of this on a website.** Without a service worker, a queued
  submission only survives while the tab stays open — close the tab and it is gone.
  So: retry aggressively while the page is open, persist the pending submission to
  `localStorage` so a reload recovers it, and **never tell the student their
  attendance is recorded until the server has acknowledged it**. An optimistic
  "Recorded ✓" that silently fails is the worst possible outcome in this system,
  because the student walks away believing they are counted. Show "Sending…" then a
  confirmed state, and if it fails, say so loudly while they are still in the hall
  and can retry or tell the lecturer.
- Never leave a student ambiguous after payment — "Checking payment…" until the
  webhook lands.
- Loading states end with `…` and say what is happening.
- Skeletons over spinners; avoid layout shift on arrival.

**Performance**
- Lists over ~50 rows virtualized.
- Explicit `width`/`height` on every image; `loading="lazy"` below the fold.
- Preload one critical font with `font-display: swap`; no second font file.
- No layout reads during render; batch DOM reads/writes.
- `<link rel="preconnect">` for Paystack/CDN origins.

**Touch**
- `touch-action: manipulation`; minimum 44×44px tap targets.
- `overscroll-behavior: contain` in sheets and modals.
- Set `-webkit-tap-highlight-color` intentionally.
- Avoid `autoFocus` on mobile — it pops the keyboard and shifts layout.
- `env(safe-area-inset-*)` on full-bleed layouts.

### Accessibility
- Icon-only buttons need `aria-label`; every control needs a label.
- `<button>` for actions, `<a>`/`<Link>` for navigation — never `<div onClick>`.
- Images need `alt` (`alt=""` if decorative); decorative icons `aria-hidden="true"`.
- Async state changes need `aria-live="polite"`.
- Semantic HTML before ARIA. Headings in order. Include a skip link.
- **Never encode status by color alone.**
- AttendanceStrip needs per-cell accessible labels.

### Focus
- Visible focus everywhere via `focus-visible:ring-*`; never `outline-none` without a
  replacement; prefer `:focus-visible`; `:focus-within` for compound controls.
- On submit with errors, move focus to the first error.

### Forms
- **Never block paste** — breaks OTP and token entry.
- Correct `type`/`inputmode`; `autocomplete="one-time-code"` for OTP.
- Disable spellcheck on matric numbers, OTP codes, tokens.
- Labels clickable; checkbox/radio share one hit target.
- Submit stays enabled until the request starts — flaky connections need retries.
- Errors inline and state the fix; placeholders show the real format.
- Warn before navigating away from unsaved input.

### Animation
- Honor `prefers-reduced-motion`; animate only `transform`/`opacity`; never
  `transition: all`; animations interruptible.
- Almost nothing here earns an animation. The tier change on a forecast panel is the
  one candidate, and even that is better as a state than a transition — a student
  arriving at Critical should read it, not watch it.

### Typography and numbers
- `tabular-nums` wherever numbers stack or update.
- `…` not `...`; curly quotes; non-breaking spaces in "30 m", "Dept-Flow".
- `text-wrap: balance` on headings.

### Content handling
- Long course/student names need `truncate` / `line-clamp-*` / `break-words`; flex
  children need `min-w-0`.
- Every list has a designed empty state stating the next action.

### Navigation and state
- URL reflects state — filters, tabs, selected student, pagination in query params.
- Deep-link stateful views.
- **Destructive and authority actions confirm**: deactivation, revoke registration,
  grace period, manual batch, level rollover. All write audit logs.

### Locale
- `Intl.DateTimeFormat` for all dates/times — critical around the Day-30/31 midnight
  boundary; never hardcode a format.
- `Intl.NumberFormat` for Naira amounts.
- `translate="no"` on matric numbers and course codes.

### Dark mode
- `color-scheme: dark` on `<html>`; `theme-color` matches surface.
- Native `<select>` needs explicit `background-color` and `color`.
- Brand orange needs no change on dark; only the text variant lightens.

### Hydration (Next.js)
- Inputs with `value` need `onChange`, or use `defaultValue`.
- Guard date/time hydration mismatches — the site has a hard midnight boundary.
- `suppressHydrationWarning` only where justified.

### Reject on sight
- `user-scalable=no` / `maximum-scale=1`
- `onPaste` + `preventDefault`
- `transition: all`
- `outline-none` with no replacement
- `<div>`/`<span>` with click handlers
- Images without dimensions; long lists without virtualization
- Inputs without labels; icon buttons without `aria-label`
- Hardcoded date/number formats
- Brand Orange `#FF9935` as text on white (**2.13:1**) — darken to `#A85E0A`
- **White text on orange** — the most likely mistake in this project
- Status conveyed by color alone
- The full crest at favicon/header size instead of the simplified mark
- Any biometric/fingerprint/selfie UI — not part of this system
- **Any location UI at all** — no coordinates, no map, no distance, no permission
  prompt. There is nothing left to show one of.
- A held offline submission rendered as success — no tick, no green

---

## 10. Non-negotiables

- **Never invent a state.** The only compliance states are those in
  `docs/system-operation-and-logic.md`: provisional, confirmed, pending verification,
  locked, cleared. The forecast tiers are exactly three: safe, watch, critical. Don't
  add "partial," "warning," or "review" to the UI vocabulary.
- **A held submission must never look like a recorded one.** This is the descendant of
  the old "provisional must never look like confirmed" rule, and it is now sharper: a
  student who sees a tick and walks out of the hall uncounted is the worst failure
  this system can produce. No optimistic state, ever.
- **Never promise a threshold that cannot be reached.** Where attending every
  remaining lecture still finishes below 75%, say that. Asking a student to do
  something that will not work is a lie they cannot detect until it is too late to
  matter.
- **No location UI anywhere.** Not a map, not a coordinate, not a distance, not a
  permission prompt. Attendance is trust-based; a screen that asked for a position
  would be collecting something this system has undertaken not to keep.
- **Authority actions confirm and log.** Deactivation, revoking a registration,
  granting an exception, submitting a manual batch, messaging a level — confirmation
  step plus reason field.
- **No biometrics anywhere.** No fingerprint prompts, no selfie capture — not in the
  system, must not appear in a mockup.

---

## 11. Workflow

1. **Name the screen's job and its one user.** "The HOD's grace-period override — a
   rare, high-consequence action by one authority figure who must trust it" beats "an
   admin panel."
2. **Check §8** for an existing pattern before inventing one.
3. **Build with shadcn/ui** per §7.
4. **Run §9** before calling anything done.
5. **Critique once.** Screenshot it. Would this read correctly to a student glancing
   for two seconds on a cracked screen in daylight? Cut anything that doesn't serve
   that.

---

## Sources

Adapted for this project from: Anthropic `frontend-design` (subject-grounded process,
copy principles, avoiding generic AI-default looks); `ui-ux-pro-max` (explicit
style/palette/anti-pattern selection); `shadcn-ui/ui` (component conventions); Vercel
`web-design-guidelines` / `web-interface-guidelines` (accessibility and interface rule
set). A fifth requested source, `supercent-io/skills-template` web-accessibility, was
unreachable (404) — its ground is covered by §9's accessibility and focus sections.
