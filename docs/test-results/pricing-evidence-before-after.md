# Pricing evidence: conversations before and after

Generated 2026-10-16 by running the real engine over the repository data (local seed catalogue, the ADREC export to 14 Oct 2026, and the price ledger in data/pricing). "Before" is production commit b2b324a; "after" is this branch. Simulated offers are marked; they are not in the ledger.

## Vista 3: a 1-bed search at AED 1.2M

The developer's unresolved 1-bed quote ("1,5" before discount) is on file. Before, past 1-bed sales put Vista 3 first and the card told the buyer to take a closer look at the 1-bed. After, the likely reading of that quote is above the budget, so Vista 3 is not shortlisted and its card has no budget highlight; the quote itself is never shown.

### Before

**Buyer:** I want a 1 bedroom in Reem, budget 1.2M

**Bot** (soft_match):

> I found these projects within your budget in Al Reem Island 👇
>
> 1️⃣ Vista 3 · Al Reem Island
> 1-bed apartment · Guide price around AED 716K
>
> 2️⃣ Renad Tower · Al Reem Island
> 1-bed apartment · Guide price around AED 1.1M
>
> 3️⃣ Radiant Square · Al Reem Island
> 1-bed apartment · Guide price around AED 1.2M
>
> Guide prices reflect recent sales. Exact prices and available units are confirmed on request.
>
> Which project would you like to explore?
>
> [Vista 3] [Renad Tower] [Radiant Square]

**Buyer:** Vista 3

**Bot** (project_knowledge):

> 🏙️ Vista 3
> 📍 Al Reem Island — city living beside Al Maryah Island
> 🏠 1-bed apartment · about 564 sq ft · guide price around AED 716K
> 🏠 Studio · about 515 sq ft · guide price around AED 717K
> 🏠 2-bed apartment · about 776 sq ft · guide price around AED 948K
> ✨ For your budget, I'd take a closer look at the 1-bed apartment.
>
> Guide prices reflect recent sales. Exact prices and available units are confirmed on request.
>
> Want the latest price and available units confirmed here on Instagram?
>
> [Check price & units] [More options] [About the area]

**Buyer:** And the 1 BR price?

**Bot** (soft_match):

> I found these projects within your budget in Al Reem Island 👇
>
> 1️⃣ Vista 3 · Al Reem Island
> 1-bed apartment · Guide price around AED 716K
>
> 2️⃣ Renad Tower · Al Reem Island
> 1-bed apartment · Guide price around AED 1.1M
>
> 3️⃣ Radiant Square · Al Reem Island
> 1-bed apartment · Guide price around AED 1.2M
>
> Guide prices reflect recent sales. Exact prices and available units are confirmed on request.
>
> Which project would you like to explore?
>
> [Vista 3] [Renad Tower] [Radiant Square]

### After

**Buyer:** I want a 1 bedroom in Reem, budget 1.2M

**Bot** (soft_match):

> Recent sales at these projects in Al Reem Island came in under your budget. Today's prices still need checking 👇
>
> 1️⃣ Renad Tower · Al Reem Island
> 1-bed apartment · recent sales around AED 1.1M
>
> 2️⃣ Radiant Square · Al Reem Island
> 1-bed apartment · recent sales around AED 1.2M
>
> Recent sales show what homes sold for, not today's prices. I can check today's price and available units for any of these here on Instagram.
>
> Which project would you like to explore?
>
> [Renad Tower] [Radiant Square]

**Buyer:** Vista 3

**Bot** (project_knowledge):

> 🏙️ Vista 3
> 📍 Al Reem Island — city living beside Al Maryah Island
> 🏠 1-bed apartment · about 564 sq ft · recent sales around AED 716K
> 🏠 Studio · about 515 sq ft · recent sales around AED 717K
> 🏠 2-bed apartment · about 776 sq ft · recent sales around AED 948K
>
> Recent sales show what homes sold for, not today's prices.
>
> Want the latest price and available units confirmed here on Instagram?
>
> [Check price & units] [More options] [About the area]

**Buyer:** And the 1 BR price?

**Bot** (project_knowledge):

> Vista 3: 1-bed apartment — recent developer sales around AED 716K (last 12 months).
>
> Want the latest price and available units confirmed here on Instagram?
>
> [Check price & units] [More options]

