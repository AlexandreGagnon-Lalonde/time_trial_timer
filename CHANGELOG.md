# Changelog

One line per change, written for the people using the app. Newest first,
grouped by the day it shipped. Add the line in the same commit as the change.

## 2026-11-06

- Operator chip folds back whenever you leave the field, even with no edits
- Warmer orange accent and a proper dark theme that follows the system setting
- Spacing on a 4px grid; inputs and buttons share one height
- Every icon button (menu, close, copy, clear) has a 44px tap area
- Results table puts the athlete first; the date column is hidden on phones
- Last stamp strip is colour-coded by type and no longer wraps long names
- On-course line keeps names readable; only the dot pulses
- Operator name folds into a chip beside the room badge once entered; tap it to edit
- Join and Create are a text link under one field instead of a switch; code and name fields are the same size
- Room and team menus show Split timer and Hide results as switches, with rules between groups
- Bottom sheets and the table keep clear of the iPhone home bar and notch
- Keyboard focus shows an orange ring on buttons
- Room and team names that are too long are cut with an ellipsis instead of wrapping the header

## 2026-10-26

- Clear button in the timer screen's text fields

## 2026-10-14

- App always opens in the lobby instead of jumping to the saved team
- The system back gesture returns to the previous screen

## 2026-10-09

- Wrong-code messages get firmer each time; code entry locks after five misses
- Join and Create share one field with a switch (replaced by a text link on 2026-11-06)
- Copy button next to the code in room and team badges

## 2026-10-06

- Teams: private groups of rooms behind a team code
- Lobby split into Rooms and Teams tabs; swipe between them
- All teams are listed in the lobby; this device's teams open directly
- Team page has a join-by-code field; tapping a team room opens its results
- Per-room athlete roster import
- Athlete lookup sorted by elapsed time
- Database reads are gated per code

## 2026-08-20

- Hide-results toggle in the room menu; idle rooms drop out of the lobby

## 2026-08-17

- Optional SPLIT stamp for mid-course checkpoints, enabled per room

## 2026-08-16

- Joining comes first in the lobby; creating a room requires a name
- CSV time columns use a dot before milliseconds

## 2026-08-12

- Room code hidden on the spectator results page

## 2026-07-14

- Screen stays awake while timing

## 2026-07-10

- Read-only spectator view
- Synced clock and single-write stamps so two operators never disagree on a time

## 2026-07-08

- Athlete name autocomplete with case-insensitive start/finish pairing
- Finishing without a matching start is allowed and flagged
- Drag away from a held stamp button to cancel it

## 2026-07-07

- Hold-to-arm overlay on the stamp buttons; release anywhere to record
- Athlete lookup computes elapsed times as you type
- CSV gains a datetime column and a finished-athletes section
- Page locked to the screen height; only the table scrolls
- Zebra stripes in the results table

## 2026-07-04

- START/FINISH and the last stamp sit above the inputs
- Compact spacing for small screens

Earlier history (from 2026-05-29) is in git.
