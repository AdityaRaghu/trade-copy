# Zerodha Trade Copier

This is a starter service for a single leader/follower setup:

- "mirror mode": listen to the leader account’s Zerodha order updates and place a matching follower order.
- "fan-out mode": submit one order request to both accounts at nearly the same time.

The default configuration assumes two separate Kite Connect apps:

- "leader": your friend’s account, used to watch trades placed from Kite web/app.
- "follower": your account, used to place the mirrored order.

Important limitations: if your friend trades directly on Kite web/mobile/desktop, your app only learns about that order after Zerodha emits the order update. So you can get near-real-time copying, but not a guaranteed identical fill at the exact same instant.

---

## What this scaffold includes

- Zerodha login flow for two accounts: "leader" and "follower"
- Local token storage in `data/tokens.json`
- Local runtime/event storage in `data/runtime.json`
- WebSocket listener for leader order updates
- Follower order placement with quantity multiplier and simple policy checks
- Optional follower cancellation replication
- Safe "DRY_RUN=true" mode
- A small dashboard at http://localhost:8787

This repo supports one follower account only. If you need a different follower, replace the single `FOLLOWER_*` credentials in `.env`.

---

## Before you use it live

Make sure both account holders explicitly consent and that your use complies with Zerodha/Kite Connect terms plus any applicable exchange, broker, and regulatory requirements.

This code is a technical scaffold, not compliance or investment advice.

---

## Also notes

- Margin, holdings, product permissions, and risk settings can differ across accounts.
- "Same order" does not mean the same fill price or exact same exchange timestamp.
- Advanced varieties such as iceberg/CO are blocked by default.
- Starting with `DRY_RUN=true` is strongly recommended.

---

## Setup

1. Copy the sample env file:

```bash
cp .env.example .env