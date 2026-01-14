# Correl

Correl is a clearing and settlement layer for prediction/event markets (e.g., Polymarket, Kalshi).

Core idea:
If two outcomes from different markets are logically equivalent (A ≡ B), then a user can redeem:

A + NOT(B) → $1 (minus a small fee)

This repository is an early prototype focused on:
- Modeling equivalence groups
- Representing outcomes across markets
- Enforcing the redemption invariant in code

No blockchain yet. No decentralization yet. Just the core logic.
