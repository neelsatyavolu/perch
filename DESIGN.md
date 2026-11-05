---
version: 1
name: Perch
extends: ~/DESIGN.md (Blackletter v2)
description: |
  Perch's interface: Blackletter's tokens, type and rules, adapted for a browser people
  look at all day. The chrome stays quiet so the websites carry the colour. A theme
  changes every surface, text and accent token at once; layout, type and spacing never change.
---

# Perch design system

Perch follows `~/DESIGN.md` (Blackletter) and the unslop rules (unslop by Damir Sokolovsky, @heydamir, CC BY 4.0). This file records what is different for a browser, and the themes. Where this file is silent, Blackletter applies.

## What changes from Blackletter

| Blackletter | Perch | Why |
|---|---|---|
| 64px nav bar, 96–128px section rhythm | Tab strip 36, toolbar 40, sidebar header 44, rows 32, menu rows 28 | A browser frame is dense; height belongs to the page |
| Body 15px | Chrome 13px, chat 14px, captions 12px | Matches Chrome and Safari so Perch feels native |
| No shadows at all | Menus, popovers and the approval card may use one soft neutral shadow | Floating layers over arbitrary web pages need separation that a hairline alone can't give on a white site |
| Serif hero on every page | Geist Serif only on the new tab page title, empty states and the welcome screen, at 40px or larger | The chrome is a tool, not an editorial |
| Dark and light | Five themes and five accents (below) | People live in a browser; it should feel like theirs |
| One accent use list | Accent marks: the perch dot, focus rings, the selected row, text selection, the search engine chip, links in chat, the active artifact | Same restraint, named for browser surfaces |

Everything else carries over: Geist / Geist Mono / Geist Serif, weights 400 and 500, the 4px grid, radii (controls and tabs 8, cards and panels 12, inner elements 8), three text roles plus `stone`, hairlines for depth, the single easing curve, no gradients, glows, glass or emoji.

## Themes

A theme sets every colour token. The accent is chosen separately and works on every theme. The default is Ink with Blue.

| Token | Ink | Graphite | Dusk | Paper | Contrast |
|---|---|---|---|---|---|
| canvas (tab strip, sidebar) | `#000000` | `#1C1D20` | `#0E1116` | `#F4F5F7` | `#000000` |
| card (toolbar, active tab, pages) | `#0E0E10` | `#232428` | `#141922` | `#FFFFFF` | `#000000` |
| elevated (address bar, chips) | `#1A1A1E` | `#2B2C31` | `#1B2130` | `#ECEEF1` | `#141414` |
| ink | `#FCFDFF` | `#F2F3F5` | `#EEF2F8` | `#0A0A0C` | `#FFFFFF` |
| body | ink at 86% | ink at 86% | ink at 86% | ink at 82% | `#FFFFFF` |
| mute | `#A1A4A5` | `#9A9DA3` | `#8E98A8` | `#5F6366` | `#C8C8C8` |
| hairline | white 6% | white 7% | white 7% | black 6% | white 28% |
| hairline-strong | white 14% | white 14% | white 14% | black 12% | white 50% |
| primary button | `#FCFDFF` on `#000000` | `#F2F3F5` on `#1C1D20` | `#EEF2F8` on `#0E1116` | `#0A0A0C` on `#FFFFFF` | `#FFFFFF` on `#000000` |