## Vista 3: a 2-bed search under AED 1M

Recorded 2-bed sales (median AED 948K, 11 sales) still shortlist Vista 3, now as past sales with today's price to check. One contact's "no 2-bed stock" removes nothing.

### Before

**Buyer:** 2 bedroom in Reem under 1M

**Bot** (soft_match):

> I found these projects within your budget in Al Reem Island 👇
>
> 1️⃣ Vista 3 · Al Reem Island
> 2-bed apartment · Guide price around AED 948K
>
> 2️⃣ Radiant Square · Al Reem Island
> 2-bed apartment · Guide price around AED 997K
>
> Guide prices reflect recent sales. Exact prices and available units are confirmed on request.
>
> Which project would you like to explore?
>
> [Vista 3] [Radiant Square]

**Buyer:** Vista 3

**Bot** (project_knowledge):

> 🏙️ Vista 3
> 📍 Al Reem Island — city living beside Al Maryah Island
> 🏠 2-bed apartment · about 776 sq ft · guide price around AED 948K
> 🏠 Studio · about 515 sq ft · guide price around AED 717K
> 🏠 1-bed apartment · about 564 sq ft · guide price around AED 716K
> ✨ For your budget, I'd take a closer look at the 2-bed apartment.
>
> Guide prices reflect recent sales. Exact prices and available units are confirmed on request.
>
> Want the latest price and available units confirmed here on Instagram?
>
> [Check price & units] [More options] [About the area]

### After

**Buyer:** 2 bedroom in Reem under 1M

**Bot** (soft_match):

> Recent sales at these projects in Al Reem Island came in under your budget. Today's prices still need checking 👇
>
> 1️⃣ Vista 3 · Al Reem Island
> 2-bed apartment · recent sales around AED 948K
>
> 2️⃣ Radiant Square · Al Reem Island
> 2-bed apartment · recent sales around AED 997K
>
> Recent sales show what homes sold for, not today's prices. I can check today's price and available units for any of these here on Instagram.
>
> Which project would you like to explore?
>
> [Vista 3] [Radiant Square]

**Buyer:** Vista 3

**Bot** (project_knowledge):

> 🏙️ Vista 3
> 📍 Al Reem Island — city living beside Al Maryah Island
> 🏠 2-bed apartment · about 776 sq ft · recent sales around AED 948K
> 🏠 Studio · about 515 sq ft · recent sales around AED 717K
> 🏠 1-bed apartment · about 564 sq ft · recent sales around AED 716K
> ✨ Recent 2-bed apartment sales here came in under your budget, so today's price is worth a check.
>
> Recent sales show what homes sold for, not today's prices.
>
> Want the latest price and available units confirmed here on Instagram?
>
> [Check price & units] [More options] [About the area]

## Budget first, then investing

Same projects, but the lead no longer says they are within the budget.

### Before

**Buyer:** Hi

**Bot** (exploring):

> Hi 👋 Welcome to The Sustainable Bot.
> I help you find the right off-plan home in Abu Dhabi, with real prices, payment plans and handover dates in seconds.
> What can I help you with?
>
> [Find a property] [Explore by budget] [Payment plans] [Talk to an agent]

**Buyer:** Invest

**Bot** (qualifying):

> What budget do you have in mind? A rough range is fine.
>
> [Under AED 1M] [AED 1M–1.5M] [AED 1.5M–2M] [AED 2M–3M] [AED 3M–5M] [AED 5M+]

**Buyer:** Around AED 2M

**Bot** (soft_match):

> I found these projects within your budget in Abu Dhabi 👇
>
> 1️⃣ Harmony Residence · Al Shamkhah
> Studio · Guide price around AED 533K
>
> 2️⃣ Plaza 1 · Masdar City
> Studio · Guide price around AED 539K
>
> 3️⃣ Vista 2 · Al Maryah Island
> Studio · Guide price around AED 550K
>
> Guide prices reflect recent sales. Exact prices and available units are confirmed on request.
>
> Which project would you like to explore?
>
> [Harmony Residence] [Plaza 1] [Vista 2] [More options]

### After

**Buyer:** Hi

**Bot** (exploring):

