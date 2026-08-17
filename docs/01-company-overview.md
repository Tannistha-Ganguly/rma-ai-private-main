# releaseMyAd — Initial Project Documentation

_Drafted from a pass over www.releasemyad.com on 2026-05-18. To be confirmed/corrected by Sharad before we go deeper._

## 1. What the company does

releaseMyAd is an **online media buying / ad booking platform**, founded in 2009, headquartered in Kolkata, with pan-India reach. It is an INS-accredited agency that lets individuals and businesses **book advertisements directly into newspapers** (primary), and also into magazines, radio, cinema, TV, and digital channels.

The core promise to the customer:
- Self-service online booking — no need to walk into a newspaper office or talk to a sales agent
- Lowest available rates (claimed) via volume agreements and historic / vacant inventory
- 200+ newspapers, 100+ cities, all major Indian languages
- 3,25,000+ cumulative customers; brands like Swiggy, OYO, PharmEasy, Nykaa alongside individuals

## 2. Who the customers are

Two clearly distinct customer profiles:

- **Individuals** — placing matrimonial, obituary, public notice, change-of-name, lost-and-found, court / marriage notice, remembrance, education, property, recruitment-personal, etc.
- **SMBs and brands** — display ads, classifieds for business/services, recruitment, tenders, announcements.

The individual segment is high-volume / low-ticket; the brand segment is lower-volume / higher-ticket. The content-moderation problem looks meaningfully different for the two — more on this in Section 5.

## 3. Ad categories (newspaper)

Twenty-plus categories visible on the site:

Matrimonial, Property, Recruitment, Business, Personal, Vehicles, Announcement, Astrology, Change of Name, Court / Marriage Notice, Education, Loss of Documents, Lost & Found, Marriage Bureau, Obituary, Public Notice, Remembrance, Services, Situations Wanted, Tenders, Travel, Wedding Arrangements, and a long tail of statutory notices.

## 4. The booking flow (as inferred from the website)

The site exposes three entry points — by newspaper, by city, or by category — that all funnel into the same booking flow. The customer-visible flow appears to be roughly:

1. Pick newspaper(s) + edition(s) + category
2. Pick publication date(s)
3. **Compose the ad text** (the step that matters for our project)
4. Pick a package / ad size — pricing is typically per-line or per-word for classifieds and per-sq-cm for display
5. Preview
6. Pay
7. Ad is submitted to the publication

The website does not surface any editorial-check or content-moderation step to the customer. That suggests that **today, this check happens either manually by an internal team after submission, or it slips through and the newspaper rejects it** — which is exactly the problem statement you described.

## 5. The problem we are solving

**Scenario:** Customer composes an ad → pays → submission goes out → newspaper rejects it (or worse, publishes a non-compliant version) because the copy contains language / claims / formats that the publication or the law disallows. Customer is then chased to rewrite, refund/repush cycles, lost trust, internal ops cost.

**Goal:** Auto-check the ad copy **at the point of composition** (or just before payment) against the rules already documented in your editorial-rules table, and block or warn before submission — so customers fix issues themselves, not after the fact.

### What "editorial rules" likely covers (to confirm with EDA)

Best guess based on Indian newspaper editorial practice:
- **Hard-banned words / phrases** — communal, defamatory, sexual, profane
- **Category-specific bans** — e.g. caste/community in matrimonial in certain papers, "guaranteed return" claims in financial/services ads, "cure" claims for health products, alcohol/tobacco references, weapons
- **Format rules** — phone numbers in certain classified categories, URLs, email addresses, ALL CAPS, special characters
- **Publication-specific rules** — Times of India banning X, Hindu banning Y; same word allowed in one paper, banned in another
- **Language-specific rules** — rules in Hindi/Bengali/Tamil etc. that don't map 1:1 to English filters

This shape — multi-axis (word × category × publication × language) — is what will most shape the system design. EDA confirms the shape.

## 6. Where this fits in the booking product

Two natural integration points:
- **Inline, while composing** — flag in real time, like spell-check, so the customer fixes as they type. Best UX, requires lowest possible latency, must run client-side or via a cheap endpoint.
- **At submit / before payment** — single server-side check that blocks the booking if any hard rule fails and surfaces soft warnings. Easier to build, slightly worse UX (catches the problem one screen later).

Recommended target is to build (b) first as a single source of truth, and later layer (a) on top of the same engine. Confirm before locking this in.

## 7. Open questions for Sharad

Listed separately in chat — not duplicating here.

## 8. Tech context (carry-over from prior work)

- Existing infra: EC2 + Plesk, Next.js + PM2 + Redis (per memory)
- Subdomain pattern in use: `agent.xpert.chat`-style; analogous `editorial.releasemyad.com` or just an internal API on the existing app is on the table.
- Stack preference: simplest path that works; no managed services we don't already pay for.
