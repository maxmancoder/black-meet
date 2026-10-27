---
name: Obsidian Flux
colors:
  surface: '#0b1326'
  surface-dim: '#0b1326'
  surface-bright: '#31394d'
  surface-container-lowest: '#060e20'
  surface-container-low: '#131b2e'
  surface-container: '#171f33'
  surface-container-high: '#222a3d'
  surface-container-highest: '#2d3449'
  on-surface: '#dae2fd'
  on-surface-variant: '#c7c4d8'
  inverse-surface: '#dae2fd'
  inverse-on-surface: '#283044'
  outline: '#918fa1'
  outline-variant: '#464555'
  surface-tint: '#c3c0ff'
  primary: '#c3c0ff'
  on-primary: '#1d00a5'
  primary-container: '#4f46e5'
  on-primary-container: '#dad7ff'
  inverse-primary: '#4d44e3'
  secondary: '#4edea3'
  on-secondary: '#003824'
  secondary-container: '#00a572'
  on-secondary-container: '#00311f'
  tertiary: '#ffb2b7'
  on-tertiary: '#67001b'
  tertiary-container: '#bf0f3c'
  on-tertiary-container: '#ffd0d2'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#e2dfff'
  primary-fixed-dim: '#c3c0ff'
  on-primary-fixed: '#0f0069'
  on-primary-fixed-variant: '#3323cc'
  secondary-fixed: '#6ffbbe'
  secondary-fixed-dim: '#4edea3'
  on-secondary-fixed: '#002113'
  on-secondary-fixed-variant: '#005236'
  tertiary-fixed: '#ffdadb'
  tertiary-fixed-dim: '#ffb2b7'
  on-tertiary-fixed: '#40000d'
  on-tertiary-fixed-variant: '#92002a'
  background: '#0b1326'
  on-background: '#dae2fd'
  surface-variant: '#2d3449'
typography:
  display-lg:
    fontFamily: Be Vietnam Pro
    fontSize: 48px
    fontWeight: '700'
    lineHeight: 56px
    letterSpacing: -0.02em
  display-md:
    fontFamily: Be Vietnam Pro
    fontSize: 36px
    fontWeight: '700'
    lineHeight: 44px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Be Vietnam Pro
    fontSize: 28px
    fontWeight: '600'
    lineHeight: 36px
  headline-md:
    fontFamily: Be Vietnam Pro
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  body-lg:
    fontFamily: Be Vietnam Pro
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 28px
  body-md:
    fontFamily: Be Vietnam Pro
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-sm:
    fontFamily: Be Vietnam Pro
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-md:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 20px
    letterSpacing: 0.05em
  label-sm:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.05em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  base: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 40px
  grid-margin: 24px
  grid-gutter: 16px
---

## Brand & Style

The design system is engineered for high-performance communication, blending the technical precision of a developer tool with the polished accessibility of a premium consumer app. The brand personality is **authoritative, secure, and hyper-modern**, targeting professional teams who require a focused environment for deep collaboration.

The visual style utilizes a **Modern-Corporate** foundation infused with **Glassmorphism** for situational overlays. It prioritizes clarity and high-contrast accessibility to ensure call controls are unmistakable during high-stakes meetings. The aesthetic evokes a sense of "digital sanctuary"—a dark, focused space where the user's content and colleagues take center stage.

Key stylistic pillars:
- **High-Contrast Dark Mode:** Deep navy depths contrasted with vibrant action colors.
- **Translucent Overlays:** Functional glass effects for floating toolbars and side panels to maintain spatial context.
- **Precision Engineering:** Sharp execution of icons and layout to reflect the reliability of the underlying stream technology.
- **RTL-First Thinking:** Logic and flow are designed to support Persian and English interchangeably without losing visual balance.

## Colors

The palette is optimized for long-duration screen exposure (reduced eye strain) while maintaining critical feedback loops through color.

- **Primary (Deep Indigo):** Reserved for primary actions, active speakers, and brand-critical touchpoints.
- **Secondary (Emerald):** Used exclusively for "Active," "Online," and "Success" states—providing a reassuring signal of connectivity.
- **Tertiary (Rose):** Dedicated to destructive actions (End Call, Mute Video) and critical alerts.
- **Neutral (Navy/Slate):** The foundation of the UI. The background uses a near-black navy to allow video feeds to pop, while UI surfaces use slightly lighter slates to establish hierarchy.

