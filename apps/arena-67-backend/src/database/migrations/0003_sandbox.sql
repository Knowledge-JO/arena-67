CREATE TABLE "paper_accounts" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"epoch" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reset_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "paper_balances" (
	"user_id" uuid NOT NULL,
	"epoch" integer NOT NULL,
	"asset" text NOT NULL,
	"symbol" text NOT NULL,
	"decimals" integer NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"realized_usd" double precision DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paper_balances_user_id_epoch_asset_pk" PRIMARY KEY("user_id","epoch","asset")
);
--> statement-breakpoint
CREATE TABLE "paper_deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"epoch" integer NOT NULL,
	"asset" text NOT NULL,
	"symbol" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"value_usd" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"epoch" integer NOT NULL,
	"side" text NOT NULL,
	"token_address" text NOT NULL,
	"token_symbol" text NOT NULL,
	"pool_id" text NOT NULL,
	"funding_address" text NOT NULL,
	"funding_symbol" text NOT NULL,
	"amount_in" numeric(78, 0) NOT NULL,
	"amount_out" numeric(78, 0) NOT NULL,
	"value_usd" double precision,
	"fee_usd" double precision DEFAULT 0 NOT NULL,
	"fee_asset" text,
	"realized_usd" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "trading_mode" text DEFAULT 'sandbox' NOT NULL;--> statement-breakpoint
ALTER TABLE "paper_accounts" ADD CONSTRAINT "paper_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_balances" ADD CONSTRAINT "paper_balances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_deposits" ADD CONSTRAINT "paper_deposits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_trades" ADD CONSTRAINT "paper_trades_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paper_deposits_user_idx" ON "paper_deposits" USING btree ("user_id","epoch");--> statement-breakpoint
CREATE INDEX "paper_trades_user_idx" ON "paper_trades" USING btree ("user_id","epoch","created_at");