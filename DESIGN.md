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
| card (toolbar, active tab, pages) | `#0A0A0C` | `#232428` | `#141922` | `#FFFFFF` | `#000000` |
| elevated (address bar, chips) | `#111114` | `#2B2C31` | `#1B2130` | `#ECEEF1` | `#141414` |
| ink | `#FCFDFF` | `#F2F3F5` | `#EEF2F8` | `#0A0A0C` | `#FFFFFF` |
| body | ink at 86% | ink at 86% | ink at 86% | ink at 82% | `#FFFFFF` |
| mute | `#A1A4A5` | `#9A9DA3` | `#8E98A8` | `#5F6366` | `#C8C8C8` |
| hairline | white 6% | white 7% | white 7% | black 6% | white 28% |
| hairline-strong | white 14% | white 14% | white 14% | black 12% | white 50% |
| primary button | `#FCFDFF` on `#000000` | `#F2F3F5` on `#1C1D20` | `#EEF2F8` on `#0E1116` | `#0A0A0C` on `#FFFFFF` | `#FFFFFF` on `#000000` |

- **Ink**: Blackletter dark. True black chrome.
- **Graphite**: a neutral grey for people who find black too stark. Close to Chrome's and Aside's dark grey.
- **Dusk**: a blue-grey dark for night reading.
- **Paper**: Blackletter light.
- **Contrast**: for low vision and bright rooms. It turns on automatically with macOS Increase Contrast.

"Match system" switches between a dark theme the user picks (Ink by default) and Paper.

## Accents

| Accent | On dark themes | On Paper | Note |
|---|---|---|---|
| Blue (default) | `#4C8DFF` | `#2F6FE0` | Blackletter's accent |
| Teal | `#2EC4B6` | `#0B7C73` | |
| Amber | `#F5A524` | `#A86200` | |
| Rose | `#FF6B8A` | `#C93558` | |
| Mono | `#E6E8EB` | `#2A2C30` | No hue; the perch dot and selection use ink |

Accent tint is the accent at 14% on dark themes and 10% on Paper. Every accent meets 4.5:1 as text on its theme's card colour. Purple and gradients are not offered (Blackletter's rule).

## Surfaces in the browser

- **Tab strip and sidebar**: canvas. **Toolbar, active tab and Perch's own pages**: card. The active tab joins the toolbar so the two read as one piece.
- **Address bar**: elevated, 28px tall, 8px radius. Focus: 1px accent border plus a 3px accent ring at 45%.
- **Sleeping tabs** (memory saver): title and favicon at 45% opacity.
- **The perch dot**: 6px accent circle. On a tab the agent is using, in the sidebar header while a task runs, and on the profile button while a task waits for approval. It breathes (opacity 1 to 0.35, 2.4s) only while a task is really running.
- **Approval card**: card surface, hairline-strong border, 12px radius. It shows exactly what will be sent; the confirm button names the action ("Send message", "Pay $42.18").

## New tab page

- Centred Perch mark (48px), then the address box at 640px wide and 48px tall with 12px radius. Placeholder "Search or ask". Right side hints: `Tab` Google, `⌘↵` Ask.
- Below: "Chats" and "Routines" switcher, three recent cards (title, two lines, time in mono), then "Suggested" with three flat cards: Set up your memory, Find routines to automate, Import from another browser. Cards use an icon tile in elevated colour; no gradient art.
- No greeting headline. Users can hide each section.

## Motion

Blackletter's curve, `cubic-bezier(0.2, 0, 0, 1)`. 120ms hover and press, 180ms menus, 240ms the sidebar. Only colour, opacity and transform animate. Reduce Motion makes changes instant.