## Typography

This design system uses **Be Vietnam Pro** as the primary typeface due to its exceptional legibility in dark interfaces and its friendly yet professional geometry. It pairs well with standard Persian sans-serif fallbacks (like Vazirmatn) to ensure a seamless RTL experience.

- **Headlines:** Set with tight tracking and bold weights to provide strong structural anchors.
- **Body Text:** Standardized on 16px for optimal readability during multitasking.
- **Labels:** **JetBrains Mono** is used for technical metadata (bitrate, participant count, timestamps) to provide a "pro-tool" aesthetic and clear character differentiation.

**RTL Adjustments:** For Persian text, line-height is increased by 15% to accommodate script descenders and ascenders without crowding.

## Layout & Spacing

The system utilizes a **Fluid Grid** for video participant tiles and a **Fixed Sidebar** model for chat and participant lists.

- **The Stage:** The central video area expands dynamically. In "Gallery View," tiles maintain a 16:9 aspect ratio with `md` (16px) spacing between them.
- **Control Bar:** A floating bottom bar, horizontally centered. It uses a `glassmorphism` effect to appear detached from the video layer.
- **RTL Logic:** The layout mirrors across the vertical axis. The "Sidebar" (Chat/People) appears on the left for Persian users, and the primary "End Call" button moves to the far left of the control cluster.
- **Breakpoints:** 
    - Mobile (<600px): Single column, stacked controls, full-screen overlays.
    - Tablet (600px - 1024px): 2-column grid for video, collapsible sidebars.
    - Desktop (>1024px): Full multi-column grid with persistent utility panels.

## Elevation & Depth

Hierarchy is established through a combination of **Tonal Layering** and **Backdrop Blurs**.

1.  **Level 0 (Canvas):** The deepest layer (`#020617`). Used for the main app background.
2.  **Level 1 (Surfaces):** Participant tiles and sidebar containers. Subtle 1px border (`rgba(255,255,255,0.1)`) to define edges without heavy shadows.
3.  **Level 2 (Floating Controls):** The main call toolbar. Uses a `backdrop-filter: blur(12px)` with a semi-transparent slate background. This allows the movement of video feeds behind the controls to be felt, maintaining immersion.
4.  **Level 3 (Modals/Popovers):** Highest elevation. Uses a soft, expansive ambient shadow (Color: `#000000`, Alpha: 40%, Blur: 32px) to focus user attention on forms or settings.

## Shapes

The shape language is **Rounded**, striking a balance between the clinical sharpness of enterprise tools and the approachability of social apps.

- **Video Tiles:** Use `rounded-lg` (16px) to soften the edges of the video stream and create a modern "contained" look.
- **Buttons & Inputs:** Standardized at `rounded-md` (8px).
- **Avatars:** Strictly circular to contrast against the rectangular video tiles.
- **Indicators:** "Live" or "Recording" tags use a pill-shape for immediate recognition as status elements.

## Components

### Buttons
- **Primary:** Deep Indigo background, white text. Transitions to a brighter indigo on hover.
- **Control Icons:** Circular buttons with `glassmorphism` backgrounds. Toggle states (e.g., Mute) switch to a solid Rose background with white icons for high-visibility "off" states.

### Forms & Inputs
- **Inputs:** Dark navy background with a subtle slate border. On focus, the border glows with a 2px Indigo outer-ring (shadow-glow).
- **Animations:** Labels use a "float" animation, moving from inside the field to the top border on focus.

### Cards (Participant Tiles)
- Tiles include a "Signal Strength" indicator in the top-right and the participant name (RTL aligned as needed) in the bottom-left. 
- A 2px Emerald border animates in when the "Active Speaker" logic is triggered.

### Call Controls
- Grouped by function: Media (Mic/Cam) on the left, Utilities (Screen Share/Record) in center, and Termination (End Call) on the right.
- For RTL, this group order is mirrored.

### Chips/Badges
- Small, low-contrast capsules used for "HD," "CC," or "Guest" labels, using the `label-sm` typography.