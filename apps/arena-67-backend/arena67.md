## Goal

https://www.openserv.ai/hackathon
So, for the open serve, that is SERV hackathon, the project in my mind is a memecoin agentic platform basically. So, the idea is to be able to trade memecoins on Robinhood blockchain. Basically, you can come to the platform and enter, let's say you want to trade a memecoin called Trump on Robinhood. You just come to the platform and say you want to buy Trump. Saying you want to buy Trump does not necessarily, there might be a lot of Trumps on Robinhood, so you would have to supply a wallet address or you see the token on the platform, then you pick the token, then you decide you want to trade it. Let's say you see the token on the platform, then you click on the token to maybe buy it, and there can be a minimalist interface. Instead of random buttons everywhere telling you to buy, it can just be a chat interface that says, "Okay, how much do you want to buy?" You can just type in the amount you want to buy, then it runs and processes your transaction. Then something else on the side is to have the platform show trending tickers on X, that is Twitter. Trading tickers here on X and also show trending news worldwide, worldwide trending news that could potentially become a narrative in memecoin. Then also top trading memecoins at the point. Basically, the idea is to be a research and trading arena on Robinhood blockchain. Give me insight on how this should be built using something like open serve, that is served in interference APIs. And I think coinbase agentkit or altana (preferably coinbase agentkit) should also come in play here in terms of giving the agents their own wallets to run with it.

### Plan

Your concept perfectly targets the intersection of the **Mainnet & MCP** track and the **AgentKit** track for the OpenServ Hackathon. Building a research and trading arena for memecoins on the Robinhood Chain requires structuring ambiguous natural language into strict, executable blockchain transactions, which is exactly what the SERV infrastructure is designed to solve.

Here is an architectural breakdown of how to build this platform.

## Core Architecture

**1. The Brain: OpenServ Reasoning API**
Natural language prompting is too unpredictable for financial transactions. OpenServ’s Reasoning API is built to enforce bounded, structured schemas. You will define a strict schema for a trade (e.g., `{ action, ticker, amount, contract_address }`). When a user types "Buy Trump," the reasoning graph extracts the intent but immediately recognizes that the `contract_address` is null because multiple tokens share that name. Instead of hallucinating a contract address, it returns a precise validation state to the frontend, triggering a UI prompt for the user to disambiguate the token.

**2. The Execution Engine: Agent Wallets**
You mentioned Altana for agent wallets. While any programmable MPC wallet works for this logic, **Coinbase AgentKit** is an officially incentivized track partner for this exact hackathon. AgentKit gives the AI a TEE-based non-custodial wallet, ensuring the private keys are isolated from the agent's code. Once the OpenServ API finalizes the trade schema, it passes the payload to the agent wallet via the Robinhood MCP (Model Context Protocol) to sign and execute the swap directly on the Robinhood Chain.

**3. The Research Arena: Real-Time Data Ingestion**
To power the trending tickers and worldwide news, a microservices backend built with Node.js and TypeScript is ideal to handle asynchronous, high-velocity streams.

- **X (Twitter) Firehose:** A dedicated service polls the X API for `$TICKER` mentions and sentiment velocity.
- **Global News Integration:** A separate service ingests global RSS feeds or news APIs.
- **Narrative Scoring:** Unstructured news text is fed into a background OpenServ agent tasked with a single reasoning job: score how closely current events align with existing memecoin narratives, surfacing the most explosive overlaps to the UI's side panel.

**4. Minimalist Interface**
A Next.js frontend can cleanly serve the dual-pane layout you described. The right pane displays the live research arena (trending narratives), while the central pane houses the chat interface. When the agent needs to clarify a token, the chat doesn't just output text—it renders an interactive React component (a "Token Selection Card") directly in the conversation flow, showing logos and liquidity pools for the user to click.

---

## The Trade Execution Flow

Order and validation are critical when handling autonomous agent transactions to prevent accidental fund loss.

1. **Intent Extraction (OpenServ Reasoning API):**
   The user inputs "Buy 100 USDC of Trump." The Reasoning API parses this against your strict JSON schema. It identifies the action (`BUY`) and amount (`100 USDC`), but detects multiple contract addresses for the ticker.