> Hi 👋 Welcome to The Sustainable Bot.
> I help you find the right off-plan home in Abu Dhabi, with real prices, payment plans and handover dates in seconds.
> What can I help you with?
>
> [Find a property] [Explore by budget] [Payment plans] [Talk to an agent]

**Buyer:** Invest

**Bot** (qualifying):

> What budget do you have in mind? A rough range is fine.
>
> [Under AED 1M] [AED 1M–1.5M] [AED 1.5M–2M] [AED 2M–3M] [AED 3M–5M] [AED 5M+]

**Buyer:** Around AED 2M

**Bot** (soft_match):

> Recent sales at these projects in Abu Dhabi came in under your budget. Today's prices still need checking 👇
>
> 1️⃣ Harmony Residence · Al Shamkhah
> Studio · recent sales around AED 533K
>
> 2️⃣ Plaza 1 · Masdar City
> Studio · recent sales around AED 539K
>
> 3️⃣ Vista 2 · Al Maryah Island
> Studio · recent sales around AED 550K
>
> Recent sales show what homes sold for, not today's prices. I can check today's price and available units for any of these here on Instagram.
>
> Which project would you like to explore?
>
> [Harmony Residence] [Plaza 1] [Vista 2] [More options]

## Merito: price follow-up and accepted check

The saved request now names the home it is for.

### Before

**Buyer:** Tell me about Merito

**Bot** (project_knowledge):

> 🏙️ Merito
> 📍 Al Shamkhah
> 🏠 1-bed apartment · about 659 sq ft · guide price around AED 932K
> 🏠 2-bed apartment · about 1,045 sq ft · guide price around AED 1.36M
> 🏠 3-bed apartment · about 1,428 sq ft · guide price around AED 1.67M
>
> Guide prices reflect recent sales. Exact prices and available units are confirmed on request.
>
> Want the latest price and available units confirmed here on Instagram?
>
> [Check price & units] [More options]

**Buyer:** And the 2 BR price?

**Bot** (project_knowledge):

> Merito: 2-bed apartment — guide price around AED 1.36M, based on recent sales.
>
> Would you like more options of the same size?
>
> [More options] [About the area]

**Buyer:** Yes

**Bot** (soft_match):

> Here are lower-priced options in Abu Dhabi 👇
>
> 1️⃣ PUD Residence 1 · Al Shamkhah
> 2-bed apartment · Guide price around AED 814K
>
> 2️⃣ Royal Park · Masdar City
> 2-bed apartment · Guide price around AED 873K
>
> 3️⃣ Vista 3 · Al Reem Island
> 2-bed apartment · Guide price around AED 948K
>
> Guide prices reflect recent sales. Exact prices and available units are confirmed on request.
>
> Which project would you like to explore?
>
> [PUD Residence 1] [Royal Park] [Vista 3] [More options]

### After

**Buyer:** Tell me about Merito

**Bot** (project_knowledge):

> 🏙️ Merito
> 📍 Al Shamkhah
> 🏠 1-bed apartment · about 659 sq ft · recent sales around AED 932K
> 🏠 2-bed apartment · about 1,045 sq ft · recent sales around AED 1.36M
> 🏠 3-bed apartment · about 1,428 sq ft · recent sales around AED 1.67M
>
> Recent sales show what homes sold for, not today's prices.
>
> Want the latest price and available units confirmed here on Instagram?
>
> [Check price & units] [More options]

**Buyer:** And the 2 BR price?

**Bot** (project_knowledge):

> Merito: 2-bed apartment — recent developer sales around AED 1.36M (last 12 months).
>
> Want the latest price and available units confirmed here on Instagram?
>
> [Check price & units] [More options]

**Buyer:** Yes

**Bot** (follow_up_requested):

> Your price and availability request for the 2-bed apartment at Merito is saved 👍 We'll reply here on Instagram once the details are checked.

## Gulf Arabic: bedroom follow-up and yes

Before, the Arabic bedroom question lost the project.

### Before

**Buyer:** حدثني عن Merito

**Bot** (project_knowledge):

