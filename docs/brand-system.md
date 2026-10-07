# Inner Game visual system

Inner Game helps players prepare deliberately, review decisions, and track their process. The brand pairs a lowercase wordmark with an ivory-and-mint `ig` monogram. Its promise is **Your game. Your process.**

## Shared assets

- `android/app/src/main/assets/www/brand-icon.png` is the original generated brand artwork. `icon.b64` contains the same PNG for Android and Electron launcher builds.
- Manrope is bundled locally under `www/fonts/`, with its SIL Open Font License. The interface works without fetching fonts.
- `design-system.css` owns appearance tokens and shared components. `styles.css` retains screen layouts and interaction animations; `desktop/desktop.css` adapts the shell at 900px. Desktop preparation copies the same web assets.

## Foundations

| Token | Value | Use |
| --- | --- | --- |
| Background | `#0b1320` | Midnight canvas |
| Surface | `#111e2c` | Cards |
| Raised surface | `#172637` | Secondary controls |
| Input surface | `#0d1825` | Form controls |
| Text | `#f3f2ed` | Ivory headings and body |
| Muted | `#a2b0c3` | Supporting text |
| Accent | `#83e6c1` | Primary action, positive data, selection |
| Secondary accent | `#a5b9f2` | Progress and focus tools |
| Warning | `#edcb8d` | Session finish and processing |
| Danger | `#ff9395` | Negative data and destructive actions |

Default page and card padding is 22px; section gaps are 20px. Small phones use 16px page padding and 18px cards and gaps. Single-line controls are 52px tall with 12px corners and 16px text. Cards use 20px corners. Buttons show visible keyboard focus; motion respects reduced-motion preferences.

## Components and behavior

`uiIcon`, `brandLockup`, `brandBar`, `header`, `stepper`, `tabs`, `prepRow`, and `appShell` provide shared markup. Stroke icons are decorative inside text-labelled controls. Navigation exposes its current page and names the session action. Fields pair labels with controls.

The phone shell uses a bottom navigation bar. Desktop uses a 224px sidebar, keeping the same destinations and session actions. Every route uses the shared appearance system, including preparation, breathing, warm-up, active sessions, logs, history, insights, saved hands, reconstruction, solver results, and profile.

Saved hands support text search, scope filters, drag and drop, and explicit image upload. Android opens the system image picker and releases its callback on selection, cancellation, replacement, or activity destruction. Explicit import works outside a session; automatic screenshot capture still requires an active session. Profile names are saved locally, with the existing greeting preserved during migration.

Displayed sessions, profit, solver EVs, and progress come from stored data. Demo sessions are added only by the player's explicit action. Local history and online hand analysis are described separately in the data settings.