2. **Disambiguation Loop:**
   The agent halts execution and returns a structured object to the frontend. The Next.js UI renders a selection card showing the top "Trump" tokens on the Robinhood Chain sorted by liquidity. The user clicks their desired token.

3. **Transaction Construction:**
   With the exact contract address confirmed, the agent interacts with the Robinhood MCP to construct the correct swap routing data for the decentralized exchange.

4. **Wallet Signature:**
   The agent wallet (via AgentKit) securely signs and broadcasts the transaction, returning a block explorer receipt directly into the chat interface.

To integrate Coinbase AgentKit into your backend architecture for the memecoin trading platform, you will use it as the execution layer that takes the validated intents from OpenServ and translates them into signed on-chain transactions.

Here is how to set up the infrastructure to manage the agent's wallet and execute token operations.

### 1. Environment & Installation

AgentKit strictly requires **Node.js v22 or higher** (earlier versions will fail silently). Install the core package using `pnpm`:

```bash
pnpm add @coinbase/agentkit

```

Because AgentKit uses decorators for custom action definitions under the hood, you must enable them in your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true
  }
}
```

### 2. Provision the Agent's Wallet

AgentKit uses the `CdpEvmWalletProvider` to generate and manage non-custodial wallets. This is critical for your architecture because the agent needs to hold funds and sign transactions on EVM-compatible networks (like the Robinhood Chain) without hardcoding private keys into your services.

```typescript
import { CdpEvmWalletProvider } from '@coinbase/agentkit';

// Initialize the wallet securely via the Coinbase Developer Platform (CDP) API
const walletProvider = await CdpEvmWalletProvider.configureWithWallet({
  apiKeyId: process.env.CDP_API_KEY_ID,
  apiKeySecret: process.env.CDP_API_KEY_SECRET,
  // You will point this to the Robinhood Chain network ID
  networkId: 'base-sepolia',
});

console.log("Agent's funding address:", await walletProvider.getAddress());
```

### 3. Initialize AgentKit with Action Providers

Next, you instantiate the core `AgentKit` class and inject the specific on-chain capabilities your trading bot needs. For a memecoin platform, the `erc20ActionProvider` is essential for handling token balances, approvals, and transfers.

```typescript
import {
  AgentKit,
  walletActionProvider,
  erc20ActionProvider,
} from '@coinbase/agentkit';

const agentKit = await AgentKit.from({
  walletProvider,
  actionProviders: [
    // Enables basic native token interactions
    walletActionProvider(),
    // Enables ERC-20 contract interactions
    erc20ActionProvider(),
  ],
});
```

### 4. Bridge with OpenServ

Once `AgentKit` is initialized, it gives your backend a secure execution environment.

The flow looks like this:

1. The Next.js frontend sends the natural language request ("Buy Trump") to your OpenServ Reasoning API.
2. OpenServ processes the text, forces the disambiguation loop, and outputs a strict JSON schema containing the final trade parameters (action, amount, verified contract address).
3. Your backend receives this validated JSON and maps the parameters to the appropriate AgentKit action to execute the swap directly on the chain.

Building this memecoin trading and research backend requires a modular architecture that separates the AI reasoning engine (OpenServ), the on-chain execution layer (Coinbase AgentKit), and real-time data ingestion. NestJS is perfectly suited for this due to its dependency injection and isolated module structure.

## Core NestJS Architecture

The backend should be divided into five distinct modules to ensure the trading execution context is isolated from noisy data-ingestion streams.

- **`OpenServModule`**: Wraps the `@openserv-labs/sdk`. Defines the AI agent configurations, strict input/output schemas using Zod, and custom capabilities for parsing user trade intents and scoring news narratives.
- **`AgentKitModule`**: Wraps `@coinbase/agentkit`. Manages the `CdpEvmWalletProvider` to generate and fund non-custodial wallets on the Robinhood Chain, and registers ERC-20 and custom swap action providers.
- **`TradingModule`**: The central orchestrator. It receives raw chat inputs from the user, passes them to the `OpenServModule` to extract a validated trade schema, and forwards the exact contract address and amount to the `AgentKitModule` for on-chain execution.
- **`ResearchModule`**: Handles background data ingestion. Uses the NestJS `@nestjs/schedule` package to run cron jobs that poll the X (Twitter) Firehose and global news APIs, passing raw text to a background OpenServ agent to score narrative relevance.
- **`GatewayModule`**: Implements `@nestjs/websockets` to stream live trending tickers, news scores, and multi-step transaction statuses (e.g., "Reasoning..." -> "Awaiting Disambiguation" -> "Executing Swap") back to the Next.js frontend.

---

## Build & Implementation Roadmap

1. **Initialize the NestJS Environment:**
   Scaffold the NestJS application and install the required AI and Web3 dependencies. You will need the OpenServ SDK, Coinbase AgentKit, Zod for schema validation, and Ethers for blockchain utilities.

```bash
nest new agentic-trading-backend
pnpm add @openserv-labs/sdk @coinbase/agentkit zod ethers @nestjs/schedule @nestjs/websockets