> 🏙️ Merito
> 📍 الشامخة
> 🏠 شقة غرفة نوم · حوالي 659 قدم² · سعر استرشادي حوالي 932 ألف درهم
> 🏠 شقة غرفتين · حوالي 1,045 قدم² · سعر استرشادي حوالي 1.36 مليون درهم
> 🏠 شقة 3 غرف · حوالي 1,428 قدم² · سعر استرشادي حوالي 1.67 مليون درهم
>
> الأسعار استرشادية من مبيعات حديثة. السعر النهائي والوحدات المتوفرة نتأكد منها حسب طلبك.
>
> تبي نتأكد لك من السعر الحالي والوحدات المتوفرة هنا في إنستغرام؟
>
> [السعر والتوفر] [خيارات أكثر]

**Buyer:** وسعر الغرفتين؟

**Bot** (fact_answer):

> أي مشروع تريد أن أتحقق منه؟

**Buyer:** ايه

**Bot** (qualifying):

> كم الميزانية تقريباً؟ يكفي نطاق تقريبي.
>
> [أقل من مليون] [1 – 1.5 مليون] [1.5 – 2 مليون] [2 – 3 مليون] [3 – 5 ملايين] [أكثر من 5 ملايين]

### After

**Buyer:** حدثني عن Merito

**Bot** (project_knowledge):

> 🏙️ Merito
> 📍 الشامخة
> 🏠 شقة غرفة نوم · حوالي 659 قدم² · مبيعات حديثة بحوالي 932 ألف درهم
> 🏠 شقة غرفتين · حوالي 1,045 قدم² · مبيعات حديثة بحوالي 1.36 مليون درهم
> 🏠 شقة 3 غرف · حوالي 1,428 قدم² · مبيعات حديثة بحوالي 1.67 مليون درهم
>
> المبيعات الحديثة توضح بكم انباعت الوحدات، مو أسعار اليوم.
>
> تبي نتأكد لك من السعر الحالي والوحدات المتوفرة هنا في إنستغرام؟
>
> [السعر والتوفر] [خيارات أكثر]

**Buyer:** وسعر الغرفتين؟

**Bot** (project_knowledge):

> Merito: شقة غرفتين — انباعت مؤخراً بحوالي 1.36 مليون درهم (مبيعات المطور خلال آخر 12 شهراً).
>
> تبي نتأكد لك من السعر الحالي والوحدات المتوفرة هنا في إنستغرام؟
>
> [السعر والتوفر] [خيارات أكثر]

**Buyer:** ايه

**Bot** (follow_up_requested):

> تم، حفظت طلبك للسعر الحالي والتوفر في Merito (شقة غرفتين) 👍 الرد بيكون هنا في إنستغرام بعد التأكد.

## Declining the price check

"No thanks" declines the check only, and it is not offered again for that project.

### Before

**Buyer:** Tell me about Merito

**Bot** (project_knowledge):

> 🏙️ Merito
> 📍 Al Shamkhah
> 🏠 1-bed apartment · about 659 sq ft · guide price around AED 932K
> 🏠 2-bed apartment · about 1,045 sq ft · guide price around AED 1.36M
> 🏠 3-bed apartment · about 1,428 sq ft · guide price around AED 1.67M
>
> Guide prices reflect recent sales. Exact prices and available units are confirmed on request.
>
> Want the latest price and available units confirmed here on Instagram?
>
> [Check price & units] [More options]

**Buyer:** No thanks

**Bot** (paused):

> Of course. I'm here whenever you need me.

**Buyer:** Tell me about Merito

**Bot** (project_knowledge):

> 🏙️ Merito
> 📍 Al Shamkhah
> 🏠 1-bed apartment · about 659 sq ft · guide price around AED 932K
> 🏠 2-bed apartment · about 1,045 sq ft · guide price around AED 1.36M
> 🏠 3-bed apartment · about 1,428 sq ft · guide price around AED 1.67M
>
> Guide prices reflect recent sales. Exact prices and available units are confirmed on request.
>
> Want the latest price and available units confirmed here on Instagram?
>
> [Check price & units] [More options]

### After

**Buyer:** Tell me about Merito

**Bot** (project_knowledge):

