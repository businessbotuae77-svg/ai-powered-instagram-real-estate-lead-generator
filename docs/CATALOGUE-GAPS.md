# Off-plan project information: what's missing

10 October 2026. For the broker.

The bot talks about off-plan projects: what each one is, the home types, the developer's published
price, the payment plan, the handover date and the amenities. It does not handle individual listings
or availability; buyers who ask about a specific unit are passed to you. Anything below that is blank
in the Knowledge Base is something the bot cannot tell a buyer.

**Sources:**
- The Google Sheet "Abu Dhabi Brokerage Knowledge Base" (Projects, Unit types and Milestones tabs), read on 10 Oct.
- The live review of 30 buyer conversations on 10 Oct, for what the bot actually said.

Airtable was not read directly.

## Decisions for you first

1. **May the bot quote the developer's published prices?**
   - The Sheet has a published price for 13 of the 30 projects.
   - In the review the bot quoted only 2: Nawayef Park Views 1BR and Al Naseem 4–6BR.
   - It told buyers "pricing not released" for Nawayef Village and Bashayer, which do have published prices.

   If yes, the bot will say "from AED X, the developer's published starting price". Making that work is
   our job, not yours.
2. **Averages are not starting prices.** Muheira, Tara Park and Hudayriyat Golf Estates only have a
   published *average*, as do Bashayer's 2BR and larger homes. The bot can mention an average, but it can
   never tell a buyer their budget fits. Where the developer publishes a "from" price, please add it.
3. **Facts stop being used 30 days after "Checked on".**
   - 29 projects were checked on 21 Sep 2026. From **21 Oct** the bot stops using their price, plan and
     handover, assuming Airtable's dates match the Sheet.
   - Nawayef Park Views (checked 6 Oct) lasts until 5 Nov.
   - Re-check the source page and update "Checked on" only after an actual check.

## Fill these first

Ordered by how often buyers asked in the review:

1. **Sama Yas and Gardenia Bay (Yas Island).** Starting price, home types and bedrooms, payment plan,
   handover. Yas came up in 14 of 30 conversations and the bot had nothing concrete to give.
2. **The Row Saadiyat, Saadiyat Lagoons and Mandarin Oriental Residences (Saadiyat Island).** The same four facts.
   Saadiyat came up in 5 conversations, including an AED 8M buyer.
3. **Nawayef Park Views 2BR and 3BR starting prices.** 2BR was asked for in 4 conversations, and the
   project only has a 1BR price.
4. **Booking percentage for the 40/60 and 50/50 plans:**
   - Al Naseem, Nawayef Village, Muheira, Hudayriyat Golf Estates and Nawayef East Homes.
   - Without it the bot cannot answer "how much do I pay upfront?", one of the most common questions.
5. **One priced Masdar City project.** A buyer asked for an apartment in Masdar and got nothing. All five
   Masdar projects lack a price.

## Project by project

✓ = in the Sheet. ✗ = missing. Notes say what is partial or conflicting.
Fill in on the **Projects** tab (price, plan, handover, amenities) and the **Unit types** tab (one row
per home type and bedroom count, with its published price and size).

### Hudayriyat Island

| Project | Price | Home types & bedrooms | Payment plan | Handover | Amenities |
|---|---|---|---|---|---|
| AD-003 Nawayef Village | ✓ from 4,100,000 | Partial: 3–5BR across townhouses and twin villas; which bedrooms in which type? | Partial: 50/50, booking % missing | ✓ from Q1 2029 | ✓ |
| AD-004 Nawayef Park Views | Partial: 1BR from 2,000,000; 2–4BR missing | ✓ 1–4BR apartments | ✓ 10% / 50% / 40% | ✓ Q1 2028 | ✓ |
| AD-005 Al Naseem Community | ✓ 4BR 7.8M, 5BR 9M, 6BR 10M | ✓ 4–6BR villas | Partial: 40/60, booking % missing | Partial: first phase Q4 2027; Modon summary page conflicts | ✓ |
| AD-012 Bashayer | Partial: 1BR from 2.5M; others are averages; villas missing | Partial: 4BR apartment and penthouse bedrooms unclear | Partial: apartments 5% / 45% / 50%; villas missing | ✓ apartments Q2 2030, villas Q1 2030 | ✓ |
| AD-014 Nawayef East | Partial: Homes from 6.6M; Heights from 19.3M is only in a note; Mansions missing | ✓ | Partial: Homes 40/60, booking % missing; Heights and Mansions missing | ✓ December 2028 | ✓ |
| AD-015 Hudayriyat Golf Estates | Averages only | Partial: Par 3 / Par 4 bedrooms unknown | Partial: 40/60, booking % missing | ✓ Q3 2030 | ✓ |

### Saadiyat Island

