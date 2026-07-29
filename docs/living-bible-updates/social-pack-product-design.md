# Living Bible Update — Product Design: Social Pack Generator

**Status:** Weekly production ready (Newsletter Social Pack sprint complete)  
**Date:** 2026-07-29  
**Note:** Master Living Edition Product Design Bible was not found on this machine. Paste this section into the current Product Design Living Edition.

---

## Social Pack Generator — purpose

Admin weekly workflow that turns each Featured Cruise in a newsletter issue into a destination-led Instagram/Facebook carousel pack — without Canva as a dependency.

## Approved three-card design system

1. **Main Cruise card** — destination photo, pointed cruise-line logo pennant, route headline, nights/dates/ship, up to six ports with centred dots, red 101cruise logo, green footer `#8DD9BF`. No price.
2. **Room Pricing card** — same destination photo (clear), pennant logo, angled room label, brochure price struck through (when higher than public), red 101cruise price, includes list with green ticks, disclaimer pill, green footer. One card per selected public room.
3. **Final CTA card** — strong blur background, TALK TO PAUL TODAY, “Get your cruise on!” script, paul@101cruise.com.au, red 101cruise logo, green footer.

Journey/map cards are **not** part of the weekly pack.

## Destination-image rotation

Media Library `media_type = destination` with priority: manual override → featured destination → arrival → departure → regional → itinerary → featured hero → ship hero fallback. Deterministic rotation; Previous/Next and Change Social Image in Admin. No Media Library writes.

## Admin weekly workflow

Newsletter Issue Composer → **Create Social Pack** → select cruises → tick/untick room prices → preview approved cards → Copy caption → Download This Cruise or Download Newsletter Social Pack ZIP.

## Public-price-only rule

Only `brochure_price` and `cruise_101_price` appear in social. Airline Staff pricing and category codes never appear in slides, captions, ZIP, or manifest.

## CTA and caption

CTA ends every carousel. Caption includes destination opening, ship, dates, highlights, selected public room prices, inclusions, paul@101cruise.com.au, 101cruise.com.au, and availability disclaimer.
