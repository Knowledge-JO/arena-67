CREATE TABLE "sync_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_tokens" (
	"wallet_address" text NOT NULL,
	"token_address" text NOT NULL,
	"first_seen_block" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_tokens_wallet_address_token_address_pk" PRIMARY KEY("wallet_address","token_address")
);
--> statement-breakpoint
CREATE INDEX "wallet_tokens_wallet_idx" ON "wallet_tokens" USING btree ("wallet_address");