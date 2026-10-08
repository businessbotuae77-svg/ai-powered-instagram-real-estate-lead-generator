# Area coverage release — 8 October 2026

## Problem and change

The deployment fallback covered six areas in English. The twelve research
records were awaiting approval and therefore could not supply broad research
answers. Provider billing failures also prevented model-assisted interpretation
and composition. More research rows alone could not fix the buyer experience.

This release adds source-reviewed English and Arabic orientation for all twelve
areas, reads six scoped guide fields from the existing Areas table, and handles
area discovery and comparison deterministically. General enquiries preserve the
buyer's search preferences. Longest-name matching prevents Yas Bay and Yas Canal
from becoming Yas Island. Arabic overviews offer twelve choices.

Source review covers general geography, existing destinations and explicitly
labelled masterplans. Buyer suitability is editorial judgement. No commercial
quotes, availability, forecasts or human approvals were created.

## Published data

The master Areas tab and Airtable Areas (research) have matching Guide tagline,
English, Arabic, sources, checked date and status values for twelve areas.
Guide sources were checked on 8 October 2026. The master's old Verified flags
were reconciled with the still-pending research status in Airtable; the original
research dates remain unchanged. See [editing instructions](AREA-GUIDE.md).

| Area | Primary publishers |
|---|---|
| Hudayriyat Island | [Modon](https://www.modon.com/real-estate/hudayriyat-island) |
| Yas Island | [Yas Island](https://www.yasisland.com/) |
| Saadiyat Island | [Saadiyat Island](https://www.saadiyatisland.ae/) |
| Ramhan Island | [Ramhan Island](https://ramhanisland.com/) |
| Fahid Island | [Aldar](https://www.aldar.com/en/news-and-media/aldar-unveils-fahid-island) |
| Al Reem Island | [Visit Abu Dhabi](https://visitabudhabi.ae/en/where-to-go/islands/al-reem-island) |
| Yas Bay | [Yas Bay](https://www.yasbay.ae/) |
| Yas Canal | [Abu Dhabi Media Office](https://www.mediaoffice.abudhabi/en/crown-prince-news/khaled-bin-mohamed-bin-zayed-approves-launch-of-yas-canal-residential-project-worth-aed3-billion/) |
| Masdar City | [Masdar City](https://masdarcity.ae/about) |
| Al Raha Beach | Aldar community pages for Al Zeina, Al Bandar and Al Muneera; exact URLs in the guide |
| Jubail Island | [Jubail Island](https://jubailisland.ae/) |
| Al Maryah Island | [Al Maryah Island](https://almaryahisland.ae/about/) |

## Verification and release gates

- 738 automated tests passed locally, including twelve areas in both languages
  using production-shaped serving fields and the full response validator.
- Read back the guide values from both connected data stores before release.
- Merge only the tested head; verify the Railway deployment reports the merged
  commit, then run informational smoke tests through the test-chat endpoint.
- These checks do not establish real Instagram delivery or lead-alert delivery.

## Remaining dependencies

The live provider health reported `billing_required` on 8 October. Funding or
repairing the Anthropic account requires its account owner; this release does
not replace the key, change the model or claim successful model operation.

WhatsApp and the broker contact destination were unconfigured at inspection.
Receiving human follow-ups still needs the owner's chosen destination and the
appropriate integration configuration. A successful HTTP health check does not
prove notification delivery.

The commercial inventory remains sparse and live availability and detailed
contractual instalments still need current evidence and approval. Publishing
the area guide does not activate draft offers or pending research.