```

2. **Configure the OpenServ Reasoning Provider:**
   In the `OpenServModule`, initialize the OpenServ client. Define your primary agent and register specific capabilities. For the trading flow, create a capability with a strict `inputSchema` that requires an `action` (buy/sell), `amount`, and `contractAddress`. If the user only says "Buy Trump", OpenServ will naturally halt and request the missing `contractAddress`, which you pass back to the frontend for user disambiguation.

3. **Provision AgentKit Execution Wallets:**
   In the `AgentKitModule`, configure the `CdpEvmWalletProvider` pointing to the Robinhood Chain network ID. Instantiate `AgentKit` and inject the `erc20ActionProvider`. Write a custom AgentKit action provider using the `@CreateAction` decorator to handle routing the final swap through a decentralized exchange on the Robinhood Chain.

4. **Build the Trade Orchestrator:**
   Create a `TradingService` that bridges OpenServ and AgentKit. When a chat message arrives, the service sends it to the OpenServ agent. If OpenServ returns a "Needs Disambiguation" state, the service emits a WebSocket event to the frontend showing the token options. Once OpenServ outputs the final validated JSON schema, the service passes the payload directly to the AgentKit wallet for signing and execution.

5. **Implement the Narrative Scoring Background Job:**
   In the `ResearchModule`, create a scheduled task that pulls the top 50 trending crypto news headlines every 5 minutes. Pass this array to a secondary OpenServ background agent equipped with a "Narrative Scorer" capability. Have the agent return a structured array of JSON objects containing `ticker`, `sentimentScore`, and `catalystSummary`, which you immediately broadcast to the frontend via WebSockets.

---

> **Security Note:** Never log the AgentKit CDP API keys or the OpenServ API keys. Use the NestJS `@nestjs/config` module to strictly type and validate your `.env` variables on application startup.

Here is exactly how you should structure the TypeScript capabilities and Zod schemas for the OpenServ agent to handle the memecoin trade extraction.

The core trick to making this work autonomously is to make the `contractAddress` **optional** in the schema, but strictly enforce the `ticker`. This forces the AI to recognize when it doesn't have the exact address, intentionally halting the execution to ask the frontend for disambiguation.

### 1. Define the Zod Schema

Use `zod` to define a strict structure. Adding `.describe()` to each field is crucial, as OpenServ's reasoning engine uses these descriptions as internal prompts to understand what data to extract from the user's natural language.

```typescript
import { z } from 'zod';

export const TradeIntentSchema = z.object({
  action: z
    .enum(['buy', 'sell'])
    .describe('The trading action the user wants to perform.'),
  amount: z
    .number()
    .positive()
    .describe('The numerical amount to swap (e.g., 100).'),
  currency: z
    .string()
    .describe(
      'The funding currency to use, usually USDC or the native gas token.',
    ),
  ticker: z
    .string()
    .describe(
      'The name or symbol of the memecoin the user wants to trade (e.g., "Trump", "Doge").',
    ),
  contractAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a valid EVM address')
    .optional()
    .describe(
      'The exact 0x contract address of the token. Leave this undefined if the user only provides a name/ticker and not the actual address.',
    ),
});