> 🏙️ Merito
> 📍 Al Shamkhah
> 🏠 1-bed apartment · about 659 sq ft · recent sales around AED 932K
> 🏠 2-bed apartment · about 1,045 sq ft · recent sales around AED 1.36M
> 🏠 3-bed apartment · about 1,428 sq ft · recent sales around AED 1.67M
>
> Recent sales show what homes sold for, not today's prices.
>
> Want the latest price and available units confirmed here on Instagram?
>
> [Check price & units] [More options]

**Buyer:** No thanks

**Bot** (price_check_declined):

> No problem, I won't check it.
> What would you like to do next?
>
> [More options] [Payment plans]

**Buyer:** Tell me about Merito

**Bot** (project_knowledge):

> 🏙️ Merito
> 📍 Al Shamkhah
> 🏠 1-bed apartment · about 659 sq ft · recent sales around AED 932K
> 🏠 2-bed apartment · about 1,045 sq ft · recent sales around AED 1.36M
> 🏠 3-bed apartment · about 1,428 sq ft · recent sales around AED 1.67M
>
> Recent sales show what homes sold for, not today's prices.
>
> What would you like to do next?
>
> [More options]

## Where do the prices come from?

Before, the question fell through to a budget question.

### Before

**Buyer:** Tell me about Vista 3

**Bot** (project_knowledge):

> 🏙️ Vista 3
> 📍 Al Reem Island — city living beside Al Maryah Island
> 🏠 Studio · about 515 sq ft · guide price around AED 717K
> 🏠 1-bed apartment · about 564 sq ft · guide price around AED 716K
> 🏠 2-bed apartment · about 776 sq ft · guide price around AED 948K
>
> Guide prices reflect recent sales. Exact prices and available units are confirmed on request.
>
> Want the latest price and available units confirmed here on Instagram?
>
> [Check price & units] [More options] [About the area]

**Buyer:** Where do these prices come from?

**Bot** (qualifying):

> What budget do you have in mind? A rough range is fine.
>
> [Under AED 1M] [AED 1M–1.5M] [AED 1.5M–2M] [AED 2M–3M] [AED 3M–5M] [AED 5M+]

### After

**Buyer:** Tell me about Vista 3

**Bot** (project_knowledge):

> 🏙️ Vista 3
> 📍 Al Reem Island — city living beside Al Maryah Island
> 🏠 Studio · about 515 sq ft · recent sales around AED 717K
> 🏠 1-bed apartment · about 564 sq ft · recent sales around AED 716K
> 🏠 2-bed apartment · about 776 sq ft · recent sales around AED 948K
>
> Recent sales show what homes sold for, not today's prices.
>
> Want the latest price and available units confirmed here on Instagram?
>
> [Check price & units] [More options] [About the area]

**Buyer:** Where do these prices come from?

**Bot** (fact_answer):

> The recent-sales figures are developer sales recorded by the Abu Dhabi Real Estate Centre over the last 12 months, up to 14 Oct 2026. They show what homes sold for, not today's price.
>
> Want the latest price and available units confirmed here on Instagram?
>
> [Check price & units] [More options]

## A named statistic

The "Get today's price" button used to send "Talk to an agent"; it now asks for the check here on Instagram.

### Before

**Buyer:** What is the average price per sqft in Merito over the last 12 months?

**Bot** (project_knowledge):

