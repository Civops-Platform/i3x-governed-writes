# CESMII Smart Manufacturing Catalog — listing sheet

Fields follow what the Catalog shows on every entry (catalog.cesmii.net): name, vendor, description,
tags, SM imperative, category, asset link, vendor website, images. Image URLs below assume the repo is
public at the asset link; Jonathan links them from there.

| Field | Value |
|---|---|
| Name | i3X Governed-Write Kit |
| Vendor | CivOps |
| Vendor website | https://civops.io |
| SM imperative | i3X |
| Category | Open Source |
| License | MIT |
| Asset link | https://github.com/Civops-Platform/i3x-governed-writes |
| Tags | #Governance #Writeback #AIAgents #CMMS #Setpoints #Audit #OpenSource |
| Hero image | `catalog/hero-1600x900.png` → https://raw.githubusercontent.com/Civops-Platform/i3x-governed-writes/main/catalog/hero-1600x900.png |
| Image source | `catalog/src/hero.html` (rendered by `catalog/render.sh`, headless Chrome at 1600×900) |
| Vendor logo | `catalog/civops-logo-light.png` (light backgrounds), `catalog/civops-logo-dark.png` (dark), 800×192; SVG sources in `catalog/src/` |

## Description (short — the line under the title)

A write engine for i3X servers and agent gateways that will not let a person, a system or an AI agent change a work order or a setpoint without the checks a careful supervisor would insist on.

## Description (long)

Letting software read plant data is mostly a plumbing problem. Letting it write is a different conversation, and the first question from anyone who has run a plant is who approved it and what happens when it goes wrong. This kit answers both in code.

A write is a request, and nothing reaches the CMMS or the device until the request has cleared identity, authority, a check that the record has not changed since the request was made, and approval. Agents may ask but never approve, and nobody approves their own request. The authority limits decide who has to sign off. The change is applied only if the record still matches the version it was requested against, then read back, and if the system acknowledged the write but did not actually make it, the kit puts the record back by itself. Rollback is a new request linked to the old one, with its own approval.

Setpoints get a hard envelope of range, largest step from the current value, and allowed states. A value outside it is refused, never clamped to the nearest legal number, and only a named person can approve a setpoint change. In a 10,000-value fuzz test, nothing outside the envelope got through.

Every step is a version in a SHA-256 hash-chained ledger, so an edited or deleted line shows up, and the verify-ledger script flags anything that was applied without an approval. A governor that dies in the middle of a request is replaced by one that finishes it exactly once, whether the first one died before or after the change was made.

TypeScript on Node 22, MIT licensed, no runtime dependencies. A REST work-order adapter and a synthetic CMMS (including one that pretends to apply writes and doesn't) come in the box, and the tests need no database and no device.
