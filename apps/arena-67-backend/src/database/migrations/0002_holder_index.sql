CREATE TABLE "address_labels" (
	"address" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"name" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_holders" (
	"token" text NOT NULL,
	"holder" text NOT NULL,
	"balance" numeric(78, 0) NOT NULL,
	"updated_block" bigint NOT NULL,
	CONSTRAINT "token_holders_token_holder_pk" PRIMARY KEY("token","holder")
);
--> statement-breakpoint
CREATE TABLE "token_index_state" (
	"token" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"from_block" bigint,
	"cursor_block" bigint,
	"transfers_seen" bigint DEFAULT 0 NOT NULL,
	"last_error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"tracked_until" timestamp with time zone,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "token_holders_token_balance_idx" ON "token_holders" USING btree ("token","balance");--> statement-breakpoint
CREATE INDEX "token_holders_holder_idx" ON "token_holders" USING btree ("holder");--> statement-breakpoint
CREATE INDEX "token_index_state_status_idx" ON "token_index_state" USING btree ("status","priority");