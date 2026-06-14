# Correl

**Prediction market clearing layer for resolving, settling, and distributing event-based payouts.**

Correl is a prototype clearing layer for prediction markets. It maps logically equivalent outcome assets across markets into shared equivalence classes, enabling payoff-equivalent swaps, redemptions, and cleaner settlement flows for event-based markets.

The initial version focuses on Polymarket-style outcome assets, where different markets or differently worded outcomes may represent the same underlying real-world event.

## Overview

Prediction markets often contain overlapping or equivalent contracts. For example, two markets may reference the same event using different wording, or one market’s `YES` side may be economically equivalent to another market’s `NO` side.

Correl introduces a clearing layer that:

* registers prediction market outcome assets;
* groups equivalent outcomes into canonical event classes;
* tracks payoff polarity relative to each event;
* supports swaps between equivalent assets;
* supports redemption of opposite-payoff positions;
* exposes a simple web UI for market, orderbook, and liquidity views.

## Core Idea

Correl treats each real-world event as an **equivalence class**.

Each outcome asset has:

* a venue, currently `polymarket`;
* a market ID;
* an asset ID;
* a side, such as `YES` or `NO`;
* a polarity relative to the canonical event;
* a class ID linking it to equivalent outcomes.

This allows Correl to reason about when two assets are economically interchangeable and when opposite-payoff assets can be redeemed together.

## Key Features

* **Market equivalence classes** — group logically equivalent outcomes across markets.
* **Payoff polarity model** — represent whether an asset pays if an event happens or does not happen.
* **Swap quotes** — quote 1:1 swaps between equivalent same-polarity assets.
* **Redemption quotes** — redeem opposite-payoff assets in the same event class.
* **Balance deltas** — produce explicit debit/credit changes for on-chain-friendly settlement.
* **Polygon integration** — wallet-connected UI for reading deployed contract state.
* **Next.js dashboard** — routes for markets, orderbooks, and equivalence-class views.

## Architecture

```text
User / LP
   |
   v
Next.js UI
   |
   |-- Wallet connection via RainbowKit / wagmi
   |-- Market and orderbook views
   |-- Equivalence class views
   |
   v
Correl Engine
   |
   |-- Registers markets
   |-- Registers outcome assets
   |-- Groups assets into equivalence classes
   |-- Quotes swaps and redemptions
   |-- Computes balance deltas
   |
   v
Smart Contracts
   |
   |-- Track LP positions
   |-- Manage token / USDC balances
   |-- Support settlement and payout flows
```

## How It Works

### 1. Register Markets

A market represents a Polymarket question or container, such as:

```text
"Who will win the 2026 Super Bowl?"
```

Each market is identified by a venue and market ID.

### 2. Register Outcome Assets

An outcome asset represents a tradable prediction market position, such as:

```text
"Team A wins — YES"
```

Each asset is assigned to an equivalence class and given a polarity.

### 3. Create Equivalence Classes

An equivalence class represents one canonical real-world event.

Example:

```text
Class: Team A wins Super Bowl 2026
```

Different markets can contain assets that map to this same event.

### 4. Swap Equivalent Assets

If two assets are in the same equivalence class and have the same polarity, they can be swapped.

Example:

```text
Asset A: Team A wins — YES
Asset B: Team A wins championship — YES
```

If both represent the same payoff, Correl can quote a swap between them.

### 5. Redeem Opposite-Payoff Assets

If two assets are in the same equivalence class but have opposite polarity, they can be redeemed together.

Example:

```text
Asset A: Event happens
Asset B: Event does not happen
```

Together, the pair represents a complete payoff set.

## Tech Stack

* **Frontend:** Next.js, React, TypeScript
* **Wallet / Web3:** RainbowKit, wagmi, viem, MetaMask SDK
* **Blockchain:** Polygon
* **Smart Contracts:** Solidity / Foundry
* **Engine:** TypeScript clearing logic

## Project Structure

```text
correl/
  src/
    app/
      api/                 # API routes
      equiv-classes/       # Equivalence class UI
      market/              # Market views
      orderbook/           # Orderbook views
      page.tsx             # Home / LP position view
      providers.tsx        # Web3 providers

    engine/
      balances.ts          # Balance state helpers
      engine.ts            # Core quote / swap / redeem logic
      smoke.ts             # Smoke test / demo logic
      state.ts             # Engine state
      types.ts             # Market, asset, class, quote types

    lib/
      wagmi.ts             # Wallet / chain configuration

  contracts/
    src/                   # Solidity contracts
    script/                # Deployment scripts
    foundry.toml           # Foundry config

  public/                  # Static assets
  package.json             # App scripts and dependencies
```

## Getting Started

### Prerequisites

* Node.js
* npm
* Foundry, if working with contracts
* A wallet connected to Polygon

### Install

```bash
git clone https://github.com/RyanW1228/correl.git
cd correl
npm install
```

### Run Locally

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

### Build

```bash
npm run build
```

### Start Production Build

```bash
npm run start
```

### Lint

```bash
npm run lint
```

## Smart Contracts

The repository includes Solidity contracts under `contracts/`.

Common Foundry commands:

```bash
cd contracts
forge build
forge test
```

## Engine Concepts

### MarketRef

Represents a prediction market container.

```ts
{
  venue: "polymarket",
  marketId: string,
  question?: string,
  slug?: string
}
```

### OutcomeAsset

Represents a tradable outcome token or position.

```ts
{
  id: string,
  venue: "polymarket",
  marketId: string,
  assetId: string,
  side: "YES" | "NO",
  polarity: "POS" | "NEG",
  classId: string,
  label?: string
}
```

### EquivalenceClass

Represents a canonical real-world event.

```ts
{
  id: string,
  name: string,
  venues: ["polymarket"],
  outcomeIds: string[]
}
```

### Swap

A swap is valid when two assets:

* belong to the same equivalence class;
* have the same payoff polarity;
* are different assets.

### Redeem

A redemption is valid when two assets:

* belong to the same equivalence class;
* have opposite payoff polarity;
* can be paired into a complete payoff set.

## Example Use Cases

* Merge liquidity across equivalent prediction market outcomes.
* Reduce fragmentation between overlapping event contracts.
* Clear payoff-equivalent assets without requiring users to manually reason about contract wording.
* Support settlement and redemption flows for event-based payouts.
* Build a prediction market clearing layer above existing venues.

## Limitations

Correl is currently a v0 prototype.

Current limitations include:

* Polymarket-only venue model.
* In-memory engine logic for registry and quote flows.
* Limited production hardening.
* Equivalence classes may require trusted curation or oracle support.
* Additional work needed for robust dispute handling, market discovery, and automated equivalence detection.

## Roadmap

* Automated equivalence-class discovery.
* Multi-venue support.
* Improved LP accounting and settlement flows.
* Public audit tools for equivalence mappings.
* On-chain execution for swaps and redemptions.
* Better market discovery and orderbook integration.
* Risk controls for invalid or disputed mappings.

## License

MIT