> 📊 Merito · Al Shamkhah
> Developer sales, off-plan · last 12 months
> 🏠 Apartments: average AED 1,348/sq ft · 73 developer sales
> 🗓️ 31 Oct 2025 – 20 Jan 2026 · data through 14 Oct 2026
>
> What would you like to do next?
>
> [Get today's price] [More options]

### After

**Buyer:** What is the average price per sqft in Merito over the last 12 months?

**Bot** (project_knowledge):

> 📊 Merito · Al Shamkhah
> Developer sales, off-plan · last 12 months
> 🏠 Apartments: average AED 1,348/sq ft · 73 developer sales
> 🗓️ 31 Oct 2025 – 20 Jan 2026 · data through 14 Oct 2026
>
> Want the latest price and available units confirmed here on Instagram?
>
> [Check price & units] [More options]

## After only: offers approved in the ledger

Production has no approved offers yet, so these use simulated records to show what the owner's approvals will do.

### After the owner confirms the 1-bed quote

Simulated: the "1,5" clarified as AED 1,500,000 before discount, received two days ago, and approved. The current price leads, with its terms and date, and the bot says it is above the budget.

**Buyer:** I want a 1 bedroom in Reem, budget 1.2M

**Bot** (soft_match):

> Recent sales at these projects in Al Reem Island came in under your budget. Today's prices still need checking 👇
>
> 1️⃣ Renad Tower · Al Reem Island
> 1-bed apartment · recent sales around AED 1.1M
>
> 2️⃣ Radiant Square · Al Reem Island
> 1-bed apartment · recent sales around AED 1.2M
>
> Recent sales show what homes sold for, not today's prices. I can check today's price and available units for any of these here on Instagram.
>
> Which project would you like to explore?
>
> [Renad Tower] [Radiant Square]

**Buyer:** Vista 3

**Bot** (project_knowledge):

> 🏙️ Vista 3
> 📍 Al Reem Island — city living beside Al Maryah Island
> 💰 Current price: 1-bed apartment · AED 1,500,000 · before discount · developer message, 14 Oct 2026
> 🏠 1-bed apartment · about 564 sq ft · recent sales around AED 716K
> 🏠 Studio · about 515 sq ft · recent sales around AED 717K
> 🏠 2-bed apartment · about 776 sq ft · recent sales around AED 948K
>
> Recent sales show what homes sold for, not today's prices.
>
> Want the latest price and available units confirmed here on Instagram?
>
> [Check price & units] [More options] [About the area]

**Buyer:** And the 1 BR price?

**Bot** (project_knowledge):

> Vista 3 · 1-bed apartment
> 💰 Current price: AED 1,500,000 · before discount · developer message, 14 Oct 2026
> Recent developer sales were around AED 716K (last 12 months).
> That's above your budget.
>
> Would you like more options of the same size?
>
> [More options] [About the area]

### A quote that fits

Simulated: a 1-bed price list entry at AED 1,100,000 with a 60/40 plan. Only the units are left to check.

**Buyer:** Vista 3

**Bot** (project_knowledge):

> 🏙️ Vista 3
> 📍 Al Reem Island — city living beside Al Maryah Island
> 💰 Current price: 1-bed apartment · AED 1,100,000 · 60/40 payment plan · developer price list, 13 Oct 2026
> 🏠 Studio · about 515 sq ft · recent sales around AED 717K
> 🏠 1-bed apartment · about 564 sq ft · recent sales around AED 716K
> 🏠 2-bed apartment · about 776 sq ft · recent sales around AED 948K
>
> Recent sales show what homes sold for, not today's prices.
>
> Want the latest price and available units confirmed here on Instagram?
>
> [Check price & units] [More options] [About the area]

**Buyer:** And the 1 BR price?

**Bot** (project_knowledge):

> Vista 3 · 1-bed apartment
> 💰 Current price: AED 1,100,000 · 60/40 payment plan · developer price list, 13 Oct 2026
> Recent developer sales were around AED 716K (last 12 months).
>
> Want me to check which units are available at this price, here on Instagram?
>
> [Check units] [More options]

**Buyer:** Yes

**Bot** (follow_up_requested):

> Your price and availability request for the 1-bed apartment at Vista 3 is saved 👍 We'll reply here on Instagram once the details are checked.

### A full-payment discount and a payment-plan buyer

Simulated: a 2-bed cash-buyer price at PUD Residence 1. It is listed with its condition and flagged for a payment-plan buyer, never as a fit.

**Buyer:** 2 bedroom in Shamkha under 1.5M with a payment plan

**Bot** (soft_match):

> Here's what I found in Al Shamkhah 👇
>
> 1️⃣ PUD Residence 1 · Al Shamkhah
> 2-bed apartment · AED 900,000 · after full-payment discount · developer price list, 13 Oct 2026 · payment-plan price to confirm
>
> 2️⃣ Al Reeman View · Al Shamkhah
> 2-bed apartment · recent sales around AED 1.26M
>
> 3️⃣ Reeman Residences · Al Shamkhah
> 2-bed apartment · recent sales around AED 1.33M
>
> Recent sales show what homes sold for, not today's prices. I can check today's price and available units for any of these here on Instagram.
>
> Which project would you like to explore?
>
> [PUD Residence 1] [Al Reeman View] [Reeman Residences] [More options]