// Infer the TypeScript type from the Zod schema for type safety in your services
export type TradeIntent = z.infer<typeof TradeIntentSchema>;
```

### 2. Create the OpenServ Capability

In the OpenServ SDK, capabilities act as tools the AI can call when it decides it has gathered the right context. You will bind the Zod schema to this capability.

When the user says "Buy 100 USDC of Trump," the agent triggers this capability. The function checks if the `contractAddress` is present. If it isn't, it returns a specific `NEEDS_DISAMBIGUATION` state instead of executing the trade.

```typescript
import { Agent } from '@openserv-labs/sdk';
// Assume we have a service to search tokens on Robinhood Chain
import { tokenSearchService } from './services/tokenSearch';

export function registerTradingCapabilities(agent: Agent) {
  agent.addCapability({
    name: 'prepare_trade_execution',
    description:
      'Prepares a memecoin trade. Use this when the user expresses intent to buy or sell a token.',
    schema: TradeIntentSchema,
    handler: async (extractedData: TradeIntent) => {
      // 1. Check if the AI successfully extracted a precise contract address
      if (!extractedData.contractAddress) {
        // 2. Address is missing. Fetch the top matching tokens for the ticker.
        const tokenCandidates = await tokenSearchService.findTokensByTicker(
          extractedData.ticker,
        );

        // 3. Halt and return the disambiguation payload to the orchestrator/frontend
        return {
          status: 'NEEDS_DISAMBIGUATION',
          message: `I found multiple tokens for "${extractedData.ticker}". Which one did you mean?`,
          extractedContext: extractedData, // Save the amount, action, etc.
          candidates: tokenCandidates, // Array of tokens (logo, address, liquidity)
        };
      }

      // 4. If we have the address, the schema is complete.
      // Return the validated payload ready for Coinbase AgentKit execution.
      return {
        status: 'READY_FOR_EXECUTION',
        message:
          'Trade parameters validated. Forwarding to AgentKit for signing.',
        payload: {
          action: extractedData.action,
          amount: extractedData.amount,
          currency: extractedData.currency,
          contractAddress: extractedData.contractAddress,
        },
      };
    },
  });
}
```

### 3. Handle the State in your NestJS Orchestrator

In your `TradingService` (the orchestrator module), you will evaluate the output of the OpenServ agent and decide whether to ping the frontend via WebSockets or forward the payload to AgentKit.

```typescript
import { Injectable } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';
import { AgentKitService } from '../agentkit/agentkit.service';

@Injectable()
@WebSocketGateway()
export class TradingOrchestratorService {
  @WebSocketServer()
  server: Server;

  constructor(private agentKitService: AgentKitService) {}

  async processAgentResponse(agentResponse: any, clientId: string) {
    if (agentResponse.status === 'NEEDS_DISAMBIGUATION') {
      // Stream the candidates back to the frontend to render the Token Selection Card
      this.server.to(clientId).emit('trade_disambiguation_required', {
        message: agentResponse.message,
        candidates: agentResponse.candidates,
        // Pass the incomplete context so the frontend can send it back once the user clicks an address
        pendingTradeState: agentResponse.extractedContext,
      });
      return;
    }

    if (agentResponse.status === 'READY_FOR_EXECUTION') {
      // The schema is complete. Pass to AgentKit to execute on the Robinhood Chain.
      this.server
        .to(clientId)
        .emit('trade_status', { message: 'Executing on-chain...' });

      const txReceipt = await this.agentKitService.executeSwap(
        agentResponse.payload,
      );

      this.server.to(clientId).emit('trade_success', {
        message: `Trade successful!`,
        hash: txReceipt.transactionHash,
      });
    }
  }
}
```

### How the Loop Closes

When the user clicks the correct token on the Next.js frontend, the frontend sends a new message back to your NestJS WebSocket:
_"Proceed with the trade. The contract address is 0x123...456."_

Because the agent retains conversation history in its workspace, the OpenServ reasoning engine seamlessly combines this new address with the previously saved `action` and `amount`, re-triggers the `prepare_trade_execution` capability (this time with the address included), and proceeds to `READY_FOR_EXECUTION`.
