# Sprint 2 controlled update: packing quantities and baggage allowances

## Included

- Removed **Group** from customer and admin traveller options.
- Retained **Solo**, **Couple** and **Family** for packing-profile filtering only.
- Removed cruise-duration and traveller multipliers from packing quantities.
- Set unsaved packing-item quantities to **1**.
- Added editable quantity fields beside every system and personal packing item.
- Added immediate item-weight and total-weight recalculation.
- Persisted system-item quantities in `user_packing_progress`.
- Continued persisting personal-item quantities in `user_packing_items`.
- Replaced the assumed 20 kg baggage limit with user-entered checked and cabin baggage allowances.
- Compared the current packing estimate with the entered checked baggage allowance.
- Added SQL to consolidate Shoes into Footwear, Swimwear & Pool into Pool & Beach, and Last Minute Items into Last Minute.
- Preserved unique items and Smart Profile mappings before deleting exact duplicates.

## Deployment order

1. Run `supabase/migrations/20260710_manual_packing_quantities_and_baggage.sql` in Supabase SQL Editor.
2. Test the planner locally or in Netlify preview.
3. Deploy the updated site.

## Current limitation

The packing library does not yet identify whether each item belongs in cabin or checked baggage. Cabin allowance is captured now, but the packing estimate is compared with checked baggage until item allocation is added.

## v0.9.9 Budget Planner and Dashboard Layout Fix

- Added the Budget module to My Cruise navigation and Dashboard Quick Access.
- Added Estimated Holiday Total hero with automatic recalculation.
- Cruise booking price is read in USD and converted to AUD using an editable exchange rate.
- Added itemised Flights, Accommodation, Car Hire and Other Expenses.
- Added single-value Food & Beverage Allowance, Travel Insurance and Shore Excursions.
- Added customer budget persistence through a new Netlify function and Supabase migration, with device storage fallback.
- Removed the Cruise Snapshot internal scrollbar and fixed-height restriction.
- Progress and Cruise Snapshot now share the height of the taller card.
- Next Essential Step remains in a separate row beneath both cards.
