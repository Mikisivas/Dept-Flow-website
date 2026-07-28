---
name: dept-flow-design
description: The design system and frontend workflow for Dept-Flow. Use when building or reviewing any UI in this project — pages, components, dashboards, forms, status indicators — or when choosing colors, typography, or layout, adding shadcn/ui components, or auditing a screen before shipping. Encodes the technology stack, the SAMACOSS-derived palette (orange/white/black), the checkpoint-pair visual signature, per-role screen patterns, and the accessibility rules this project must not break. Triggers on "design this page", "build this component", "what color should this be", "review this UI", "add a shadcn component".
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
| Cache | **Redis** | Hot-path compliance check during checkpoint bursts |
| Payments | **Paystack** | Card + Pay with Transfer, webhook-verified |
| ML | **scikit-learn** | Advisory regression only |

**Why Tailwind + shadcn + Radix:** Tailwind keeps styling utility-first with no second
CSS framework and no unused-rule bloat, which matters on metered data. shadcn ships
**Radix** primitives, which supply keyboard navigation, focus trapping, and ARIA roles
for free — most of the accessibility checklist in §9 is satisfied by using them instead
of hand-rolled markup. Radix is unstyled, so it takes the palette in §3 without
fighting it. Bundles stay small.

**Why Redis:** the load pattern is bursty, not sustained — hundreds of students
submitting inside the same 3–5 minute token window across parallel classes. Caching
the "is this student cleared / provisional / locked" lookup keeps a database
round-trip off the hot path. Postgres alone would survive a demo; Redis is what makes
the scalability claim defensible at 5,000 students.

For Chapter 3 (Research Instruments/Tools), list all of these **with versions** —
that section is graded on reproducibility.

---

## 2. The design thesis

Dept-Flow is an **institutional instrument**, not a consumer product. It decides whether
a student sits an exam. It should read as precise, legible, and trustworthy —
tabular, high-contrast, low-decoration. When in doubt, choose the version that looks
like a well-made register rather than a startup landing page.

**The signature element: the checkpoint pair.** Dept-Flow's one genuinely unusual
mechanic is that a lecture is scored `0 / 0.5 / 1.0` from two checkpoints. Make that
the recurring visual motif — every session renders as two cells:

```
▮▮  Full (1.0)      ▮▯  Half (0.5)      ▯▯  Absent (0)      ⌐⌐  Provisional
```

Orange fills a captured checkpoint; an outline marks a missed one. This scales from
a single list row to a full semester strip, and it comes from the system's own logic
rather than a template. Spend the design's boldness here and keep everything around
it quiet.

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
  /* provisional has no colour of its own — see below */
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
| Provisional | **Neutral, dashed outline** — not a warning, just *not yet counted* |
| Pending verification | Blue `--info` — system is working, student need do nothing |
| Locked | Red `--danger`, filled |
| At risk (advisory) | Red **outlined**, not filled — lower emphasis than Locked |

Never encode a state by color alone: every status carries an icon or text label too,
so it survives color-blindness and a bad phone screen in bright daylight.

### Why provisional has no color

Provisional attendance is not a warning and not an error — it is a record that exists
but does not yet count. Giving it a color implies a judgment. Instead: **dashed 1px
border**, `--muted` text, no fill; checkpoint cells render hollow with a dashed edge;
always paired with the sentence explaining it and the action that fixes it.

Once the student clears, those cells fill solid orange and the border goes solid.
That hollow→filled transition is the most important visual moment in the product —
it is the payoff for paying dues. Design it deliberately (a brief fill animation is
justified here; honor `prefers-reduced-motion`).

### Budgeting orange

Orange is loud. A screen where everything is orange loses hierarchy and stops looking
institutional.

- **~10% of the screen maximum** — primary action, checkpoint motif, active nav item.
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
Empty states are typographic plus a single icon. The checkpoint motif is CSS/SVG. The
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
- **`cva`** for variants. `StatusBadge` (`confirmed | provisional | pending | locked |
  atRisk`) is the obvious case — declare variants, don't branch JSX.
- **Theme through the CSS variables in §3**, mapped onto shadcn's token names. Never
  hardcode hex inside components; dark mode and any palette change depend on this.
- **Own the code.** Once a component is in `components/ui/`, edit it directly rather
  than wrapping it in another abstraction.
- **Compose from primitives:** `CheckpointStrip`, `StatusBadge`, `AttendanceMeter`,
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

### CheckpointStrip — the signature component

```
Single session:   ▮▮ 1.0     ▮▯ 0.5     ▯▯ 0     ⌐⌐ provisional (dashed)
Semester strip:   ▮▮ ▮▯ ▮▮ ▮▮ ▯▯ ▮▮ ▮▯ ▮▮ …
```

- Filled cell = accepted checkpoint (`--brand`); hollow = missed (1px `--line`);
  dashed = provisional
- **Single-checkpoint session** (lecturer issued one token) renders as one wide cell,
  so it is visibly not a pair — never fake a second cell
- Manual/paper batch carries a small corner mark; tapping reveals "Recorded from
  paper register"
- Each cell needs an accessible label (`aria-label="Week 4, both checkpoints
  captured"`) — the motif must not be the only carrier of meaning