- **Ink**: Blackletter dark. True black canvas; card and elevated sit one clear step up each (design review, 2026-11-05: Blackletter's `#0A0A0C` and `#111114` were too close to black to separate tabs, toolbar and fields).
- **Graphite**: a neutral grey for people who find black too stark. Close to Chrome's and Aside's dark grey.
- **Dusk**: a blue-grey dark for night reading.
- **Paper**: Blackletter light.
- **Contrast**: for low vision and bright rooms. It turns on automatically with macOS Increase Contrast.

"Match system" switches between a dark theme the user picks (Ink by default) and Paper.

## Accents

| Accent | On dark themes | On Paper | Note |
|---|---|---|---|
| Blue (default) | `#4C8DFF` | `#2B68D6` | Blackletter's accent, a shade darker on Paper |
| Teal | `#2EC4B6` | `#0B7C73` | |
| Amber | `#F5A524` | `#9C5A00` | |
| Rose | `#FF6B8A` | `#C93558` | |
| Mono | `#E6E8EB` | `#2A2C30` | No hue; the perch dot and selection use ink |

Accent tint is the accent at 22% over the elevated colour on dark themes and 10% on Paper; selected rows also get a 2px accent edge on the left, so selection reads at a glance. Every accent meets 4.5:1 as text on its theme's card and canvas colours. Small text on elevated surfaces uses ink, not the accent. Links in chat are underlined (2px offset) so the Mono accent still reads as a link. Purple and gradients are not offered (Blackletter's rule).

State colours: ok `#3DD68C`, warn `#FFC53D`, danger `#FF453A` on dark themes (moved away from Rose), `#D92D3F` on Paper. State is always said in words too; a coloured dot never stands alone.

## Surfaces in the browser

- **Tab strip and sidebar**: canvas. **Toolbar, active tab and Perch's own pages**: card. The active tab joins the toolbar so the two read as one piece.
- **Address bar**: elevated, 28px tall, 8px radius. Focus, here and on every control: a 2px solid accent outline with a 2px offset (a 45% ring failed the 3:1 rule for controls).
- **Tabs**: flexible width, 72 to 220px, shrinking as tabs are added; a 16px close button shows on hover, focus and the active tab; a 1×16px hairline separates inactive tabs. A browser menu button (28×28) ends the toolbar. Agent tabs sit in a tab group labelled "Agent" (20px chip, 8px radius, accent tint).
- **Switches**: the knob is ink-on-canvas dark (`btn-fg`) on dark themes and white on Paper, so it shows on every accent.
- **Sleeping tabs** (memory saver): title in mute colour with a 12px moon icon. Never lowered opacity: a sleeping tab must stay readable (AA) and clickable.
- **The perch dot**: 6px accent circle. On a tab the agent is using and in the sidebar header while a task runs, breathing (opacity 1 to 0.35, 2.4s). While a task waits for approval it is still: one static dot on the profile button, and nothing breathes. It appears nowhere else; cards and hints say the state in words.
- **Approval card**: card surface, hairline-strong border, 12px radius. It shows exactly what will be sent; the confirm button names the action ("Send message", "Pay $42.18").

## New tab page

- A 640px column: the Perch mark (48px), then the address box (640×48, 12px radius) with a Search | Ask segmented control (28px tall) at its right end; the shortcuts (`Tab` Google, `⌘↵` Ask) sit in 12px mute text under the box.
- A collapsible chat rail on the left (200px): New chat, Search chats, then recent chats, as in Aside.
- Below the box: "Chats" and "Routines" switcher, three recent cards (elevated fill, no border, 16px padding, 112px tall, title plus two lines, time in mono), then "Suggested": lighter cards (transparent, 24px icon tile, 80px tall). A suggestion disappears once its job is done; after setup the suggestions become tasks to run ("Summarise unread mail").
- No greeting headline. Users can hide each section.

## Chat

- Replies have copy, branch and a timestamp on hover. The composer's mode, tab scope and model are real controls (24px, elevated fill, 6px radius), not captions.
- While an approval card is up it is the only status in the thread: no separate "working" row. The card uses the elevated surface with a hairline, no shadow.
- Full-page chat: chat list 200px (collapses below 1100px), conversation at least 480px, artifact pane 360px and resizable.

## Motion

Blackletter's curve, `cubic-bezier(0.2, 0, 0, 1)`. 120ms hover and press, 180ms menus, 240ms the sidebar. Only colour, opacity and transform animate. Reduce Motion makes changes instant.
