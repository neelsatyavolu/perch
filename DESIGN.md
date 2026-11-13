---
version: 2
name: Perch
extends: ~/DESIGN.md (Ledger v3)
description: |
  Perch's interface: Ledger's tokens, type and rules, adapted for a browser people
  look at all day. The chrome stays quiet so the websites carry the colour. A theme
  changes every surface, text and accent token at once; layout, type and spacing never change.
---

# Perch design system

Perch follows `~/DESIGN.md` (Ledger) and the unslop rules (unslop by Damir Sokolovsky, @heydamir, CC BY 4.0). This file records what is different for a browser, and the themes. Where this file is silent, Ledger applies.

## What changes from Ledger

| Ledger | Perch | Why |
|---|---|---|
| 64px nav bar, 96–128px section rhythm | Tab strip 36, toolbar 40, sidebar header 44, rows 32, menu rows 28 | A browser frame is dense; height belongs to the page |
| Body 15px | Chrome 13px, chat 14px, captions 12px | Matches Chrome and Safari so Perch feels native |
| No shadows, blur or glass | Popups are glass: menus, bubbles and the pickers in Perch's own pages sit on a blurred backdrop under a thin tint with a hairline edge. Nothing else blurs, and nothing casts a shadow | The owner asked for popups that stay glassy; a floating layer over an arbitrary web page needs separation a hairline alone can't give |
| Serif hero on every page | Newsreader only on the new tab page title, empty states and the welcome screen, at 40px or larger | The chrome is a tool, not an editorial |
| Dark and light | Seven themes and six accents (below), including Sakura mode | People live in a browser; it should feel like theirs |
| One accent use list | Accent marks: the perch dot, focus rings, text selection, the search engine chip, links in chat, the active artifact | Same restraint, named for browser surfaces |

Everything else carries over: Newsreader / Geist / Geist Mono, weights 400 and 500, the 4px grid, radii (controls, rows and chips 8, panels, menus, dialogs and cards 12, the composer and the new tab address box 16, pills full; owner's Aside-parity layout, 2026-11-11). The native chrome (toolbar buttons, menu rows, menus) stays tighter: 4 for buttons and rows, 6 for menus and bubbles, three text roles plus `stone`, hairlines for depth, the single easing curve, no gradients, glows, glass (menus aside) or emoji.

## Themes

A theme sets every colour token. The accent is chosen separately and works on every theme. The default is Ink with Blue.

| Token | Ink | Graphite | Dusk | Paper | Contrast | Sakura | Yozakura |
|---|---|---|---|---|---|---|---|
| canvas (tab strip, sidebar) | `#0E0E0D` | `#1C1D20` | `#0E1116` | `#F7F5EF` | `#000000` | `#FAF2F4` | `#150F12` |
| card (toolbar, active tab, pages) | `#141413` | `#232428` | `#141922` | `#FBFAF6` | `#000000` | `#FDF7F8` | `#1C1418` |
| elevated (address bar, chips) | `#1A1A18` | `#2B2C31` | `#1B2130` | `#EFECE4` | `#141414` | `#F3E2E7` | `#261B20` |
| ink | `#F2F0EA` | `#F2F3F5` | `#EEF2F8` | `#16161A` | `#FFFFFF` | `#2A1A1F` | `#F8E9ED` |
| body | ink at 86% | ink at 86% | ink at 86% | ink at 86% | `#FFFFFF` | ink at 86% | ink at 86% |
| mute | `#8B8A87` | `#9A9DA3` | `#8E98A8` | `#676667` | `#C8C8C8` | `#765C64` | `#A88E96` |
| hairline | ink at 8% | white 7% | white 7% | ink at 10% | white 28% | ink at 10% | ink at 8% |
| hairline-strong | ink at 18% | white 14% | white 14% | ink at 22% | white 50% | ink at 22% | ink at 18% |
| primary button | `#F2F0EA` on `#0E0E0D` | `#F2F3F5` on `#1C1D20` | `#EEF2F8` on `#0E1116` | `#16161A` on `#F7F5EF` | `#FFFFFF` on `#000000` | `#2A1A1F` on `#FAF2F4` | `#F8E9ED` on `#150F12` |

- **Ink**: Ledger dark. Warm off-black, not pure black; card and elevated are Ledger's `surface-card` and `surface-hover`.
- **Graphite**: a neutral grey for people who find black too stark. Close to Chrome's and Aside's dark grey.
- **Dusk**: a blue-grey dark for night reading.
- **Paper**: Ledger light, on warm paper.
- **Contrast**: for low vision and bright rooms. It turns on automatically with macOS Increase Contrast.
- **Sakura**: cherry-blossom light. Blush paper and a warm sumi ink with a red-brown cast, never purple. Picking it turns on Sakura mode (below).
- **Yozakura**: night sakura, its dark partner. A plum-brown dark with blush ink.

"Match system" switches between a dark theme the user picks (Ink by default) and Paper; with Yozakura as the dark theme, the light side is Sakura instead.

## Accents

| Accent | On dark themes | On Paper and Sakura | Note |
|---|---|---|---|
| Blue (default) | `#4C8DFF` | `#2A63CC` | Ledger's accent |
| Teal | `#2EC4B6` | `#0B7C73` | |
| Amber | `#F5A524` | `#9C5A00` | |
| Rose | `#FF6B8A` | `#C93558` | |
| Mono | `#E6E8EB` | `#2A2C30` | No hue; the perch dot and selection use ink |
| Sakura | `#F5A3BC` | `#B03762` | Blossom pink on dark, cherry on light |

Accent tint is the accent at 22% over the elevated colour on dark themes and 10% on Paper; it is used for text selection and the search engine chip. Selected rows, picked options and the current step are a surface step (elevated) with a hairline ring and ink text, never an accent fill or an accent edge on a rounded row (owner review, 2026-11-05). Every accent meets 4.5:1 as text on its theme's card and canvas colours. Small text on elevated surfaces uses ink, not the accent. Links in chat are underlined (2px offset) so the Mono accent still reads as a link. Purple and gradients are not offered (Blackletter's rule).