### StatusBadge
Icon + label + color, never color alone: "Counted" / "Not yet counted" /
"Checking payment…" / "Attendance locked" / "At risk".

### AttendanceMeter
The 75% threshold is the whole point — the meter must show the line, not just the
value. A bare percentage with no threshold marker is a failed design here.
- Horizontal bar, orange fill, hard tick at 75% with a label
- Below the number, the actionable sentence: "You need 4 more full sessions to reach 75%"
- Provisional sessions show as a dashed segment beyond the solid fill, so the student
  sees what clearing would gain them
- `tabular-nums` on the percentage

### Student

**Dashboard** — the most-used screen. Priority top to bottom:
1. **Compliance state** — if locked or provisional, first thing on screen with the fix
   action attached. Never bury it under a greeting.
2. **AttendanceMeter** per course, with the 75% line.
3. **CheckpointStrip** for the semester.
4. Risk nudge, worded by pattern: trending 0s → "You've missed 3 full classes";
   trending 0.5s → "You're catching only one checkpoint — try to stay till the end."

**Token entry** — highest-frequency, most time-pressured interaction, in a noisy hall
with a 3–5 minute window.
- Big numeric input, `inputmode="numeric"`, `autocomplete="one-time-code"`
- **Never block paste**; auto-advance between digits but allow pasting the whole code
- Show the expiry countdown
- One clear result: accepted (and which checkpoint), or rejected **with the reason** —
  "You're outside the lecture hall," "This code expired," "Your account is locked."
  A generic failure here generates disputes.
- Must work on a bad connection: optimistic local state + retry, with an honest "not
  yet confirmed" indicator until the server acknowledges

**Payment** — Card and Pay with Transfer. Show the amount, the deadline, and what
clearing unlocks ("This will count your 12 waiting sessions"). After paying, never
leave an ambiguous screen: show "Checking payment…" until the webhook confirms.

### Lecturer

**Session control** — one primary action at a time, large tap targets; operated while
standing in front of a class.
- Start Session → a single prominent **"Generate checkpoint code"** button
- Display the 4-digit code **very large** (it gets written on a whiteboard) with the
  expiry countdown
- Live count of submissions arriving
- Clearly indicate which checkpoint this is and that a second is expected
- End Session confirms if only one checkpoint was issued ("This session will be scored
  present/absent, not out of two checkpoints — continue?")

**Manual/paper batch** — reached only from a closed session. Two-column entry
mirroring the paper sheet, mandatory justification note, explicit warning that the
entry is flagged and reviewable. Should feel heavier than the normal flow — it
bypasses the anti-proxy checks.

**Schedule** — makeup / reschedule / cancel for own courses only. Cancelling states
its consequence: "This session won't count toward anyone's total."

### HOD
Academic governance; individual students visible.
- **Risk list** — students trending below 75%, sorted by severity, each row showing
  the CheckpointStrip so the pattern is legible at a glance
- **Grace period control** — the highest-consequence control on the site. Show exactly
  who it affects and how many, require a reason, confirm before applying, state the
  expiry in plain language. Writes to the audit log.
- **Waivers, disputes, final eligibility list** — the eligibility list is an
  authorization action, not an export; the confirm step is serious.
- HOD does **not** see dues configuration, geo-fence coordinates, or the whitelist.

### Admin
Operations only. Aggregate signals — **no individual student risk alerts** (that is
HOD scope; showing it here breaks separation of duties).
- Whitelist upload with a preview/diff before committing
- Registration disputes: revoke + reclaim, with reason, audit-logged
- Deactivation (Expelled / Withdrawn / Graduated / Other) — soft delete, confirm,
  reason required
- Level rollover — one bulk action with a strong confirmation showing how many students
  move and to what level; irreversible in practice
- System health: reconciliation failures, GPS-rejection spikes, aggregate compliance

### Layout rules
- **Mobile-first, always.** Students only ever use phones. Desktop is the HOD/admin
  secondary case.
- Tables collapse to stacked cards below `md` — never horizontal-scroll a data table
  as the primary mobile experience.
- Sticky primary action on mobile (pay, submit code) so it survives a long scroll.
- Bottom-sheet pattern for token entry and confirmations; `overscroll-behavior: contain`.
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
- CheckpointStrip needs per-cell accessible labels.

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
- The provisional→confirmed fill is the one place worth a deliberate animation.

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
- Brand Orange `#F0952B` as text on white (2.32:1)
- **White text on orange** — the most likely mistake in this project
- Status conveyed by color alone
- The full crest at favicon/header size instead of the simplified mark
- Any biometric/fingerprint/selfie UI — not part of this system
- Raw GPS coordinates displayed to any user

---

## 10. Non-negotiables

- **Never invent a state.** The only compliance states are those in
  `docs/system-operation-and-logic.md`: provisional, confirmed, pending verification,
  locked, cleared. Don't add "partial," "warning," or "review" to the UI vocabulary.
- **Provisional must never look like confirmed.** A student with 12 provisional
  sessions has *nothing counted yet*. A reassuring number there actively misleads them.
- **Never show raw GPS coordinates.** Location is captured momentarily and purged; the
  UI shows pass/fail only.
- **Authority actions confirm and log.** Deactivation, revoking a registration,
  granting grace, submitting a manual batch — confirmation step plus reason field.
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