| Project | Price | Home types & bedrooms | Payment plan | Handover | Amenities |
|---|---|---|---|---|---|
| AD-001 The Row Saadiyat | ✗ | ✓ 1–3BR | ✗ | ✗ | ✓ |
| AD-002 Mandarin Oriental Residences | ✗ | ✗ | ✗ | ✗ | ✓ |
| AD-022 Saadiyat Lagoons | ✗ | Partial: villas, bedrooms unknown | ✗ | ✗ | ✓ |

### Yas Island, Yas Bay and Yas Canal

| Project | Price | Home types & bedrooms | Payment plan | Handover | Amenities |
|---|---|---|---|---|---|
| AD-020 Gardenia Bay (Yas Island) | ✗ | ✗ | ✗ | ✗ | ✓ |
| AD-023 Sama Yas (Yas Island) | ✗ | ✗ | ✗ | ✗ | ✓ |
| AD-007 Manchester City Yas Residences (Yas Canal) | ✓ from 2,000,000 | Partial: developer page contradicts itself; townhouse and twin villa bedrooms missing | Partial: 50/50 or 35/65 "depending on release" | ✗ | ✓ |
| AD-009 Bab Al Qasr Residence 25 (Yas Bay) | ✗ | Partial: bedrooms unknown | ✗ | Conflict: Q3 vs Q4 2028 | ✓ |
| AD-016 Bab Al Qasr Residence 31 (Yas Bay) | ✗ | ✗ | ✗ | ✓ Q1 2029 | Thin |
| AD-025 Perla Heights (Yas Bay) | ✓ from 700,000 | Partial: listing and project page disagree | ✗ | ✗ | ✓ |
| AD-026 Perla Waves (Yas Bay) | ✓ from 1,900,000 | Partial: 1–4BR vs 3–5BR duplexes | ✗ | ✗ | ✓ |

### Al Reem Island

| Project | Price | Home types & bedrooms | Payment plan | Handover | Amenities |
|---|---|---|---|---|---|
| AD-006 Elie Saab Waterfront | ✗ | ✓ 1–3BR | ✗ | ✗ | ✓ |
| AD-011 Muheira | Averages only | ✓ 1–3BR | Partial: 50/50, booking % missing | ✓ Q2 2029 | ✓ |
| AD-013 Tara Park | Averages only | ✓ 1–3BR | ✓ 5% / 35% / 60% | ✓ Q2 2030 | ✓ |
| AD-024 Marlin II | ✓ from 1,600,000 (not tied to a bedroom count) | ✓ 2–4BR | ✗ | ✗ | ✓ |
| AD-028 Seamont Autograph Collection | ✗ | Partial: duplex and penthouse bedrooms | ✗ | Partial: Q4 2028 from a Sept 2025 announcement | Thin |

### Masdar City

| Project | Price | Home types & bedrooms | Payment plan | Handover | Amenities |
|---|---|---|---|---|---|
| AD-008 Ville 12 | ✗ | ✗ | ✗ | ✓ Q3 2028 | ✓ |
| AD-017 Bab Al Qasr Garden Residence 66 | ✗ | ✗ | ✗ | ✓ Q2 2029 | ✓ |
| AD-019 Bab Al Qasr Resort Residence 18 | ✗ | ✗ | ✗ | ✓ Q3 2028 | ✓ |
| AD-029 Bab Al Qasr Resort Residence 19 | ✗ | ✗ | ✗ | ✓ Q3 2028 | ✗ |
| AD-030 Ville 11 | ✗ | ✗ | ✗ | ✗ | ✗ |

### Al Raha Beach, Fahid Island, Ramhan Island

| Project | Price | Home types & bedrooms | Payment plan | Handover | Amenities |
|---|---|---|---|---|---|
| AD-018 Bab Al Qasr Canal View Residence 22 | ✗ | ✗ | ✗ | ✓ Q2 2029 | Thin |
| AD-027 Brabus Island | Partial: towers from 2.8M; villa price unclear | Partial: penthouse and villa bedrooms | ✗ | ✗ | ✓ |
| AD-021 Fahid Beach Residences | ✗ | ✗ | ✗ | ✗ | ✓ |
| AD-010 Ramhan Island | ✗ | ✗ | ✗ | ✗ | ✓ |

## Totals

| Fact | Complete | Partial | Missing |
|---|---|---|---|
| Price | 6 | 4 partial, 3 averages only | 17 |
| Home types & bedrooms | 8 | 10 | 12 |
| Payment plan | 2 with booking % | 7 | 21 |
| Handover | 13 | 2 partial, 1 conflict | 14 |
| Amenities | 25 | 3 thin | 2 |

## Nice to have

- **Brochure links.** Only Ville 12 and Bab Al Qasr Residence 25 have one. A buyer asked for a brochure
  in the review.
- **Sizes** per home type (Unit types, Size min/max sqm). Most rows are blank.
- **Published service charges.** Only Ville 12 and Bab Al Qasr Residence 25 have an estimate.