State colours: ok `#4FBF85`, warn `#D9A23A`, danger `#EE5A4B` on dark themes, `#BC2E23` on Paper. State is always said in words too; a coloured dot never stands alone.

## Surfaces in the browser

- **Tab strip and sidebar**: canvas. **Toolbar, active tab and Perch's own pages**: card. The active tab joins the toolbar so the two read as one piece.
- **Address bar**: 28px tall, 4px radius (chips inside it 4px); it sits on the toolbar colour at rest and steps to elevated on hover and focus. Focus, here and on every control: a 2px solid accent outline with a 2px offset (a 45% ring failed the 3:1 rule for controls).
- **Tabs**: flexible width, 72 to 220px, shrinking as tabs are added; a 16px close button shows on hover, focus and the active tab; a 1×16px hairline separates inactive tabs. A browser menu button (28×28) ends the toolbar. Agent tabs sit in a tab group labelled "Agent" (20px chip, 8px radius, accent tint).
- **Switches**: on uses the primary button's colours (`btn-bg` track, `btn-fg` knob; white knob on Paper), so a page of switches doesn't fill with the accent.
- **Sleeping tabs** (memory saver): title in mute colour with a 12px moon icon. Never lowered opacity: a sleeping tab must stay readable (AA) and clickable.
- **The perch dot**: 6px accent circle. On a tab the agent is using and in the sidebar header while a task runs, breathing (opacity 1 to 0.35, 2.4s). While a task waits for approval it is still: one static dot on the profile button, and nothing breathes. It appears nowhere else; cards and hints say the state in words.
- **Approval card**: card surface, hairline-strong border, 12px radius. It shows exactly what will be sent; the confirm button names the action ("Send message", "Pay $42.18").

## New tab page

- A 680px column: the Perch mark (48px), then the address box (680 wide, 16px radius) with a Search | Ask segmented control (28px tall) at its right end; the shortcuts (`Tab` Google, `⌘↵` Ask) sit in 12px mute text under the box.
- A collapsible chat rail on the left (270px, rows 32px with 8px radius): New chat, Search chats, then recent chats, as in Aside.
- Below the box: "Chats" and "Routines" switcher, three recent cards (elevated fill, no border, 16px padding, 112px tall, title plus two lines, time in mono), then "Suggested": lighter cards (transparent, 32px icon tile, 104px tall). A suggestion disappears once its job is done; after setup the suggestions become tasks to run ("Summarise unread mail").
- No greeting headline. Users can hide each section.

## Chat

- Replies have copy, branch and a timestamp on hover. The composer's mode, tab scope and model are real controls (24px, elevated fill, 8px radius), not captions.
- While an approval card is up it is the only status in the thread: no separate "working" row. The card uses the elevated surface with a hairline, no shadow.
- Full-page chat: chat list 200px (collapses below 1100px), conversation at least 480px, artifact pane 360px and resizable.

## Sakura mode

The one place Perch decorates. It is on while the Sakura or Yozakura theme shows, and everywhere else stays as quiet as this file says.

- **Petals**: a few cherry petals (8 to 14, 10–16px, the accent and two blush tints, never more than 60% opacity) drift down the new tab page and the welcome screen, under the content and never over a control. They are CSS animations of transform and opacity only, which the browser doesn't draw in a hidden tab. With Reduce Motion they rest in place instead.
- **The branch**: a blossoming branch drawn in the new tab page's top right corner (280×200), line art in mute with blossoms in the accent's tints. Decorative only (aria-hidden), hidden below 900px wide.
- **The blossom mark**: the dot in the Perch mark becomes a five-petal blossom in the accent, on Perch's own pages and in the sidebar; on the welcome screen it drifts down turning instead of dropping. The 6px status dot stays a dot (a blossom that small is a smudge).
- **Petal burst**: sending a chat message lets six petals fall from the send button over 900ms. Never with Reduce Motion.
- **Turning it on**: Settings › Appearance › Sakura mode picks Sakura (Yozakura from a dark theme) and the Sakura accent; off goes back to Paper or Ink with Blue. Picking either theme directly works too.
- Pink is the accent Sakura mode suggests, but any accent works on both themes and every accent meets 4.5:1 on them.

## Motion

Ledger's curve, `cubic-bezier(0.2, 0, 0, 1)`. 120ms hover and press, 180ms menus, 240ms the sidebar. Only colour, opacity and transform animate. Reduce Motion makes changes instant.
